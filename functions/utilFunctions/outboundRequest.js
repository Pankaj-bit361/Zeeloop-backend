"use strict";
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns/promises");
const net = require("node:net");
const zlib = require("node:zlib");
const config = require("../../config/config");

function isPublicAddress(address) {
    if (net.isIP(address) === 4) {
        const [a, b, c] = address.split(".").map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
    }
    if (net.isIP(address) !== 6) return false;
    // Accept native global unicast only. Mapped IPv4, local/link-local,
    // multicast and transition mechanisms cannot hide a private IPv4 target.
    const first = parseInt(address.split(":")[0] || "0", 16);
    return (first & 0xe000) === 0x2000 && !/^2002:/i.test(address) &&
        !/^2001:(0*:|0*db8:)/i.test(address);
}

function parseDestination(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("Outbound URLs must use http or https without embedded credentials");
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const testLoopback = config.ALLOW_TEST_LOOPBACK && process.env.NODE_ENV === "test" &&
        ["localhost", "127.0.0.1", "::1"].includes(hostname);
    if (!testLoopback && (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
        (net.isIP(hostname) && !isPublicAddress(hostname)))) {
        throw new Error("Outbound requests to private or reserved destinations are not permitted");
    }
    return { url, hostname, testLoopback };
}

async function resolveDestination(value, { lookup = dns.lookup } = {}) {
    const destination = parseDestination(value);
    const records = net.isIP(destination.hostname)
        ? [{ address: destination.hostname, family: net.isIP(destination.hostname) }]
        : await lookup(destination.hostname, { all: true, verbatim: true });
    if (!records.length || records.some(record => !isPublicAddress(record.address) &&
        !(destination.testLoopback && ["127.0.0.1", "::1"].includes(record.address)))) {
        throw new Error("Outbound DNS resolved to a private or reserved destination");
    }
    return { ...destination, address: records.find(record => record.family === 4) || records[0] };
}

function pinnedRequest(destination, options, signal, maxBytes) {
    return new Promise((resolve, reject) => {
        const headers = { ...options.headers, "accept-encoding": "identity" };
        for (const name of Object.keys(headers)) {
            if (["host", "connection", "proxy-authorization", "content-length"].includes(name.toLowerCase())) delete headers[name];
        }
        if (options.body != null) headers["content-length"] = Buffer.byteLength(options.body);
        const transport = destination.url.protocol === "https:" ? https : http;
        const request = transport.request(destination.url, {
            method: options.method || "GET", headers, signal, agent: false,
            family: destination.address.family,
            // DNS is pinned for the connection. Validating then calling fetch
            // would resolve again and leave a DNS rebinding window.
            lookup: (_host, lookupOptions, callback) => lookupOptions.all
                ? callback(null, [destination.address])
                : callback(null, destination.address.address, destination.address.family),
        }, response => {
            let received = 0, decoded = 0;
            const chunks = [];
            const fail = error => { reject(error); request.destroy(error); response.destroy(); };
            response.on("data", chunk => {
                received += chunk.length;
                if (received > maxBytes) fail(new Error("Outbound response exceeds the size limit"));
            });
            const encoding = response.headers["content-encoding"];
            const decoder = encoding === "gzip" ? zlib.createGunzip() : encoding === "br" ? zlib.createBrotliDecompress() : encoding === "deflate" ? zlib.createInflate() : null;
            const body = decoder ? response.pipe(decoder) : response;
            body.on("data", chunk => {
                decoded += chunk.length;
                if (decoded > maxBytes) fail(new Error("Outbound response exceeds the size limit"));
                else chunks.push(chunk);
            });
            body.on("error", fail);
            response.on("aborted", () => reject(new Error("Outbound response was interrupted")));
            body.on("end", () => {
                const bytes = Buffer.concat(chunks);
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                    if (value != null) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
                }
                resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300,
                    headers: responseHeaders, text: async () => bytes.toString("utf8"), json: async () => JSON.parse(bytes.toString("utf8")) });
            });
        });
        request.on("error", reject);
        request.end(options.body);
    });
}

async function outboundRequest(value, options = {}) {
    const { timeoutMs = 15_000, maxBytes = 5 * 1024 * 1024, maxRedirects = 4, fetchImpl, ...requestOptions } = options;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error("Outbound request timed out")), timeoutMs);
    const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
    let url = String(value);
    let currentOptions = requestOptions;
    try {
        for (let hop = 0; hop <= maxRedirects; hop++) {
            // Test transports are injected in-process, never selectable by a
            // client. Validate literal/private URLs even for those transports.
            let response;
            if (fetchImpl && fetchImpl !== global.fetch) {
                parseDestination(url);
                response = await Promise.race([fetchImpl(url, { ...currentOptions, redirect: "manual", signal: controller.signal }), aborted]);
                const text = await Promise.race([response.text ? response.text() : Promise.resolve(""), aborted]);
                if (Buffer.byteLength(text) > maxBytes) throw new Error("Outbound response exceeds the size limit");
                response = { status: response.status, ok: response.ok, headers: response.headers || new Headers(), text: async () => text, json: async () => JSON.parse(text) };
            } else {
                const destination = await Promise.race([resolveDestination(url), aborted]);
                response = await Promise.race([pinnedRequest(destination, currentOptions, controller.signal, maxBytes), aborted]);
            }
            if (![301, 302, 303, 307, 308].includes(response.status)) return response;
            if (currentOptions.redirect === "error" || hop === maxRedirects) throw new Error("Outbound redirect is not permitted");
            const location = response.headers.get("location");
            if (!location) return response;
            const next = new URL(location, url);
            if (new URL(url).protocol === "https:" && next.protocol !== "https:") throw new Error("Outbound redirects cannot downgrade TLS");
            if (next.origin !== new URL(url).origin) {
                currentOptions = { ...currentOptions, headers: { "user-agent": "ZealoopBot/1.0", accept: "text/html, application/xml" } };
            }
            if (response.status === 303 || ([301, 302].includes(response.status) && currentOptions.method === "POST")) {
                currentOptions = { ...currentOptions, method: "GET", body: undefined };
            }
            url = next.href;
        }
    } finally { clearTimeout(deadline); }
}

module.exports = { outboundRequest, resolveDestination, parseDestination, isPublicAddress };

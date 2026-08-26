#!/usr/bin/env node
/**
 * Load-test one authenticated GET.
 *
 *   LOAD_URL='https://api.zealoop.com/api/org/<orgId>/me' \
 *   LOAD_TOKEN='<org jwt>' \
 *   node scripts/loadTest.js --rps 5000 --seconds 10
 *
 * High rps from one process is still mostly your laptop, TLS, and the
 * org rate limiter — not a cluster capacity test. Expect 429s.
 *
 * Token stays in the environment. Do not paste it into this file.
 */
const http = require("http");
const https = require("https");

const args = Object.fromEntries(
    process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : []))
);
const rps = Math.max(1, Number(args.rps || 5000));
const seconds = Math.max(1, Number(args.seconds || 5));
const url = process.env.LOAD_URL;
const token = process.env.LOAD_TOKEN;

if (!url || !token) {
    console.error("Set LOAD_URL and LOAD_TOKEN. Example:\n  LOAD_URL='https://api.zealoop.com/api/org/ORG/me' LOAD_TOKEN='eyJ...' node scripts/loadTest.js --rps 50 --seconds 5");
    process.exit(1);
}
// A single Node process cannot open 50M sockets. Past ~10k rps this
// script measures the client heap, not the server. The 5k run already
// 502'd production; cranking the number only OOMs this process.
const MAX_RPS = 10_000;
const MAX_TOTAL = 100_000;
const MAX_IN_FLIGHT = 2_000;
if (rps > MAX_RPS) {
    console.error(`Refusing --rps ${rps}. Cap is ${MAX_RPS}. The 5k run already returned 0% ok (502). More rps OOMs Node, it does not test the server.`);
    process.exit(1);
}
if (rps * seconds > MAX_TOTAL) {
    console.error(`Refusing ${rps} × ${seconds}s = ${rps * seconds} requests. Cap is ${MAX_TOTAL} total.`);
    process.exit(1);
}

const target = new URL(url);
const lib = target.protocol === "https:" ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: Math.min(rps, 2048) });
const headers = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    origin: process.env.LOAD_ORIGIN || "https://app.zealoop.com",
};

const counts = new Map();
const latencies = [];
let inFlight = 0;
let sent = 0;
const total = rps * seconds;
const started = Date.now();

function fire() {
    if (inFlight >= MAX_IN_FLIGHT) {
        counts.set("DROPPED", (counts.get("DROPPED") || 0) + 1);
        sent += 1;
        if (sent >= total && inFlight === 0) report();
        return;
    }
    const t0 = Date.now();
    inFlight += 1;
    sent += 1;
    const req = lib.request(
        {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            path: target.pathname + target.search,
            method: "GET",
            headers,
            agent,
            timeout: 10_000,
        },
        (res) => {
            res.resume();
            res.on("end", () => done(String(res.statusCode), Date.now() - t0));
        }
    );
    req.on("error", (err) => done(err.code || "ERR", Date.now() - t0));
    req.on("timeout", () => {
        req.destroy();
        done("TIMEOUT", Date.now() - t0);
    });
    req.end();
}

function done(code, ms) {
    inFlight -= 1;
    counts.set(code, (counts.get(code) || 0) + 1);
    latencies.push(ms);
    if (sent >= total && inFlight === 0) report();
}

function percentile(p) {
    if (!latencies.length) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report() {
    const elapsed = (Date.now() - started) / 1000;
    const ok = (counts.get("200") || 0) + (counts.get("304") || 0);
    console.log(`\nsent ${sent} in ${elapsed.toFixed(2)}s  (${(sent / elapsed).toFixed(1)} rps actual)`);
    console.log(`ok ${ok}  (${((ok / sent) * 100).toFixed(1)}%)`);
    console.log(`p50 ${percentile(50)}ms  p95 ${percentile(95)}ms  p99 ${percentile(99)}ms`);
    console.log("status:");
    for (const [code, n] of [...counts.entries()].sort()) {
        console.log(`  ${code}  ${n}`);
    }
    agent.destroy();
}

console.log(`GET ${url}  ${rps} rps × ${seconds}s  (${total} requests)`);
// One timer tick per second, fire `rps` requests in the tick. setInterval
// cannot schedule faster than ~1ms, so a 1-request-per-tick loop cannot
// reach thousands of rps.
let tick = 0;
const timer = setInterval(() => {
    const n = Math.min(rps, total - sent);
    for (let i = 0; i < n; i++) fire();
    tick += 1;
    if (tick >= seconds || sent >= total) clearInterval(timer);
}, 1000);
// First batch immediately so we don't sit idle for a second.
{
    const n = Math.min(rps, total);
    for (let i = 0; i < n; i++) fire();
    tick = 1;
    if (tick >= seconds) clearInterval(timer);
}

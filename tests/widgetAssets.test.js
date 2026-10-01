"use strict";
/* The widget's own files, as a customer's browser fetches them.

   Nothing tested these before, and production served 500 on /widget.js — the
   URL in every install snippet — for as long as the server read the build
   from a sibling checkout that only exists on a laptop. */
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BASE_URL } = require("./helpers/client");

async function fetchAsset(p) {
    const res = await fetch(BASE_URL + p);
    return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text() };
}

describe("widget assets are served", () => {
    test("/widget.js is the loader, as JavaScript", async () => {
        const res = await fetchAsset("/widget.js");
        assert.equal(res.status, 200, res.body.slice(0, 200));
        assert.match(res.type, /javascript/);
        assert.match(res.body, /zealoop/i);
    });

    test("/widget/frame/ is the messenger frame, as HTML", async () => {
        const res = await fetchAsset("/widget/frame/?pk=x");
        assert.equal(res.status, 200, res.body.slice(0, 200));
        assert.match(res.type, /html/);
    });

    test("the frame's script and stylesheet resolve", async () => {
        for (const file of ["frame.js", "frame.css"]) {
            const res = await fetchAsset(`/widget/frame/${file}`);
            assert.equal(res.status, 200, `${file}: ${res.body.slice(0, 120)}`);
        }
    });
});

describe("the vendored widget build cannot go stale", () => {
    const vendored = path.resolve(__dirname, "../public/widget");
    const sibling = path.resolve(__dirname, "../../widget/dist");

    test("public/widget is committed and complete", () => {
        // This is the copy production serves. Its absence is the outage.
        for (const file of ["widget.js", "frame/index.html", "frame/frame.js", "frame/frame.css"]) {
            assert.ok(fs.existsSync(path.join(vendored, file)), `public/widget/${file} is missing — run npm run widget:sync`);
        }
    });

    test("public/widget matches ../widget/dist byte for byte (when the sibling build exists)", (t) => {
        /* On a laptop with the widget repo beside this one, a widget change
           that was built but not synced would work locally and ship stale.
           This makes that a red test instead of a surprise. On CI and on
           the server there is no sibling, and the vendored copy is the only
           truth — nothing to compare. */
        if (!fs.existsSync(path.join(sibling, "widget.js"))) {
            t.skip("no sibling widget build to compare against");
            return;
        }
        const list = (root) => {
            const out = [];
            (function walk(dir) {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) walk(full);
                    else out.push(path.relative(root, full));
                }
            })(root);
            return out.sort();
        };
        assert.deepEqual(list(vendored), list(sibling), "file sets differ — run npm run widget:sync");
        for (const file of list(sibling)) {
            assert.ok(
                fs.readFileSync(path.join(vendored, file)).equals(fs.readFileSync(path.join(sibling, file))),
                `${file} differs from the widget build — run npm run widget:sync`
            );
        }
    });
});

describe("widget assets are compressed and cached for how they are used", () => {
    // fetch decodes br and gzip transparently but still reports the header,
    // so these assert on what the server chose, not on raw bytes.
    const frameRefs = async () => {
        const html = await (await fetch(BASE_URL + "/widget/frame/?pk=x")).text();
        return [...html.matchAll(/\.\/(frame\.[0-9a-f]{10}\.(?:js|css))/g)].map((match) => match[1]);
    };

    test("the frame's fingerprinted assets are immutable and brotli-encoded", async () => {
        const refs = await frameRefs();
        assert.equal(refs.length, 2, "index.html should reference one fingerprinted script and one stylesheet");
        for (const ref of refs) {
            const res = await fetch(`${BASE_URL}/widget/frame/${ref}`, { headers: { "accept-encoding": "br, gzip" } });
            assert.equal(res.status, 200, ref);
            assert.equal(res.headers.get("content-encoding"), "br", ref);
            assert.match(res.headers.get("cache-control") || "", /max-age=31536000.*immutable/, ref);
            assert.match(res.headers.get("vary") || "", /accept-encoding/i, ref);
            assert.match(res.headers.get("content-type") || "", ref.endsWith(".js") ? /javascript/ : /css/, ref);
            assert.ok((await res.text()).length > 1000, `${ref} decoded to almost nothing`);
        }
    });

    test("a client without brotli gets gzip, and one without either gets plain bytes", async () => {
        const [script] = (await frameRefs()).filter((ref) => ref.endsWith(".js"));
        const gz = await fetch(`${BASE_URL}/widget/frame/${script}`, { headers: { "accept-encoding": "gzip" } });
        assert.equal(gz.headers.get("content-encoding"), "gzip");
        const plain = await fetch(`${BASE_URL}/widget/frame/${script}`, { headers: { "accept-encoding": "identity" } });
        assert.equal(plain.headers.get("content-encoding"), null);
        assert.equal((await gz.text()).length, (await plain.text()).length);
    });

    test("widget.js and the frame page keep a short cache that revalidates in the background", async () => {
        for (const url of ["/widget.js", "/widget/frame/?pk=x"]) {
            const res = await fetch(BASE_URL + url, { headers: { "accept-encoding": "br" } });
            assert.equal(res.status, 200, url);
            assert.match(res.headers.get("cache-control") || "", /max-age=300.*stale-while-revalidate/, url);
            assert.doesNotMatch(res.headers.get("cache-control") || "", /immutable/, url);
        }
    });

    test("a fingerprint from an older deploy falls back to the current build, uncached", async () => {
        const res = await fetch(`${BASE_URL}/widget/frame/frame.0000000000.js`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("cache-control"), "no-cache");
        assert.match(res.headers.get("content-type") || "", /javascript/);
    });

    test("paths outside the frame directory are not served", async () => {
        for (const probe of ["/widget/frame/..%2f..%2fserver.js", "/widget/frame/%2e%2e/%2e%2e/package.json"]) {
            const res = await fetch(BASE_URL + probe);
            const body = await res.text();
            assert.ok(res.status !== 200 || !/require\(|"dependencies"/.test(body), `${probe} leaked a file`);
        }
    });

    test("/widget/frame without a trailing slash still redirects to the page", async () => {
        const res = await fetch(BASE_URL + "/widget/frame", { redirect: "manual" });
        assert.ok([301, 302, 303, 307, 308].includes(res.status), `status ${res.status}`);
    });
});

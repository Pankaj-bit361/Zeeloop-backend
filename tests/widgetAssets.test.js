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

// §1.1 SITEMAP discovery. Parsing and the include/exclude heuristics are pure,
// so they are tested directly; discovery is tested with an injected fetch so
// the suite never depends on a third-party site being up.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const sitemap = require("../functions/knowledge/sitemapFunctions");

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://acme.test/docs/getting-started</loc><lastmod>2026-05-01</lastmod></url>
  <url><loc>https://acme.test/blog/we-raised-a-round</loc><lastmod>2026-04-02</lastmod></url>
  <url><loc>https://acme.test/pricing</loc></url>
  <url><loc>https://acme.test/assets/hero.png</loc></url>
</urlset>`;

const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://acme.test/sitemap-docs.xml</loc></sitemap>
  <sitemap><loc>https://acme.test/sitemap-marketing.xml</loc></sitemap>
</sitemapindex>`;

const DOCS_CHILD = `<urlset><url><loc>https://acme.test/docs/a</loc></url><url><loc>https://acme.test/docs/b</loc></url></urlset>`;
const MARKETING_CHILD = `<urlset><url><loc>https://acme.test/blog/x</loc></url></urlset>`;

// Minimal fetch stand-in: a map of url -> body.
function fakeFetch(routes) {
    return async (url) => {
        if (!(url in routes)) return { ok: false, status: 404, text: async () => "" };
        return { ok: true, status: 200, text: async () => routes[url] };
    };
}

describe("parse", () => {
    test("extracts locs and lastmods from a urlset", () => {
        const result = sitemap.parse(URLSET);
        assert.equal(result.isIndex, false);
        assert.equal(result.entries.length, 4);
        assert.equal(result.entries[0].url, "https://acme.test/docs/getting-started");
        assert.equal(result.entries[0].lastmod, "2026-05-01");
    });

    test("pairs each loc with its own lastmod, not a neighbour's", () => {
        const result = sitemap.parse(URLSET);
        assert.equal(result.entries[1].lastmod, "2026-04-02");
        assert.equal(result.entries[2].lastmod, null, "an entry without lastmod must not inherit one");
    });

    test("recognises a sitemap index", () => {
        const result = sitemap.parse(INDEX);
        assert.equal(result.isIndex, true);
        assert.equal(result.entries.length, 2);
    });

    test("decodes XML entities in URLs", () => {
        const xml = `<urlset><url><loc>https://acme.test/a?x=1&amp;y=2</loc></url></urlset>`;
        assert.equal(sitemap.parse(xml).entries[0].url, "https://acme.test/a?x=1&y=2");
    });

    test("tolerates whitespace and mixed case tags", () => {
        const xml = `<URLSET><URL><LOC>
            https://acme.test/docs/x
        </LOC></URL></URLSET>`;
        assert.equal(sitemap.parse(xml).entries[0].url, "https://acme.test/docs/x");
    });

    test("returns empty for junk rather than throwing", () => {
        assert.deepEqual(sitemap.parse("not xml at all").entries, []);
        assert.deepEqual(sitemap.parse("").entries, []);
        assert.deepEqual(sitemap.parse(null).entries, []);
    });
});

describe("classifyUrl", () => {
    test("includes documentation paths", () => {
        for (const path of ["/docs/x", "/help/y", "/faq", "/guide/z", "/support/a", "/pricing"]) {
            assert.equal(sitemap.classifyUrl(`https://acme.test${path}`).included, true, path);
        }
    });

    test("excludes blog, careers and legal", () => {
        for (const path of ["/blog/post", "/careers", "/legal/terms", "/privacy", "/author/jane"]) {
            assert.equal(sitemap.classifyUrl(`https://acme.test${path}`).included, false, path);
        }
    });

    test("excludes assets", () => {
        for (const path of ["/a/hero.png", "/b/app.js", "/c/style.css", "/d/clip.mp4"]) {
            assert.equal(sitemap.classifyUrl(`https://acme.test${path}`).included, false, path);
        }
    });

    test("includes unknown paths but marks them uncategorised for review", () => {
        const result = sitemap.classifyUrl("https://acme.test/some/page");
        assert.equal(result.included, true);
        assert.equal(result.reason, "uncategorised");
    });

    test("exclusion beats inclusion — /blog/docs-tips is still a blog post", () => {
        assert.equal(sitemap.classifyUrl("https://acme.test/blog/docs-tips").included, false);
    });

    test("an unparseable url is excluded rather than crashing the crawl", () => {
        assert.equal(sitemap.classifyUrl("not-a-url").included, false);
    });
});

describe("discover", () => {
    test("finds sitemap.xml from a bare domain", async () => {
        const result = await sitemap.discover({
            url: "https://acme.test",
            fetchImpl: fakeFetch({ "https://acme.test/sitemap.xml": URLSET }),
        });
        assert.equal(result.success, true);
        assert.equal(result.source, "https://acme.test/sitemap.xml");
        assert.equal(result.urls.length, 4);
    });

    test("classifies every discovered url", async () => {
        const result = await sitemap.discover({
            url: "https://acme.test",
            fetchImpl: fakeFetch({ "https://acme.test/sitemap.xml": URLSET }),
        });
        const byUrl = Object.fromEntries(result.urls.map((entry) => [entry.url, entry]));
        assert.equal(byUrl["https://acme.test/docs/getting-started"].included, true);
        assert.equal(byUrl["https://acme.test/blog/we-raised-a-round"].included, false);
        assert.equal(byUrl["https://acme.test/assets/hero.png"].included, false);
    });

    test("follows a sitemap index one level down", async () => {
        const result = await sitemap.discover({
            url: "https://acme.test/sitemap.xml",
            fetchImpl: fakeFetch({
                "https://acme.test/sitemap.xml": INDEX,
                "https://acme.test/sitemap-docs.xml": DOCS_CHILD,
                "https://acme.test/sitemap-marketing.xml": MARKETING_CHILD,
            }),
        });
        assert.equal(result.success, true);
        assert.equal(result.urls.length, 3);
    });

    test("survives a child sitemap that 404s", async () => {
        const result = await sitemap.discover({
            url: "https://acme.test/sitemap.xml",
            fetchImpl: fakeFetch({
                "https://acme.test/sitemap.xml": INDEX,
                "https://acme.test/sitemap-docs.xml": DOCS_CHILD,
            }),
        });
        assert.equal(result.success, true);
        assert.equal(result.urls.length, 2, "the reachable child still contributes");
    });

    test("deduplicates and strips fragments", async () => {
        const xml = `<urlset>
            <url><loc>https://acme.test/docs/a</loc></url>
            <url><loc>https://acme.test/docs/a#section</loc></url>
            <url><loc>https://acme.test/docs/a</loc></url>
        </urlset>`;
        const result = await sitemap.discover({
            url: "https://acme.test/sitemap.xml",
            fetchImpl: fakeFetch({ "https://acme.test/sitemap.xml": xml }),
        });
        assert.equal(result.urls.length, 1);
    });

    test("respects maxUrls", async () => {
        const result = await sitemap.discover({
            url: "https://acme.test/sitemap.xml",
            maxUrls: 2,
            fetchImpl: fakeFetch({ "https://acme.test/sitemap.xml": URLSET }),
        });
        assert.equal(result.urls.length, 2);
    });

    test("rejects a non-http url without attempting a fetch", async () => {
        let called = false;
        const result = await sitemap.discover({
            url: "file:///etc/passwd",
            fetchImpl: async () => {
                called = true;
                return { ok: true, text: async () => URLSET };
            },
        });
        assert.equal(result.success, false);
        assert.equal(called, false, "an SSRF-shaped url must not reach fetch at all");
    });

    test("reports a helpful failure when no sitemap exists", async () => {
        const result = await sitemap.discover({ url: "https://acme.test", fetchImpl: fakeFetch({}) });
        assert.equal(result.success, false);
        assert.ok(result.error.includes("No sitemap found"));
    });

    test("a fetch that throws does not take the request down", async () => {
        const result = await sitemap.discover({
            url: "https://acme.test",
            fetchImpl: async () => {
                throw new Error("ECONNREFUSED");
            },
        });
        assert.equal(result.success, false);
    });
});

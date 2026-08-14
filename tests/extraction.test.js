// §1.5 main-content extraction. Pure, no network.
//
// The point of this module is that boilerplate is identical across every page
// of a site, so it adds no retrieval signal while diluting the text that does.
// These tests are mostly about what gets thrown away.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const extraction = require("../functions/knowledge/extractionFunctions");

const PAGE = `<!doctype html>
<html>
<head>
  <title>Refund policy — AcmeShip</title>
  <meta property="og:title" content="Refund policy">
  <style>.cta { color: red }</style>
  <script>window.analytics = {};</script>
</head>
<body>
  <div class="cookie-consent">We use cookies. <button>Accept all</button></div>
  <header class="site-header"><nav><a href="/pricing">Pricing</a></nav></header>
  <nav class="navbar"><a href="/docs">Docs</a></nav>
  <main>
    <h1>Refund policy</h1>
    <p>Refunds are issued within 14 days of purchase.</p>
    <h2>Exceptions</h2>
    <ul><li>Digital goods once downloaded</li><li>Gift cards</li></ul>
    <p>Contact support if your case is unusual and we will take a look at it for you.</p>
  </main>
  <aside class="sidebar"><h3>Related</h3><a href="/blog">Blog</a></aside>
  <div class="newsletter">Subscribe for updates</div>
  <footer class="site-footer">Start free trial · © AcmeShip</footer>
</body>
</html>`;

describe("extractMainContent", () => {
    const result = extraction.extractMainContent(PAGE);

    test("keeps the real content", () => {
        assert.ok(result.text.includes("Refunds are issued within 14 days"));
        assert.ok(result.text.includes("Digital goods once downloaded"));
    });

    test("drops the cookie banner", () => {
        assert.equal(result.text.includes("We use cookies"), false);
        assert.equal(result.text.includes("Accept all"), false);
    });

    test("drops nav, header and footer", () => {
        assert.equal(result.text.includes("Pricing"), false);
        assert.equal(result.text.includes("Start free trial"), false);
        assert.equal(result.text.includes("© AcmeShip"), false);
    });

    test("drops the sidebar and newsletter CTA", () => {
        assert.equal(result.text.includes("Subscribe for updates"), false);
        assert.equal(result.text.includes("Related"), false);
    });

    test("drops script and style contents", () => {
        assert.equal(result.text.includes("window.analytics"), false);
        assert.equal(result.text.includes("color: red"), false);
    });

    test("preserves headings as markdown so headingPath survives chunking", () => {
        assert.ok(result.text.includes("# Refund policy"));
        assert.ok(result.text.includes("## Exceptions"));
    });

    test("prefers og:title for the document title", () => {
        assert.equal(result.title, "Refund policy");
    });
});

describe("title extraction", () => {
    test("falls back to h1 when og:title is absent", () => {
        const html = "<html><head><title>Site</title></head><body><h1>Shipping</h1><p>x</p></body></html>";
        assert.equal(extraction.extractMainContent(html).title, "Shipping");
    });

    test("falls back to <title> when there is no h1", () => {
        const html = "<html><head><title>Site name</title></head><body><p>x</p></body></html>";
        assert.equal(extraction.extractMainContent(html).title, "Site name");
    });

    test("returns null when there is nothing to use", () => {
        assert.equal(extraction.extractMainContent("<div>hello</div>").title, null);
    });
});

describe("content container detection", () => {
    test("prefers <article> when present", () => {
        const html = `<body><div>chrome text</div><article>${"Real documentation content. ".repeat(20)}</article></body>`;
        const text = extraction.extractMainContent(html).text;
        assert.ok(text.includes("Real documentation content"));
        assert.equal(text.includes("chrome text"), false);
    });

    test("ignores a content container too small to be the main content", () => {
        // A tiny <main> is usually a layout wrapper, not the article.
        const html = `<body><main>Hi</main><div>${"The actual page body text. ".repeat(30)}</div></body>`;
        const text = extraction.extractMainContent(html).text;
        assert.ok(text.includes("The actual page body text"));
    });

    test("falls back to the whole body for unusual markup", () => {
        const html = "<body><span>Some content with no semantic wrapper at all.</span></body>";
        assert.ok(extraction.extractMainContent(html).text.includes("Some content with no semantic wrapper"));
    });

    test("handles nested divs without ending the match early", () => {
        const html = `<body><main><div><div><p>Deeply nested answer.</p></div></div><p>Trailing paragraph.</p></main></body>`;
        const text = extraction.extractMainContent(html).text;
        assert.ok(text.includes("Deeply nested answer"));
        assert.ok(text.includes("Trailing paragraph"), "the nested close must not terminate <main>");
    });
});

describe("selector override", () => {
    test("a class selector overrides the heuristics", () => {
        const html = `<body><main>Heuristic content that is quite long indeed.</main><div class="docs-body">Override content.</div></body>`;
        const text = extraction.extractMainContent(html, { selectors: { include: ".docs-body" } }).text;
        assert.ok(text.includes("Override content"));
    });

    test("an id selector works too", () => {
        const html = `<body><div id="content">Chosen by id.</div><main>Not this one.</main></body>`;
        const text = extraction.extractMainContent(html, { selectors: { include: "#content" } }).text;
        assert.ok(text.includes("Chosen by id"));
    });

    test("a selector that matches nothing falls back rather than returning empty", () => {
        const html = `<body><main>${"Fallback content here. ".repeat(20)}</main></body>`;
        const text = extraction.extractMainContent(html, { selectors: { include: ".nope" } }).text;
        assert.ok(text.includes("Fallback content here"));
    });
});

describe("toText", () => {
    test("renders list items as markdown bullets", () => {
        assert.ok(extraction.toText("<ul><li>One</li><li>Two</li></ul>").includes("- One"));
    });

    test("decodes entities", () => {
        assert.equal(extraction.toText("<p>Tom &amp; Jerry&#39;s</p>"), "Tom & Jerry's");
    });

    test("collapses runs of blank lines", () => {
        assert.equal(/\n{3,}/.test(extraction.toText("<p>a</p><p></p><p></p><p></p><p>b</p>")), false);
    });

    test("empty and non-string input do not throw", () => {
        assert.equal(extraction.extractMainContent("").text, "");
        assert.equal(extraction.extractMainContent(null).text, "");
    });
});

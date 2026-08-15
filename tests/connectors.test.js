// Unit tests for the migration connectors (§5.5) with an injected fetch.
//
// No network. Each adapter is exercised against a fake that returns the real
// shape of its provider's API, which is the part that is easy to get wrong and
// impossible to notice until a customer's import comes back empty.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const connectorFunctions = require("../functions/knowledge/connectorFunctions");

// Minimal fetch double: a map of url-substring → response body.
function fakeFetch(routes) {
    return async (url) => {
        for (const [needle, body] of Object.entries(routes)) {
            if (String(url).includes(needle)) {
                return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
            }
        }
        return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
    };
}

describe("connector registry", () => {
    test("lists every connector with its config fields", () => {
        const { json } = connectorFunctions.listConnectors();
        assert.equal(json.success, true);
        assert.ok(json.data.length >= 4);

        for (const connector of json.data) {
            assert.ok(connector.key);
            assert.ok(connector.label);
            assert.ok(Array.isArray(connector.configFields));
        }
    });

    test("secret fields are marked so the dashboard masks them", () => {
        const { json } = connectorFunctions.listConnectors();
        const zendesk = json.data.find((connector) => connector.key === "ZENDESK");
        const token = zendesk.configFields.find((field) => field.name === "apiToken");
        assert.equal(token.secret, true);
    });
});

describe("Zendesk adapter", () => {
    const adapter = connectorFunctions.CONNECTORS.ZENDESK;

    test("extracts published articles and skips drafts", () => {
        // Importing a draft would put unpublished policy into the agent's mouth.
        const fetchImpl = fakeFetch({
            "help_center": {
                articles: [
                    { id: 1, title: "Refunds", body: "<p>30 days</p>", html_url: "https://acme.zendesk.com/1", draft: false },
                    { id: 2, title: "Unreleased pricing", body: "<p>secret</p>", draft: true },
                ],
                next_page: null,
            },
        });

        return adapter.list({ config: { subdomain: "acme", email: "a@acme.com", apiToken: "t" }, fetchImpl }).then((articles) => {
            assert.equal(articles.length, 1);
            assert.equal(articles[0].title, "Refunds");
            assert.equal(articles[0].externalId, "1");
        });
    });

    test("accepts a full URL as well as a bare subdomain", async () => {
        // People paste both. Normalising is kinder than a validation error.
        let requestedUrl = null;
        const fetchImpl = async (url) => {
            requestedUrl = url;
            return { ok: true, status: 200, json: async () => ({ articles: [], next_page: null }) };
        };

        await adapter.list({ config: { subdomain: "https://acme.zendesk.com", email: "a@a.com", apiToken: "t" }, fetchImpl });
        assert.match(requestedUrl, /^https:\/\/acme\.zendesk\.com\//);
    });

    test("follows next_page rather than stopping at the first page", async () => {
        let call = 0;
        const fetchImpl = async () => {
            call += 1;
            return {
                ok: true,
                status: 200,
                json: async () =>
                    call === 1
                        ? { articles: [{ id: 1, title: "A", body: "a" }], next_page: "https://acme.zendesk.com/page2" }
                        : { articles: [{ id: 2, title: "B", body: "b" }], next_page: null },
            };
        };

        const articles = await adapter.list({ config: { subdomain: "acme", email: "a@a.com", apiToken: "t" }, fetchImpl });
        assert.equal(articles.length, 2);
    });

    test("a non-ok response surfaces the provider's own status", async () => {
        // "Zendesk returned 401" is actionable; "import failed" is not.
        const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "Couldn't authenticate you" });
        await assert.rejects(
            () => adapter.list({ config: { subdomain: "acme", email: "a@a.com", apiToken: "bad" }, fetchImpl }),
            /Zendesk returned 401/
        );
    });
});

describe("Freshdesk adapter", () => {
    const adapter = connectorFunctions.CONNECTORS.FRESHDESK;

    test("walks categories → folders → articles and keeps only published", () => {
        // Freshdesk has no "all articles" endpoint. status 2 is published.
        const fetchImpl = fakeFetch({
            "solutions/categories/10/folders": [{ id: 100 }],
            "solutions/folders/100/articles": [
                { id: 1000, title: "Shipping", description: "<p>2 days</p>", status: 2 },
                { id: 1001, title: "Draft", description: "<p>x</p>", status: 1 },
            ],
            "solutions/categories": [{ id: 10 }],
        });

        return adapter.list({ config: { domain: "acme.freshdesk.com", apiKey: "k" }, fetchImpl }).then((articles) => {
            assert.equal(articles.length, 1);
            assert.equal(articles[0].title, "Shipping");
        });
    });
});

describe("Notion adapter", () => {
    const adapter = connectorFunctions.CONNECTORS.NOTION;

    test("reads the title from whichever property is of type title", () => {
        // Notion databases name the title column whatever the customer wants.
        const page = { properties: { "Article name": { type: "title", title: [{ plain_text: "Refund policy" }] } } };
        assert.equal(adapter._notionTitle(page), "Refund policy");
    });

    test("falls back to Untitled rather than crashing on a page with no title", () => {
        assert.equal(adapter._notionTitle({ properties: {} }), "Untitled");
    });

    test("converts blocks to markdown, preserving heading levels", () => {
        // Heading preservation is what keeps headingPath meaningful downstream.
        const markdown = adapter._notionBlocksToMarkdown({
            results: [
                { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Billing" }] } },
                { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Refunds" }] } },
                { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Within 30 days." }] } },
                { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "No questions asked" }] } },
                { type: "divider", divider: {} },
            ],
        });

        assert.match(markdown, /^# Billing$/m);
        assert.match(markdown, /^## Refunds$/m);
        assert.match(markdown, /^- No questions asked$/m);
        // A divider has no text and must not produce an empty line item.
        assert.doesNotMatch(markdown, /^\s*-\s*$/m);
    });
});

describe("HTML to text conversion", () => {
    const toText = (html) => connectorFunctions._htmlToText(html);

    test("preserves headings as markdown", () => {
        assert.match(toText("<h1>Billing</h1><h2>Refunds</h2><p>30 days</p>"), /# Billing/);
        assert.match(toText("<h2>Refunds</h2>"), /## Refunds/);
    });

    test("preserves list items", () => {
        assert.match(toText("<ul><li>First</li><li>Second</li></ul>"), /- First/);
    });

    test("strips scripts and styles entirely, including their contents", () => {
        const text = toText("<p>Hi</p><script>alert('x')</script><style>.a{}</style>");
        assert.doesNotMatch(text, /alert/);
        assert.doesNotMatch(text, /\.a\{\}/);
        assert.match(text, /Hi/);
    });

    test("decodes entities without double-decoding", () => {
        // &amp;amp; must become &amp;, not &.
        assert.match(toText("<p>Tom &amp;amp; Jerry</p>"), /Tom &amp; Jerry/);
        assert.match(toText("<p>a &lt; b</p>"), /a < b/);
    });

    test("collapses runs of blank lines", () => {
        assert.doesNotMatch(toText("<p>a</p><p></p><p></p><p>b</p>"), /\n{3,}/);
    });

    test("empty input returns empty rather than throwing", () => {
        assert.equal(toText(null), "");
        assert.equal(toText(""), "");
    });
});

describe("import validation", () => {
    test("rejects an unknown connector and lists the real ones", async () => {
        const result = await connectorFunctions.importFrom({ orgId: "org_x", connector: "INTERCOM", config: {} });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /Available: /);
    });

    test("names the missing required fields rather than failing generically", async () => {
        const result = await connectorFunctions.importFrom({ orgId: "org_x", connector: "ZENDESK", config: { subdomain: "acme" } });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /Agent email/);
        assert.match(result.json.error, /API token/);
    });
});

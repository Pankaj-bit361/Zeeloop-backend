const { SourceType, SourceStatus, IdPrefix } = require("../../config/enums");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §5.5 — migration connectors. Zendesk, Freshdesk, Document360, Notion.
//
// The PRD says design the source type as pluggable now so this is additive
// later, and puts it at P2 with a note: the moment a prospect says "we have 200
// articles in Zendesk", it becomes P0.
//
// So this is the pluggable part, built for real: one adapter interface, four
// adapters that each know one API's shape, and an importer that turns whatever
// they return into SNIPPET sources through the existing ingest path. There is no
// new storage, no new chunker and no new retrieval — an imported article is a
// knowledge source like any other, which is what makes this additive rather
// than a parallel system.
//
// Each adapter is deliberately thin: list articles, return { externalId, title,
// body, url }. Everything downstream is shared.

const MAX_ARTICLES = 500;

const CONNECTORS = {
    ZENDESK: {
        label: "Zendesk Guide",
        // The subdomain, not the full URL — people paste both, so it is
        // normalised rather than validated into a support ticket.
        configFields: [
            { name: "subdomain", label: "Zendesk subdomain", placeholder: "acme", required: true },
            { name: "email", label: "Agent email", placeholder: "you@acme.com", required: true },
            { name: "apiToken", label: "API token", secret: true, required: true },
            { name: "locale", label: "Locale", placeholder: "en-us", required: false },
        ],
        async list({ config: settings, fetchImpl }) {
            const subdomain = String(settings.subdomain || "").replace(/^https?:\/\//, "").split(".")[0];
            const locale = settings.locale || "en-us";
            const auth = Buffer.from(`${settings.email}/token:${settings.apiToken}`).toString("base64");

            const articles = [];
            let url = `https://${subdomain}.zendesk.com/api/v2/help_center/${locale}/articles.json?per_page=100`;

            // Cursor-followed rather than page-numbered: Zendesk deprecated
            // offset pagination on large sets and returns next_page for both.
            while (url && articles.length < MAX_ARTICLES) {
                const response = await fetchImpl(url, { headers: { authorization: `Basic ${auth}` } });
                if (!response.ok) {
                    const body = await response.text();
                    throw new Error(`Zendesk returned ${response.status}: ${body.slice(0, 200)}`);
                }
                const data = await response.json();
                for (const article of data.articles || []) {
                    // Drafts are drafts. Importing them would put unpublished
                    // policy into the agent's mouth.
                    if (article.draft) continue;
                    articles.push({
                        externalId: String(article.id),
                        title: article.title,
                        body: article.body || "",
                        url: article.html_url || null,
                    });
                }
                url = data.next_page || null;
            }
            return articles;
        },
    },

    FRESHDESK: {
        label: "Freshdesk Solutions",
        configFields: [
            { name: "domain", label: "Freshdesk domain", placeholder: "acme.freshdesk.com", required: true },
            { name: "apiKey", label: "API key", secret: true, required: true },
        ],
        async list({ config: settings, fetchImpl }) {
            const domain = String(settings.domain || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
            const auth = Buffer.from(`${settings.apiKey}:X`).toString("base64");

            // Freshdesk has no "all articles" endpoint — articles hang off
            // folders, which hang off categories. Three hops, not one.
            const categoriesResponse = await fetchImpl(`https://${domain}/api/v2/solutions/categories`, {
                headers: { authorization: `Basic ${auth}` },
            });
            if (!categoriesResponse.ok) {
                throw new Error(`Freshdesk returned ${categoriesResponse.status}`);
            }
            const categories = await categoriesResponse.json();

            const articles = [];
            for (const category of categories) {
                if (articles.length >= MAX_ARTICLES) break;
                const foldersResponse = await fetchImpl(`https://${domain}/api/v2/solutions/categories/${category.id}/folders`, {
                    headers: { authorization: `Basic ${auth}` },
                });
                if (!foldersResponse.ok) continue;
                const folders = await foldersResponse.json();

                for (const folder of folders) {
                    if (articles.length >= MAX_ARTICLES) break;
                    const articlesResponse = await fetchImpl(`https://${domain}/api/v2/solutions/folders/${folder.id}/articles`, {
                        headers: { authorization: `Basic ${auth}` },
                    });
                    if (!articlesResponse.ok) continue;
                    for (const article of await articlesResponse.json()) {
                        // status 2 is published; 1 is draft.
                        if (article.status !== 2) continue;
                        articles.push({
                            externalId: String(article.id),
                            title: article.title,
                            body: article.description || "",
                            url: `https://${domain}/support/solutions/articles/${article.id}`,
                        });
                    }
                }
            }
            return articles;
        },
    },

    DOCUMENT360: {
        label: "Document360",
        configFields: [
            { name: "apiKey", label: "API token", secret: true, required: true },
            { name: "projectVersionId", label: "Project version id", required: true },
        ],
        async list({ config: settings, fetchImpl }) {
            const headers = { "api_token": settings.apiKey, "content-type": "application/json" };
            const response = await fetchImpl(
                `https://apihub.document360.io/v2/ProjectVersions/${settings.projectVersionId}/articles`,
                { headers }
            );
            if (!response.ok) throw new Error(`Document360 returned ${response.status}`);

            const data = await response.json();
            return (data.data || [])
                .filter((article) => article.is_published !== false)
                .slice(0, MAX_ARTICLES)
                .map((article) => ({
                    externalId: String(article.id),
                    title: article.title,
                    body: article.content || article.html_content || "",
                    url: article.url || null,
                }));
        },
    },

    NOTION: {
        label: "Notion",
        configFields: [
            { name: "apiKey", label: "Internal integration token", secret: true, required: true },
            { name: "databaseId", label: "Database id", required: true },
        ],
        async list({ config: settings, fetchImpl }) {
            const headers = {
                authorization: `Bearer ${settings.apiKey}`,
                "notion-version": "2022-06-28",
                "content-type": "application/json",
            };

            const articles = [];
            let cursor = undefined;
            do {
                const response = await fetchImpl(`https://api.notion.com/v1/databases/${settings.databaseId}/query`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
                });
                if (!response.ok) throw new Error(`Notion returned ${response.status}`);
                const data = await response.json();

                for (const page of data.results || []) {
                    const title = this._notionTitle(page);
                    // Page properties give the title; the body needs a second
                    // call per page for its blocks. Fetched here rather than
                    // lazily because a title-only import is not knowledge.
                    const blocks = await fetchImpl(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, { headers });
                    const body = blocks.ok ? this._notionBlocksToMarkdown(await blocks.json()) : "";
                    articles.push({ externalId: page.id, title, body, url: page.url || null });
                    if (articles.length >= MAX_ARTICLES) break;
                }

                cursor = data.has_more ? data.next_cursor : undefined;
            } while (cursor && articles.length < MAX_ARTICLES);

            return articles;
        },

        _notionTitle(page) {
            const properties = page.properties || {};
            for (const property of Object.values(properties)) {
                if (property && property.type === "title") {
                    return (property.title || []).map((part) => part.plain_text).join("") || "Untitled";
                }
            }
            return "Untitled";
        },

        _notionBlocksToMarkdown(data) {
            const lines = [];
            for (const block of data.results || []) {
                const content = block[block.type];
                if (!content) continue;
                const text = (content.rich_text || []).map((part) => part.plain_text).join("");
                if (!text) continue;

                if (block.type === "heading_1") lines.push(`# ${text}`);
                else if (block.type === "heading_2") lines.push(`## ${text}`);
                else if (block.type === "heading_3") lines.push(`### ${text}`);
                else if (block.type === "bulleted_list_item") lines.push(`- ${text}`);
                else if (block.type === "numbered_list_item") lines.push(`1. ${text}`);
                else lines.push(text);
            }
            return lines.join("\n\n");
        },
    },
};

class ConnectorFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    listConnectors() {
        console.log("ConnectorFunctions:listConnectors");
        return {
            status: 200,
            json: {
                success: true,
                data: Object.entries(CONNECTORS).map(([key, connector]) => ({
                    key,
                    label: connector.label,
                    configFields: connector.configFields,
                })),
            },
        };
    }

    // Imports into SNIPPET sources, one per article, going through the normal
    // ingest path. Credentials are used for the import and NOT stored: a
    // one-time migration does not justify holding a customer's Zendesk token
    // indefinitely, and re-entering it for a re-import is a fair trade.
    async importFrom({ orgId, connector, config: settings, fetchImpl = fetch }) {
        console.log("ConnectorFunctions:importFrom: orgId:", orgId, "connector:", connector);
        try {
            const adapter = CONNECTORS[connector];
            if (!adapter) {
                return { status: 400, json: { success: false, error: `Unknown connector. Available: ${Object.keys(CONNECTORS).join(", ")}` } };
            }

            const missing = adapter.configFields
                .filter((field) => field.required && !(settings || {})[field.name])
                .map((field) => field.label);
            if (missing.length > 0) {
                return { status: 400, json: { success: false, error: `Missing: ${missing.join(", ")}` } };
            }

            let articles;
            try {
                articles = await adapter.list.call(adapter, { config: settings, fetchImpl });
            } catch (error) {
                // The provider's own message, not a generic one. "Zendesk
                // returned 401" is actionable; "import failed" is not.
                return { status: 400, json: { success: false, error: error.message } };
            }

            if (!articles || articles.length === 0) {
                return { status: 200, json: { success: true, data: { imported: 0, skipped: 0 }, message: "No published articles found." } };
            }

            const knowledgeFunctions = require("./knowledgeFunctions");
            const prefix = `${connector.toLowerCase()}:`;

            // Existing imports are matched by external id in the name, so a
            // re-import updates rather than duplicating. Importing 200 Zendesk
            // articles twice must not produce 400 sources.
            const existing = await KnowledgeSource.find({ orgId, type: SourceType.SNIPPET, name: { $regex: `^\\[${connector}\\]` } })
                .select("sourceId name")
                .lean();
            const byExternalId = new Map(
                existing
                    .map((source) => {
                        const match = source.name.match(/\{#([^}]+)\}$/);
                        return match ? [match[1], source.sourceId] : null;
                    })
                    .filter(Boolean)
            );

            let imported = 0;
            let updated = 0;
            let skipped = 0;

            for (const article of articles) {
                const text = this._htmlToText(article.body);
                if (!text.trim()) {
                    skipped += 1;
                    continue;
                }

                // The external id is carried in the name so a re-import can find
                // it again without a new column on KnowledgeSource — the whole
                // point of routing this through SNIPPET is that it needs no new
                // storage.
                const name = `[${connector}] ${article.title} {#${article.externalId}}`;
                const content = article.url ? `${text}\n\nSource: ${article.url}` : text;

                const existingId = byExternalId.get(article.externalId);
                if (existingId) {
                    const source = await KnowledgeSource.findOne({ orgId, sourceId: existingId });
                    if (source) {
                        source.name = name;
                        source.content = content;
                        source.documentHashes = {};
                        await source.save();
                        await knowledgeFunctions._ingestSource({ source });
                        updated += 1;
                        continue;
                    }
                }

                const source = await KnowledgeSource.create({
                    orgId,
                    sourceId: generalFunctions.generateId(IdPrefix.KNOWLEDGE_SOURCE),
                    type: SourceType.SNIPPET,
                    name,
                    content,
                    status: SourceStatus.PENDING,
                });
                await knowledgeFunctions._ingestSource({ source });
                imported += 1;
            }

            return {
                status: 200,
                json: {
                    success: true,
                    data: { imported, updated, skipped, total: articles.length },
                    note: "Credentials were used for this import and not stored. Re-enter them to import again.",
                },
            };
        } catch (error) {
            console.error("ConnectorFunctions:importFrom: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Help-centre HTML to text, preserving headings so headingPath survives
    // into the chunks. Regex rather than a parser, for the same reason
    // extractionFunctions uses one: this runs on bytes from a customer-named
    // host, and a parser is a much larger attack surface.
    _htmlToText(html) {
        if (!html) return "";
        return String(html)
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
            .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
            .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
            .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
}

module.exports = new ConnectorFunctions();
module.exports.CONNECTORS = CONNECTORS;
module.exports.MAX_ARTICLES = MAX_ARTICLES;

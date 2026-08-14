const generalFunctions = require("../utilFunctions/generalFunctions");

// SITEMAP discovery (§1.1). Declared in the enum since day one and rejected at
// knowledgeFunctions.js:222 until now.
//
// Parsing is done with regexes rather than an XML parser on purpose: sitemaps
// are a fixed, trivial grammar, and the alternative is a dependency that parses
// arbitrary XML — including entity expansion — against a document fetched from
// a URL the customer typed. That is a billion-laughs vector for no benefit.

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const LASTMOD_RE = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i;
const SITEMAPINDEX_RE = /<sitemapindex[\s>]/i;

// Paths worth having in a support agent's knowledge base.
const INCLUDE_HINTS = ["/docs", "/help", "/faq", "/guide", "/support", "/pricing", "/kb", "/knowledge", "/article"];

// Paths that reliably produce noise. A blog post about a funding round is not
// something a support agent should cite, and careers pages actively mislead.
const EXCLUDE_HINTS = [
    "/blog",
    "/careers",
    "/jobs",
    "/legal",
    "/privacy",
    "/terms",
    "/author",
    "/tag/",
    "/category/",
    "/press",
    "/events",
    "/webinar",
];

const EXCLUDE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico", ".css", ".js", ".zip", ".mp4"];

const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
const MAX_INDEX_CHILDREN = 50;

class SitemapFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Returns { success, urls: [{ url, lastmod, included, reason }] }. Nothing
    // is fetched or embedded here — the caller shows this list for review
    // first (§1.1), because a customer who discovers we crawled their careers
    // page discovers it in their bill.
    async discover({ url, maxUrls = 1000, fetchImpl = fetch }) {
        console.log("SitemapFunctions:discover: url:", url);
        try {
            if (!url || !this._isHttpUrl(url)) {
                return { success: false, error: "A valid http(s) sitemap or site URL is required" };
            }

            const candidates = this._sitemapCandidates(url);
            for (const candidate of candidates) {
                const fetched = await this._fetchText({ url: candidate, fetchImpl });
                if (!fetched.success) continue;

                const parsed = await this._parseRecursive({ xml: fetched.text, baseUrl: candidate, fetchImpl, maxUrls });
                if (parsed.entries.length > 0) {
                    return {
                        success: true,
                        source: candidate,
                        urls: this._classify(parsed.entries).slice(0, maxUrls),
                    };
                }
            }

            return {
                success: false,
                error: "No sitemap found. Try a direct sitemap.xml URL, or add pages as individual URL sources.",
            };
        } catch (error) {
            console.error("SitemapFunctions:discover: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, error: "Could not read the sitemap" };
        }
    }

    // Exposed separately so the parsing is testable without a network.
    parse(xml) {
        const entries = [];
        if (typeof xml !== "string" || xml.length === 0) return { isIndex: false, entries };

        const isIndex = SITEMAPINDEX_RE.test(xml);

        // Split on entry boundaries so each <loc> keeps its sibling <lastmod>.
        const blocks = xml.split(/<\/(?:url|sitemap)>/i);
        for (const block of blocks) {
            LOC_RE.lastIndex = 0;
            const locMatch = LOC_RE.exec(block);
            if (!locMatch) continue;
            const lastmodMatch = LASTMOD_RE.exec(block);
            entries.push({
                url: this._decodeEntities(locMatch[1]),
                lastmod: lastmodMatch ? lastmodMatch[1] : null,
            });
        }

        return { isIndex, entries };
    }

    // The include/exclude heuristics, pure and separately testable.
    classifyUrl(url) {
        let path;
        try {
            path = new URL(url).pathname.toLowerCase();
        } catch (error) {
            return { included: false, reason: "unparseable url" };
        }

        if (EXCLUDE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
            return { included: false, reason: "asset" };
        }
        const excluded = EXCLUDE_HINTS.find((hint) => path.includes(hint));
        if (excluded) return { included: false, reason: `excluded path (${excluded})` };

        const included = INCLUDE_HINTS.find((hint) => path.includes(hint));
        if (included) return { included: true, reason: `documentation path (${included})` };

        // Unknown paths default to included but flagged, so the review step
        // shows them without the customer having to hunt for them.
        return { included: true, reason: "uncategorised" };
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _isHttpUrl(value) {
        try {
            const parsed = new URL(value);
            return parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch (error) {
            return false;
        }
    }

    // Accepts either a direct sitemap URL or a bare domain, trying the
    // conventional locations in order.
    _sitemapCandidates(url) {
        if (/\.xml(\?|$)/i.test(url)) return [url];
        const origin = new URL(url).origin;
        return [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/sitemap-index.xml`, url];
    }

    async _fetchText({ url, fetchImpl }) {
        try {
            const response = await fetchImpl(url, {
                redirect: "follow",
                headers: { "user-agent": "ZealoopBot/1.0 (+https://zealoop.com/docs/knowledge)" },
            });
            if (!response.ok) return { success: false };

            const text = await response.text();
            // A sitemap larger than this is either an attack or a site we
            // should not be ingesting inline anyway.
            if (text.length > MAX_SITEMAP_BYTES) return { success: false };
            return { success: true, text };
        } catch (error) {
            return { success: false };
        }
    }

    // A sitemap index points at more sitemaps. One level of recursion covers
    // every real-world case; going deeper is how a crawler gets stuck.
    async _parseRecursive({ xml, fetchImpl, maxUrls }) {
        const parsed = this.parse(xml);
        if (!parsed.isIndex) return { entries: parsed.entries };

        const entries = [];
        for (const child of parsed.entries.slice(0, MAX_INDEX_CHILDREN)) {
            if (entries.length >= maxUrls) break;
            const fetched = await this._fetchText({ url: child.url, fetchImpl });
            if (!fetched.success) continue;
            const childParsed = this.parse(fetched.text);
            entries.push(...childParsed.entries);
        }
        return { entries };
    }

    _classify(entries) {
        const seen = new Set();
        const output = [];
        for (const entry of entries) {
            const normalised = entry.url.split("#")[0];
            if (seen.has(normalised)) continue;
            seen.add(normalised);
            const classification = this.classifyUrl(normalised);
            output.push({ url: normalised, lastmod: entry.lastmod, ...classification });
        }
        return output;
    }

    _decodeEntities(value) {
        return value
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'");
    }
}

module.exports = new SitemapFunctions();

// Main-content extraction (§1.5). Without it every chunk carries "Start free
// trial", the cookie banner and the entire footer nav, and retrieval degrades:
// the boilerplate is identical across every page, so it adds no signal while
// diluting the text that does.
//
// Deliberately dependency-free. A DOM parser would be more precise, but this
// runs against HTML fetched from a URL a customer typed, and the regex approach
// has no parser to exploit. The escape hatch for sites where the heuristics
// fail is the per-source selector override (§1.5), not a heavier parser.

// Removed wholesale, content and all. These elements never contain the answer
// to a support question.
const STRIP_ELEMENTS = ["script", "style", "noscript", "nav", "footer", "header", "aside", "svg", "form", "iframe"];

// Removed when they appear as a class or id. Ordered roughly by how often they
// wrap something that matters — anything ambiguous is left in, because losing
// real documentation is worse than keeping a CTA.
const STRIP_HINTS = [
    "cookie",
    "consent",
    "banner",
    "navbar",
    "nav-",
    "sidebar",
    "site-footer",
    "site-header",
    "breadcrumb",
    "skip-link",
    "announcement",
    "newsletter",
    "subscribe",
    "social-share",
    "related-posts",
    "advertisement",
];

// Tried in order; the first that yields substantial text wins. These are the
// conventional wrappers for documentation content.
const CONTENT_SELECTORS = ["article", "main", '[role="main"]'];

const MIN_MAIN_CONTENT_CHARS = 200;

class ExtractionFunctions {
    // Returns { title, text }. `selectors.include` overrides the heuristics
    // entirely for sites where auto-detection fails.
    extractMainContent(html, { selectors = null } = {}) {
        if (typeof html !== "string" || html.length === 0) return { title: null, text: "" };

        const title = this._extractTitle(html);
        let working = this._stripElements(html);
        working = this._stripByHint(working);

        let candidate = null;
        if (selectors && selectors.include) {
            candidate = this._extractBySelector(working, selectors.include);
        }
        if (!candidate) {
            for (const selector of CONTENT_SELECTORS) {
                const extracted = this._extractByTag(working, selector);
                if (extracted && this.toText(extracted).length >= MIN_MAIN_CONTENT_CHARS) {
                    candidate = extracted;
                    break;
                }
            }
        }

        // Nothing matched — fall back to the whole body rather than returning
        // empty. A page with unusual markup should still be ingestible.
        const text = this.toText(candidate || this._extractByTag(working, "body") || working);
        return { title, text };
    }

    // Heading-aware conversion. h1–h4 become markdown headings so the existing
    // chunker can build headingPath from them, which is what makes a citation
    // point at a section rather than a page.
    toText(html) {
        return String(html)
            .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (match, level, inner) => {
                const heading = inner.replace(/<[^>]+>/g, "").trim();
                return heading ? `\n${"#".repeat(Number(level))} ${heading}\n` : "\n";
            })
            .replace(/<li[^>]*>/gi, "\n- ")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|li|tr|section|article|h[1-6])>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/[ \t]+/g, " ")
            .replace(/ *\n */g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _extractTitle(html) {
        const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
        if (ogTitle) return ogTitle[1].trim();
        const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
        if (h1) {
            const text = h1[1].replace(/<[^>]+>/g, "").trim();
            if (text) return text;
        }
        const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        return title ? title[1].replace(/\s+/g, " ").trim() : null;
    }

    _stripElements(html) {
        let output = html;
        for (const element of STRIP_ELEMENTS) {
            output = output.replace(new RegExp(`<${element}\\b[\\s\\S]*?<\\/${element}>`, "gi"), " ");
            // Self-closing or unclosed variants.
            output = output.replace(new RegExp(`<${element}\\b[^>]*\\/>`, "gi"), " ");
        }
        return output.replace(/<!--[\s\S]*?-->/g, " ");
    }

    // Removes a div/section whose class or id matches a hint, along with its
    // subtree. Nesting is handled by scanning for the matching close tag rather
    // than a regex, which cannot count.
    _stripByHint(html) {
        let output = html;
        for (const hint of STRIP_HINTS) {
            let guard = 0;
            let index = this._findOpeningTagWithHint(output, hint);
            while (index !== -1 && guard++ < 50) {
                const end = this._findMatchingClose(output, index);
                if (end === -1) break;
                output = output.slice(0, index) + " " + output.slice(end);
                index = this._findOpeningTagWithHint(output, hint);
            }
        }
        return output;
    }

    _findOpeningTagWithHint(html, hint) {
        const pattern = new RegExp(`<(div|section|aside|ul|p)\\b[^>]*(?:class|id)=["'][^"']*${hint}[^"']*["']`, "i");
        const match = pattern.exec(html);
        return match ? match.index : -1;
    }

    // Walks forward counting opens and closes of the same tag name so a nested
    // <div> does not end the match early.
    _findMatchingClose(html, startIndex) {
        const tagMatch = /^<([a-z0-9]+)/i.exec(html.slice(startIndex));
        if (!tagMatch) return -1;
        const tag = tagMatch[1].toLowerCase();

        const scanner = new RegExp(`<${tag}\\b|<\\/${tag}>`, "gi");
        scanner.lastIndex = startIndex;
        let depth = 0;
        let match;
        while ((match = scanner.exec(html)) !== null) {
            if (match[0].toLowerCase().startsWith("</")) {
                depth--;
                if (depth === 0) return match.index + match[0].length;
            } else {
                depth++;
            }
        }
        return -1;
    }

    _extractByTag(html, selector) {
        if (selector.startsWith("[")) {
            const attribute = /\[([a-z-]+)=["']([^"']+)["']\]/i.exec(selector);
            if (!attribute) return null;
            const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*${attribute[1]}=["']${attribute[2]}["'][^>]*>`, "i");
            const match = pattern.exec(html);
            if (!match) return null;
            const end = this._findMatchingClose(html, match.index);
            return end === -1 ? null : html.slice(match.index, end);
        }

        const opening = new RegExp(`<${selector}\\b`, "i").exec(html);
        if (!opening) return null;
        const end = this._findMatchingClose(html, opening.index);
        return end === -1 ? null : html.slice(opening.index, end);
    }

    // Supports the small selector vocabulary a customer would realistically
    // paste: a tag, .class, #id.
    _extractBySelector(html, selector) {
        const trimmed = String(selector).trim();
        if (trimmed.startsWith(".")) {
            const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*class=["'][^"']*\\b${trimmed.slice(1)}\\b[^"']*["'][^>]*>`, "i");
            const match = pattern.exec(html);
            if (!match) return null;
            const end = this._findMatchingClose(html, match.index);
            return end === -1 ? null : html.slice(match.index, end);
        }
        if (trimmed.startsWith("#")) {
            const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*id=["']${trimmed.slice(1)}["'][^>]*>`, "i");
            const match = pattern.exec(html);
            if (!match) return null;
            const end = this._findMatchingClose(html, match.index);
            return end === -1 ? null : html.slice(match.index, end);
        }
        return this._extractByTag(html, trimmed);
    }
}

module.exports = new ExtractionFunctions();

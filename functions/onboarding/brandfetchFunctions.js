const config = require("../../config/config");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §1.7 — domain → brand colours and logo.
//
// Returns a proposal, never an applied change. Every field comes back with what
// was found and where it came from, and the dashboard shows a confirmation
// dialog with manual override on each one. Automatic brand import that silently
// repaints someone's widget is a feature people turn off once and never turn
// back on.
//
// Works without an API key. Brandfetch is the good path; the fallback parses the
// site's own HTML for a theme-color meta tag and an apple-touch-icon, which is
// present on a surprising share of real sites and costs nothing.

const FETCH_TIMEOUT_MS = 6000;

class BrandfetchFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async importBrand({ domain, fetchImpl = fetch }) {
        console.log("BrandfetchFunctions:importBrand: domain:", domain);
        try {
            const clean = this._normaliseDomain(domain);
            if (!clean) {
                return { status: 400, json: { success: false, error: "Enter a domain, like acme.com" } };
            }

            if (config.BRANDFETCH_API_KEY) {
                const viaApi = await this._fetchFromBrandfetch({ domain: clean, fetchImpl });
                if (viaApi.success) {
                    return { status: 200, json: { success: true, data: viaApi.brand } };
                }
                console.log("BrandfetchFunctions:importBrand: API lookup failed, falling back to page scrape");
            }

            const viaPage = await this._fetchFromPage({ domain: clean, fetchImpl });
            if (viaPage.success) {
                return { status: 200, json: { success: true, data: viaPage.brand } };
            }

            // Not a 404. Nothing found is a normal outcome, and the wizard
            // should offer manual entry rather than an error state.
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        domain: clean,
                        accentColor: null,
                        backgroundColor: null,
                        logoUrl: null,
                        name: null,
                        source: "none",
                        message: "Nothing found automatically — pick your colours by hand.",
                    },
                },
            };
        } catch (error) {
            console.error("BrandfetchFunctions:importBrand: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _fetchFromBrandfetch({ domain, fetchImpl }) {
        try {
            const response = await fetchImpl(`${config.BRANDFETCH_BASE_URL}/brands/${encodeURIComponent(domain)}`, {
                headers: { Authorization: `Bearer ${config.BRANDFETCH_API_KEY}` },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) return { success: false };

            const data = await response.json();
            const colors = data.colors || [];
            const accent =
                (colors.find((color) => color.type === "accent") || colors.find((color) => color.type === "brand") || colors[0] || {}).hex ||
                null;
            const background = (colors.find((color) => color.type === "background") || {}).hex || null;

            // Prefer an SVG or a large PNG: below 72px the header logo renders
            // blurry and a solid initial circle looks better (§4.4).
            const logos = (data.logos || []).flatMap((logo) => logo.formats || []);
            const svg = logos.find((format) => format.format === "svg");
            const large = logos.filter((format) => (format.width || 0) >= 144).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            const logo = svg || large || logos[0] || null;

            return {
                success: true,
                brand: {
                    domain,
                    name: data.name || null,
                    accentColor: this._normaliseHex(accent),
                    backgroundColor: this._normaliseHex(background),
                    logoUrl: logo ? logo.src : null,
                    logoFormat: logo ? logo.format : null,
                    source: "brandfetch",
                },
            };
        } catch (error) {
            console.log("BrandfetchFunctions:_fetchFromBrandfetch: failed:", error.message);
            return { success: false };
        }
    }

    // No API key, or the API had nothing. Regex over the head rather than an
    // HTML parser — see extractionFunctions for the same reasoning: this runs on
    // customer-supplied URLs and a parser is a much larger attack surface than a
    // handful of anchored patterns.
    async _fetchFromPage({ domain, fetchImpl }) {
        try {
            const response = await fetchImpl(`https://${domain}`, {
                redirect: "follow",
                headers: { "user-agent": "ZealoopBot/1.0 (+https://zealoop.com/docs/knowledge)" },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!response.ok) return { success: false };

            // Only the head is needed, and a homepage can be megabytes.
            const html = (await response.text()).slice(0, 200_000);

            const themeColor = this._firstMatch(html, [
                /<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i,
                /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i,
            ]);

            const logo = this._firstMatch(html, [
                /<link[^>]+rel=["'](?:apple-touch-icon|apple-touch-icon-precomposed)["'][^>]+href=["']([^"']+)["']/i,
                /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
            ]);

            const name = this._firstMatch(html, [
                /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
                /<title[^>]*>([^<]+)<\/title>/i,
            ]);

            const accentColor = this._normaliseHex(themeColor);
            if (!accentColor && !logo) return { success: false };

            return {
                success: true,
                brand: {
                    domain,
                    name: name ? name.split(/[|·—-]/)[0].trim().slice(0, 60) : null,
                    accentColor,
                    backgroundColor: null,
                    logoUrl: logo ? this._absoluteUrl(logo, domain) : null,
                    logoFormat: null,
                    source: "page",
                    // Said plainly: a theme-color meta tag is the browser chrome
                    // colour, which is often but not always the brand colour.
                    message: "Taken from the site's own metadata — check it looks right before applying.",
                },
            };
        } catch (error) {
            console.log("BrandfetchFunctions:_fetchFromPage: failed:", error.message);
            return { success: false };
        }
    }

    _firstMatch(html, patterns) {
        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match && match[1]) return match[1].trim();
        }
        return null;
    }

    _normaliseHex(value) {
        if (!value) return null;
        const match = String(value).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return null;
        const hex = match[1];
        // Expanded, because the theme derivation expects six digits and #f0a
        // would otherwise parse as garbage rather than failing visibly.
        const full = hex.length === 3 ? hex.split("").map((character) => character + character).join("") : hex;
        return `#${full.toUpperCase()}`;
    }

    _absoluteUrl(href, domain) {
        if (/^https?:\/\//i.test(href)) return href;
        if (href.startsWith("//")) return `https:${href}`;
        if (href.startsWith("/")) return `https://${domain}${href}`;
        return `https://${domain}/${href}`;
    }

    _normaliseDomain(domain) {
        const clean = String(domain || "")
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .replace(/^www\./, "")
            .split("/")[0]
            .split("?")[0];
        // Loose on purpose: an over-strict pattern rejects real domains, and the
        // fetch below fails harmlessly on a bad one.
        return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) ? clean : null;
    }
}

module.exports = new BrandfetchFunctions();

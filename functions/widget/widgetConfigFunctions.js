const {
    HomeSectionType,
    HeaderTextMode,
    BackgroundType,
    LauncherSide,
    IdPrefix,
    ConfigObjectType,
} = require("../../config/enums");

/* Validated, not sanitised. These values are interpolated into a CSS
   background declaration inside the frame, so an unchecked string there is a
   style injection — "red;--accent:#000" would escape the property it was
   written into. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/* A background image URL ends up inside a CSS url() in the frame. Quotes,
   parentheses, backslashes and whitespace can all break out of that function
   and into the surrounding declaration, so they are refused outright rather
   than escaped — there is no legitimate image URL that needs them.

   https only: the frame is served over https on customer sites, and an http
   image would be blocked as mixed content anyway. Failing here says so;
   allowing it produces a background that silently never appears. */
const UNSAFE_IN_CSS_URL = /["'()\\\s]/;

function validateImageUrl(value) {
    if (value === "") return { success: true };
    if (typeof value !== "string" || value.length > 2000) {
        return { success: false, error: "backgroundImageUrl must be a URL under 2000 characters" };
    }
    if (UNSAFE_IN_CSS_URL.test(value)) {
        return { success: false, error: "backgroundImageUrl cannot contain quotes, brackets, backslashes or spaces" };
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        return { success: false, error: "backgroundImageUrl must be a valid URL" };
    }
    if (parsed.protocol !== "https:") {
        return { success: false, error: "backgroundImageUrl must start with https://" };
    }
    return { success: true };
}
const POSITIONS = Object.values(LauncherSide).flatMap((side) => [`bottom-${side}`, `top-${side}`]);
// Launcher offsets are bounded: negative pushes it off-screen, and something
// large strands it in the middle of the customer's page.
const MAX_LAUNCHER_SPACING = 200;
const Org = require("../../models/org/org");
const ConfigVersion = require("../../models/config/configVersion");
const generalFunctions = require("../utilFunctions/generalFunctions");
const themeDerivation = require("../utilFunctions/themeDerivation");
const segmentFunctions = require("../config/segmentFunctions");

// §4.1–§4.5 — everything about how the messenger looks and when it appears.
//
// ── Settings precedence (§4.3) ───────────────────────────────────────
//
// Documented here and enforced in exactly one function, because per the PRD this
// generates more support tickets than any other setting. The order, highest
// wins:
//
//   1. zealoopSettings on the page       — the site owner's per-page override
//   2. workspace config                  — what the dashboard says
//   3. system preference                 — prefers-color-scheme, language
//   4. defaults                          — what ships
//
// The important consequence, and the one people trip over: a `hideLauncher: true`
// in the page snippet beats "show launcher" in the dashboard, and always will.
// Someone toggling the dashboard setting and seeing nothing change is looking at
// a page-level override, not a bug.

// §4.1 — the shipped default. Four sections, deliberately. Empty space in a
// messenger is not a bug, and every extra card is one more thing between a
// customer and the thing they came to do.
const DEFAULT_HOME_SECTIONS = [
    { id: "trust", type: HomeSectionType.TRUST_BADGE, enabled: true, order: 0, config: {} },
    { id: "ask", type: HomeSectionType.ASK_QUESTION, enabled: true, order: 1, config: {} },
    { id: "recent", type: HomeSectionType.RECENT_CONVERSATION, enabled: true, order: 2, config: {} },
    { id: "search", type: HomeSectionType.ARTICLE_SEARCH, enabled: true, order: 3, config: { maxResults: 3 } },
];

const MAX_SECTIONS = 8;

// §4.4 — the 8px spacing scale from the side-by-side against Intercom. Served
// to the widget rather than hardcoded in it, so a change here reaches deployed
// embeds without anyone republishing a script.
const SPACING_TOKENS = {
    panelPadding: 24,
    greetingSpaceAbove: 32,
    greetingSpaceBelow: 32,
    cardGap: 12,
    cardPadding: 20,
    cardRadius: 16,
    greetingSize: 30,
    greetingLineHeight: 1.15,
    // The tab bar overlaps the footer without this; "Powered by Zealoop"
    // clipping behind it was on the fix list.
    footerClearance: 56,
    minTapTarget: 44,
    // Below this the header logo renders blurry, so a solid initial circle is
    // used instead — a crisp letter beats a fuzzy logo every time.
    minLogoPx: 72,
};

class WidgetConfigFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async getConfig({ orgId }) {
        console.log("WidgetConfigFunctions:getConfig: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId }).lean();
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        widget: org.widget || {},
                        homeSections: this.resolveHomeSections({ org }),
                        spacing: SPACING_TOKENS,
                        sectionTypes: Object.values(HomeSectionType),
                        headerTextModes: Object.values(HeaderTextMode),
                        // Rendered in the dashboard next to the launcher
                        // settings, so nobody has to find it in the docs.
                        precedence: [
                            "zealoopSettings on the page",
                            "workspace config",
                            "system preference",
                            "defaults",
                        ],
                    },
                },
            };
        } catch (error) {
            console.error("WidgetConfigFunctions:getConfig: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async updateConfig({ orgId, widget, actorEmail }) {
        console.log("WidgetConfigFunctions:updateConfig: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };
            if (!widget) return { status: 400, json: { success: false, error: "widget is required" } };

            if (widget.homeSections !== undefined) {
                const validation = this._validateSections(widget.homeSections);
                if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };
            }
            if (widget.headerTextMode !== undefined && !Object.values(HeaderTextMode).includes(widget.headerTextMode)) {
                return {
                    status: 400,
                    json: { success: false, error: `headerTextMode must be one of: ${Object.values(HeaderTextMode).join(", ")}` },
                };
            }

            if (widget.backgroundType !== undefined && !Object.values(BackgroundType).includes(widget.backgroundType)) {
                return {
                    status: 400,
                    json: { success: false, error: `backgroundType must be one of: ${Object.values(BackgroundType).join(", ")}` },
                };
            }
            for (const field of ["backgroundSolid", "backgroundGradientFrom", "backgroundGradientTo"]) {
                if (widget[field] !== undefined && widget[field] !== "" && !HEX_COLOR.test(widget[field])) {
                    return { status: 400, json: { success: false, error: `${field} must be a #rrggbb colour` } };
                }
            }
            if (widget.backgroundImageUrl !== undefined) {
                const check = validateImageUrl(widget.backgroundImageUrl);
                if (!check.success) return { status: 400, json: { success: false, error: check.error } };
            }
            for (const field of ["launcherSideSpacing", "launcherBottomSpacing"]) {
                if (widget[field] === undefined) continue;
                const value = Number(widget[field]);
                if (!Number.isFinite(value) || value < 0 || value > MAX_LAUNCHER_SPACING) {
                    return {
                        status: 400,
                        json: { success: false, error: `${field} must be between 0 and ${MAX_LAUNCHER_SPACING}` },
                    };
                }
            }
            if (widget.position !== undefined && !POSITIONS.includes(widget.position)) {
                return { status: 400, json: { success: false, error: `position must be one of: ${POSITIONS.join(", ")}` } };
            }

            await this._snapshot({ org, actorEmail });

            const scalarFields = [
                "position",
                "theme",
                "accentColor",
                "background",
                "headerTextMode",
                "backgroundType",
                "backgroundSolid",
                "backgroundGradientFrom",
                "backgroundGradientTo",
                "backgroundImageUrl",
                "backgroundFade",
                "launcherSideSpacing",
                "launcherBottomSpacing",
            ];
            for (const field of scalarFields) {
                if (widget[field] !== undefined) org.widget[field] = widget[field];
            }
            if (widget.homeSections !== undefined) org.widget.homeSections = widget.homeSections;
            if (widget.welcome !== undefined) {
                if (widget.welcome.anonymous !== undefined) org.widget.welcome.anonymous = widget.welcome.anonymous;
                if (widget.welcome.identified !== undefined) org.widget.welcome.identified = widget.welcome.identified;
            }
            if (widget.launcher !== undefined) {
                for (const field of ["showToVisitors", "showToIdentified", "urlInclude", "urlExclude", "segmentIds"]) {
                    if (widget.launcher[field] !== undefined) org.widget.launcher[field] = widget.launcher[field];
                }
            }

            // Re-derive theme tokens whenever a colour input changes. The widget
            // never does colour maths — it reads pre-computed tokens — so a
            // colour saved without re-derivation shows the old palette.
            if (widget.accentColor !== undefined && org.widget.accentColor) {
                org.widget.themeTokens = themeDerivation.deriveThemes(org.widget.accentColor);
            }

            org.widget.configVersion = (org.widget.configVersion || 1) + 1;
            await org.save();

            return {
                status: 200,
                json: {
                    success: true,
                    data: { widget: org.widget, homeSections: this.resolveHomeSections({ org }) },
                },
            };
        } catch (error) {
            console.error("WidgetConfigFunctions:updateConfig: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Null homeSections means "never customised", which is different from an
    // empty array meaning "the customer removed every section". Collapsing the
    // two would resurrect the defaults on a workspace that deliberately cleared
    // them.
    resolveHomeSections({ org }) {
        const stored = org.widget && org.widget.homeSections;
        if (stored === null || stored === undefined) return DEFAULT_HOME_SECTIONS;
        if (!Array.isArray(stored)) return DEFAULT_HOME_SECTIONS;
        return [...stored].sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    // §4.2 — the greeting, with `{first_name}` substituted here rather than in
    // the widget. Two reasons: the widget would need the customer's name in
    // plaintext to do it, and a template engine in the embed is 3KB nobody
    // needs on a first paint.
    renderWelcome({ org, endUser, identityVerified }) {
        const welcome = (org.widget && org.widget.welcome) || {};
        const template = identityVerified && welcome.identified ? welcome.identified : welcome.anonymous;

        if (!template) {
            return (org.agent && org.agent.greeting) || "Hi! How can I help?";
        }

        const firstName = this._firstName(endUser);
        // No name and a template that wants one would render "Hi , how can we
        // help" — so the whole clause collapses rather than leaving the comma
        // stranded.
        if (!firstName) {
            return template
                .replace(/,?\s*\{first_name\}/g, "")
                .replace(/\s{2,}/g, " ")
                .trim();
        }
        return template.replace(/\{first_name\}/g, firstName);
    }

    // §4.3 — the ONE place launcher visibility is decided. Returns the reason as
    // well as the answer, because "why is my launcher hidden" is the support
    // ticket this feature generates.
    async shouldShowLauncher({ org, pageUrl, identityVerified, endUser, pageSettings }) {
        console.log("WidgetConfigFunctions:shouldShowLauncher: orgId:", org.orgId);
        try {
            // Level 1: the page wins, unconditionally. See the precedence note.
            if (pageSettings && pageSettings.hideLauncher === true) {
                return { show: false, reason: "hideLauncher is set in zealoopSettings on the page", level: "page" };
            }
            if (pageSettings && pageSettings.customLauncherSelector) {
                return {
                    show: false,
                    reason: "A customLauncherSelector is set — the site provides its own launcher element",
                    level: "page",
                    customLauncherSelector: pageSettings.customLauncherSelector,
                };
            }

            const launcher = (org.widget && org.widget.launcher) || {};

            // Level 2: workspace config.
            if (identityVerified && launcher.showToIdentified === false) {
                return { show: false, reason: "Hidden for identified users in workspace settings", level: "workspace" };
            }
            if (!identityVerified && launcher.showToVisitors === false) {
                return { show: false, reason: "Hidden for anonymous visitors in workspace settings", level: "workspace" };
            }

            if (pageUrl) {
                const include = launcher.urlInclude || [];
                const exclude = launcher.urlExclude || [];
                // Exclude is checked first: someone who has written both means
                // "everywhere in the docs EXCEPT the changelog", and evaluating
                // include first would show it there.
                if (exclude.some((pattern) => this._matchesUrl(pageUrl, pattern))) {
                    return { show: false, reason: "This URL matches an exclude pattern", level: "workspace" };
                }
                // An empty include list means everywhere, not nowhere.
                if (include.length > 0 && !include.some((pattern) => this._matchesUrl(pageUrl, pattern))) {
                    return { show: false, reason: "This URL does not match any include pattern", level: "workspace" };
                }
            }

            if ((launcher.segmentIds || []).length > 0) {
                const membership = await segmentFunctions.resolveMembership({
                    orgId: org.orgId,
                    context: {
                        identityVerified,
                        email: endUser ? endUser.email : null,
                        conversationCount: endUser ? endUser.conversationCount || 0 : 0,
                        firstSeenAt: endUser ? endUser.firstSeenAt : null,
                        planId: (org.credits && org.credits.plan) || null,
                    },
                });
                const inSegment = launcher.segmentIds.some((segmentId) => membership.segmentIds.includes(segmentId));
                if (!inSegment) {
                    return { show: false, reason: "This visitor is not in any of the selected segments", level: "workspace" };
                }
            }

            return { show: true, reason: "No rule hides it", level: "default" };
        } catch (error) {
            console.error("WidgetConfigFunctions:shouldShowLauncher: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Fail visible. A rules-engine error that hid the support widget
            // would be invisible to us and infuriating for the customer.
            return { show: true, reason: "Visibility rules could not be evaluated; showing by default", level: "default" };
        }
    }

    // §4.5 — header text colour. AUTO computes from luminance, which is correct
    // for a solid background and wrong for a gradient: the two stops can straddle
    // the threshold, so no single computed value is readable across both. Those
    // need a human to pick.
    resolveHeaderTextColor({ org }) {
        const widget = org.widget || {};
        if (widget.headerTextMode === HeaderTextMode.BLACK) return { color: "#000000", source: "manual" };
        if (widget.headerTextMode === HeaderTextMode.WHITE) return { color: "#FFFFFF", source: "manual" };

        /* A single luminance value can only describe a solid fill. Everything
           else — the five presets and any custom gradient — has stops that can
           straddle the threshold, so no computed value is readable across the
           whole header.

           This used to read `widget.background !== "solid"`, comparing against
           a value `background` never holds: it stores a preset name. The answer
           was right by luck because all five presets are gradients, but the
           luminance branch below was unreachable, and would have started
           misfiring the moment a solid option existed. */
        const isGradient = widget.backgroundType !== BackgroundType.SOLID;
        if (isGradient) {
            // An image has no luminance we can read at all, and telling someone
            // "this background is a gradient" when they pointed at a photo is
            // the kind of message that makes people distrust the whole screen.
            const what = widget.backgroundType === BackgroundType.IMAGE ? "an image" : "a gradient";
            return {
                color: "#FFFFFF",
                source: "gradient-default",
                // Surfaced rather than silently guessed, so the dashboard can
                // prompt for a choice instead of leaving unreadable text up.
                warning: `This background is ${what} — pick Black or White manually if the header text is hard to read.`,
            };
        }

        // The BACKGROUND's luminance, not the accent's. Header text sits on the
        // hero; the accent is what buttons and bubbles are painted with, so
        // reading it here answered a question nobody asked.
        const luminance = this._luminance(widget.backgroundSolid || widget.accentColor || "#4F46E5");
        return { color: luminance > 0.55 ? "#000000" : "#FFFFFF", source: "computed", luminance };
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _validateSections(sections) {
        if (!Array.isArray(sections)) return { success: false, error: "homeSections must be an array" };
        if (sections.length > MAX_SECTIONS) {
            return { success: false, error: `At most ${MAX_SECTIONS} home sections` };
        }
        const ids = new Set();
        for (const section of sections) {
            if (!section || !section.id) return { success: false, error: "Every section needs an id" };
            if (ids.has(section.id)) return { success: false, error: `Duplicate section id: ${section.id}` };
            ids.add(section.id);
            // Unknown types are accepted on write and skipped by the widget on
            // read (§4.1). Rejecting them here would stop a newer dashboard from
            // configuring a section an older backend has not heard of.
            if (!section.type) return { success: false, error: "Every section needs a type" };
        }
        return { success: true };
    }

    // Glob-ish matching: * is the wildcard, everything else literal. Not full
    // regex — a customer pasting a URL with a ? or a . into a regex field gets
    // silently wrong matching, and debugging that from a support ticket is
    // miserable.
    _matchesUrl(url, pattern) {
        if (!pattern) return false;
        const escaped = String(pattern)
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\\\*/g, ".*");
        try {
            return new RegExp(`^${escaped}$`, "i").test(url) || new RegExp(escaped, "i").test(url);
        } catch (error) {
            return false;
        }
    }

    _firstName(endUser) {
        if (!endUser) return null;
        if (endUser.name && endUser.name.trim()) return endUser.name.trim().split(/\s+/)[0];
        return null;
    }

    // Relative luminance, WCAG formula. Same maths as themeDerivation uses; kept
    // here rather than imported because that module's version is private to its
    // token pipeline.
    _luminance(hex) {
        const clean = String(hex).replace("#", "");
        if (clean.length !== 6) return 0;
        const channels = [0, 2, 4].map((offset) => {
            const value = parseInt(clean.slice(offset, offset + 2), 16) / 255;
            return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    async _snapshot({ org, actorEmail }) {
        try {
            const previous = await ConfigVersion.countDocuments({
                orgId: org.orgId,
                objectType: ConfigObjectType.WIDGET_CONFIG,
                objectId: org.orgId,
            });
            await ConfigVersion.create({
                orgId: org.orgId,
                versionId: generalFunctions.generateId(IdPrefix.CONFIG_VERSION),
                objectType: ConfigObjectType.WIDGET_CONFIG,
                objectId: org.orgId,
                version: previous + 1,
                snapshot: org.widget,
                changedBy: actorEmail || null,
                note: "edited",
            });
            return { success: true };
        } catch (error) {
            console.error("WidgetConfigFunctions:_snapshot: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }
}

module.exports = new WidgetConfigFunctions();
module.exports.DEFAULT_HOME_SECTIONS = DEFAULT_HOME_SECTIONS;
// Exported so the URL guard can be tested without a database. It is a pure
// function and the thing it prevents — a string escaping a CSS url() — is
// worth asserting directly rather than through an HTTP round trip.
module.exports.validateImageUrl = validateImageUrl;
module.exports.SPACING_TOKENS = SPACING_TOKENS;
module.exports.MAX_SECTIONS = MAX_SECTIONS;

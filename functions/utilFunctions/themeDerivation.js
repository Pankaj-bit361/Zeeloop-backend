/**
 * Zealoop theme derivation — the single source of truth for turning a raw
 * brand hex into accessible widget tokens. Runs on the SERVER (settings save,
 * widget bootstrap); the widget itself never does color math.
 *
 * Method (per spec):
 *   brand hex → OKLCH (perceptually uniform; NOT HSL) → clamp chroma → build a
 *   lightness scale with hue/chroma fixed → accent = first step that reaches
 *   4.5:1 WCAG contrast against the theme surface → accent text from luminance.
 *
 * Zero dependencies — OKLab/OKLCH conversion is hand-rolled (Björn Ottosson's
 * published matrices) so this stays requireable everywhere.
 *
 * KEEP IN SYNC with zealoop/src/lib/derive-theme.ts (dashboard live preview).
 */

const STOPS = [0.98, 0.95, 0.9, 0.82, 0.72, 0.62, 0.52, 0.42, 0.32, 0.22];
const CHROMA_MAX = 0.16;

const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// Warm stone neutrals — fixed per theme; only the accent is derived.
const NEUTRALS = {
    light: {
        surface: "#fafaf9",
        surfaceRaised: "#ffffff",
        surfaceSunken: "#f0efed",
        border: "#e7e5e4",
        text: "#0c0a09",
        textMuted: "#78716c",
        shadow: "0 1px 3px rgba(0, 0, 0, 0.06), 0 4px 12px rgba(0, 0, 0, 0.04)",
    },
    dark: {
        surface: "#161412",
        surfaceRaised: "#211f1d",
        surfaceSunken: "#1b1917",
        border: "#35322f",
        text: "#f5f5f0",
        textMuted: "#a8a29e",
        shadow: "0 3px 14px rgba(0, 0, 0, 0.3)",
    },
};

// Default (no brand color): ink in light, bone in dark — mirrors the launcher.
const DEFAULT_ACCENT = {
    light: { accent: "#0c0a09", accentHover: "#292524", accentText: "#ffffff" },
    dark: { accent: "#f5f5f0", accentHover: "#e7e5e0", accentText: "#161412" },
};

/* ── color math ──────────────────────────────────────────────── */

function hexToRgb(hex) {
    const match = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!match) return null;
    const n = parseInt(match[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

function rgbToHex([r, g, b]) {
    const to = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    return `#${to(r)}${to(g)}${to(b)}`;
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklch(rgb) {
    const [r, g, b] = rgb.map(srgbToLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { l: L, c: Math.sqrt(a * a + bb * bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

function oklchToRgbRaw({ l, c, h }) {
    const rad = (h * Math.PI) / 180;
    const a = c * Math.cos(rad);
    const b = c * Math.sin(rad);
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
        -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
        -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_,
    ].map(linearToSrgb);
}

// Out-of-gamut colors get their chroma walked down until they fit sRGB —
// hue and lightness hold, which is the whole point of OKLCH.
function oklchToHex(oklch) {
    let { l, c, h } = oklch;
    let rgb = oklchToRgbRaw({ l, c, h });
    const inGamut = (v) => v.every((x) => x >= -0.0001 && x <= 1.0001);
    if (!inGamut(rgb)) {
        let lo = 0, hi = c;
        for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) / 2;
            if (inGamut(oklchToRgbRaw({ l, c: mid, h }))) lo = mid;
            else hi = mid;
        }
        rgb = oklchToRgbRaw({ l, c: lo, h });
    }
    return rgbToHex(rgb);
}

function relativeLuminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    const [r, g, b] = rgb.map(srgbToLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
    const la = relativeLuminance(hexA);
    const lb = relativeLuminance(hexB);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ── derivation ──────────────────────────────────────────────── */

/**
 * deriveTheme(brandHex, mode) → the full token set for one theme.
 * mode: "light" | "dark". Invalid/missing hex falls back to the ink default.
 */
function deriveTheme(brandHex, mode) {
    const theme = mode === "dark" ? "dark" : "light";
    const neutrals = NEUTRALS[theme];
    const base = {
        ...neutrals,
        radius: "12px",
        font: FONT_STACK,
    };

    const rgb = brandHex ? hexToRgb(brandHex) : null;
    if (!rgb) {
        return { ...base, ...DEFAULT_ACCENT[theme], adjusted: false };
    }

    const { c, h } = rgbToOklch(rgb);
    const chroma = Math.min(c, CHROMA_MAX);
    const scale = STOPS.map((l) => oklchToHex({ l, c: chroma, h }));

    // Light surface: scan light→dark; dark surface: scan dark→light. Either
    // way: the first step that reaches 4.5:1 — closest to the brand that reads.
    const ordered = theme === "light" ? scale : [...scale].reverse();
    let index = ordered.findIndex((step) => contrastRatio(step, neutrals.surface) >= 4.5);
    if (index === -1) index = ordered.length - 1;
    const accent = ordered[index];
    const accentHover = ordered[Math.min(index + 1, ordered.length - 1)];
    // Not the naive luminance>0.5 rule — around mid-tones it picks a text color
    // near 3.5:1. Take whichever pole actually contrasts more; given the accent
    // already cleared 4.5:1 against a near-extreme surface, the winner always
    // clears 4.5:1 too.
    const accentText =
        contrastRatio("#0c0a09", accent) >= contrastRatio("#ffffff", accent) ? "#0c0a09" : "#ffffff";

    return {
        ...base,
        accent,
        accentHover,
        accentText,
        // true when the raw brand hex itself would have failed on this surface
        adjusted: contrastRatio(brandHex.toLowerCase(), neutrals.surface) < 4.5 || c > CHROMA_MAX,
    };
}

/** Both themes from one brand input — what gets stored on the workspace. */
function deriveThemes(brandHex) {
    return { light: deriveTheme(brandHex, "light"), dark: deriveTheme(brandHex, "dark") };
}

module.exports = { deriveTheme, deriveThemes, contrastRatio, relativeLuminance, STOPS, CHROMA_MAX };

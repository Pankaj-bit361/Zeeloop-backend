"use strict";
// The look of every lifecycle email Zealoop sends its customers — the same
// editorial language as the dashboard: a warm off-white page, a white card
// under a thin teal rule, an EB Garamond headline, an ink pill button, and the
// wordmark with its teal dot.
//
// Email clients are the constraint, not the web: tables and inline styles
// only, padding on the button's cell (Outlook ignores it on links), no images
// to block, system fonts behind the brand ones, and one small <style> block
// that only tightens spacing on phones. Colour scheme is declared light so
// dark-mode clients that respect it leave the design alone.
//
// Copy lives in templates/; this file only knows how to dress it.
// Placeholders like {{firstName | "there"}} are filled by Volanea at send time.

const APP = "https://app.zealoop.com/app";
const SITE = "https://www.zealoop.com";
// Where replies and questions go. Lifecycle mail is sent from this address too.
const SUPPORT = "hello@zealoop.com";

// Postal address for marketing footers (CAN-SPAM and similar). Set it once the
// legal entity is final, then sync.
const COMPANY_ADDRESS = "";

const C = {
    canvas: "#f6f5f1",
    card: "#ffffff",
    ink: "#1a1a17",
    inkStrong: "#262521",
    body: "#56534c",
    muted: "#7b776f",
    soft: "#aaa69c",
    hairline: "#e8e6df",
    hairlineSoft: "#f2f1ec",
    code: "#1c1b18",
    codeText: "#e8e6df",
    codeDim: "#9c978c",
    teal: "#0f766e",
    tealSoft: "#5eb5aa",
    good: "#15803d",
    goodBg: "#eefaf2",
    warn: "#a16207",
    warnBg: "#fdf8e8",
    bad: "#b42318",
    badBg: "#fdf1ef",
};

// The pale wash behind a hero or a tile, and its deeper accent.
const TINT = { teal: "#ecf5f3", sand: "#f8f4ea", sage: "#f0f5ee", clay: "#fbf1eb", sky: "#eef3f8", stone: "#f4f3ef" };
const DEEP = { teal: C.teal, sand: "#d8c7a0", sage: "#9fbf99", clay: "#dfa98f", sky: "#9fbad6", stone: "#d8d4ca" };

const DISPLAY = "'EB Garamond','Iowan Old Style',Georgia,'Times New Roman',serif";
const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono','SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

const table = (inner, style = "", attrs = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${attrs} style="border-collapse:separate;${style}">${inner}</table>`;

/* ── text ─────────────────────────────────────────────────────────── */

const p = (html) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.65;color:${C.body};">${html}</p>`;
const lead = (html) => `<p style="margin:0 0 18px;font-family:${SANS};font-size:16.5px;line-height:1.6;color:${C.inkStrong};">${html}</p>`;
const b = (html) => `<strong style="color:${C.ink};font-weight:600;">${html}</strong>`;
const a = (label, href) => `<a href="${href}" style="color:${C.ink};text-decoration:underline;text-decoration-color:${C.tealSoft};text-underline-offset:3px;">${label}</a>`;
const code = (text) => `<code style="font-family:${MONO};font-size:13px;background:${C.hairlineSoft};border-radius:5px;padding:2px 6px;color:${C.inkStrong};">${text}</code>`;
const h2 = (text) => `<p style="margin:26px 0 10px;font-family:${SANS};font-size:12px;line-height:1.4;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${text}</p>`;
const small = (html) => `<p style="margin:16px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted};">${html}</p>`;
const rule = () => table(`<tr><td height="1" style="height:1px;line-height:1px;font-size:0;background:${C.hairline};">&nbsp;</td></tr>`, "margin:26px 0 24px;");

// A visitor's words, set apart like a quote in the inbox.
const quote = (html, who = "Visitor") =>
    table(
        `<tr><td width="3" style="width:3px;background:${C.teal};border-radius:3px;font-size:0;">&nbsp;</td><td style="padding:14px 18px;">` +
            `<p style="margin:0 0 6px;font-family:${SANS};font-size:11.5px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};">${who}</p>` +
            `<p style="margin:0;font-family:${DISPLAY};font-size:19px;line-height:1.45;color:${C.ink};">&ldquo;${html}&rdquo;</p></td></tr>`,
        `margin:6px 0 20px;background:${TINT.teal};border-radius:12px;`,
    );

/* ── actions ──────────────────────────────────────────────────────── */

const button = (label, href) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 6px;"><tr>` +
    `<td align="center" bgcolor="${C.inkStrong}" style="background:${C.inkStrong};border-radius:999px;padding:14px 28px;">` +
    `<a href="${href}" style="display:inline-block;font-family:${SANS};font-size:15px;line-height:1;font-weight:600;color:#ffffff;text-decoration:none;white-space:nowrap;">${label}&nbsp;&nbsp;&rarr;</a>` +
    `</td></tr></table>`;

// The pill and a quieter second action. Each is its own inline table, so on a
// narrow screen the second wraps under the first instead of squeezing both.
const buttons = (primary, secondary) =>
    `<div style="margin:10px 0 6px;font-size:0;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:top;margin:0 10px 10px 0;"><tr>` +
    `<td align="center" bgcolor="${C.inkStrong}" style="background:${C.inkStrong};border-radius:999px;padding:14px 26px;">` +
    `<a href="${primary.href}" style="display:inline-block;font-family:${SANS};font-size:15px;line-height:1;font-weight:600;color:#ffffff;text-decoration:none;white-space:nowrap;">${primary.label}</a></td></tr></table>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:top;margin:0 0 10px;"><tr>` +
    `<td align="center" style="border:1px solid ${C.hairline};border-radius:999px;padding:13px 22px;">` +
    `<a href="${secondary.href}" style="display:inline-block;font-family:${SANS};font-size:15px;line-height:1;font-weight:500;color:${C.inkStrong};text-decoration:none;white-space:nowrap;">${secondary.label}</a></td></tr></table>` +
    `</div>`;

/* ── blocks ───────────────────────────────────────────────────────── */

const steps = (items) =>
    table(
        items
            .map(
                (s, i) =>
                    `<tr><td valign="top" width="40" style="width:40px;padding:0 0 18px;">` +
                    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="28" height="28" style="width:28px;height:28px;border-radius:999px;background:${C.ink};font-family:${SANS};font-size:13px;font-weight:600;color:#ffffff;">${i + 1}</td></tr></table>` +
                    `</td><td valign="top" style="padding:3px 0 18px;">` +
                    `<p style="margin:0 0 3px;font-family:${SANS};font-size:15px;line-height:1.45;font-weight:600;color:${C.ink};">${s.title}</p>` +
                    `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.muted};">${s.body}</p>` +
                    `</td></tr>`,
            )
            .join(""),
        "margin:6px 0 8px;",
    );

const points = (items, tint = "teal") =>
    table(
        items
            .map(
                (item) =>
                    `<tr><td valign="top" width="22" style="width:22px;padding:8px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="8" height="8" style="width:8px;height:8px;border-radius:999px;background:${DEEP[tint]};font-size:0;line-height:0;">&nbsp;</td></tr></table></td>` +
                    `<td valign="top" style="padding:0 0 10px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.body};">${item}</td></tr>`,
            )
            .join(""),
        "margin:2px 0 14px;",
    );

const checklist = (items) =>
    table(
        items
            .map(
                (item) =>
                    `<tr><td valign="middle" width="34" style="width:34px;padding:7px 0;">` +
                    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="22" height="22" style="width:22px;height:22px;border-radius:999px;${item.done ? `background:${C.teal};color:#ffffff;` : `border:1.5px solid ${C.hairline};color:${C.soft};`}font-family:${SANS};font-size:12px;font-weight:700;line-height:1;">${item.done ? "&#10003;" : "&nbsp;"}</td></tr></table>` +
                    `</td><td valign="middle" style="padding:7px 0;font-family:${SANS};font-size:15px;line-height:1.45;color:${item.done ? C.muted : C.ink};${item.done ? `text-decoration:line-through;text-decoration-color:${C.soft};` : "font-weight:500;"}">${item.label}</td></tr>`,
            )
            .join(""),
        `margin:6px 0 18px;padding:10px 18px;background:${TINT.stone};border-radius:14px;`,
    );

// Side-by-side figures. Values are placeholders the backend fills, already formatted.
const stats = (items, tint = "stone") => {
    const width = Math.floor(100 / items.length);
    return table(
        `<tr>${items
            .map(
                (s, i) =>
                    `${i ? `<td width="8" style="width:8px;font-size:0;">&nbsp;</td>` : ""}<td valign="top" align="left" width="${width}%" style="width:${width}%;padding:16px 16px 14px;background:${TINT[tint]};border-radius:14px;">` +
                    `<p style="margin:0;font-family:${DISPLAY};font-size:28px;line-height:1.1;color:${C.ink};letter-spacing:-0.01em;">${s.value}</p>` +
                    `<p style="margin:6px 0 0;font-family:${SANS};font-size:12px;line-height:1.35;color:${C.muted};">${s.label}</p></td>`,
            )
            .join("")}</tr>`,
        "margin:4px 0 20px;",
    );
};

const details = (rows) =>
    table(
        rows
            .map(
                ([k, v], i) =>
                    `<tr><td valign="top" style="padding:11px 0;${i ? `border-top:1px solid ${C.hairlineSoft};` : ""}font-family:${SANS};font-size:13.5px;color:${C.muted};width:40%;">${k}</td>` +
                    `<td valign="top" align="right" style="padding:11px 0;${i ? `border-top:1px solid ${C.hairlineSoft};` : ""}font-family:${SANS};font-size:14px;font-weight:500;color:${C.ink};">${v}</td></tr>`,
            )
            .join(""),
        `margin:4px 0 20px;padding:4px 18px;border:1px solid ${C.hairline};border-radius:14px;`,
    );

// A dark code card: the install snippet, an MCP command. Lines are pre-escaped HTML.
const codeBlock = (label, lines) =>
    table(
        `<tr><td style="padding:12px 18px 0;font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.codeDim};">${label}</td></tr>` +
            `<tr><td style="padding:10px 18px 16px;font-family:${MONO};font-size:13px;line-height:1.7;color:${C.codeText};white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;">${lines.join("<br>")}</td></tr>`,
        `margin:6px 0 20px;background:${C.code};border-radius:14px;`,
    );

const tok = {
    key: (s) => `<span style="color:#9fbad6;">${s}</span>`,
    str: (s) => `<span style="color:#8fd1c6;">${s}</span>`,
    dim: (s) => `<span style="color:${C.codeDim};">${s}</span>`,
    hi: (s) => `<span style="color:#dfa98f;">${s}</span>`,
};

const callout = (tone, title, body) => {
    const [bg, fg, bar] =
        tone === "good" ? [C.goodBg, C.good, C.good] : tone === "warn" ? [C.warnBg, C.warn, "#e0b23a"] : tone === "bad" ? [C.badBg, C.bad, C.bad] : [TINT.teal, C.inkStrong, C.teal];
    return table(
        `<tr><td width="3" style="width:3px;background:${bar};border-radius:3px;font-size:0;">&nbsp;</td><td style="padding:14px 18px;">` +
            `<p style="margin:0 0 4px;font-family:${SANS};font-size:14px;line-height:1.45;font-weight:600;color:${fg};">${title}</p>` +
            `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.body};">${body}</p></td></tr>`,
        `margin:6px 0 20px;background:${bg};border-radius:12px;`,
    );
};

const tiles = (items) => {
    const cell = (t) =>
        `<td valign="top" class="tile" width="50%" style="width:50%;padding:16px 16px 14px;background:${TINT[t.tint]};border-radius:14px;">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="22" height="4" style="width:22px;height:4px;border-radius:4px;background:${DEEP[t.tint]};font-size:0;line-height:0;">&nbsp;</td></tr></table>` +
        `<p style="margin:12px 0 4px;font-family:${SANS};font-size:15px;line-height:1.4;font-weight:600;color:${C.ink};">${t.href ? `<a href="${t.href}" style="color:${C.ink};text-decoration:none;">${t.title}&nbsp;&rarr;</a>` : t.title}</p>` +
        `<p style="margin:0;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.muted};">${t.body}</p></td>`;
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
        const pair = items.slice(i, i + 2);
        rows.push(
            `<tr>${cell(pair[0])}<td width="10" class="tile-gap" style="width:10px;font-size:0;">&nbsp;</td>${pair[1] ? cell(pair[1]) : `<td width="50%" style="width:50%;">&nbsp;</td>`}</tr>` +
                (i + 2 < items.length ? `<tr><td colspan="3" height="10" style="height:10px;font-size:0;line-height:0;">&nbsp;</td></tr>` : ""),
        );
    }
    return table(rows.join(""), "margin:6px 0 20px;");
};

// A miniature of a chat turn: what was asked and how the agent answered.
const chat = (question, answer, agent = "Zea") =>
    table(
        `<tr><td style="padding:16px 16px 6px;" align="right"><span style="display:inline-block;max-width:80%;padding:10px 14px;border-radius:16px 16px 4px 16px;background:${C.ink};font-family:${SANS};font-size:14px;line-height:1.5;color:#ffffff;text-align:left;">${question}</span></td></tr>` +
            `<tr><td style="padding:6px 16px 16px;"><p style="margin:0 0 4px;font-family:${SANS};font-size:11.5px;font-weight:600;color:${C.teal};">${agent}</p><span style="display:inline-block;max-width:85%;padding:10px 14px;border-radius:16px 16px 16px 4px;background:${C.hairlineSoft};font-family:${SANS};font-size:14px;line-height:1.5;color:${C.inkStrong};">${answer}</span></td></tr>`,
        `margin:6px 0 20px;background:#ffffff;border:1px solid ${C.hairline};border-radius:16px;`,
    );

const meter = (caption, percentWidth, tone = "ink") => {
    const fill = tone === "bad" ? C.bad : tone === "warn" ? "#e0b23a" : C.teal;
    return (
        `<p style="margin:0 0 8px;font-family:${SANS};font-size:13.5px;color:${C.muted};">${caption}</p>` +
        table(
            `<tr><td style="background:${C.hairlineSoft};border-radius:999px;height:10px;line-height:10px;font-size:0;">` +
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${percentWidth}" style="width:${percentWidth};"><tr><td height="10" style="height:10px;background:${fill};border-radius:999px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`,
            "margin:0 0 20px;",
        )
    );
};

const signature = (name = "Pankaj", role = "Founder, Zealoop") =>
    table(
        `<tr><td width="48" valign="middle" style="width:48px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="38" height="38" style="width:38px;height:38px;border-radius:999px;background:${TINT.teal};border:1px solid ${C.tealSoft};font-family:${DISPLAY};font-size:18px;color:${C.teal};">${name[0]}</td></tr></table></td>` +
            `<td valign="middle"><p style="margin:0;font-family:${SANS};font-size:14.5px;font-weight:600;color:${C.ink};">${name}</p><p style="margin:2px 0 0;font-family:${SANS};font-size:13px;color:${C.muted};">${role}</p></td></tr>`,
        "margin:24px 0 0;",
    );

/* ── the frame ────────────────────────────────────────────────────── */

const mark = () =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td valign="middle" style="font-family:${DISPLAY};font-size:25px;line-height:1;color:${C.ink};letter-spacing:-0.01em;">zealoop</td>` +
    `<td valign="middle" style="padding-left:4px;padding-top:4px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="7" height="7" style="width:7px;height:7px;border-radius:999px;background:${C.teal};font-size:0;line-height:0;">&nbsp;</td></tr></table></td>` +
    `</tr></table>`;

// email: { preheader, eyebrow, heading, tint, body: string[], reason }
function renderEmail(email) {
    const address = COMPANY_ADDRESS.trim();
    return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${email.heading}</title>
<style>
  @media (max-width: 600px) {
    .wrap { padding: 20px 12px !important; }
    .pad { padding: 28px 22px 26px !important; }
    .hero { padding: 26px 22px 22px !important; }
    .h1 { font-size: 29px !important; }
    .tile { display: block !important; width: auto !important; margin-bottom: 10px !important; }
    .tile-gap { display: none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.canvas};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;color:${C.canvas};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${email.preheader}${"&nbsp;&#847;&zwnj;".repeat(40)}</div>
${table(
    `<tr><td align="center" class="wrap" style="padding:40px 20px 48px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;">
<tr><td style="padding:0 6px 22px;">${mark()}</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.hairline};border-radius:22px;overflow:hidden;">
${table(`<tr><td height="3" style="height:3px;line-height:3px;font-size:0;background:${C.teal};">&nbsp;</td></tr>`)}
${table(
    `<tr><td class="hero" style="padding:34px 40px 26px;background:${TINT[email.tint]};">` +
        `<p style="margin:0 0 12px;font-family:${SANS};font-size:11.5px;line-height:1.4;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:${C.teal};">${email.eyebrow}</p>` +
        `<h1 class="h1" style="margin:0;font-family:${DISPLAY};font-size:35px;line-height:1.1;font-weight:400;color:${C.ink};letter-spacing:-0.015em;">${email.heading}</h1>` +
        `</td></tr>` +
        `<tr><td class="pad" style="padding:30px 40px 34px;">${email.body.join("\n")}</td></tr>`,
)}
</td></tr>
<tr><td style="padding:22px 8px 0;">
<p style="margin:0 0 8px;font-family:${SANS};font-size:12.5px;line-height:1.6;color:${C.muted};">${email.reason}</p>
<p style="margin:0;font-family:${SANS};font-size:12.5px;line-height:1.6;color:${C.soft};">
<a href="${APP}" style="color:${C.muted};text-decoration:none;">Dashboard</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="${SITE}" style="color:${C.muted};text-decoration:none;">zealoop.com</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="mailto:${SUPPORT}" style="color:${C.muted};text-decoration:none;">${SUPPORT}</a>${address ? `<br>${address}` : ""}
</p>
</td></tr>
</table>
</td></tr>`,
    `background:${C.canvas};`,
)}
</body>
</html>`;
}

module.exports = {
    APP, SITE, SUPPORT, COMPANY_ADDRESS, C, TINT,
    p, lead, b, a, code, h2, small, rule, quote, button, buttons, steps, points, checklist, stats, details, codeBlock, tok, callout, tiles, chat, meter, signature,
    renderEmail,
};

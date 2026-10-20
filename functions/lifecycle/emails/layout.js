"use strict";
// The look of every lifecycle email Zealoop sends its customers, taken from
// zealoop.com: a warm off-white page, a soft peach-and-blue wash behind the
// headline, light Inter headlines set tight, the eyebrow in a white pill,
// dark rounded buttons, check-marked lists, light code cards with window dots,
// chat turns as the widget shows them, and small mono "Fig." captions.
//
// Email clients are the constraint, not the web: tables and inline styles
// only, padding on the button's cell (Outlook ignores it on links), Inter and
// JetBrains Mono where the client loads web fonts and the system's own
// otherwise, a solid colour behind the wash for clients that drop gradients,
// and one small <style> block for phones.
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

// Zea, the agent, as the site's hero shows her.
const ZEA = { src: `${SITE}/hero/zea-poster.jpg`, alt: "Zea, the Zealoop support agent" };

const C = {
    canvas: "#f7f7f4",
    card: "#ffffff",
    ink: "#26251e",
    body: "#5a5852",
    muted: "#8a877e",
    soft: "#b4b1a7",
    hairline: "#e9e7e0",
    wash: "#f7f7f4",
    teal: "#0f766e",
    code: { key: "#3d5f9a", str: "#26251e", dim: "#a3a097", hi: "#9a4f2f" },
    good: "#15803d",
    goodBg: "#eef8f1",
    warn: "#9a6510",
    warnBg: "#fbf5e6",
    bad: "#b42318",
    badBg: "#fbefed",
};

const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono','SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

const table = (inner, style = "", attrs = "") =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${attrs} style="border-collapse:separate;${style}">${inner}</table>`;
const closing = `<tr><td colspan="9" style="border-top:1px solid ${C.hairline};font-size:0;line-height:0;">&nbsp;</td></tr>`;

/* ── text ─────────────────────────────────────────────────────────── */

const p = (html) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:15.5px;line-height:1.65;color:${C.body};">${html}</p>`;
const lead = (html) => `<p style="margin:0 0 18px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.ink};">${html}</p>`;
const b = (html) => `<strong style="color:${C.ink};font-weight:600;">${html}</strong>`;
const a = (label, href) => `<a href="${href}" style="color:${C.ink};text-decoration:underline;text-decoration-color:${C.soft};text-underline-offset:3px;">${label}</a>`;
const code = (text) => `<code style="font-family:${MONO};font-size:13px;background:${C.wash};border:1px solid ${C.hairline};border-radius:5px;padding:1px 6px;color:${C.ink};">${text}</code>`;
// A section label, the way the site labels its sections ("20-MINUTE SETUP").
const h2 = (text) => `<p style="margin:28px 0 10px;font-family:${SANS};font-size:11.5px;line-height:1.4;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:${C.muted};">${text}</p>`;
const small = (html) => `<p style="margin:16px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted};">${html}</p>`;
const rule = () => table(`<tr><td height="1" style="height:1px;line-height:1px;font-size:0;background:${C.hairline};">&nbsp;</td></tr>`, "margin:26px 0 24px;");
const mono = (text, color = C.muted) => `<span style="font-family:${MONO};font-size:12px;line-height:1.5;color:${color};">${text}</span>`;
// The site's figure caption: "Fig. 02 · Paste, crawl, ready".
const fig = (text) => `<p style="margin:-10px 2px 22px;text-align:right;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${C.soft};">${text}</p>`;

/* ── actions ──────────────────────────────────────────────────────── */

const dark = (label, href) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:middle;margin:0 10px 10px 0;"><tr>` +
    `<td align="center" bgcolor="${C.ink}" style="background:${C.ink};border-radius:8px;padding:13px 22px;">` +
    `<a href="${href}" style="display:inline-block;font-family:${SANS};font-size:15px;line-height:1;font-weight:500;color:#ffffff;text-decoration:none;white-space:nowrap;">${label}</a>` +
    `</td></tr></table>`;
const outline = (label, href) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;vertical-align:middle;margin:0 0 10px;"><tr>` +
    `<td align="center" bgcolor="#ffffff" style="background:#ffffff;border:1px solid #dcd9d0;border-radius:8px;padding:12px 20px;">` +
    `<a href="${href}" style="display:inline-block;font-family:${SANS};font-size:15px;line-height:1;font-weight:500;color:${C.ink};text-decoration:none;white-space:nowrap;">${label}</a>` +
    `</td></tr></table>`;

const button = (label, href) => `<div style="margin:14px 0 4px;font-size:0;">${dark(label, href)}</div>`;
const buttons = (primary, secondary) => `<div style="margin:14px 0 4px;font-size:0;">${dark(primary.label, primary.href)}${outline(secondary.label, secondary.href)}</div>`;
// The site's quiet link: "Follow the quickstart →".
const more = (label, href) => `<p style="margin:6px 0 4px;"><a href="${href}" style="font-family:${SANS};font-size:14.5px;font-weight:500;color:${C.ink};text-decoration:none;">${label}&nbsp;&rarr;</a></p>`;

/* ── blocks ───────────────────────────────────────────────────────── */

// The site's numbered timeline: a small circle with a mono number, a line between.
const steps = (items) =>
    table(
        items
            .map(
                (s, i) =>
                    `<tr><td valign="top" width="40" style="width:40px;padding:0;">` +
                    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="26" height="26" style="width:26px;height:26px;border-radius:999px;border:1px solid #d9d6cd;background:#ffffff;font-family:${MONO};font-size:11.5px;color:${C.muted};">${i + 1}</td></tr></table>` +
                    (i < items.length - 1 ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="13" style="width:13px;font-size:0;">&nbsp;</td><td width="1" height="34" style="width:1px;height:34px;background:${C.hairline};font-size:0;line-height:0;">&nbsp;</td></tr></table>` : "") +
                    `</td><td valign="top" style="padding:3px 0 ${i < items.length - 1 ? "14px" : "4px"};">` +
                    `<p style="margin:0 0 3px;font-family:${SANS};font-size:15.5px;line-height:1.4;font-weight:500;color:${C.ink};">${s.title}</p>` +
                    `<p style="margin:0;font-family:${SANS};font-size:14.5px;line-height:1.6;color:${C.body};">${s.body}</p></td></tr>`,
            )
            .join(""),
        "margin:6px 0 18px;",
    );

// The site's check-marked list.
const points = (items) =>
    table(
        items
            .map(
                (item) =>
                    `<tr><td valign="top" width="24" style="width:24px;padding:1px 0 11px;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.ink};">&#10003;</td>` +
                    `<td valign="top" style="padding:0 0 11px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.body};">${item}</td></tr>`,
            )
            .join(""),
        "margin:4px 0 14px;",
    );

const checklist = (items) =>
    table(
        items
            .map(
                (item) =>
                    `<tr><td valign="middle" width="32" style="width:32px;padding:11px 0;border-top:1px solid ${C.hairline};">` +
                    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="20" height="20" style="width:20px;height:20px;border-radius:999px;${item.done ? `background:${C.ink};color:#ffffff;` : `border:1.5px solid #d9d6cd;color:#ffffff;`}font-family:${SANS};font-size:11px;font-weight:700;line-height:1;">${item.done ? "&#10003;" : "&nbsp;"}</td></tr></table>` +
                    `</td><td valign="middle" style="padding:11px 0;border-top:1px solid ${C.hairline};font-family:${SANS};font-size:15px;line-height:1.45;color:${item.done ? C.soft : C.ink};${item.done ? "text-decoration:line-through;" : ""}">${item.label}</td></tr>`,
            )
            .join("") + closing,
        "margin:4px 0 18px;",
    );

// The site's flow of chips: "SITEMAP.XML → 214 PAGES CRAWLED → ✓ READY".
const flow = (labels) =>
    `<div style="margin:2px 0 20px;font-size:0;line-height:30px;">${labels
        .map(
            (l, i) =>
                (i ? `<span style="display:inline-block;margin:0 8px;font-family:${SANS};font-size:13px;color:${C.soft};vertical-align:middle;">&rarr;</span>` : "") +
                `<span style="display:inline-block;padding:6px 11px;border-radius:999px;background:#eceae4;font-family:${SANS};font-size:11px;line-height:1;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${C.ink};vertical-align:middle;white-space:nowrap;">${l}</span>`,
        )
        .join("")}</div>`;

// Big numbers between hairlines. Values arrive formatted.
const stats = (items) => {
    const width = Math.floor(100 / items.length);
    return table(
        `<tr>${items
            .map(
                (s, i) =>
                    `<td valign="top" width="${width}%" style="width:${width}%;padding:18px ${i < items.length - 1 ? "16px" : "0"} 18px ${i ? "16px" : "0"};${i ? `border-left:1px solid ${C.hairline};` : ""}">` +
                    `<p style="margin:0;font-family:${SANS};font-size:34px;line-height:1.05;font-weight:400;color:${C.ink};letter-spacing:-0.035em;">${s.value}</p>` +
                    `<p style="margin:7px 0 0;font-family:${SANS};font-size:13px;line-height:1.4;color:${C.muted};">${s.label}</p></td>`,
            )
            .join("")}</tr>`,
        `margin:6px 0 22px;border-top:1px solid ${C.hairline};border-bottom:1px solid ${C.hairline};`,
    );
};

// Label → value rows, like the site's tables: a plan, a receipt, a record.
const details = (rows) =>
    table(
        rows
            .map(
                ([k, v], i) =>
                    `<tr><td valign="top" style="padding:12px 18px;${i ? `border-top:1px solid ${C.hairline};` : ""}font-family:${MONO};font-size:11.5px;letter-spacing:0.04em;text-transform:uppercase;color:${C.muted};width:42%;">${k}</td>` +
                    `<td valign="top" align="right" style="padding:12px 18px;${i ? `border-top:1px solid ${C.hairline};` : ""}font-family:${SANS};font-size:14px;font-weight:500;color:${C.ink};">${v}</td></tr>`,
            )
            .join(""),
        `margin:4px 0 22px;background:#ffffff;border:1px solid ${C.hairline};border-radius:14px;`,
    );

// A light code card with window dots and a file name, like the site's snippets.
const codeBlock = (label, lines) =>
    table(
        `<tr><td style="padding:12px 18px;border-bottom:1px solid ${C.hairline};">` +
            `<span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:#d9d6cd;margin-right:5px;"></span><span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:#d9d6cd;margin-right:5px;"></span><span style="display:inline-block;width:8px;height:8px;border-radius:999px;background:#d9d6cd;margin-right:12px;"></span>` +
            `${mono(label)}</td></tr>` +
            `<tr><td style="padding:16px 18px 18px;font-family:${MONO};font-size:13px;line-height:1.75;color:${C.ink};white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;">${lines.join("<br>")}</td></tr>`,
        `margin:6px 0 22px;background:#ffffff;border:1px solid ${C.hairline};border-radius:14px;`,
    );

const tok = {
    key: (s) => `<span style="color:${C.code.key};">${s}</span>`,
    str: (s) => `<span style="color:${C.code.str};">${s}</span>`,
    dim: (s) => `<span style="color:${C.code.dim};">${s}</span>`,
    hi: (s) => `<span style="color:${C.code.hi};">${s}</span>`,
};

const callout = (tone, title, body) => {
    const [bg, fg, border] =
        tone === "good" ? [C.goodBg, C.good, C.goodBg] : tone === "warn" ? [C.warnBg, C.warn, C.warnBg] : tone === "bad" ? [C.badBg, C.bad, C.badBg] : ["#ffffff", C.ink, C.hairline];
    return table(
        `<tr><td style="padding:16px 18px;">` +
            `<p style="margin:0 0 4px;font-family:${SANS};font-size:14.5px;line-height:1.45;font-weight:600;color:${fg};">${title}</p>` +
            `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.6;color:${C.body};">${body}</p></td></tr>`,
        `margin:6px 0 20px;background:${bg};border:1px solid ${border};border-radius:14px;`,
    );
};

// Cards two by two, like the site's feature grid, each with a mono index.
const tiles = (items) => {
    const cell = (t, n) =>
        `<td valign="top" class="tile" width="50%" style="width:50%;padding:16px 16px 18px;background:#ffffff;border:1px solid ${C.hairline};border-radius:14px;">` +
        `<p style="margin:0 0 10px;">${mono(String(n).padStart(2, "0"), C.soft)}</p>` +
        `<p style="margin:0 0 4px;font-family:${SANS};font-size:15px;line-height:1.4;font-weight:500;color:${C.ink};">${t.href ? `<a href="${t.href}" style="color:${C.ink};text-decoration:none;">${t.title}&nbsp;&rarr;</a>` : t.title}</p>` +
        `<p style="margin:0;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${C.body};">${t.body}</p></td>`;
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
        rows.push(
            `<tr>${cell(items[i], i + 1)}<td width="10" class="tile-gap" style="width:10px;font-size:0;">&nbsp;</td>${items[i + 1] ? cell(items[i + 1], i + 2) : `<td width="50%" style="width:50%;">&nbsp;</td>`}</tr>` +
                (i + 2 < items.length ? `<tr><td colspan="3" height="10" style="height:10px;font-size:0;line-height:0;">&nbsp;</td></tr>` : ""),
        );
    }
    return table(rows.join(""), "margin:6px 0 20px;");
};

// A turn as the widget shows it: the visitor's dark bubble, Zea's light reply.
const chat = (question, answer, agent = "Zea") =>
    table(
        `<tr><td style="padding:18px 18px 8px;" align="right"><span style="display:inline-block;max-width:82%;padding:11px 15px;border-radius:16px;background:${C.ink};font-family:${SANS};font-size:14px;line-height:1.5;color:#ffffff;text-align:left;">${question}</span></td></tr>` +
            `<tr><td style="padding:6px 18px 18px;"><p style="margin:0 0 6px;">${mono(agent, C.muted)}</p><span style="display:inline-block;max-width:86%;padding:11px 15px;border-radius:16px;background:${C.wash};border:1px solid ${C.hairline};font-family:${SANS};font-size:14px;line-height:1.5;color:${C.ink};">${answer}</span></td></tr>` +
            `<tr><td style="padding:12px 18px;border-top:1px solid ${C.hairline};font-family:${MONO};font-size:11px;letter-spacing:0.06em;color:${C.muted};">GATE &mdash; RETRIEVE &mdash; RERANK &mdash; GENERATE &mdash; VALIDATE &nbsp;&middot;&nbsp; grounded</td></tr>`,
        `margin:6px 0 22px;background:#ffffff;border:1px solid ${C.hairline};border-radius:16px;`,
    );

// A visitor's own words, set as the widget shows them.
const quote = (html, who = "Visitor") =>
    table(
        `<tr><td style="padding:16px 18px 8px;"><p style="margin:0;">${mono(who, C.muted)}</p></td></tr>` +
            `<tr><td style="padding:0 18px 18px;"><span style="display:inline-block;padding:11px 15px;border-radius:16px;background:${C.ink};font-family:${SANS};font-size:14.5px;line-height:1.5;color:#ffffff;">${html}</span></td></tr>`,
        `margin:6px 0 22px;background:#ffffff;border:1px solid ${C.hairline};border-radius:16px;`,
    );

// A score bar, like the site's rerank threshold.
const meter = (caption, percentWidth, tone = "ink") => {
    const fill = tone === "bad" ? C.bad : tone === "warn" ? "#c08a2a" : C.ink;
    return (
        `<p style="margin:0 0 10px;font-family:${MONO};font-size:11.5px;letter-spacing:0.05em;text-transform:uppercase;color:${C.muted};">${caption}</p>` +
        table(
            `<tr><td style="background:#eceae4;border-radius:999px;height:6px;line-height:6px;font-size:0;">` +
                `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${percentWidth}" style="width:${percentWidth};"><tr><td height="6" style="height:6px;background:${fill};border-radius:999px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`,
            "margin:0 0 22px;",
        )
    );
};

// Zea, as on the site's hero, with a figure caption. The poster has thin dark
// bands top and bottom that the site crops; the frame trims them the same way
// (clients that ignore overflow show the full poster).
const zea = (caption = "Fig. 00 · Zea, answering on your site") =>
    `<div style="width:240px;max-width:100%;height:294px;overflow:hidden;border-radius:18px;background:#efe9e3;">` +
    `<img src="${ZEA.src}" width="240" alt="${ZEA.alt}" style="display:block;width:240px;max-width:100%;height:auto;border:0;margin-top:-3px;" /></div>` +
    `<p style="margin:10px 2px 22px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${C.soft};">${caption}</p>`;

const signature = (name = "Pankaj", role = "Founder, Zealoop") =>
    table(
        `<tr><td width="46" valign="middle" style="width:46px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="36" height="36" style="width:36px;height:36px;border-radius:999px;background:${C.ink};font-family:${SANS};font-size:15px;font-weight:500;color:#ffffff;">${name[0]}</td></tr></table></td>` +
            `<td valign="middle"><p style="margin:0;font-family:${SANS};font-size:14.5px;font-weight:500;color:${C.ink};">${name}</p><p style="margin:2px 0 0;font-family:${SANS};font-size:13px;color:${C.muted};">${role}</p></td></tr>`,
        `margin:26px 0 0;padding-top:20px;border-top:1px solid ${C.hairline};`,
    );

/* ── the frame ────────────────────────────────────────────────────── */

// The wordmark: "Zealoop" with the logo's teal dot.
const mark = () =>
    `<span style="font-family:${SANS};font-size:17px;line-height:1;font-weight:600;color:${C.ink};letter-spacing:-0.02em;">Zealoop</span>` +
    `<span style="display:inline-block;width:6px;height:6px;margin-left:3px;border-radius:999px;background:${C.teal};vertical-align:baseline;"></span>`;

// The eyebrow in a white pill with a dot, like "• Built for small SaaS support teams".
const eyebrowPill = (text) =>
    `<span style="display:inline-block;padding:6px 12px 6px 10px;border-radius:999px;background:#ffffff;border:1px solid rgba(38,37,30,0.06);font-family:${SANS};font-size:12.5px;line-height:1;font-weight:500;color:${C.ink};white-space:nowrap;">` +
    `<span style="display:inline-block;width:5px;height:5px;margin-right:7px;border-radius:999px;background:${C.ink};vertical-align:middle;"></span>${text}</span>`;

// email: { preheader, eyebrow, heading, body: string[], reason }
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400&amp;display=swap" rel="stylesheet" />
<style>
  @media (max-width: 600px) {
    .wrap { padding: 16px 10px !important; }
    .pad { padding: 26px 22px 28px !important; }
    .hero { padding: 26px 22px 28px !important; }
    .h1 { font-size: 32px !important; }
    .tile { display: block !important; width: auto !important; margin-bottom: 10px !important; }
    .tile-gap { display: none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.canvas};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;color:${C.canvas};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${email.preheader}${"&nbsp;&#847;&zwnj;".repeat(40)}</div>
${table(
    `<tr><td align="center" class="wrap" style="padding:36px 20px 48px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;">
<tr><td style="background:${C.card};border:1px solid ${C.hairline};border-radius:22px;">
${table(
    `<tr><td class="hero" bgcolor="#f4efe9" style="padding:30px 40px 34px;background:#f4efe9;background-image:linear-gradient(115deg,#f2ddd2 0%,#f5f1ec 48%,#e1e8f1 100%);border-radius:22px 22px 0 0;">` +
        `<p style="margin:0 0 34px;">${mark()}</p>` +
        `<p style="margin:0 0 18px;">${eyebrowPill(email.eyebrow)}</p>` +
        `<h1 class="h1" style="margin:0;font-family:${SANS};font-size:38px;line-height:1.08;font-weight:400;color:${C.ink};letter-spacing:-0.035em;">${email.heading}</h1>` +
        `</td></tr>` +
        `<tr><td class="pad" style="padding:32px 40px 36px;">${email.body.join("\n")}</td></tr>`,
)}
</td></tr>
<tr><td style="padding:22px 10px 0;">
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
    APP, SITE, SUPPORT, COMPANY_ADDRESS, C, ZEA,
    p, lead, b, a, code, h2, small, rule, mono, fig, quote, button, buttons, more, steps, points, checklist, flow, stats, details, codeBlock, tok, callout, tiles, chat, meter, zea, signature,
    renderEmail,
};

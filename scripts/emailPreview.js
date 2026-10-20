"use strict";
// Renders every lifecycle template with sample values into a folder of HTML
// files plus gallery.html, to review the copy and design before syncing.
//   node scripts/emailPreview.js <out dir>
const fs = require("node:fs");
const path = require("node:path");
const { renderEmail } = require("../functions/lifecycle/emails/layout");
const { TEMPLATES } = require("../functions/lifecycle/emails/templates");

const SAMPLE = {
    firstName: "Maya", workspace: "Brightloop", plan_name: "Growth", plan_tier: "paid", role: "admin",
    trial_days: "14", trial_ends_on: "Nov 3", source_name: "brightloop.io", chunks_label: "1,284 passages", site: "brightloop.io",
    preview: "Hi! Can I change the size on an order I placed this morning?", conversation_url: "https://app.zealoop.com/app/inbox",
    action_name: "Order lookup", table_name: "Delivery zones", rows_label: "312 rows", procedure_name: "Returns", from_address: "dan@northwind.com",
    days_left: "7 days", conversations: "486", conversations_label: "486 conversations", escalated: "12", hours: "41", hours_label: "41 hours", inviter_name: "Rohit", action_url: "https://app.zealoop.com/login",
    member_email: "sam@brightloop.io", changed_at: "Oct 20, 2026 at 9:41 AM UTC", actor_email: "rohit@brightloop.io", grace_until: "Oct 21, 2026 at 9:41 AM UTC", client: "Claude Code", reason: "a billing dispute",
    used_label: "243 conversations", limit_label: "300 conversations", percent: "81%", resets_on: "Nov 1", last_seen_on: "Oct 12",
    failures_label: "38 failed calls", last_error: "The endpoint answered HTTP 401.", error: "The sitemap at brightloop.io/sitemap.xml returned 403.",
    from_plan: "Starter", renews_on: "Nov 20", grace_days: "7", grace_ends_on: "Oct 27", ends_on: "Nov 20", count_label: "1,000 conversations",
    week_label: "Oct 13 – Oct 19", resolved_pct: "74%", handoffs_note: "Each one is waiting in the inbox with the full thread.",
    month: "October", years_label: "1 year",
};

// Volanea's placeholder syntax: {{path}} or {{path | "fallback"}}.
const fill = (text) => text.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*"([^"]*)")?\s*\}\}/g, (_, key, fallback) => SAMPLE[key] ?? fallback ?? "");

const out = path.resolve(process.argv[2] || "email-preview");
fs.mkdirSync(out, { recursive: true });
const cards = TEMPLATES.map((tpl, i) => {
    fs.writeFileSync(path.join(out, `${tpl.key}.html`), fill(renderEmail(tpl.parts)));
    return `<figure class="card" data-type="${tpl.type}" data-q="${(tpl.name + " " + fill(tpl.subject)).toLowerCase().replace(/"/g, "")}">
  <figcaption><span class="n">${i + 1}</span><b>${tpl.name.replace("Zealoop · ", "")}</b><span class="t ${tpl.type}">${tpl.type}</span>
  <div class="s">${fill(tpl.subject)}</div><a href="${tpl.key}.html" target="_blank">open ↗</a></figcaption>
  <div class="frame"><iframe loading="lazy" src="${tpl.key}.html"></iframe></div>
</figure>`;
});
fs.writeFileSync(path.join(out, "gallery.html"), `<!doctype html><meta charset="utf-8"><title>Zealoop emails · ${TEMPLATES.length}</title>
<style>
body{margin:0;background:#f4f3ef;font:14px system-ui;color:#1a1a17}
header{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #e8e6df;padding:12px 24px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font:600 18px system-ui;margin:0 12px 0 0}
input{padding:7px 12px;border:1px solid #ddd9d0;border-radius:999px;width:220px}
button{padding:6px 12px;border:1px solid #ddd9d0;border-radius:999px;background:#fff;cursor:pointer}
button.on{background:#262521;color:#fff;border-color:#262521}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--w),1fr));gap:20px;padding:24px}
.card{margin:0;background:#fff;border:1px solid #e8e6df;border-radius:14px;overflow:hidden}
figcaption{padding:10px 14px;border-bottom:1px solid #e8e6df;position:relative}
figcaption a{position:absolute;right:14px;top:10px;color:#56534c;font-size:12px}
.n{color:#aaa69c;margin-right:6px}.s{color:#56534c;margin-top:3px;font-size:13px}
.t{font-size:11px;padding:1px 8px;border-radius:999px;margin-left:8px}
.t.marketing{background:#ecf5f3;color:#0f766e}.t.transactional{background:#f8f4ea;color:#8a6a1f}
.frame{height:640px;overflow:hidden}
iframe{border:0;width:100%;height:100%}
</style>
<header><h1>${TEMPLATES.length} Zealoop emails</h1>
<input id="q" placeholder="Search name or subject">
<button data-f="all" class="on">All</button><button data-f="transactional">Transactional</button><button data-f="marketing">Marketing</button>
<span style="flex:1"></span><button id="w">Mobile width</button></header>
<main style="--w:460px">${cards.join("")}</main>
<script>
let f="all";const cards=[...document.querySelectorAll(".card")],q=document.getElementById("q");
const apply=()=>cards.forEach(c=>c.hidden=!((f==="all"||c.dataset.type===f)&&c.dataset.q.includes(q.value.toLowerCase())));
q.oninput=apply;
document.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{f=b.dataset.f;document.querySelectorAll("[data-f]").forEach(x=>x.classList.toggle("on",x===b));apply()});
const w=document.getElementById("w"),m=document.querySelector("main");
w.onclick=()=>{const mob=w.classList.toggle("on");m.style.setProperty("--w",mob?"375px":"460px");m.style.gridTemplateColumns=mob?"repeat(auto-fill,375px)":""};
</script>`);
console.log(`${TEMPLATES.length} templates → ${out}/gallery.html`);

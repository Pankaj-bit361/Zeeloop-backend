"use strict";
// Pushes Zealoop's lifecycle emails into the "Zealoop" project in Volanea:
// every template, then every workflow. Safe to run again and again.
//
//   templates   matched by name. Created when missing, updated only when the
//               content differs, so a run with no changes writes nothing.
//   workflows   matched by name. Created as DRAFTS. An existing one has its
//               steps updated but its status is never sent: whether a flow is
//               live is decided in Volanea, not by a deploy.
//   anything in Volanea called "Zealoop · …" that isn't here any more is
//   reported, never deleted.
//
// Used by scripts/emailSync.js; kept separate so it can be tested against a
// stand-in Volanea.

const { renderEmail, SUPPORT } = require("./layout");
const { TEMPLATES } = require("./templates");
const { PREFIX } = require("./templates/types");
const { WORKFLOWS, toGraph } = require("./workflows");

// Who lifecycle email comes from. Replies go to a person.
const FROM = { name: "Zealoop", email: SUPPORT };

// JSON with the keys in a fixed order, so two graphs that mean the same thing compare equal.
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

// The parts of a graph that matter, in a fixed order: what Volanea adds or
// reorders on its own must not look like a change.
function canonicalGraph(graph) {
    if (!graph) return "";
    const nodes = [...graph.nodes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((n) => ({ id: n.id, type: n.type, label: n.label, config: n.config || {}, x: n.x, y: n.y }));
    const edges = graph.edges
        .map((edge) => ({ from: edge.from, to: edge.to, label: edge.label || "" }))
        .sort((a, b) => `${a.from}>${a.to}>${a.label}`.localeCompare(`${b.from}>${b.to}>${b.label}`));
    return stable({ nodes, edges });
}

const sameTemplate = (remote, want) =>
    remote.type === want.type && remote.subject === want.subject && remote.body === want.body && (remote.fromName || "") === want.fromName && remote.fromEmail === want.fromEmail;

async function syncEmails({ apiKey, baseUrl = "https://api.volanea.com", dryRun = false, fetchImpl = fetch }) {
    const base = baseUrl.replace(/\/+$/, "");

    async function request(method, path, body) {
        const response = await fetchImpl(`${base}${path}`, {
            method,
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const json = await response.json().catch(() => null);
        if (!response.ok || (json && json.success === false)) {
            const detail = json && json.details ? json.details.map((d) => `${d.path || "request"}: ${d.message}`).join("; ") : "";
            throw new Error(`${method} ${path} failed (${response.status} ${(json && json.code) || "no code"}): ${(json && json.error) || "no detail"}${detail ? ` — ${detail}` : ""}`);
        }
        return json || {};
    }
    const api = async (method, path, body) => {
        const json = await request(method, path, body);
        return json.data !== undefined ? json.data : json;
    };
    // Template lists come in pages. Reading only the first would miss what's
    // already there and create it again, so follow the cursor to the end.
    async function listAll(path) {
        const rows = [];
        let cursor = null;
        do {
            const page = await request("GET", `${path}?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
            rows.push(...(page.data || []));
            cursor = page.nextCursor || null;
        } while (cursor);
        return rows;
    }

    const report = { dryRun, templates: [], workflows: [], orphans: [], duplicates: [] };

    /* ── templates ── */
    const remoteTemplates = await listAll("/v1/templates");
    const templateByName = new Map();
    for (const remote of [...remoteTemplates].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))) {
        if (templateByName.has(remote.name)) report.duplicates.push({ kind: "template", name: remote.name });
        else templateByName.set(remote.name, remote);
    }

    const ids = {};
    for (const tpl of TEMPLATES) {
        const want = { name: tpl.name, type: tpl.type, subject: tpl.subject, body: renderEmail(tpl.parts), fromName: FROM.name, fromEmail: FROM.email };
        const existing = templateByName.get(tpl.name);
        let id;
        let action;
        if (!existing) {
            action = "created";
            id = dryRun ? `(new ${tpl.key})` : (await api("POST", "/v1/templates", want)).templateId;
        } else if (sameTemplate(existing, want)) {
            action = "unchanged";
            id = existing.templateId;
        } else {
            action = "updated";
            id = existing.templateId;
            if (!dryRun) await api("PATCH", `/v1/templates/${id}`, want);
        }
        ids[tpl.key] = id;
        report.templates.push({ key: tpl.key, name: tpl.name, id, action });
    }
    const known = new Set(TEMPLATES.map((tpl) => tpl.name));
    for (const remote of templateByName.values()) if (remote.name.startsWith(PREFIX) && !known.has(remote.name)) report.orphans.push({ kind: "template", name: remote.name, id: remote.templateId });

    /* ── workflows ── */
    const remoteWorkflows = await api("GET", "/v1/workflows");
    const workflowByName = new Map();
    for (const remote of remoteWorkflows) {
        if (workflowByName.has(remote.name)) report.duplicates.push({ kind: "workflow", name: remote.name });
        else workflowByName.set(remote.name, remote);
    }

    for (const def of WORKFLOWS) {
        const want = { name: def.name, trigger: `event:${def.trigger}`, reentry: def.reentry, graph: toGraph(def, ids) };
        const existing = workflowByName.get(def.name);
        if (!existing) {
            const id = dryRun ? `(new ${def.trigger})` : (await api("POST", "/v1/workflows", want)).workflowId;
            report.workflows.push({ name: def.name, id, action: "created", status: "draft" });
        } else if (existing.trigger === want.trigger && existing.reentry === want.reentry && canonicalGraph(existing.graph) === canonicalGraph(want.graph)) {
            report.workflows.push({ name: def.name, id: existing.workflowId, action: "unchanged", status: existing.status });
        } else {
            // No `status` here, on purpose: a live flow stays live and a paused one stays paused.
            if (!dryRun) await api("PATCH", `/v1/workflows/${existing.workflowId}`, want);
            report.workflows.push({ name: def.name, id: existing.workflowId, action: "updated", status: existing.status });
        }
    }
    const knownFlows = new Set(WORKFLOWS.map((w) => w.name));
    for (const remote of workflowByName.values()) if (remote.name.startsWith(PREFIX) && !knownFlows.has(remote.name)) report.orphans.push({ kind: "workflow", name: remote.name, id: remote.workflowId });

    return report;
}

module.exports = { syncEmails, FROM, canonicalGraph };

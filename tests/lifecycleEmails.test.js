// The lifecycle email contract: templates, workflows, the sync, and the pure
// rules that decide what's due. No database.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { EVENTS, CONTACT_FIELDS, RESERVED_PREFIXES } = require("../functions/lifecycle/events");
const { TEMPLATES } = require("../functions/lifecycle/emails/templates");
const { WORKFLOWS, toGraph } = require("../functions/lifecycle/emails/workflows");
const { renderEmail } = require("../functions/lifecycle/emails/layout");
const { syncEmails } = require("../functions/lifecycle/emails/sync");
const { dueEvents } = require("../functions/lifecycle/rules");
const { billingEvents } = require("../functions/lifecycle/hooks");

const placeholders = (text) => [...text.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]);
const byKey = new Map(TEMPLATES.map((tpl) => [tpl.key, tpl]));

describe("lifecycle templates", () => {
    test("there are at least 60, with unique keys and names", () => {
        assert.ok(TEMPLATES.length >= 60, `only ${TEMPLATES.length} templates`);
        assert.equal(new Set(TEMPLATES.map((t) => t.key)).size, TEMPLATES.length);
        assert.equal(new Set(TEMPLATES.map((t) => t.name)).size, TEMPLATES.length);
    });

    test("every placeholder is a field its event sends, or a contact field", () => {
        for (const tpl of TEMPLATES) {
            const allowed = new Set([...CONTACT_FIELDS, ...(tpl.event ? EVENTS[tpl.event] : [])]);
            if (tpl.event) assert.ok(EVENTS[tpl.event], `${tpl.key}: unknown event ${tpl.event}`);
            for (const field of placeholders(tpl.subject + renderEmail(tpl.parts))) {
                assert.ok(allowed.has(field), `${tpl.key} uses {{${field}}}, which ${tpl.event || "a campaign base"} doesn't send`);
            }
        }
    });

    test("security, billing, usage and failures are transactional; nudges and news are marketing", () => {
        for (const tpl of TEMPLATES) {
            const notice = /^(security|billing|usage|trial|member|workspace\.(suspended|reinstated)|knowledge\.source_failed|widget\.silent|action\.failing)/.test(tpl.event || "");
            if (tpl.key === "trial-winback" || tpl.key === "winback" || tpl.key === "upgrade-nudge") assert.equal(tpl.type, "marketing", tpl.key);
            else if (notice) assert.equal(tpl.type, "transactional", tpl.key);
            else assert.equal(tpl.type, "marketing", tpl.key);
        }
    });

    test("renders as a complete, light-only email document", () => {
        for (const tpl of TEMPLATES) {
            const html = renderEmail(tpl.parts);
            assert.match(html, /^<!DOCTYPE html/);
            assert.match(html, /<meta name="color-scheme" content="light" \/>/);
            assert.ok(html.includes(tpl.parts.preheader), `${tpl.key}: preheader missing`);
            assert.ok(!/undefined|\[object Object\]/.test(html), `${tpl.key} rendered undefined`);
        }
    });
});

describe("lifecycle events and workflows", () => {
    test("no event name uses a prefix Volanea reserves", () => {
        for (const name of Object.keys(EVENTS)) assert.ok(!RESERVED_PREFIXES.some((p) => name.startsWith(p)), name);
    });

    test("every event starts a workflow, and every non-campaign template is sent by one", () => {
        const triggers = new Set(WORKFLOWS.map((w) => w.trigger));
        for (const name of Object.keys(EVENTS)) assert.ok(triggers.has(name), `no workflow for ${name}`);
        const sent = new Set(WORKFLOWS.flatMap((w) => w.nodes.filter((n) => n.type === "send_email").map((n) => n.config.template)));
        for (const tpl of TEMPLATES.filter((t) => t.event)) assert.ok(sent.has(tpl.key), `template ${tpl.key} is never sent`);
    });

    test("each email in a flow belongs to that flow's event, so its fields exist", () => {
        for (const flow of WORKFLOWS) {
            for (const node of flow.nodes.filter((n) => n.type === "send_email")) {
                const tpl = byKey.get(node.config.template);
                assert.ok(tpl, `${flow.name}: unknown template ${node.config.template}`);
                assert.equal(tpl.event, flow.trigger, `${flow.name} sends ${tpl.key}, written for ${tpl.event}`);
            }
        }
    });

    test("no dead ends: conditions branch yes and no, waits have a timeout path, every step leads somewhere", () => {
        for (const flow of WORKFLOWS) {
            const ids = new Set(flow.nodes.map((n) => n.id));
            for (const edge of flow.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to), `${flow.name}: edge to nowhere`);
            for (const node of flow.nodes) {
                const out = flow.edges.filter((e) => e.from === node.id);
                if (node.type === "exit") continue;
                assert.ok(out.length, `${flow.name}: ${node.id} leads nowhere`);
                if (node.type === "condition") assert.deepEqual(out.map((e) => e.label).sort(), ["no", "yes"], `${flow.name}: ${node.id}`);
                if (node.type === "wait_event") assert.ok(out.some((e) => e.label === "timeout") && out.some((e) => !e.label), `${flow.name}: ${node.id}`);
                if (node.type === "wait_event") assert.ok(EVENTS[node.config.event], `${flow.name} waits for unknown ${node.config.event}`);
            }
        }
    });

    test("every delay is followed by a check, so nobody is nudged to do what they've done", () => {
        for (const flow of WORKFLOWS) {
            for (const node of flow.nodes.filter((n) => n.type === "delay")) {
                const next = flow.edges.filter((e) => e.from === node.id).map((e) => flow.nodes.find((n) => n.id === e.to));
                assert.ok(next.every((n) => n.type === "condition"), `${flow.name}: ${node.id} isn't followed by a check`);
            }
            for (const node of flow.nodes.filter((n) => n.type === "condition")) {
                for (const filter of node.config.conditions.groups.flatMap((g) => g.filters)) {
                    const [, event] = filter.field.split(/^event\./);
                    if (event) assert.ok(EVENTS[event], `${flow.name} checks unknown ${event}`);
                }
            }
        }
    });

    test("graphs swap template keys for ids", () => {
        const ids = Object.fromEntries(TEMPLATES.map((t) => [t.key, `tpl_${t.key}`]));
        const graph = toGraph(WORKFLOWS[0], ids);
        const sends = graph.nodes.filter((n) => n.type === "send_email");
        assert.ok(sends.length && sends.every((n) => n.config.templateId && !n.config.template));
    });
});

describe("sync", () => {
    function fakeVolanea() {
        const templates = [];
        const workflows = [];
        const calls = [];
        const fetchImpl = async (url, init) => {
            const path = new URL(url).pathname;
            const body = init.body ? JSON.parse(init.body) : undefined;
            calls.push(`${init.method} ${path}`);
            const ok = (data) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
            if (path === "/v1/templates" && init.method === "GET") {
                // Pages of 50, like Volanea's list.
                const from = Number(new URL(url).searchParams.get("cursor") || 0);
                const page = templates.slice(from, from + 50);
                return new Response(JSON.stringify({ success: true, data: page, nextCursor: from + 50 < templates.length ? String(from + 50) : null }), { status: 200 });
            }
            if (path === "/v1/templates" && init.method === "POST") { const row = { ...body, templateId: `tpl_${templates.length}` }; templates.push(row); return ok(row); }
            if (path === "/v1/workflows" && init.method === "GET") return ok(workflows);
            if (path === "/v1/workflows" && init.method === "POST") { const row = { ...body, workflowId: `wf_${workflows.length}`, status: "draft" }; workflows.push(row); return ok(row); }
            return new Response(JSON.stringify({ success: false, error: "unexpected" }), { status: 400 });
        };
        return { fetchImpl, calls, templates, workflows };
    }

    test("creates everything once, then a second run changes nothing — across every page of templates", async () => {
        const volanea = fakeVolanea();
        const first = await syncEmails({ apiKey: "sk_test_x", fetchImpl: volanea.fetchImpl });
        assert.equal(first.templates.filter((t) => t.action === "created").length, TEMPLATES.length);
        assert.equal(first.workflows.filter((w) => w.action === "created").length, WORKFLOWS.length);
        assert.ok(volanea.workflows.every((w) => w.status === "draft"));
        assert.ok(volanea.templates.every((t) => t.fromEmail === "hello@zealoop.com"));

        volanea.calls.length = 0;
        const second = await syncEmails({ apiKey: "sk_test_x", fetchImpl: volanea.fetchImpl });
        assert.ok(second.templates.every((t) => t.action === "unchanged"));
        assert.ok(second.workflows.every((w) => w.action === "unchanged"));
        assert.deepEqual(volanea.calls.filter((c) => !c.startsWith("GET")), []);
    });
});

describe("rules", () => {
    const DAY = 86_400_000;
    const now = new Date("2026-10-20T10:00:00Z");
    const base = (over = {}) => ({
        orgId: "org_1", workspace: "Acme", createdAt: new Date(now - 0.5 * DAY), tier: "trial", trialEndsAt: new Date(now.getTime() + 13 * DAY),
        firstReadySource: null, failedSources: [], widget: { installed: false, origin: null, lastSeenAt: null }, firstConversation: null, conversationsTotal: 0,
        firstEscalation: null, liveAction: null, firstTable: null, liveProcedure: null, firstEmailConversation: null, usage: { conversations: 0, limit: 1200 },
        lastActiveAt: now, conversationsSinceActive: 0, failingActions: [], week: null, previousMonth: null, ...over,
    });
    const fresh = () => ({ flags: {} });

    test("a new workspace hears about its first source, then not again", () => {
        const s = base({ firstReadySource: { name: "acme.com", chunks: 120 } });
        const first = dueEvents(s, fresh(), now);
        assert.deepEqual(first.send.map((d) => d.event), ["knowledge.first_ready"]);
        assert.equal(first.send[0].data.chunks_label, "120 passages");
        assert.deepEqual(dueEvents(s, { flags: { "knowledge.first_ready": "x" } }, now).send, []);
    });

    test("an older workspace seen for the first time is baselined without a word", () => {
        const s = base({ createdAt: new Date(now - 40 * DAY), firstReadySource: { name: "acme.com", chunks: 1 }, widget: { installed: true, origin: "acme.com", lastSeenAt: now }, conversationsTotal: 1500 });
        const r = dueEvents(s, fresh(), now);
        assert.deepEqual(r.send, []);
        assert.ok(r.silent.includes("knowledge.first_ready") && r.silent.includes("widget.installed") && r.silent.includes("milestone.conversations:1000"));
    });

    test("tips are spaced 20 hours apart; notices are not", () => {
        const s = base({ firstReadySource: { name: "a", chunks: 1 }, widget: { installed: true, origin: "acme.com", lastSeenAt: now }, trialEndsAt: new Date(now.getTime() + 2 * DAY) });
        const r = dueEvents(s, fresh(), now);
        assert.deepEqual(r.send.map((d) => d.event), ["knowledge.first_ready", "trial.ending_2"]);
        const later = dueEvents(s, { flags: { "knowledge.first_ready": "x" }, lastTipAt: new Date(now - 2 * 3_600_000).toISOString(), baselinedAt: "x" }, now);
        assert.ok(!later.send.some((d) => d.tip));
    });

    test("trial notices: a week out, then two days out, each once", () => {
        const week = dueEvents(base({ trialEndsAt: new Date(now.getTime() + 6 * DAY), conversationsTotal: 42 }), fresh(), now);
        assert.deepEqual(week.send.map((d) => d.event), ["trial.ending_7"]);
        assert.equal(week.send[0].data.conversations_label, "42 conversations");
        const two = dueEvents(base({ trialEndsAt: new Date(now.getTime() + 1.5 * DAY) }), fresh(), now);
        assert.deepEqual(two.send.map((d) => d.event), ["trial.ending_2"]);
        assert.equal(dueEvents(base({ tier: "paid", trialEndsAt: new Date(now.getTime() + 1.5 * DAY) }), fresh(), now).send.length, 0);
    });

    test("tells only the furthest conversation milestone and marks the smaller ones", () => {
        const r = dueEvents(base({ conversationsTotal: 12_400 }), { flags: {}, baselinedAt: "x" }, now);
        assert.equal(r.send.find((d) => d.event === "milestone.conversations").data.count_label, "10,000 conversations");
        assert.ok(r.silent.includes("milestone.conversations:100") && r.silent.includes("milestone.conversations:1000"));
    });

    test("a failing source is told once when it starts failing", () => {
        const s = base({ failedSources: [{ sourceId: "src_1", name: "Help centre", error: "403" }] });
        assert.equal(dueEvents(s, fresh(), now).send[0].event, "knowledge.source_failed");
        assert.deepEqual(dueEvents(s, { flags: {}, failedSources: ["src_1"] }, now).send, []);
    });

    test("a widget that went quiet a week ago is flagged; one gone for months isn't", () => {
        const quiet = base({ widget: { installed: true, origin: "acme.com", lastSeenAt: new Date(now - 8 * DAY) } });
        assert.ok(dueEvents(quiet, { flags: { "widget.installed": "x" }, baselinedAt: "x" }, now).send.some((d) => d.event === "widget.silent"));
        const gone = base({ widget: { installed: true, origin: "acme.com", lastSeenAt: new Date(now - 90 * DAY) } });
        assert.ok(!dueEvents(gone, { flags: { "widget.installed": "x" }, baselinedAt: "x" }, now).send.some((d) => d.event === "widget.silent"));
    });

    test("away from the dashboard: only the longest gap is told, keyed to the last visit", () => {
        const s = base({ createdAt: new Date(now - 90 * DAY), lastActiveAt: new Date(now - 35 * DAY), conversationsSinceActive: 88 });
        const r = dueEvents(s, { flags: {}, baselinedAt: "x" }, now);
        assert.deepEqual(r.send.filter((d) => d.event.startsWith("user.inactive")).map((d) => d.event), ["user.inactive_30d"]);
        assert.equal(r.send.find((d) => d.event === "user.inactive_30d").data.conversations_label, "88 conversations");
        assert.ok(r.silent.some((k) => k.startsWith("user.inactive_14d:")));
    });

    test("weekly digest on Mondays, only when there were conversations", () => {
        const monday = new Date("2026-10-19T10:00:00Z");
        const s = base({ createdAt: new Date(monday - 30 * DAY), week: { conversations: 40, resolved: 30, escalated: 0 } });
        const r = dueEvents(s, { flags: {}, baselinedAt: "x" }, monday);
        const digest = r.send.find((d) => d.event === "digest.weekly");
        assert.equal(digest.data.resolved_pct, "75%");
        assert.equal(digest.data.handoffs_note, "Nothing needed a person this week.");
        assert.ok(!dueEvents(base({ week: { conversations: 0, resolved: 0, escalated: 0 } }), { flags: {}, baselinedAt: "x" }, monday).send.some((d) => d.event === "digest.weekly"));
    });
});

describe("billing transitions", () => {
    test("trial to paid starts a subscription; a plan change reads as up or down", () => {
        assert.deepEqual(billingEvents({ plan: "GROWTH", status: "TRIALING" }, { plan: "STARTER", status: "ACTIVE" }).map((e) => e[0]), ["billing.subscription_started"]);
        assert.deepEqual(billingEvents({ plan: "STARTER", status: "ACTIVE" }, { plan: "SCALE", status: "ACTIVE" }).map((e) => e[0]), ["billing.plan_upgraded"]);
        assert.deepEqual(billingEvents({ plan: "SCALE", status: "ACTIVE" }, { plan: "GROWTH", status: "ACTIVE" }).map((e) => e[0]), ["billing.plan_downgraded"]);
    });

    test("a failed payment, its recovery, a cancellation and the end are each told", () => {
        assert.deepEqual(billingEvents({ plan: "GROWTH", status: "ACTIVE" }, { plan: "GROWTH", status: "PAST_DUE" }).map((e) => e[0]), ["billing.payment_failed"]);
        assert.deepEqual(billingEvents({ plan: "GROWTH", status: "PAST_DUE" }, { plan: "GROWTH", status: "ACTIVE" }).map((e) => e[0]), ["billing.recovered"]);
        assert.deepEqual(billingEvents({ plan: "GROWTH", status: "ACTIVE", cancelAtPeriodEnd: false }, { plan: "GROWTH", status: "ACTIVE", cancelAtPeriodEnd: true }).map((e) => e[0]), ["billing.cancel_scheduled"]);
        assert.deepEqual(billingEvents({ plan: "GROWTH", status: "ACTIVE" }, { plan: "GROWTH", status: "CANCELLED" }).map((e) => e[0]), ["billing.subscription_ended"]);
        assert.deepEqual(billingEvents({ plan: "GROWTH", status: "ACTIVE" }, { plan: "GROWTH", status: "ACTIVE" }), []);
    });
});

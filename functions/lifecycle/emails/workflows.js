"use strict";
// The automations that run inside the "Zealoop" project in Volanea: when an
// event from this backend arrives (../events.js), what to send, how long to
// wait, and when to stop because the person already did the thing. Synced by
// scripts/emailSync.js, which creates workflows as drafts and never changes
// whether one is live — switching them on is a deliberate step.
//
// Principles every flow follows:
//   - One email, one job; no flow sends more than it has to.
//   - Check before every nudge: nobody is told to do what they've done.
//   - Onboarding nudges are spaced days apart and stop at the first sign of progress.
//   - Re-entry: "never" for one-time moments, "after_exit" for things that can
//     recur once a run has finished, "always" where every occurrence matters and
//     the backend already sends each one once (security, billing, reports).
//
// Conditions on `event.<name>` ask whether that contact ever sent the event;
// `data.<field>` reads the contact fields sent with every event (CONTACT_FIELDS).

const { PREFIX } = require("./templates/types");

/* ── builders ─────────────────────────────────────────────────────── */

const start = () => ({ id: "start", type: "trigger", label: "Event arrives" });
const send = (id, template, label) => ({ id, type: "send_email", label, config: { template } });
const wait = (id, label, time) => ({ id, type: "delay", label, config: time });
const waitFor = (id, event, hours, label) => ({ id, type: "wait_event", label, config: { event, timeoutHours: hours } });
const end = () => ({ id: "end", type: "exit", label: "Done" });
// Branches "yes" when every filter holds.
const check = (id, label, filters) => ({ id, type: "condition", label, config: { conditions: { logic: "and", groups: [{ filters }] } } });
const did = (event) => ({ field: `event.${event}`, operator: "triggered" });
const hasNot = (event) => ({ field: `event.${event}`, operator: "notTriggered" });
const onTier = (tier) => ({ field: "data.plan_tier", operator: "equals", value: tier });
const e = (from, to, label) => (label ? { from, to, label } : { from, to });

// trigger → one email.
const single = (name, purpose, event, template, reentry) => ({
    name: `${PREFIX}${name}`,
    trigger: event,
    reentry,
    purpose,
    nodes: [start(), send("email", template, "Send the email"), end()],
    edges: [e("start", "email"), e("email", "end")],
});

// trigger → (Free plan ? one email : another).
const byPlan = (name, purpose, event, freeTemplate, paidTemplate) => ({
    name: `${PREFIX}${name}`,
    trigger: event,
    reentry: "always",
    purpose,
    nodes: [start(), check("free", "On the Free plan?", [onTier("free")]), send("free_email", freeTemplate, "Free plan version"), send("paid_email", paidTemplate, "Paid or trial version"), end()],
    edges: [e("start", "free"), e("free", "free_email", "yes"), e("free", "paid_email", "no"), e("free_email", "end"), e("paid_email", "end")],
});

// trigger → email → wait → (did the next thing ? stop : nudge).
const thenNudge = (name, purpose, event, first, days, nextEvent, nudge, reentry = "never") => ({
    name: `${PREFIX}${name}`,
    trigger: event,
    reentry,
    purpose,
    nodes: [start(), send("first", first, "Send the email"), wait("wait", `Wait ${days} days`, { days }), check("done", "Already done it?", [did(nextEvent)]), send("nudge", nudge, "Nudge"), end()],
    edges: [e("start", "first"), e("first", "wait"), e("wait", "done"), e("done", "end", "yes"), e("done", "nudge", "no"), e("nudge", "end")],
});

/* ── the flows ────────────────────────────────────────────────────── */

const WORKFLOWS = [
    /* getting started */
    thenNudge("Welcome", "Welcome someone the moment they sign up, and nudge once after two days if they still haven't created a workspace.", "user.signed_up", "welcome", 2, "workspace.created", "workspace-nudge"),
    {
        name: `${PREFIX}Workspace ready`,
        trigger: "workspace.created",
        reentry: "always",
        purpose: "Point a new workspace at its first steps, then nudge content on day 1 only if nothing is indexed yet.",
        nodes: [start(), send("ready", "workspace-created", "Workspace ready"), wait("d1", "Wait 1 day", { days: 1 }), check("has_content", "Content indexed?", [did("knowledge.first_ready")]), send("nudge", "knowledge-nudge", "Add your content"), end()],
        edges: [e("start", "ready"), e("ready", "d1"), e("d1", "has_content"), e("has_content", "end", "yes"), e("has_content", "nudge", "no"), e("nudge", "end")],
    },
    thenNudge("Content indexed", "Celebrate the first indexed source, and two days later nudge the install if the widget hasn't been seen.", "knowledge.first_ready", "knowledge-ready", 2, "widget.installed", "install-nudge"),
    thenNudge("Widget live", "Celebrate the widget going live, and after three quiet days suggest why nobody has talked to it.", "widget.installed", "widget-installed", 3, "conversation.first", "no-conversations"),
    single("First conversation", "Show the first real visitor's question and where to read the thread.", "conversation.first", "first-conversation", "never"),
    single("First handoff", "Explain handoffs the first time the agent brings in a person.", "escalation.first", "first-escalation", "never"),
    thenNudge("First action", "Confirm the first live action, and four days later suggest tables if none exists.", "action.first_live", "action-live", 4, "table.first_created", "tables-nudge"),
    thenNudge("First table", "Confirm the first table, and five days later suggest procedures if none is live.", "table.first_created", "table-created", 5, "procedure.first_live", "procedures-nudge"),
    single("First procedure", "Confirm the first live procedure and suggest testing its branches.", "procedure.first_live", "procedure-live", "never"),
    single("Email channel live", "Tell them the agent answered its first email.", "email_channel.first_received", "email-channel-live", "never"),
    {
        name: `${PREFIX}Day 3 check-in`,
        trigger: "account.day_3",
        reentry: "never",
        purpose: "Three days in: a personal offer of help if there's still no content, otherwise how to write rules.",
        nodes: [start(), check("no_content", "Still no content?", [hasNot("knowledge.first_ready")]), send("help", "help-stuck", "Offer help"), send("rules", "guidance-nudge", "Shape your agent"), end()],
        edges: [e("start", "no_content"), e("no_content", "help", "yes"), e("no_content", "rules", "no"), e("help", "end"), e("rules", "end")],
    },
    {
        name: `${PREFIX}Day 7 check-in`,
        trigger: "account.day_7",
        reentry: "never",
        purpose: "A week in: on the trial, what Growth unlocks; otherwise actions, unless one is already live.",
        nodes: [
            start(),
            check("trial", "On the trial?", [onTier("trial")]),
            send("halfway", "trial-halfway", "Trial halfway"),
            check("no_action", "No live action?", [hasNot("action.first_live")]),
            send("actions", "actions-nudge", "Connect an action"),
            end(),
        ],
        edges: [e("start", "trial"), e("trial", "halfway", "yes"), e("trial", "no_action", "no"), e("halfway", "end"), e("no_action", "actions", "yes"), e("no_action", "end", "no"), e("actions", "end")],
    },
    {
        name: `${PREFIX}Day 12 check-in`,
        trigger: "account.day_12",
        reentry: "never",
        purpose: "Twelve days in: bring the team in if nobody has joined, otherwise suggest the email channel if it isn't in use.",
        nodes: [
            start(),
            check("solo", "Still on their own?", [hasNot("member.joined")]),
            send("team", "team-nudge", "Invite your team"),
            check("no_email", "Email channel unused?", [hasNot("email_channel.first_received")]),
            send("email", "email-channel-nudge", "Answer email too"),
            end(),
        ],
        edges: [e("start", "solo"), e("solo", "team", "yes"), e("solo", "no_email", "no"), e("team", "end"), e("no_email", "email", "yes"), e("no_email", "end", "no"), e("email", "end")],
    },
    {
        name: `${PREFIX}Day 30 check-in`,
        trigger: "account.day_30",
        reentry: "never",
        purpose: "A month in: what visitors ask that content misses, or — if the widget never went live — how an AI agent can set it up.",
        nodes: [start(), check("live", "Widget live?", [did("widget.installed")]), send("insights", "insights-tip", "What visitors ask"), send("mcp", "mcp-tip", "Let your AI set it up"), end()],
        edges: [e("start", "live"), e("live", "insights", "yes"), e("live", "mcp", "no"), e("insights", "end"), e("mcp", "end")],
    },

    /* trial */
    single("Trial ends in a week", "Say what changes, and what doesn't, a week before the trial ends.", "trial.ending_7", "trial-ending-7", "always"),
    single("Trial ends in two days", "The last reminder before the trial ends.", "trial.ending_2", "trial-ending-2", "always"),
    {
        name: `${PREFIX}Trial ended`,
        trigger: "trial.ended",
        reentry: "after_exit",
        purpose: "Say the trial ended with what it achieved, and two weeks later ask once why they didn't upgrade — unless they have.",
        nodes: [start(), send("ended", "trial-ended", "Trial ended"), waitFor("upgrade", "billing.subscription_started", 14 * 24, "Wait up to 2 weeks for an upgrade"), send("ask", "trial-winback", "Ask what was missing"), end()],
        edges: [e("start", "ended"), e("ended", "upgrade"), e("upgrade", "end"), e("upgrade", "ask", "timeout"), e("ask", "end")],
    },

    /* team and security — every occurrence */
    single("Invitation", "Invite someone into a workspace with a link to sign in or sign up.", "member.invited", "member-invited", "always"),
    single("Teammate joined", "Tell the owner an invited teammate opened the workspace.", "member.joined", "member-joined", "always"),
    single("Removed from workspace", "Tell a person they no longer have access to a workspace.", "member.removed", "member-removed", "always"),
    single("Password changed", "Security notice after a password change.", "security.password_changed", "password-changed", "always"),
    single("Widget secret rotated", "Security notice when the identity secret is rotated.", "security.widget_secret_rotated", "secret-rotated", "always"),
    single("Agent connected", "Security notice when an MCP client is approved for a workspace.", "security.agent_connected", "agent-connected", "always"),
    single("Workspace suspended", "Tell the owner their workspace was suspended and how to resolve it.", "workspace.suspended", "workspace-suspended", "always"),
    single("Workspace restored", "Tell the owner a suspension was lifted.", "workspace.reinstated", "workspace-reinstated", "always"),

    /* usage and health */
    byPlan("Limit almost reached", "Warn at 80% of the period's conversations, with the Free or paid wording.", "usage.quota_near", "quota-near-free", "quota-near-paid"),
    byPlan("Limit reached", "Say the agent paused answering at the limit, with the Free or paid wording.", "usage.quota_reached", "quota-reached-free", "quota-reached-paid"),
    single("Usage ceiling reached", "Explain the safety ceiling on processing per period.", "usage.cost_ceiling", "cost-ceiling", "always"),
    single("Outgrowing Free", "Once, when a Free workspace nears its limit, show the next plans.", "usage.heavy_free", "upgrade-nudge", "never"),
    single("Source failed", "A knowledge source stopped syncing.", "knowledge.source_failed", "source-failed", "always"),
    single("Widget not seen", "The widget hasn't loaded for a week after being live.", "widget.silent", "widget-silent", "always"),
    single("Action failing", "An action failed more than half its calls in a day.", "action.failing", "action-failing", "always"),

    /* billing */
    single("Subscription started", "Welcome a new paying workspace and confirm what's included.", "billing.subscription_started", "subscription-started", "always"),
    single("Plan upgraded", "Confirm an upgrade between paid plans.", "billing.plan_upgraded", "plan-upgraded", "always"),
    single("Plan downgraded", "Confirm a move to a smaller plan and what pauses.", "billing.plan_downgraded", "plan-downgraded", "always"),
    {
        name: `${PREFIX}Payment failed`,
        trigger: "billing.payment_failed",
        reentry: "after_exit",
        purpose: "Three notices across the 7-day grace period, stopping the moment the payment goes through.",
        nodes: [
            start(),
            send("first", "payment-failed-1", "First notice"),
            waitFor("w1", "billing.recovered", 48, "Wait up to 2 days for the payment"),
            send("second", "payment-failed-2", "Reminder"),
            waitFor("w2", "billing.recovered", 72, "Wait up to 3 more days"),
            send("third", "payment-failed-3", "Final notice"),
            end(),
        ],
        edges: [e("start", "first"), e("first", "w1"), e("w1", "end"), e("w1", "second", "timeout"), e("second", "w2"), e("w2", "end"), e("w2", "third", "timeout"), e("third", "end")],
    },
    single("Payment received", "Confirm a failed payment went through.", "billing.recovered", "payment-recovered", "always"),
    single("Cancellation scheduled", "Confirm a cancellation and the date the plan ends.", "billing.cancel_scheduled", "cancel-scheduled", "always"),
    {
        name: `${PREFIX}Subscription ended`,
        trigger: "billing.subscription_ended",
        reentry: "after_exit",
        purpose: "Say the plan ended, and three weeks later invite them back once — unless they've already resubscribed.",
        nodes: [start(), send("ended", "subscription-ended", "Plan ended"), waitFor("back", "billing.subscription_started", 21 * 24, "Wait up to 3 weeks for a resubscribe"), send("winback", "winback", "Win-back"), end()],
        edges: [e("start", "ended"), e("ended", "back"), e("back", "end"), e("back", "winback", "timeout"), e("winback", "end")],
    },

    /* results and staying in touch */
    single("Conversations milestone", "Mark 100, 1k, 10k and 100k conversations.", "milestone.conversations", "conversations-milestone", "always"),
    single("Weekly digest", "The week's conversations, resolution and handoffs, only when there were any.", "digest.weekly", "weekly-digest", "always"),
    single("Monthly report", "The month at a glance, with time saved.", "report.monthly", "monthly-report", "always"),
    single("Anniversary", "Thank a customer on each year with Zealoop.", "account.anniversary", "anniversary", "always"),
    single("Feedback ask", "A few weeks into real traffic, ask what works and what doesn't.", "feedback.ask", "feedback-ask", "never"),
    single("Away for two weeks", "Show what the agent did while nobody looked.", "user.inactive_14d", "inactive-14d", "always"),
    single("Away for a month", "Ask, personally, whether Zealoop still fits.", "user.inactive_30d", "inactive-30d", "always"),
    single("Away for two months", "The last check-in, and a promise to stop.", "user.inactive_60d", "inactive-60d", "always"),
];

/* ── graph for the API ────────────────────────────────────────────── */

// Lays nodes out left to right by depth, so the flow reads cleanly on the canvas.
function place(nodes, edges) {
    const depth = new Map([["start", 0]]);
    for (let pass = 0; pass < nodes.length; pass++) {
        for (const edge of edges) {
            const d = depth.get(edge.from);
            if (d !== undefined) depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, d + 1));
        }
    }
    const rows = new Map();
    const at = new Map();
    for (const node of nodes) {
        const d = depth.get(node.id) ?? 0;
        const row = rows.get(d) ?? 0;
        rows.set(d, row + 1);
        at.set(node.id, { x: 80 + d * 260, y: 80 + row * 150 });
    }
    return at;
}

// The workflow as Volanea stores it, with template keys swapped for template ids.
function toGraph(def, templateIds) {
    const positions = place(def.nodes, def.edges);
    return {
        nodes: def.nodes.map((node) => {
            const config = { ...(node.config || {}) };
            if (node.type === "send_email") {
                const id = templateIds[String(config.template)];
                if (!id) throw new Error(`Workflow "${def.name}" uses template "${config.template}", which has no id yet.`);
                delete config.template;
                config.templateId = id;
            }
            return { id: node.id, type: node.type, label: node.label, config, ...positions.get(node.id) };
        }),
        edges: def.edges.map((edge) => ({ ...edge })),
    };
}

module.exports = { WORKFLOWS, toGraph };

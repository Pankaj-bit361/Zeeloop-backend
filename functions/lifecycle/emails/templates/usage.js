"use strict";
// Usage and health: limits, and the things that quietly stop working — a source
// that won't sync, a widget that disappeared, an action that keeps failing.
// All transactional: they're about the service they pay for, not promotion.
const { APP, b, button, buttons, callout, details, lead, meter, p, points, small } = require("../layout");
const { hi, t } = require("./types");

const REASON_USAGE = "You're getting this because of your Zealoop workspace's usage this billing period.";
const REASON_HEALTH = "You're getting this because something in your Zealoop workspace needs attention.";
const AT_LIMIT = "At the limit, the agent tells visitors your team will follow up instead of answering. Their questions are still recorded, so nothing is lost.";

const USAGE = [
    t("quota-near-free", "Limit almost reached (Free)", "transactional", "usage.quota_near", "{{workspace}} has used {{percent}} of its free conversations", {
        preheader: "{{used_label}} of {{limit_label}} this month. Resets {{resets_on}}.",
        eyebrow: "Usage · {{percent}}",
        heading: "You're close to the Free limit.",
        tint: "sand",
        body: [
            lead(hi),
            meter("{{used_label}} of {{limit_label}} this period", "{{percent}}", "warn"),
            p(`${b("{{workspace}}")} is getting busy — good news. ${AT_LIMIT}`),
            p("Starter raises the limit to 300 conversations a month and unlocks tables and actions, so the agent can look up orders instead of only reading docs."),
            button("See the plans", `${APP}/billing`),
            small("The count resets on {{resets_on}}."),
        ],
        reason: REASON_USAGE,
    }),

    t("quota-near-paid", "Limit almost reached", "transactional", "usage.quota_near", "{{workspace}} has used {{percent}} of this period's conversations", {
        preheader: "{{used_label}} of {{limit_label}}. Resets {{resets_on}}.",
        eyebrow: "Usage · {{percent}}",
        heading: "You've used {{percent}} of this period's conversations.",
        tint: "sand",
        body: [
            lead(hi),
            meter("{{used_label}} of {{limit_label}} on {{plan_name}}", "{{percent}}", "warn"),
            p(`${b("{{workspace}}")} is on track to reach its limit before {{resets_on}}. ${AT_LIMIT}`),
            buttons({ label: "Raise the limit", href: `${APP}/billing` }, { label: "See usage", href: `${APP}/billing` }),
        ],
        reason: REASON_USAGE,
    }),

    t("quota-reached-free", "Limit reached (Free)", "transactional", "usage.quota_reached", "{{workspace}} has reached its free conversation limit", {
        preheader: "Visitors are told your team will follow up until {{resets_on}}, or until you upgrade.",
        eyebrow: "Usage · Limit reached",
        heading: "Your agent has paused answering.",
        tint: "clay",
        body: [
            lead(hi),
            meter("All {{limit_label}} used", "100%", "bad"),
            p(`${b("{{workspace}}")} has used all {{limit_label}} included in the Free plan this period. ${AT_LIMIT}`),
            callout("tip", "Back in a minute", "Upgrade and the agent starts answering again straight away — no reinstall, nothing to reconfigure."),
            button("Upgrade now", `${APP}/billing`),
            small("Or wait: the count resets on {{resets_on}}."),
        ],
        reason: REASON_USAGE,
    }),

    t("quota-reached-paid", "Limit reached", "transactional", "usage.quota_reached", "{{workspace}} has reached its conversation limit", {
        preheader: "Visitors are told your team will follow up until {{resets_on}}, or until you raise the limit.",
        eyebrow: "Usage · Limit reached",
        heading: "Your agent has paused answering.",
        tint: "clay",
        body: [
            lead(hi),
            meter("All {{limit_label}} used", "100%", "bad"),
            p(`${b("{{workspace}}")} has used every conversation in {{plan_name}} this period. ${AT_LIMIT}`),
            button("Raise the limit", `${APP}/billing`),
            small("The count resets on {{resets_on}}. Handoffs you receive meanwhile are in the inbox."),
        ],
        reason: REASON_USAGE,
    }),

    t("cost-ceiling", "Usage ceiling reached", "transactional", "usage.cost_ceiling", "{{workspace}} hit its usage ceiling for this period", {
        preheader: "An unusually heavy month tripped the safety ceiling. Here's what it means.",
        eyebrow: "Usage",
        heading: "Your workspace reached its safety ceiling.",
        tint: "clay",
        body: [
            lead(hi),
            p(`Separately from the conversation count, every plan has a ceiling on processing per period, so one runaway conversation or a bot hammering the widget can't run up a bill. ${b("{{workspace}}")} just reached it.`),
            p(`${AT_LIMIT} It resets on {{resets_on}}.`),
            points([
                "Check the inbox for a burst of very long or repetitive conversations.",
                "If it's real traffic, a larger plan has a higher ceiling.",
            ], "clay"),
            buttons({ label: "Open the inbox", href: `${APP}/inbox` }, { label: "See plans", href: `${APP}/billing` }),
        ],
        reason: REASON_USAGE,
    }),

    t("upgrade-nudge", "Outgrowing Free", "marketing", "usage.heavy_free", "{{workspace}} is outgrowing the Free plan", {
        preheader: "{{used_label}} of {{limit_label}} already. Here's what the next plan adds.",
        eyebrow: "Plans",
        heading: "Your visitors are using your agent.",
        tint: "teal",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} has handled {{used_label}} of its {{limit_label}} this period. That's a sign it's earning its place — and that you'll reach the limit soon.`),
            details([
                ["Starter · $29 a month", "300 conversations, tables and actions"],
                ["Growth · $99 a month", "1,200 conversations, procedures, email channel"],
            ]),
            button("Compare plans", `${APP}/billing`),
        ],
        reason: REASON_USAGE,
    }),

    t("source-failed", "Source failed", "transactional", "knowledge.source_failed", "{{source_name}} couldn't be synced", {
        preheader: "Your agent keeps answering from the last good copy. Here's what went wrong.",
        eyebrow: "Needs a look",
        heading: "{{source_name}} couldn't be synced.",
        tint: "clay",
        body: [
            lead(hi),
            p(`The last sync of ${b("{{source_name}}")} failed. Your agent keeps answering from what it already had, but new or changed pages won't reach it until this is fixed.`),
            callout("bad", "What Zealoop saw", "{{error}}"),
            points([
                `${b("Behind a login or a bot wall?")} Zealoop can only read public pages; upload a file instead.`,
                `${b("Sitemap moved?")} Re-point the source at the new sitemap URL.`,
                `${b("Rate limited?")} Retry later, or narrow the source to the pages that matter.`,
            ], "clay"),
            button("Open the source", `${APP}/knowledge`),
        ],
        reason: REASON_HEALTH,
    }),

    t("widget-silent", "Widget not seen", "transactional", "widget.silent", "We haven't seen the Zealoop widget on {{site}} for a week", {
        preheader: "Last seen {{last_seen_on}}. A redesign or a cookie banner usually explains it.",
        eyebrow: "Needs a look",
        heading: "Your widget may have gone missing.",
        tint: "clay",
        body: [
            lead(hi),
            p(`The widget for ${b("{{workspace}}")} last loaded on ${b("{{site}}")} on {{last_seen_on}}, and we haven't seen it since. If you took it down on purpose, ignore this.`),
            points([
                "A site redesign or a new theme dropped the snippet.",
                "A consent or cookie tool is blocking scripts until visitors accept.",
                "A content security policy doesn't allow api.zealoop.com.",
            ], "clay"),
            button("Check the install", `${APP}/setup`),
        ],
        reason: REASON_HEALTH,
    }),

    t("action-failing", "Action failing", "transactional", "action.failing", "{{action_name}} is failing", {
        preheader: "{{failures_label}} in the last day. The agent hands those conversations over instead.",
        eyebrow: "Needs a look",
        heading: "{{action_name}} keeps failing.",
        tint: "clay",
        body: [
            lead(hi),
            p(`${b("{{action_name}}")} failed ${b("{{failures_label}}")} in the last 24 hours — more than half its calls. When it fails, the agent tells the visitor it can't look that up right now and hands over.`),
            callout("bad", "Latest response", "{{last_error}}"),
            p("The action log shows every request and response, which usually makes the cause obvious: an expired token, a changed URL, or a field that's now required."),
            button("Open the action log", `${APP}/apis`),
        ],
        reason: REASON_HEALTH,
    }),
];

module.exports = { USAGE };

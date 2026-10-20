"use strict";
// The 14-day Growth trial: no card, so it can't fail to convert — it ends and
// the workspace moves to Free with everything intact. These emails say exactly
// that, and what changes.
const { APP, b, button, buttons, callout, details, lead, p, points, signature, small, stats } = require("../layout");
const { hi, t } = require("./types");

const REASON = "You're getting this because your Zealoop workspace is on the Growth trial.";
const PLANS = details([
    ["Starter · $29 a month", "300 conversations, tables, actions"],
    ["Growth · $99 a month", "1,200 conversations, procedures, email"],
    ["Scale · $399 a month", "6,000 conversations, everything"],
]);

const TRIAL = [
    t("trial-ending-7", "Trial ends in a week", "transactional", "trial.ending_7", "{{days_left}} left on your Zealoop trial", {
        preheader: "Nothing breaks when it ends. Here's exactly what changes, and what doesn't.",
        eyebrow: "Trial · {{days_left}} left",
        heading: "Your trial ends {{trial_ends_on}}.",
        tint: "sand",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} has {{days_left}} left on the Growth trial. So far your agent has handled ${b("{{conversations_label}}")}.`),
            p("When the trial ends, nothing is deleted and the agent keeps answering. The workspace moves to the Free plan, which means:"),
            points([
                "A lower monthly limit: 50 conversations.",
                "Tables, actions, procedures and the email channel pause until you pick a plan.",
                "Your content, rules, conversations and widget all stay exactly as they are.",
            ], "sand"),
            PLANS,
            button("Choose a plan", `${APP}/billing`),
            small("Prices are in USD; Indian workspaces see rupee pricing, GST included."),
        ],
        reason: REASON,
    }),

    t("trial-ending-2", "Trial ends in two days", "transactional", "trial.ending_2", "Your Zealoop trial ends {{trial_ends_on}}", {
        preheader: "Pick a plan to keep actions, tables and the higher limit running without a gap.",
        eyebrow: "Trial · {{days_left}} left",
        heading: "{{days_left}} left on your trial.",
        tint: "clay",
        body: [
            lead(hi),
            p(`The Growth trial on ${b("{{workspace}}")} ends on ${b("{{trial_ends_on}}")}. If you've connected actions or tables, those are the parts that pause on the Free plan — your content and the widget keep working.`),
            callout("tip", "Choosing takes a minute", "Pick a plan on the Billing page and the switch happens the moment the trial ends, with no gap for your visitors."),
            button("Choose a plan", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("trial-ended", "Trial ended", "transactional", "trial.ended", "{{workspace}} is now on the Free plan", {
        preheader: "Your agent is still live and still answering. Here's what your trial did.",
        eyebrow: "Trial ended",
        heading: "Your trial has ended. Your agent hasn't.",
        tint: "stone",
        body: [
            lead(hi),
            p(`The trial is over and ${b("{{workspace}}")} has moved to the Free plan. Your agent is still live and still answering from your content. Here's what it did during the trial:`),
            stats([
                { label: "Conversations", value: "{{conversations}}" },
                { label: "Resolved without a person", value: "{{resolved_pct}}" },
            ], "teal"),
            p("What changed: the monthly limit is now 50 conversations, and tables, actions, procedures and the email channel are paused. Nothing was deleted — upgrade and they pick up where they stopped."),
            button("Upgrade", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("trial-winback", "After the trial", "marketing", "trial.ended", "What would it take for Zealoop to be worth it?", {
        preheader: "A short note, and a real question. One line back helps more than you'd think.",
        eyebrow: "A note from the founder",
        heading: "Was something missing?",
        tint: "stone",
        body: [
            lead(hi),
            p(`It's been a couple of weeks since ${b("{{workspace}}")}'s trial ended and it's been on the Free plan since. I'd genuinely like to know why you didn't upgrade — the price, a missing integration, answers that weren't good enough, or simply not the right time.`),
            p("Reply with one line. I read every answer, and more than one feature exists because someone told us what they needed."),
            buttons({ label: "See the plans", href: `${APP}/billing` }, { label: "Open your workspace", href: `${APP}/dashboard` }),
            signature(),
        ],
        reason: "You're getting this because your Zealoop trial ended recently.",
    }),
];

module.exports = { TRIAL };

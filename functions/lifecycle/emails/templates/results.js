"use strict";
// Results and staying in touch: milestones, the weekly and monthly numbers,
// and the check-ins when nobody has looked in a while.
const { APP, b, button, buttons, lead, p, points, signature, small, stats } = require("../layout");
const { hi, t } = require("./types");

const REASON = "You're getting this because you use Zealoop. You can turn these updates off with the link below.";

const RESULTS = [
    t("conversations-milestone", "Conversations milestone", "marketing", "milestone.conversations", "{{count_label}} — your agent's latest milestone", {
        preheader: "Every one answered from your content, any hour of the day.",
        eyebrow: "Milestone",
        heading: "{{count_label}} and counting.",
        tint: "teal",
        body: [
            lead(hi),
            p(`Your agent on ${b("{{workspace}}")} just passed ${b("{{count_label}}")}. Each one is a visitor who got an answer without waiting for your team.`),
            p("A good moment to look at what they ask most — Analytics shows the top topics, the resolution rate, and the questions your content still misses."),
            button("See your analytics", `${APP}/analytics`),
        ],
        reason: REASON,
    }),

    t("weekly-digest", "Weekly digest", "marketing", "digest.weekly", "Your agent's week: {{conversations_label}}, {{resolved_pct}} resolved", {
        preheader: "{{week_label}} · {{conversations_label}}. {{handoffs_note}}",
        eyebrow: "Weekly · {{week_label}}",
        heading: "Your agent's week.",
        tint: "sky",
        body: [
            lead(hi),
            p(`Here's how ${b("{{workspace}}")}'s agent did last week.`),
            stats([
                { label: "Conversations", value: "{{conversations}}" },
                { label: "Resolved by the agent", value: "{{resolved_pct}}" },
                { label: "Handed to your team", value: "{{escalated}}" },
            ], "sky"),
            p("{{handoffs_note}}"),
            buttons({ label: "Open the inbox", href: `${APP}/inbox` }, { label: "Full analytics", href: `${APP}/analytics` }),
        ],
        reason: REASON,
    }),

    t("monthly-report", "Monthly report", "marketing", "report.monthly", "{{month}} on Zealoop: {{conversations_label}}, {{hours_label}} saved", {
        preheader: "{{resolved_pct}} resolved without a person. Here's the month at a glance.",
        eyebrow: "Monthly report · {{month}}",
        heading: "{{month}} at a glance.",
        tint: "teal",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} in {{month}}:`),
            stats([
                { label: "Conversations", value: "{{conversations}}" },
                { label: "Resolved by the agent", value: "{{resolved_pct}}" },
            ], "teal"),
            stats([
                { label: "Handed to your team", value: "{{escalated}}" },
                { label: "Hours of team time saved, roughly", value: "{{hours}}" },
            ], "stone"),
            small("Time saved assumes six minutes for each conversation the agent resolved on its own."),
            button("See the details", `${APP}/analytics`),
        ],
        reason: REASON,
    }),

    t("anniversary", "Anniversary", "marketing", "account.anniversary", "{{years_label}} with Zealoop — thank you", {
        preheader: "{{conversations_label}} answered so far.",
        eyebrow: "Anniversary",
        heading: "{{years_label}} together.",
        tint: "sand",
        body: [
            lead(hi),
            p(`It's ${b("{{years_label}}")} since ${b("{{workspace}}")} joined Zealoop, and your agent has handled ${b("{{conversations_label}}")} since. Thank you for building with us.`),
            p("If there's one thing that would make the next year better, reply and tell me — I read every one."),
            signature(),
        ],
        reason: REASON,
    }),

    t("feedback-ask", "Feedback", "marketing", "feedback.ask", "Two questions about Zealoop", {
        preheader: "What's working, and what isn't? One line back is plenty.",
        eyebrow: "A note from the founder",
        heading: "How is it going, honestly?",
        tint: "stone",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")}'s agent has been answering real visitors for a few weeks. I'd love to know two things:`),
            points([
                `${b("What's the best thing it does for you?")}`,
                `${b("What's the one thing that annoys you most?")}`,
            ], "stone"),
            p("Reply with a line or two. Every answer comes straight to me."),
            signature(),
        ],
        reason: REASON,
    }),

    t("inactive-14d", "Away for two weeks", "marketing", "user.inactive_14d", "Your agent handled {{conversations_label}} while you were away", {
        preheader: "Nobody's opened the dashboard in two weeks. Here's what you missed.",
        eyebrow: "While you were away",
        heading: "Your agent kept working.",
        tint: "sky",
        body: [
            lead(hi),
            p(`Nobody on ${b("{{workspace}}")} has opened the dashboard in two weeks. Meanwhile the agent handled ${b("{{conversations_label}}")}.`),
            p("Ten minutes in the inbox is worth it: check the handoffs, skim a few answers, and fix anything it got wrong."),
            button("Open the inbox", `${APP}/inbox`),
        ],
        reason: REASON,
    }),

    t("inactive-30d", "Away for a month", "marketing", "user.inactive_30d", "Is Zealoop still working for you?", {
        preheader: "A month without a visit. A quick, honest check-in.",
        eyebrow: "A note from the founder",
        heading: "Still the right fit?",
        tint: "stone",
        body: [
            lead(hi),
            p(`It's been a month since anyone on ${b("{{workspace}}")} opened Zealoop. The agent handled ${b("{{conversations_label}}")} in that time — but an agent nobody reviews slowly drifts from how you'd answer.`),
            p("If something's in the way — time, setup, answers you don't trust — reply and tell me. I'll help you fix it or tell you honestly if Zealoop isn't the right tool."),
            signature(),
        ],
        reason: REASON,
    }),

    t("inactive-60d", "Away for two months", "marketing", "user.inactive_60d", "We'll stop checking in", {
        preheader: "One last note. Your workspace stays exactly as it is.",
        eyebrow: "Last check-in",
        heading: "We'll leave you to it.",
        tint: "stone",
        body: [
            lead(hi),
            p(`It's been two months since anyone visited ${b("{{workspace}}")}, so this is the last check-in we'll send. Your content, rules and conversations stay exactly where they are, and the agent keeps doing whatever it's set up to do.`),
            p("Whenever you're back, everything will be waiting. And if you ever want help, just reply."),
            button("Open Zealoop", `${APP}/dashboard`),
        ],
        reason: REASON,
    }),
];

module.exports = { RESULTS };

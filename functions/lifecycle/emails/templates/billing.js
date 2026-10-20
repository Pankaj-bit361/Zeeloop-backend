"use strict";
// Billing: receipts of what changed, the three dunning notices, and the end of a plan.
const { APP, b, button, buttons, callout, details, lead, p, points, signature, small } = require("../layout");
const { hi, t } = require("./types");

const REASON = "You're getting this because of a change to your Zealoop subscription.";

const BILLING = [
    t("subscription-started", "Subscription started", "transactional", "billing.subscription_started", "Welcome to {{plan_name}}", {
        preheader: "{{limit_label}}, everything in the plan unlocked. Thank you.",
        eyebrow: "Subscription",
        heading: "{{workspace}} is on {{plan_name}}.",
        tint: "teal",
        body: [
            lead(hi),
            p(`Thank you — ${b("{{workspace}}")} is now on ${b("{{plan_name}}")}. Everything in the plan is unlocked from this moment.`),
            details([["Plan", "{{plan_name}}"], ["Included", "{{limit_label}}"], ["Renews", "{{renews_on}}"]]),
            p("Invoices and payment details live on the Billing page, along with your usage this period."),
            button("Open billing", `${APP}/billing`),
            small("Questions about an invoice? Reply to this email."),
        ],
        reason: REASON,
    }),

    t("plan-upgraded", "Plan upgraded", "transactional", "billing.plan_upgraded", "You've moved up to {{plan_name}}", {
        preheader: "From {{from_plan}} to {{plan_name}}: {{limit_label}}.",
        eyebrow: "Subscription",
        heading: "Upgraded to {{plan_name}}.",
        tint: "teal",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} moved from {{from_plan}} to ${b("{{plan_name}}")}. The new limit and features apply now.`),
            details([["From", "{{from_plan}}"], ["To", "{{plan_name}}"], ["Included", "{{limit_label}}"]]),
            button("See what's included", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("plan-downgraded", "Plan changed", "transactional", "billing.plan_downgraded", "Your plan is changing to {{plan_name}}", {
        preheader: "From {{from_plan}} to {{plan_name}}. Here's what that means for the workspace.",
        eyebrow: "Subscription",
        heading: "Moving to {{plan_name}}.",
        tint: "sand",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} is moving from {{from_plan}} to ${b("{{plan_name}}")} ({{limit_label}}).`),
            p("If the new plan doesn't include something you use — procedures, the email channel, more seats — those pause rather than disappear. Your setup stays, ready if you move back."),
            button("Review your plan", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("payment-failed-1", "Payment failed", "transactional", "billing.payment_failed", "We couldn't take payment for {{workspace}}", {
        preheader: "Nothing is suspended. You have {{grace_days}} days to update your card.",
        eyebrow: "Billing",
        heading: "Your payment didn't go through.",
        tint: "sand",
        body: [
            lead(hi),
            p(`We couldn't collect the payment for ${b("{{workspace}}")} on {{plan_name}}. That's usually an expired card or a bank declining a foreign charge.`),
            callout("tip", "Nothing is suspended", "Your agent keeps working normally until {{grace_ends_on}}. Update the payment method any time before then."),
            button("Update payment method", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("payment-failed-2", "Payment still failing", "transactional", "billing.payment_failed", "Reminder: payment for {{workspace}} is still failing", {
        preheader: "Update your card before {{grace_ends_on}} to keep {{plan_name}}.",
        eyebrow: "Billing · Reminder",
        heading: "Your payment is still failing.",
        tint: "clay",
        body: [
            lead(hi),
            p(`The payment for ${b("{{workspace}}")} still hasn't gone through. If it isn't sorted by ${b("{{grace_ends_on}}")}, the workspace moves to the Free plan: 50 conversations a month, with tables and actions paused.`),
            button("Update payment method", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("payment-failed-3", "Payment final notice", "transactional", "billing.payment_failed", "Final notice: {{workspace}} moves to Free on {{grace_ends_on}}", {
        preheader: "Two days left to update your payment method.",
        eyebrow: "Billing · Final notice",
        heading: "Two days to keep {{plan_name}}.",
        tint: "clay",
        body: [
            lead(hi),
            p(`This is the last reminder. On ${b("{{grace_ends_on}}")}, ${b("{{workspace}}")} moves to the Free plan unless the payment goes through. Nothing is deleted, but actions, tables and the higher limit stop.`),
            button("Update payment method", `${APP}/billing`),
            small("Already sorted? Ignore this — it can cross with a successful payment."),
        ],
        reason: REASON,
    }),

    t("payment-recovered", "Payment received", "transactional", "billing.recovered", "Payment received — {{workspace}} is all set", {
        preheader: "Thanks for sorting it. Nothing changed for your visitors.",
        eyebrow: "Billing",
        heading: "Payment received, thank you.",
        tint: "teal",
        body: [
            lead(hi),
            p(`The payment for ${b("{{workspace}}")} on {{plan_name}} went through. Everything carries on as normal, and the reminders stop here.`),
            button("Open billing", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("cancel-scheduled", "Cancellation scheduled", "transactional", "billing.cancel_scheduled", "Your {{plan_name}} plan ends on {{ends_on}}", {
        preheader: "Everything keeps working until then. Change your mind any time before.",
        eyebrow: "Subscription",
        heading: "Cancellation confirmed.",
        tint: "stone",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} stays on ${b("{{plan_name}}")} until ${b("{{ends_on}}")}, then moves to the Free plan. You've paid through then, so nothing changes before it.`),
            points([
                "Your content, rules, conversations and widget all stay.",
                "Tables, actions and procedures pause on the Free plan, ready if you come back.",
            ], "sand"),
            p("If you have a minute, reply and tell me why you're leaving. It genuinely shapes what we build next."),
            button("Keep my plan", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("subscription-ended", "Subscription ended", "transactional", "billing.subscription_ended", "{{workspace}} has moved to the Free plan", {
        preheader: "Your agent still answers. Here's what changed.",
        eyebrow: "Subscription",
        heading: "{{workspace}} is on the Free plan.",
        tint: "stone",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")}'s {{plan_name}} plan has ended and the workspace is now on the Free plan. Your agent is still live and answering from your content.`),
            p("What changed: the limit is 50 conversations a month, and tables, actions, procedures and the email channel are paused. Nothing was deleted."),
            button("Reactivate", `${APP}/billing`),
        ],
        reason: REASON,
    }),

    t("winback", "Come back", "marketing", "billing.subscription_ended", "Your Zealoop setup is still here", {
        preheader: "Everything you built is waiting. Pick a plan and it's all back in a minute.",
        eyebrow: "A note from the founder",
        heading: "Everything you built is still here.",
        tint: "teal",
        body: [
            lead(hi),
            p(`It's been a few weeks since ${b("{{workspace}}")} moved to the Free plan. Your actions, tables and procedures are exactly where you left them — pick a plan and they're working again in a minute.`),
            p("And if something made Zealoop the wrong fit, I'd really like to hear it. Just reply."),
            buttons({ label: "See the plans", href: `${APP}/billing` }, { label: "Open your workspace", href: `${APP}/dashboard` }),
            signature(),
        ],
        reason: "You're getting this because you used to be on a paid Zealoop plan.",
    }),
];

module.exports = { BILLING };

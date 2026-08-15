const { EmailKind } = require("../../config/enums");

// Every transactional email in one file, as plain functions returning
// { subject, text }. No HTML: these are short operational notices, and an
// HTML-only email that renders as blank in a text client is a bug with no
// upside for a message this short.
//
// Kept out of emailFunctions so the sending mechanics and the words are
// separately readable — and so a copy change is a diff nobody has to review for
// delivery correctness.

function _plan(planName) {
    return planName || "your plan";
}

const TEMPLATES = {
    [EmailKind.TRIAL_ENDING_7]: ({ orgName, daysLeft, appUrl }) => ({
        subject: `${daysLeft} days left on your Zealoop trial`,
        text: [
            `Hi,`,
            ``,
            `Your Zealoop trial for ${orgName} has ${daysLeft} days left.`,
            ``,
            `Nothing breaks when it ends — the workspace drops to the Free plan and keeps answering, just with a lower conversation limit and without tables or actions.`,
            ``,
            `Pick a plan whenever you're ready: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.TRIAL_ENDING_2]: ({ orgName, daysLeft, appUrl }) => ({
        subject: `Your Zealoop trial ends in ${daysLeft} days`,
        text: [
            `Hi,`,
            ``,
            `${orgName}'s trial ends in ${daysLeft} days.`,
            ``,
            `If you've connected tables or actions, those are the parts that pause on the Free plan — your knowledge base and the widget keep working.`,
            ``,
            `Choose a plan: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.TRIAL_ENDED]: ({ orgName, appUrl }) => ({
        subject: `${orgName} is now on the Free plan`,
        text: [
            `Hi,`,
            ``,
            `The trial has ended and ${orgName} has moved to the Free plan. Your agent is still live and still answering.`,
            ``,
            `What changed: a lower monthly conversation limit, and tables and actions are paused until you upgrade. Nothing was deleted.`,
            ``,
            `Upgrade any time: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.PAYMENT_FAILED]: ({ orgName, graceDays, appUrl }) => ({
        subject: `Payment failed for ${orgName}`,
        text: [
            `Hi,`,
            ``,
            `We couldn't process the payment for ${orgName}.`,
            ``,
            `Your workspace keeps working normally for the next ${graceDays} days while you sort it out — nothing is suspended today.`,
            ``,
            `Update your payment method: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.DUNNING_REMINDER]: ({ orgName, daysLeft, appUrl }) => ({
        subject: `Action needed: ${orgName} payment still failing`,
        text: [
            `Hi,`,
            ``,
            `The payment for ${orgName} is still failing. You have ${daysLeft} days left before the workspace drops to the Free plan.`,
            ``,
            `Update your payment method: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.SUBSCRIPTION_SUSPENDED]: ({ orgName, appUrl }) => ({
        subject: `${orgName} has moved to the Free plan`,
        text: [
            `Hi,`,
            ``,
            `We weren't able to collect payment for ${orgName}, so the workspace has moved to the Free plan.`,
            ``,
            `Your agent is still answering and nothing has been deleted. Tables and actions are paused, and the monthly conversation limit is lower.`,
            ``,
            `Reactivate whenever you like: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.QUOTA_WARNING]: ({ orgName, used, limit, planName, appUrl }) => ({
        subject: `${orgName} has used ${Math.round((used / limit) * 100)}% of this month's conversations`,
        text: [
            `Hi,`,
            ``,
            `${orgName} has used ${used} of ${limit} conversations on ${_plan(planName)} this billing period.`,
            ``,
            `At the limit, the agent tells visitors that someone will follow up rather than answering — so this is worth a look before it gets there.`,
            ``,
            `Usage and plans: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.QUOTA_EXCEEDED]: ({ orgName, limit, appUrl }) => ({
        subject: `${orgName} has hit its conversation limit`,
        text: [
            `Hi,`,
            ``,
            `${orgName} has used all ${limit} conversations for this billing period.`,
            ``,
            `Your agent is now telling visitors that the team will follow up, instead of answering. Their questions are still being recorded, so nothing is lost.`,
            ``,
            `Raise the limit: ${appUrl}/app/settings/billing`,
        ].join("\n"),
    }),

    [EmailKind.ESCALATION_NOTICE]: ({ orgName, conversationId, lastMessage, ruleTitle, appUrl }) => ({
        subject: `Zealoop escalation — ${orgName}`,
        text: [
            `A conversation has been escalated${ruleTitle ? ` by the rule "${ruleTitle}"` : ""}.`,
            ``,
            `Last message from the customer:`,
            `> ${String(lastMessage || "").slice(0, 500)}`,
            ``,
            `Open it: ${appUrl}/app/inbox/${conversationId}`,
        ].join("\n"),
    }),

    [EmailKind.AGENT_REPLY]: ({ agentName, orgName, reply, conversationId }) => ({
        subject: null, // set by the caller — replies keep the thread's subject
        text: [
            reply,
            ``,
            `—`,
            `${agentName || "Support"} · ${orgName}`,
            `Reply to this email and it lands back in the same conversation.`,
            `[ref:${conversationId}]`,
        ].join("\n"),
    }),
};

function render({ kind, data }) {
    const template = TEMPLATES[kind];
    if (!template) return null;
    return template(data || {});
}

module.exports = { TEMPLATES, render };

"use strict";
const config = require("../../config/config");
const Account = require("../../models/user/account");

// Business alerts in #zealoop-alerts: the customer moments the team wants to
// see as they happen (a signup, a workspace, the first visitor, a payment, a
// cancellation, a workspace that hit a wall). An incoming webhook,
// ALERT_WEBHOOK_URL, posts Block Kit messages.
//
// Most alerts ride on lifecycle events: client.announce() calls sendAlert()
// once Volanea has accepted an allow-listed event, so they inherit its "once"
// (milestone flags, conditional updates, state transitions). The rest call
// sendAlert() from where the moment happens:
//   conversation.first_visitor  productAnalytics/events.js, the first real visitor conversation
//   payment.succeeded/failed    billingFunctions.processWebhook, once per webhook ledger row
//
// Never throws and never holds the caller. Off without ALERT_WEBHOOK_URL (local
// dev, tests) and with SLACK_ALERTS=off. Seed/test workspaces on reserved
// domains are skipped, like announce() skips them. The URL is never logged.
// Email and name are fine in this internal channel; message content, tokens
// and card data never go in.

const TIMEOUT_MS = 5_000;

function alertsEnabled() {
    return !!config.ALERT_WEBHOOK_URL && config.SLACK_ALERTS !== "off";
}

const METHODS = { PASSWORD: "Email", GOOGLE: "Google", GITHUB: "GitHub" };

// The allow-list: event → header and the event-specific fields. Name, Email,
// Workspace and Plan are added to every alert that has them.
const ALERTS = {
    "user.signed_up": { emoji: "🆕", title: "New signup", fields: (d, account) => [["Method", account && METHODS[(account.providers || [])[0]]]] },
    "workspace.created": { emoji: "🚀", title: "Workspace created", fields: () => [] },
    "widget.installed": { emoji: "🌐", title: "Widget installed", fields: (d) => [["Site", d.site]] },
    "knowledge.first_ready": { emoji: "🌐", title: "First knowledge source ready", fields: (d) => [["Source", d.source_name], ["Indexed", d.chunks_label]] },
    "conversation.first_visitor": { emoji: "⭐", title: "First visitor conversation", fields: (d) => [["Channel", d.channel]] },
    "payment.succeeded": { emoji: "💰", title: "Payment received", fields: (d) => [["Amount", d.amount]] },
    "billing.plan_upgraded": { emoji: "💰", title: "Plan upgraded", fields: (d) => [["From", d.from_plan]] },
    "payment.failed": { emoji: "❌", title: "Payment failed", fields: (d) => [["Amount", d.amount]] },
    "billing.plan_downgraded": { emoji: "❌", title: "Plan downgraded", fields: (d) => [["From", d.from_plan]] },
    "billing.cancel_scheduled": { emoji: "❌", title: "Subscription cancelled", fields: (d) => [["Ends", d.ends_on]] },
    "billing.subscription_ended": { emoji: "❌", title: "Subscription ended", fields: (d) => [["Was on", d.plan_name]] },
    "trial.ended": { emoji: "❌", title: "Trial ended without paying", fields: (d) => [["Conversations", d.conversations]] },
    "usage.quota_reached": { emoji: "⚠️", title: "Conversation quota reached", fields: (d) => [["Limit", d.limit_label], ["Resets", d.resets_on]] },
    "usage.cost_ceiling": { emoji: "⚠️", title: "Cost ceiling reached", fields: (d) => [["Resets", d.resets_on]] },
    "knowledge.source_failed": { emoji: "⚠️", title: "Knowledge source failed", fields: (d) => [["Source", d.source_name]] },
};

const isAlerted = (event) => Object.prototype.hasOwnProperty.call(ALERTS, event);

// The Block Kit message plus a plain `text` fallback for notifications.
function messageFor(event, email, data, contact, { orgId } = {}, account = null) {
    const spec = ALERTS[event];
    const title = `${spec.emoji} ${spec.title}`;
    const name = (account && account.name) || contact.firstName;
    const fields = [["Name", name], ["Email", email], ["Workspace", contact.workspace], ["Plan", contact.plan_name], ...spec.fields(data, account)]
        .filter(([, value]) => value !== undefined && value !== null && value !== "");
    const blocks = [
        { type: "header", text: { type: "plain_text", text: title, emoji: true } },
        // Slack allows ten fields per section.
        { type: "section", fields: fields.slice(0, 10).map(([label, value]) => ({ type: "mrkdwn", text: `*${label}*\n${value}` })) },
    ];
    if (orgId) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${config.APP_URL.replace(/\/+$/, "")}/admin/workspaces/${orgId}|Open in admin>` }] });
    const text = `${title}: ${[contact.workspace, email].filter(Boolean).join(" · ")}`;
    return { text, blocks };
}

// Posts one alert for an allow-listed event. Returns whether Slack took it.
async function sendAlert(email, event, data = {}, contact = {}, meta = {}) {
    // Required here, not at the top: client.js requires this file for announce().
    const { isReservedAddress } = require("./client");
    if (!alertsEnabled() || !isAlerted(event) || !email || isReservedAddress(email)) return false;
    try {
        const account = await Account.findOne({ email: String(email).toLowerCase() }).select("name providers").lean();
        const response = await fetch(config.ALERT_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messageFor(event, email, data, contact, meta, account)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) console.log(`SlackAlerts: ${event} refused by Slack: HTTP ${response.status}`);
        return response.ok;
    } catch (error) {
        console.log(`SlackAlerts: ${event} could not be posted; the caller is unaffected:`, error.message);
        return false;
    }
}

// Fire-and-forget form for callers on a request path.
function alertLater(email, event, data, contact, meta) {
    void sendAlert(email, event, data, contact, meta);
}

module.exports = { alertsEnabled, isAlerted, messageFor, sendAlert, alertLater, ALERTS };

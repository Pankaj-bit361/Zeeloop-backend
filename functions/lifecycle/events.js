"use strict";
// Every event this backend announces to the "Zealoop" project in Volanea, and
// the data fields each carries. This is the contract between the code that
// fires events (hooks.js, sweep.js, the billing and usage paths) and the
// templates that use them (emails/templates): a test fails if a template asks
// for a field its event doesn't send.
//
// Values are always pre-formatted strings ("1,240 conversations", "Nov 3"):
// Volanea's template engine fills placeholders but has no logic, so plurals,
// dates and percentages are written here, never in a template.
//
// Names must not start with email., contact., segment. or workflow. — Volanea
// reserves those for its own events and refuses them.

const EVENTS = {
    /* getting started */
    "user.signed_up": [],
    "workspace.created": ["workspace", "trial_days", "trial_ends_on"],
    "knowledge.first_ready": ["source_name", "chunks_label"],
    "knowledge.source_failed": ["source_name", "error"],
    "widget.installed": ["site"],
    "conversation.first": ["preview"],
    "escalation.first": ["preview", "conversation_url"],
    "action.first_live": ["action_name"],
    "table.first_created": ["table_name", "rows_label"],
    "procedure.first_live": ["procedure_name"],
    "email_channel.first_received": ["from_address"],
    "account.day_3": [],
    "account.day_7": [],
    "account.day_12": [],
    "account.day_30": [],

    /* trial */
    "trial.ending_7": ["days_left", "trial_ends_on", "conversations_label"],
    "trial.ending_2": ["days_left", "trial_ends_on", "conversations_label"],
    "trial.ended": ["conversations", "resolved_pct"],

    /* team and security */
    "member.invited": ["inviter_name", "workspace", "role", "action_url"],
    "member.joined": ["member_email", "role", "workspace"],
    "member.removed": ["workspace"],
    "security.password_changed": ["changed_at"],
    "security.widget_secret_rotated": ["workspace", "changed_at", "actor_email", "grace_until"],
    "security.agent_connected": ["client", "workspace"],
    "workspace.suspended": ["workspace", "reason"],
    "workspace.reinstated": ["workspace"],

    /* usage and health */
    "usage.quota_near": ["used_label", "limit_label", "percent", "resets_on"],
    "usage.quota_reached": ["limit_label", "resets_on"],
    "usage.cost_ceiling": ["resets_on"],
    "usage.heavy_free": ["used_label", "limit_label"],
    "widget.silent": ["site", "last_seen_on"],
    "action.failing": ["action_name", "failures_label", "last_error"],

    /* billing */
    "billing.subscription_started": ["plan_name", "limit_label", "renews_on"],
    "billing.plan_upgraded": ["from_plan", "plan_name", "limit_label"],
    "billing.plan_downgraded": ["from_plan", "plan_name", "limit_label"],
    "billing.payment_failed": ["plan_name", "grace_days", "grace_ends_on"],
    "billing.recovered": ["plan_name"],
    "billing.cancel_scheduled": ["plan_name", "ends_on"],
    "billing.subscription_ended": ["plan_name"],

    /* results and staying in touch */
    "milestone.conversations": ["count_label"],
    "digest.weekly": ["week_label", "conversations", "conversations_label", "resolved_pct", "escalated", "handoffs_note"],
    "report.monthly": ["month", "conversations", "conversations_label", "resolved_pct", "escalated", "hours", "hours_label"],
    "account.anniversary": ["years_label", "conversations_label"],
    "feedback.ask": [],
    "user.inactive_14d": ["conversations_label"],
    "user.inactive_30d": ["conversations_label"],
    "user.inactive_60d": [],
};

// Sent as contact fields with every event, so workflows can branch on them
// (`data.plan_tier`) and templates can greet by name.
const CONTACT_FIELDS = ["firstName", "workspace", "plan_name", "plan_tier", "role"];

const RESERVED_PREFIXES = ["email.", "contact.", "segment.", "workflow."];

module.exports = { EVENTS, CONTACT_FIELDS, RESERVED_PREFIXES };

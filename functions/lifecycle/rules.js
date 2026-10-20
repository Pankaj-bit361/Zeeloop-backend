"use strict";
const { num, plural, pct, shortDate } = require("./client");

// What's due for one workspace, from a snapshot of its state and what it has
// already been told. Pure: no database, no clock but `now`, so every rule is
// tested directly.
//
// Returns { send, silent }:
//   send    events to announce; each has a `key` that, once Volanea accepts it,
//           is flagged on the workspace so it never goes again;
//   silent  keys to flag without a word — a milestone made moot (a smaller one
//           behind a bigger one), or everything already true the first time
//           an older workspace is seen.
//
// Spacing: notices (trial, failures, reports) always go. Tips and milestones
// go at most one per workspace every 20 hours, so a busy first day reads as a
// conversation rather than a pile.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIP_SPACING_MS = 20 * HOUR;
const BASELINE_AGE_MS = 2 * DAY;
const CONVERSATION_MILESTONES = [100, 1_000, 10_000, 100_000];
// Minutes a human would have spent on a conversation the agent resolved.
const MINUTES_SAVED_PER_RESOLUTION = 6;

const dayKey = (date) => new Date(date).toISOString().slice(0, 10);
const monthKey = (date) => new Date(date).toISOString().slice(0, 7);
const clip = (text, max = 160) => {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

function dueEvents(s, state, now) {
    const flags = state.flags || {};
    const told = (key) => Boolean(flags[key]);
    const age = now - new Date(s.createdAt);
    const candidates = [];
    const silent = [];
    const add = (key, event, data, tip) => {
        if (!told(key)) candidates.push({ key, event, data, tip });
    };

    /* ── getting started ── */
    if (s.firstReadySource) add("knowledge.first_ready", "knowledge.first_ready", { source_name: s.firstReadySource.name, chunks_label: plural(s.firstReadySource.chunks, "passage") }, true);
    if (s.widget.installed) add("widget.installed", "widget.installed", { site: s.widget.origin || "your site" }, true);
    if (s.firstConversation) add("conversation.first", "conversation.first", { preview: clip(s.firstConversation.preview) || "A visitor started a conversation." }, true);
    if (s.firstEscalation) add("escalation.first", "escalation.first", { preview: clip(s.firstEscalation.preview) || "A visitor asked for a person.", conversation_url: s.firstEscalation.url }, true);
    if (s.liveAction) add("action.first_live", "action.first_live", { action_name: s.liveAction.name }, true);
    if (s.firstTable) add("table.first_created", "table.first_created", { table_name: s.firstTable.name, rows_label: plural(s.firstTable.rows, "row") }, true);
    if (s.liveProcedure) add("procedure.first_live", "procedure.first_live", { procedure_name: s.liveProcedure.name }, true);
    if (s.firstEmailConversation) add("email_channel.first_received", "email_channel.first_received", { from_address: s.firstEmailConversation.from || "a customer" }, true);

    // Check-ins, each inside a window so a workspace first seen later never gets an old one.
    for (const [day, window] of [[3, 2], [7, 2], [12, 3], [30, 5]]) {
        if (age >= day * DAY && age < (day + window) * DAY) add(`account.day_${day}`, `account.day_${day}`, {}, true);
    }

    /* ── trial ── */
    if (s.tier === "trial" && s.trialEndsAt) {
        const daysLeft = Math.ceil((new Date(s.trialEndsAt) - now) / DAY);
        const ref = dayKey(s.trialEndsAt);
        const data = { days_left: plural(daysLeft, "day"), trial_ends_on: shortDate(s.trialEndsAt), conversations_label: plural(s.conversationsTotal, "conversation") };
        if (daysLeft > 2 && daysLeft <= 7) add(`trial.ending_7:${ref}`, "trial.ending_7", data, false);
        if (daysLeft > 0 && daysLeft <= 2) add(`trial.ending_2:${ref}`, "trial.ending_2", data, false);
    }

    /* ── usage and health ── */
    if (s.tier === "free" && s.usage.limit) {
        const ratio = s.usage.conversations / s.usage.limit;
        if (ratio >= 0.9 && ratio < 1) add("usage.heavy_free", "usage.heavy_free", { used_label: plural(s.usage.conversations, "conversation"), limit_label: plural(s.usage.limit, "conversation") }, true);
    }

    for (const source of s.failedSources) {
        if (!(state.failedSources || []).includes(source.sourceId)) {
            add(`knowledge.source_failed:${source.sourceId}:${dayKey(now)}`, "knowledge.source_failed", { source_name: source.name, error: clip(source.error, 200) || "The source could not be read." }, false);
        }
    }

    // Silent for a week, but seen within the month: a widget that just stopped, not one abandoned long ago.
    if (s.widget.installed && s.widget.lastSeenAt) {
        const quiet = now - new Date(s.widget.lastSeenAt);
        if (quiet >= 7 * DAY && quiet < 30 * DAY) {
            add(`widget.silent:${dayKey(s.widget.lastSeenAt)}`, "widget.silent", { site: s.widget.origin || "your site", last_seen_on: shortDate(s.widget.lastSeenAt) }, false);
        }
    }

    const week = Math.floor(now / (7 * DAY));
    for (const action of s.failingActions) {
        add(`action.failing:${action.actionId}:${week}`, "action.failing", { action_name: action.name, failures_label: plural(action.failures, "failed call"), last_error: clip(action.lastError, 200) || "The endpoint returned an error." }, false);
    }

    /* ── results ── */
    const crossed = CONVERSATION_MILESTONES.filter((m) => s.conversationsTotal >= m);
    if (crossed.length) {
        const top = crossed[crossed.length - 1];
        add(`milestone.conversations:${top}`, "milestone.conversations", { count_label: plural(top, "conversation") }, true);
        for (const m of crossed.slice(0, -1)) if (!told(`milestone.conversations:${m}`)) silent.push(`milestone.conversations:${m}`);
    }

    if (now.getUTCDay() === 1 && now.getUTCHours() >= 9 && s.week && s.week.conversations > 0) {
        const escalated = s.week.escalated;
        add(`digest.weekly:${dayKey(now)}`, "digest.weekly", {
            week_label: `${shortDate(new Date(now - 7 * DAY))} – ${shortDate(new Date(now - DAY))}`,
            conversations: num(s.week.conversations),
            conversations_label: plural(s.week.conversations, "conversation"),
            resolved_pct: pct(s.week.resolved / s.week.conversations),
            escalated: num(escalated),
            handoffs_note: escalated ? "Each one is waiting in the inbox with the full thread." : "Nothing needed a person this week.",
        }, false);
    }

    if (now.getUTCDate() <= 3 && s.previousMonth && s.previousMonth.conversations > 0) {
        const m = s.previousMonth;
        const hours = Math.round((m.resolved * MINUTES_SAVED_PER_RESOLUTION) / 60);
        add(`report.monthly:${m.key}`, "report.monthly", {
            month: m.label,
            conversations: num(m.conversations),
            conversations_label: plural(m.conversations, "conversation"),
            resolved_pct: pct(m.resolved / m.conversations),
            escalated: num(m.escalated),
            hours: num(hours),
            hours_label: plural(hours, "hour"),
        }, false);
    }

    const years = Math.floor(age / (365 * DAY));
    if (years >= 1 && age - years * 365 * DAY < 7 * DAY) {
        add(`account.anniversary:${years}`, "account.anniversary", { years_label: plural(years, "year"), conversations_label: plural(s.conversationsTotal, "conversation") }, true);
    }

    if (age >= 21 * DAY && s.conversationsTotal >= 25) add("feedback.ask", "feedback.ask", {}, true);

    // Nobody has opened the dashboard for a while. Only the longest gap crossed
    // is told; keyed to the last visit, so a return re-arms it.
    if (s.lastActiveAt) {
        const away = now - new Date(s.lastActiveAt);
        const ref = dayKey(s.lastActiveAt);
        const gaps = [[60, "user.inactive_60d"], [30, "user.inactive_30d"], [14, "user.inactive_14d"]].filter(([days]) => away >= days * DAY);
        if (gaps.length) {
            const [, event] = gaps[0];
            add(`${event}:${ref}`, event, event === "user.inactive_60d" ? {} : { conversations_label: plural(s.conversationsSinceActive, "conversation") }, true);
            for (const [, smaller] of gaps.slice(1)) if (!told(`${smaller}:${ref}`)) silent.push(`${smaller}:${ref}`);
        }
    }

    /* ── baseline and spacing ── */
    if (!state.baselinedAt && age > BASELINE_AGE_MS) {
        return { send: [], silent: [...silent, ...candidates.map((c) => c.key)] };
    }

    const send = [];
    let lastTip = state.lastTipAt ? new Date(state.lastTipAt).getTime() : 0;
    for (const candidate of candidates) {
        if (candidate.tip) {
            if (now - lastTip < TIP_SPACING_MS) continue;
            lastTip = now.getTime();
        }
        send.push(candidate);
    }
    return { send, silent };
}

module.exports = { dueEvents, TIP_SPACING_MS, CONVERSATION_MILESTONES, MINUTES_SAVED_PER_RESOLUTION, monthKey };

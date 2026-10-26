"use strict";
const config = require("../../config/config");

// Sends a lifecycle event about one of our customers to the "Zealoop" project
// in Volanea, over its public /v1/events API. The workflows there decide what
// to send and when.
//
// Never throws and never holds the caller for long: a signup, a payment or a
// conversation must not fail because our own lifecycle mail is down. Returns
// whether Volanea accepted the event, so the sweep only records a milestone as
// told once it really was.
//
// A no-op without VOLANEA_LIFECYCLE_KEY (local dev, CI, tests that don't opt in).

const TIMEOUT_MS = 5_000;

function lifecycleEnabled() {
    return !!config.VOLANEA_LIFECYCLE_KEY && config.LIFECYCLE_EMAILS !== "off";
}

// Domains reserved for documentation and testing (RFC 2606 / RFC 6761). No one
// can receive mail there — example.com publishes a null MX — so a workspace
// owned by one is a seed or test account, and mailing it only buys a bounce
// that counts against our sender reputation.
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;

function isReservedAddress(email) {
    const domain = String(email).split("@").pop().trim();
    return RESERVED_DOMAIN.test(domain);
}

async function announce(email, event, data = {}, contact = {}) {
    if (!lifecycleEnabled() || !email || isReservedAddress(email)) return false;
    const { firstName, lastName, ...custom } = contact;
    try {
        const response = await fetch(`${config.VOLANEA_API_URL.replace(/\/+$/, "")}/v1/events`, {
            method: "POST",
            headers: { Authorization: `Bearer ${config.VOLANEA_LIFECYCLE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                name: event,
                email,
                data,
                // Who they are lands on the contact (templates read {{firstName}}
                // off it, workflow conditions read data.plan_tier); what happened
                // stays on the event.
                contact: {
                    ...(firstName !== undefined ? { firstName: firstName || null } : {}),
                    ...(lastName !== undefined ? { lastName: lastName || null } : {}),
                    data: Object.fromEntries(Object.entries(custom).filter(([, value]) => value !== undefined && value !== null)),
                },
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) console.log(`Lifecycle: ${event} refused by Volanea: HTTP ${response.status}`);
        return response.ok;
    } catch (error) {
        console.log(`Lifecycle: ${event} could not be sent; the caller is unaffected:`, error.message);
        return false;
    }
}

// Fire-and-forget form for inline hooks.
function announceLater(email, event, data, contact) {
    void announce(email, event, data, contact);
}

// ── Formatting: every field arrives already written ──────────────────

const numberFormat = new Intl.NumberFormat("en-US");
// "1 conversation", "1,240 conversations".
const plural = (n, one, many = `${one}s`) => `${numberFormat.format(n)} ${n === 1 ? one : many}`;
const num = (n) => numberFormat.format(n);
// 0.734 → "73%".
const pct = (ratio) => `${Math.round(ratio * 100)}%`;
// "Oct 20".
const shortDate = (date) => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
// "Oct 20, 2026 at 9:41 AM UTC".
const stamp = (date) => {
    const d = new Date(date);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC`;
};

module.exports = { lifecycleEnabled, isReservedAddress, announce, announceLater, plural, num, pct, shortDate, stamp };

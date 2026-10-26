"use strict";
const config = require("../../config/config");

// Product analytics on Mixpanel, sent from the server. The two events that
// matter happen here (an account is created; a workspace's agent answers its
// first real visitor, with no dashboard in sight), so they are tracked by the
// API and the dashboard's browser SDK is left to identity. The tracking plan
// is docs/ANALYTICS.md; the events themselves are in events.js.
//
// Rules this file enforces for every event:
//   - Consent first. Nothing is sent for anyone who has not accepted analytics
//     (Account.analyticsConsent === "granted"). The banner on zealoop.com and
//     app.zealoop.com leaves a `zealoop_consent` cookie on .zealoop.com that
//     the API reads (consentFromCookies) and stores on the account.
//   - Only the account id identifies a person (`acc_…`). Never an email or a
//     name, and no conversation content.
//   - No IP address: every event is sent with ip=0, so none carries a location.
//   - Never throws and never holds the caller: a broken analytics call must not
//     fail a sign-up or a visitor's reply.
//   - Only production sends anything (config.MIXPANEL_TOKEN). Local runs and
//     tests are silent unless MIXPANEL_TOKEN is set on purpose.

const CONSENT_COOKIE = "zealoop_consent";
const TIMEOUT_MS = 5_000;

function analyticsEnabled() {
    return Boolean(config.MIXPANEL_TOKEN) && config.MIXPANEL_ENABLED !== "off";
}

// The analytics choice the request's cookies carry, or null when the visitor
// hasn't made one.
function consentFromCookies(cookies) {
    const value = cookies && cookies[CONSENT_COOKIE];
    return value === "granted" || value === "denied" ? value : null;
}

let warnedAt = 0;
// Once a minute at most: an outage at Mixpanel is a line in the log, not a flood.
function warn(message) {
    if (Date.now() - warnedAt < 60_000) return;
    warnedAt = Date.now();
    console.log(`ProductAnalytics: ${message}; the caller is unaffected`);
}

// Sends one event for an account that accepted analytics, and returns whether
// it went. `properties` are flat and non-personal; `insertId` makes a retried
// call a no-op in Mixpanel (one real-world event, one id).
function trackEvent({ accountId, consent, event, properties = {}, insertId }) {
    try {
        if (consent !== "granted" || !accountId || !analyticsEnabled()) return false;
        const body = [{ event, properties: { ...properties, token: config.MIXPANEL_TOKEN, distinct_id: accountId, $insert_id: insertId, time: Date.now() } }];
        fetch(`https://${config.MIXPANEL_HOST}/track?ip=0`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/plain" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        }).then(
            async (response) => {
                // Mixpanel answers 200 with "0" for an event it did not take.
                if (!response.ok || (await response.text()).trim() === "0") warn(`Mixpanel did not take ${event} (HTTP ${response.status})`);
            },
            (error) => warn(`${event} could not be sent: ${error.message}`),
        );
        return true;
    } catch (error) {
        warn(`${event} could not be sent: ${error.message}`);
        return false;
    }
}

module.exports = { CONSENT_COOKIE, analyticsEnabled, consentFromCookies, trackEvent };

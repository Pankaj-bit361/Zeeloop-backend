"use strict";
const Org = require("../../models/org/org");
const Member = require("../../models/org/member");
const Account = require("../../models/user/account");
const Conversation = require("../../models/conversation/conversation");
const { REAL } = require("../lifecycle/sweep");
const { analyticsEnabled, trackEvent } = require("./mixpanel");

// The product events Zealoop sends to Mixpanel (mixpanel.js holds the rules
// they all follow: consent first, the account id only, no personal data,
// never throws).
//
//   sign_up_completed             an account was created         sign_up_method, platform, is_invited
//   first_conversation_received   a workspace's agent answered   org_id, channel, days_since_signup
//                                 its first real visitor          (the Value Moment)
//
// Both are attributed to an account id, which is also what the dashboard
// passes to identify(), so the browser's anonymous visits and these server
// events end up on one person. Called without await from the code path where
// the thing happened.

const DAY = 86_400_000;

// Email sign-up, or the first Google/GitHub sign-in that creates the account.
function announceSignUp({ account, method }) {
    void (async () => {
        try {
            if (account.analyticsConsent !== "granted" || !analyticsEnabled()) return;
            // Someone who signed up to join a teammate's workspace already has a seat waiting.
            const invited = Boolean(await Member.exists({ email: account.email.toLowerCase() }));
            trackEvent({
                accountId: account.accountId,
                consent: account.analyticsConsent,
                event: "sign_up_completed",
                properties: { sign_up_method: method, platform: "web", is_invited: invited },
                insertId: `sign_up_completed:${account.accountId}`,
            });
        } catch (error) {
            console.log("ProductAnalytics: could not record sign_up_completed:", error.message);
        }
    })();
}

// Called after the first reply of every new conversation. Only the workspace's
// earliest real conversation counts: the same one the lifecycle sweep calls
// "conversation.first", evaluation runs excluded. So it fires once per
// workspace, and never for a workspace whose first conversation came before
// this code. Attributed to the workspace owner.
function announceFirstConversation({ orgId, conversationId, channel }) {
    void (async () => {
        try {
            if (!analyticsEnabled()) return;
            const first = await Conversation.findOne({ orgId, ...REAL }).sort({ createdAt: 1 }).select("conversationId").lean();
            if (!first || first.conversationId !== conversationId) return;
            const org = await Org.findOne({ orgId }).select("ownerEmail").lean();
            const owner = org && (await Account.findOne({ email: org.ownerEmail.toLowerCase() }).select("accountId analyticsConsent createdAt").lean());
            if (!owner) return;
            trackEvent({
                accountId: owner.accountId,
                consent: owner.analyticsConsent,
                event: "first_conversation_received",
                properties: {
                    org_id: orgId,
                    channel: String(channel || "CHAT").toLowerCase(),
                    days_since_signup: Math.floor((Date.now() - new Date(owner.createdAt)) / DAY),
                },
                insertId: `first_conversation_received:${orgId}`,
            });
        } catch (error) {
            console.log("ProductAnalytics: could not record first_conversation_received:", error.message);
        }
    })();
}

module.exports = { announceSignUp, announceFirstConversation };

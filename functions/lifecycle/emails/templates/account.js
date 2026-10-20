"use strict";
// Team and security: things that happened to a person or to their workspace's
// access. Every one is transactional except the welcome-to-the-team note.
const { APP, SUPPORT, b, button, callout, code, details, lead, p, points, small } = require("../layout");
const { hi, t } = require("./types");

const NOT_YOU = `If this wasn't you or someone on your team, reply to this email or write to ${SUPPORT} straight away.`;

const ACCOUNT = [
    t("member-invited", "Invitation", "transactional", "member.invited", "{{inviter_name}} invited you to {{workspace}} on Zealoop", {
        preheader: "Join as {{role}} to answer handoffs and help run the agent.",
        eyebrow: "Invitation",
        heading: "Join {{workspace}} on Zealoop",
        tint: "teal",
        body: [
            lead(hi),
            p(`${b("{{inviter_name}}")} added you to ${b("{{workspace}}")} as ${b("{{role}}")}. Zealoop is the AI agent that answers {{workspace}}'s customers — and hands conversations to people like you when it should.`),
            button("Accept the invitation", "{{action_url}}"),
            small("Sign in or create your account with this email address and the workspace appears in your list."),
        ],
        reason: "You're getting this because someone invited this address to a Zealoop workspace.",
    }),

    t("member-joined", "Teammate joined", "transactional", "member.joined", "{{member_email}} joined {{workspace}}", {
        preheader: "They've opened the workspace for the first time.",
        eyebrow: "Team",
        heading: "{{member_email}} joined {{workspace}}",
        tint: "sage",
        body: [
            lead(hi),
            p(`${b("{{member_email}}")} accepted the invitation and opened ${b("{{workspace}}")} as ${b("{{role}}")}.`),
            button("Manage the team", `${APP}/users`),
        ],
        reason: "You're getting this because you own this Zealoop workspace.",
    }),

    t("member-removed", "Removed from workspace", "transactional", "member.removed", "You no longer have access to {{workspace}}", {
        preheader: "An admin removed your seat. Your own account is untouched.",
        eyebrow: "Team",
        heading: "You've been removed from {{workspace}}",
        tint: "stone",
        body: [
            lead(hi),
            p(`Your seat in ${b("{{workspace}}")} on Zealoop was removed by one of its admins. Your account and any other workspaces you belong to are unaffected.`),
            p("If you think this was a mistake, ask the workspace's owner to invite you again."),
        ],
        reason: "You're getting this because your access to a Zealoop workspace changed.",
    }),

    t("password-changed", "Password changed", "transactional", "security.password_changed", "Your Zealoop password was changed", {
        preheader: "Every other session has been signed out.",
        eyebrow: "Security",
        heading: "Your password was changed",
        tint: "stone",
        body: [
            lead(hi),
            p("The password on your Zealoop account was just changed, and every other signed-in session was signed out."),
            details([["When", "{{changed_at}}"]]),
            callout("warn", "Wasn't you?", NOT_YOU),
        ],
        reason: "You're getting this because the password on your Zealoop account changed.",
    }),

    t("secret-rotated", "Widget secret rotated", "transactional", "security.widget_secret_rotated", "The identity secret for {{workspace}} was rotated", {
        preheader: "Update your server so signed visitor identities keep verifying.",
        eyebrow: "Security",
        heading: "The widget secret was rotated",
        tint: "sand",
        body: [
            lead(hi),
            p(`A new identity-verification secret was generated for ${b("{{workspace}}")}. The old one keeps working until ${b("{{grace_until}}")}, then stops.`),
            details([["Workspace", "{{workspace}}"], ["Rotated by", "{{actor_email}}"], ["When", "{{changed_at}}"]]),
            points([
                `Put the new secret wherever your server signs ${code("identify()")} payloads.`,
                "Deploy before the old secret expires, or identified visitors will be treated as anonymous.",
            ], "sand"),
            button("View the new secret", `${APP}/security`),
            callout("warn", "Wasn't you?", NOT_YOU),
        ],
        reason: "You're getting this because you own this Zealoop workspace.",
    }),

    t("agent-connected", "Agent connected", "transactional", "security.agent_connected", "{{client}} was connected to {{workspace}}", {
        preheader: "An MCP client can now read and change this workspace's setup.",
        eyebrow: "Security",
        heading: "An AI agent was connected",
        tint: "sky",
        body: [
            lead(hi),
            p(`${b("{{client}}")} was approved to manage ${b("{{workspace}}")} over MCP. It can add content, draft rules and wire up the widget on someone's behalf.`),
            p("You can see and revoke every connection under Security."),
            button("Review connections", `${APP}/security`),
            callout("warn", "Don't recognise it?", `Revoke it under Security, then ${NOT_YOU.charAt(0).toLowerCase()}${NOT_YOU.slice(1)}`),
        ],
        reason: "You're getting this because you own this Zealoop workspace.",
    }),

    t("workspace-suspended", "Workspace suspended", "transactional", "workspace.suspended", "{{workspace}} has been suspended", {
        preheader: "The widget, dashboard and API are paused. Nothing has been deleted.",
        eyebrow: "Account",
        heading: "{{workspace}} is suspended",
        tint: "clay",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} has been suspended following ${b("{{reason}}")}. While it is, the widget doesn't load and the dashboard and API refuse requests. Nothing has been deleted.`),
            p(`Reply to this email or write to ${SUPPORT} and we'll explain what happened and what's needed to restore it.`),
        ],
        reason: "You're getting this because you own this Zealoop workspace.",
    }),

    t("workspace-reinstated", "Workspace restored", "transactional", "workspace.reinstated", "{{workspace}} is active again", {
        preheader: "Everything is back exactly as it was.",
        eyebrow: "Account",
        heading: "{{workspace}} is back",
        tint: "teal",
        body: [
            lead(hi),
            p(`The suspension on ${b("{{workspace}}")} has been lifted. The widget, dashboard and API work again, with your content, rules and conversations exactly as they were.`),
            button("Open the workspace", `${APP}/dashboard`),
        ],
        reason: "You're getting this because you own this Zealoop workspace.",
    }),
];

module.exports = { ACCOUNT };

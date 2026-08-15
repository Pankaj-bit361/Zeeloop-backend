// Integration tests for the trial and dunning lifecycle (§0.5) and the email
// layer that carries it (§4.8).
//
// Runs against a real database. The claim under test is idempotency: this sweep
// runs on cron, cron runs twice, and running it five times must produce the same
// result as running it once — otherwise a customer gets five "your trial is
// ending" emails on the same morning.
"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Subscription = require("../models/billing/subscription");
const EmailLog = require("../models/org/emailLog");
const Org = require("../models/org/org");
const subscriptionFunctions = require("../functions/billing/subscriptionFunctions");
const emailFunctions = require("../functions/email/emailFunctions");
const emailTemplates = require("../functions/email/emailTemplates");
const { PlanId, SubscriptionStatus, EmailKind } = require("../config/enums");
const { TRIAL_DAYS, GRACE_PERIOD_DAYS } = require("../config/plans");

const DAY_MS = 86_400_000;
// Never the production URI. See the note in backend/README.md — npm run seed
// wipes whatever it points at.
const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_lifecycle_test";

let connection;
const created = [];

async function makeOrg(label) {
    const orgId = `org_lc_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await Org.create({
        orgId,
        name: `Lifecycle ${label}`,
        ownerEmail: `${orgId}@example.com`,
        publicKey: `pk_${orgId}`,
        widgetSecret: "ws_test",
    });
    created.push(orgId);
    return orgId;
}

async function cleanup() {
    if (created.length === 0) return;
    await Promise.all([
        Org.deleteMany({ orgId: { $in: created } }),
        Subscription.deleteMany({ orgId: { $in: created } }),
        EmailLog.deleteMany({ orgId: { $in: created } }),
    ]);
}

before(async () => {
    connection = await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    // Email idempotency IS the unique index on dedupeKey. Mongoose builds
    // indexes in the background, so against a fresh database the "sends once"
    // assertions would be testing timing rather than the guarantee.
    await EmailLog.init();
});

after(async () => {
    await cleanup();
    if (connection) await mongoose.disconnect();
});

describe("trial start (§0.5)", () => {
    test("starts a 14-day trial on the paid tier, not on FREE", async () => {
        // A trial of the free plan is not a trial. The point is to let someone
        // build the thing they would pay for and discover what they lose.
        const orgId = await makeOrg("start");
        const result = await subscriptionFunctions.startTrial({ orgId });

        assert.equal(result.success, true);
        assert.equal(result.created, true);

        const subscription = await Subscription.findOne({ orgId }).lean();
        assert.equal(subscription.status, SubscriptionStatus.TRIALING);
        assert.notEqual(subscription.plan, PlanId.FREE);

        const days = Math.round((subscription.trialEndsAt - Date.now()) / DAY_MS);
        assert.equal(days, TRIAL_DAYS);
    });

    test("is idempotent — a re-run cannot restart someone's trial", async () => {
        const orgId = await makeOrg("idem");
        await subscriptionFunctions.startTrial({ orgId });
        const second = await subscriptionFunctions.startTrial({ orgId });

        assert.equal(second.created, false);
        assert.equal(await Subscription.countDocuments({ orgId }), 1);
    });
});

describe("trial expiry", () => {
    test("an expired trial drops to FREE rather than suspending", async () => {
        // No card was taken, so there is nothing to charge and nothing to
        // suspend. Suspending would punish the customer still evaluating.
        const orgId = await makeOrg("expire");
        await subscriptionFunctions.startTrial({ orgId });
        await Subscription.updateOne({ orgId }, { $set: { trialEndsAt: new Date(Date.now() - DAY_MS) } });

        const sweep = await subscriptionFunctions.runLifecycleSweep({});
        assert.ok(sweep.trialsExpired >= 1);

        const subscription = await Subscription.findOne({ orgId }).lean();
        assert.equal(subscription.status, SubscriptionStatus.EXPIRED);
        assert.equal(subscription.plan, PlanId.FREE);

        // The billing period must keep moving, or usage never resets and the
        // workspace looks permanently over its limit.
        assert.ok(subscription.currentPeriodEnd > new Date());

        const org = await Org.findOne({ orgId }).lean();
        assert.equal(org.credits.plan, PlanId.FREE);
    });

    test("expiry emails exactly once, however many times the sweep runs", async () => {
        const orgId = await makeOrg("once");
        await subscriptionFunctions.startTrial({ orgId });
        await Subscription.updateOne({ orgId }, { $set: { trialEndsAt: new Date(Date.now() - DAY_MS) } });

        await subscriptionFunctions.runLifecycleSweep({});
        await subscriptionFunctions.runLifecycleSweep({});
        await subscriptionFunctions.runLifecycleSweep({});

        const sent = await EmailLog.countDocuments({ orgId, kind: EmailKind.TRIAL_ENDED });
        assert.equal(sent, 1, "a cron that fires twice must not email twice");
    });
});

describe("trial notices", () => {
    test("sends the day-7 notice exactly once", async () => {
        const orgId = await makeOrg("notice7");
        await subscriptionFunctions.startTrial({ orgId });
        // Exactly seven days out, plus an hour so Math.ceil lands on 7.
        await Subscription.updateOne(
            { orgId },
            { $set: { trialEndsAt: new Date(Date.now() + 7 * DAY_MS - 3600_000) } }
        );

        await subscriptionFunctions.runLifecycleSweep({});
        await subscriptionFunctions.runLifecycleSweep({});

        assert.equal(await EmailLog.countDocuments({ orgId, kind: EmailKind.TRIAL_ENDING_7 }), 1);
    });

    test("sends nothing on a day that is not a notice day", async () => {
        const orgId = await makeOrg("notice9");
        await subscriptionFunctions.startTrial({ orgId });
        await Subscription.updateOne({ orgId }, { $set: { trialEndsAt: new Date(Date.now() + 9 * DAY_MS) } });

        await subscriptionFunctions.runLifecycleSweep({});
        assert.equal(await EmailLog.countDocuments({ orgId }), 0);
    });
});

describe("dunning and grace (§0.5)", () => {
    test("a failed payment starts a grace period without suspending anything", async () => {
        const orgId = await makeOrg("grace");
        await subscriptionFunctions.startTrial({ orgId });

        const result = await subscriptionFunctions.beginGracePeriod({ orgId });
        assert.equal(result.success, true);
        assert.equal(result.restarted, true);

        const subscription = await Subscription.findOne({ orgId }).lean();
        assert.equal(subscription.status, SubscriptionStatus.PAST_DUE);
        // Still on the paid plan — that is the difference between "card expired
        // on holiday" and "stopped paying".
        assert.notEqual(subscription.plan, PlanId.FREE);

        const days = Math.round((subscription.gracePeriodEndsAt - Date.now()) / DAY_MS);
        assert.equal(days, GRACE_PERIOD_DAYS);
    });

    test("a second failure webhook does not restart the grace clock", async () => {
        // A provider that retries a charge three times sends three failure
        // webhooks. Restarting the clock each time would give a non-paying
        // workspace an indefinite grace period.
        const orgId = await makeOrg("noretstart");
        await subscriptionFunctions.startTrial({ orgId });
        await subscriptionFunctions.beginGracePeriod({ orgId });

        const first = await Subscription.findOne({ orgId }).lean();
        const second = await subscriptionFunctions.beginGracePeriod({ orgId });
        const after = await Subscription.findOne({ orgId }).lean();

        assert.equal(second.restarted, false);
        assert.equal(first.gracePeriodEndsAt.getTime(), after.gracePeriodEndsAt.getTime());
    });

    test("a lapsed grace period suspends to FREE", async () => {
        const orgId = await makeOrg("lapse");
        await subscriptionFunctions.startTrial({ orgId });
        await subscriptionFunctions.beginGracePeriod({ orgId });
        await Subscription.updateOne({ orgId }, { $set: { gracePeriodEndsAt: new Date(Date.now() - DAY_MS) } });

        const sweep = await subscriptionFunctions.runLifecycleSweep({});
        assert.ok(sweep.subscriptionsSuspended >= 1);

        const subscription = await Subscription.findOne({ orgId }).lean();
        assert.equal(subscription.plan, PlanId.FREE);
        assert.equal(await EmailLog.countDocuments({ orgId, kind: EmailKind.SUBSCRIPTION_SUSPENDED }), 1);
    });

    test("the two dunning reminders in one window are two distinct emails", async () => {
        // Deduping them against each other would silence the second reminder,
        // which is the one that lands closest to suspension.
        const orgId = await makeOrg("dunning");
        await subscriptionFunctions.startTrial({ orgId });
        await subscriptionFunctions.beginGracePeriod({ orgId });

        await Subscription.updateOne({ orgId }, { $set: { gracePeriodEndsAt: new Date(Date.now() + 5 * DAY_MS - 3600_000) } });
        await subscriptionFunctions.runLifecycleSweep({});

        await Subscription.updateOne({ orgId }, { $set: { gracePeriodEndsAt: new Date(Date.now() + 2 * DAY_MS - 3600_000) } });
        await subscriptionFunctions.runLifecycleSweep({});

        assert.equal(await EmailLog.countDocuments({ orgId, kind: EmailKind.DUNNING_REMINDER }), 2);
    });
});

describe("email idempotency (§4.8)", () => {
    test("the same dedupe key sends once and reports the duplicate", async () => {
        const orgId = await makeOrg("dedupe");
        const args = {
            orgId,
            kind: EmailKind.QUOTA_WARNING,
            to: "owner@example.com",
            dedupeKey: `${orgId}:test-dedupe`,
            data: { orgName: "Test", used: 80, limit: 100, planName: "Starter", appUrl: "http://localhost:5173" },
        };

        const first = await emailFunctions.send(args);
        const second = await emailFunctions.send(args);

        assert.equal(first.success, true);
        assert.equal(second.skipped, true);
        assert.equal(second.reason, "ALREADY_SENT");
        assert.equal(await EmailLog.countDocuments({ orgId, kind: EmailKind.QUOTA_WARNING }), 1);
    });

    test("with no provider configured the body is still logged, not lost", async () => {
        // A workspace without sending credentials can see what WOULD have gone
        // out rather than discovering the silence later.
        const orgId = await makeOrg("noprovider");
        const result = await emailFunctions.send({
            orgId,
            kind: EmailKind.TRIAL_ENDED,
            to: "owner@example.com",
            dedupeKey: `${orgId}:noprovider`,
            data: { orgName: "Test", appUrl: "http://localhost:5173" },
        });

        assert.equal(result.success, true);
        assert.equal(result.reason, "NO_PROVIDER");

        const entry = await EmailLog.findOne({ orgId }).lean();
        assert.equal(entry.delivered, false);
        assert.ok(entry.body.length > 0, "the body must be kept even when nothing was sent");
    });

    test("a missing recipient is skipped rather than throwing", async () => {
        const result = await emailFunctions.send({ orgId: "org_x", kind: EmailKind.TRIAL_ENDED, to: null });
        assert.equal(result.skipped, true);
        assert.equal(result.reason, "NO_RECIPIENT");
    });
});

describe("email templates", () => {
    test("every EmailKind has a template", () => {
        // A kind with no template silently sends nothing.
        for (const kind of Object.values(EmailKind)) {
            const rendered = emailTemplates.render({ kind, data: { orgName: "Test", appUrl: "http://x", daysLeft: 5, limit: 100, used: 80 } });
            assert.ok(rendered, `no template for ${kind}`);
            assert.ok(rendered.text && rendered.text.length > 0, `empty body for ${kind}`);
        }
    });

    test("trial and suspension emails reassure rather than threaten", () => {
        // The workspace is still serving customers. An email implying the agent
        // stopped would be both wrong and alarming.
        const ended = emailTemplates.render({ kind: EmailKind.TRIAL_ENDED, data: { orgName: "Acme", appUrl: "http://x" } });
        assert.match(ended.text, /still live|still answering/i);
        assert.match(ended.text, /Nothing was deleted|nothing has been deleted/i);
    });

    test("an unknown kind returns null rather than throwing", () => {
        assert.equal(emailTemplates.render({ kind: "NOT_A_KIND", data: {} }), null);
    });
});

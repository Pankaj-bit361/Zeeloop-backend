const crypto = require("crypto");
const config = require("../../config/config");
const {
    OutboundWebhookEvent,
    IdPrefix,
    TurnOutcome,
    FeatureKey,
    AuditAction,
} = require("../../config/enums");
const OutboundWebhook = require("../../models/webhook/outboundWebhook");
const generalFunctions = require("../utilFunctions/generalFunctions");
const auditFunctions = require("../audit/auditFunctions");
const { planHasFeature } = require("../../config/plans");

// §5.6 — outbound webhooks.
//
// Signed the same way we expect our own providers to sign: HMAC-SHA256 over the
// exact bytes sent, in a header alongside a timestamp. A customer verifying our
// webhook follows the same recipe we follow for theirs, which is one page of
// docs instead of two.
//
// The timestamp is inside the signed payload, not merely beside it. Signing the
// body alone lets an attacker who captures one delivery replay it forever;
// signing timestamp + body lets the receiver reject anything old.

const MAX_FAILURES_BEFORE_DISABLE = 10;
const DELIVERY_TIMEOUT_MS = 5000;

class OutboundWebhookFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async list({ orgId }) {
        console.log("OutboundWebhookFunctions:list: orgId:", orgId);
        try {
            const hooks = await OutboundWebhook.find({ orgId }).sort({ createdAt: 1 });
            return { status: 200, json: { success: true, data: hooks.map((hook) => hook.toJSON()) } };
        } catch (error) {
            console.error("OutboundWebhookFunctions:list: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async create({ orgId, url, events, actorEmail }) {
        console.log("OutboundWebhookFunctions:create: orgId:", orgId);
        try {
            const validation = this._validateUrl(url);
            if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };

            const requested = Array.isArray(events) ? events : [];
            const unknown = requested.filter((event) => !Object.values(OutboundWebhookEvent).includes(event));
            if (unknown.length > 0) {
                return { status: 400, json: { success: false, error: `Unknown events: ${unknown.join(", ")}` } };
            }
            if (requested.length === 0) {
                return { status: 400, json: { success: false, error: "Subscribe to at least one event" } };
            }

            const secret = `whsec_${crypto.randomBytes(24).toString("hex")}`;
            const hook = await OutboundWebhook.create({
                orgId,
                outboundWebhookId: generalFunctions.generateId(IdPrefix.OUTBOUND_WEBHOOK),
                url,
                events: requested,
                secret: generalFunctions.encrypt(secret),
            });

            await auditFunctions.record({
                orgId,
                action: AuditAction.API_KEY_CREATED,
                actorEmail,
                targetType: "OUTBOUND_WEBHOOK",
                targetId: hook.outboundWebhookId,
                detail: { url, events: requested },
            });

            // The plaintext secret is returned exactly once, here. There is no
            // read endpoint for it — a secret that can be fetched later is a
            // secret that leaks through whatever else can read the API.
            return { status: 201, json: { success: true, data: { ...hook.toJSON(), secret } } };
        } catch (error) {
            console.error("OutboundWebhookFunctions:create: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async remove({ orgId, outboundWebhookId, actorEmail }) {
        console.log("OutboundWebhookFunctions:remove: id:", outboundWebhookId);
        try {
            const result = await OutboundWebhook.deleteOne({ orgId, outboundWebhookId });
            if (result.deletedCount === 0) {
                return { status: 404, json: { success: false, error: "Webhook not found" } };
            }
            await auditFunctions.record({
                orgId,
                action: AuditAction.API_KEY_REVOKED,
                actorEmail,
                targetType: "OUTBOUND_WEBHOOK",
                targetId: outboundWebhookId,
            });
            return { status: 200, json: { success: true, data: { deleted: outboundWebhookId } } };
        } catch (error) {
            console.error("OutboundWebhookFunctions:remove: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Called fire-and-forget from the chat path. Works out which events this
    // turn produced and dispatches them.
    async dispatchForTurn({ org, conversation, turn, isNewConversation }) {
        console.log("OutboundWebhookFunctions:dispatchForTurn: conversationId:", conversation.conversationId);
        try {
            // Gated on the plan, checked here rather than at the route: this is
            // the only entry point, and a gate on the create endpoint alone
            // would keep delivering for workspaces that downgraded.
            if (!planHasFeature((org.credits && org.credits.plan) || "FREE", FeatureKey.PUBLIC_API)) {
                return { success: true, dispatched: 0 };
            }

            const events = [];
            if (isNewConversation) events.push(OutboundWebhookEvent.CONVERSATION_CREATED);
            if (turn.escalate || turn.outcome === TurnOutcome.ESCALATED) {
                events.push(OutboundWebhookEvent.CONVERSATION_ESCALATED);
            }
            for (const call of turn.toolCalls || []) {
                if (call.status === "EXECUTED") events.push(OutboundWebhookEvent.ACTION_EXECUTED);
            }
            if (events.length === 0) return { success: true, dispatched: 0 };

            let dispatched = 0;
            for (const event of [...new Set(events)]) {
                const result = await this.dispatch({
                    orgId: org.orgId,
                    event,
                    payload: {
                        conversationId: conversation.conversationId,
                        endUserId: conversation.endUserId || null,
                        outcome: turn.outcome,
                        channel: conversation.channel,
                        turnCount: conversation.turnCount,
                    },
                });
                dispatched += result.dispatched || 0;
            }
            return { success: true, dispatched };
        } catch (error) {
            console.error("OutboundWebhookFunctions:dispatchForTurn: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, dispatched: 0 };
        }
    }

    async dispatch({ orgId, event, payload, fetchImpl = fetch }) {
        console.log("OutboundWebhookFunctions:dispatch: orgId:", orgId, "event:", event);
        try {
            const hooks = await OutboundWebhook.find({ orgId, enabled: true, events: event });
            if (hooks.length === 0) return { success: true, dispatched: 0 };

            let dispatched = 0;
            for (const hook of hooks) {
                const delivered = await this._deliver({ hook, event, payload, fetchImpl });
                if (delivered.success) dispatched += 1;
            }
            return { success: true, dispatched };
        } catch (error) {
            console.error("OutboundWebhookFunctions:dispatch: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, dispatched: 0 };
        }
    }

    // Exposed so the docs, the tests and any future verifier all agree on one
    // definition of the signature.
    computeSignature({ secret, timestamp, body }) {
        return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _deliver({ hook, event, payload, fetchImpl }) {
        try {
            const secret = generalFunctions.safeDecrypt(hook.secret);
            if (!secret) {
                console.log("OutboundWebhookFunctions:_deliver: secret undecryptable, skipping");
                return { success: false };
            }

            const timestamp = Math.floor(Date.now() / 1000);
            const body = JSON.stringify({ event, timestamp, data: payload });
            const signature = this.computeSignature({ secret, timestamp, body });

            const response = await fetchImpl(hook.url, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "zealoop-signature": signature,
                    "zealoop-timestamp": String(timestamp),
                    "zealoop-event": event,
                },
                body,
                signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
            });

            hook.lastDeliveryAt = new Date();
            hook.lastStatus = response.status;
            if (response.ok) {
                hook.failureCount = 0;
            } else {
                hook.failureCount += 1;
            }
            this._disableIfDead(hook);
            await hook.save();

            return { success: response.ok };
        } catch (error) {
            console.error("OutboundWebhookFunctions:_deliver: delivery failed:", error.message);
            hook.lastDeliveryAt = new Date();
            hook.lastStatus = null;
            hook.failureCount += 1;
            this._disableIfDead(hook);
            await hook.save();
            return { success: false };
        }
    }

    _disableIfDead(hook) {
        if (hook.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
            hook.enabled = false;
            hook.disabledReason = `Disabled after ${MAX_FAILURES_BEFORE_DISABLE} consecutive delivery failures`;
        }
    }

    // Refuses anything that is not an https URL to a public host. Without this,
    // a webhook is a server-side request forgery primitive: the customer names a
    // URL and we fetch it from inside our own network, which reaches the cloud
    // metadata endpoint and every internal service that trusts its own subnet.
    _validateUrl(url) {
        let parsed;
        try {
            parsed = new URL(String(url));
        } catch (error) {
            return { success: false, error: "url must be a valid absolute URL" };
        }

        if (parsed.protocol !== "https:" && !config.ALLOW_INSECURE_WEBHOOKS) {
            return { success: false, error: "Webhook URLs must use https" };
        }

        // URL keeps the brackets on an IPv6 hostname — `new URL("https://[::1]/")`
        // gives "[::1]", not "::1" — so a bare `host === "::1"` check silently
        // lets loopback through. Stripped before every comparison below.
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        const blocked =
            host === "localhost" ||
            // IPv6 loopback and unspecified, plus the ::ffff: mapped-IPv4 form
            // that resolves straight back to a private address.
            host === "::" ||
            host.startsWith("::ffff:") ||
            // Unique local addresses, the IPv6 equivalent of 10.x and 192.168.x.
            /^f[cd][0-9a-f]{2}:/.test(host) ||
            // IPv6 link-local, which is where the metadata service also answers.
            /^fe80:/.test(host) ||
            host === "metadata.google.internal" ||
            host.endsWith(".internal") ||
            host.endsWith(".local") ||
            /^127\./.test(host) ||
            /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
            // Link-local, which is where every cloud metadata service lives.
            host === "169.254.169.254" ||
            /^169\.254\./.test(host) ||
            host === "::1" ||
            host === "0.0.0.0";

        if (blocked && !config.ALLOW_INSECURE_WEBHOOKS) {
            return { success: false, error: "Webhook URLs must point at a public host" };
        }
        return { success: true };
    }
}

module.exports = new OutboundWebhookFunctions();
module.exports.MAX_FAILURES_BEFORE_DISABLE = MAX_FAILURES_BEFORE_DISABLE;

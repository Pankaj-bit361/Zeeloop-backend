const config = require("../../config/config");
const { EmailKind, EscalationMode, IdPrefix } = require("../../config/enums");
const EmailLog = require("../../models/org/emailLog");
const generalFunctions = require("../utilFunctions/generalFunctions");
const emailTemplates = require("./emailTemplates");

// The ONLY file that sends email. Same shape as llmFunctions: swapping Resend
// for SES or Postmark means changing one private method.
//
// Two properties this file exists to guarantee:
//
//   1. It works with no credentials. Without EMAIL_API_KEY, every send is
//      logged with delivered:false and the body intact. A workspace can see
//      exactly what would have gone out, and the backend never crashes for want
//      of an email provider — same rule as Sentry and New Relic.
//   2. It never sends twice. The dedupe key goes through a unique index and the
//      insert happens BEFORE the send. A find-then-insert leaves a window where
//      two cron instances both see nothing and both send.

const MAX_BODY_STORED = 4000;

class EmailFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Returns { success, skipped, reason } — never { status, json }. Nothing
    // user-facing waits on an email.
    async send({ orgId, kind, to, dedupeKey, data, subjectOverride }) {
        console.log("EmailFunctions:send: orgId:", orgId, "kind:", kind, "to:", to ? "set" : "unset");
        try {
            if (!to) return { success: false, skipped: true, reason: "NO_RECIPIENT" };

            const rendered = emailTemplates.render({ kind, data });
            if (!rendered) return { success: false, skipped: true, reason: "NO_TEMPLATE" };

            const subject = subjectOverride || rendered.subject || "Zealoop";
            const key = dedupeKey || `${orgId}:${kind}:${to}`;

            // Claim the send before making it. If this throws 11000, another
            // worker already owns this email and we are done.
            let logEntry;
            try {
                logEntry = await EmailLog.create({
                    orgId,
                    emailLogId: generalFunctions.generateId(IdPrefix.EMAIL_LOG),
                    kind,
                    to,
                    subject,
                    dedupeKey: key,
                    delivered: false,
                    body: String(rendered.text || "").slice(0, MAX_BODY_STORED),
                });
            } catch (error) {
                if (error && error.code === 11000) {
                    console.log("EmailFunctions:send: already sent, skipping:", key);
                    return { success: true, skipped: true, reason: "ALREADY_SENT" };
                }
                throw error;
            }

            if (!config.EMAIL_API_KEY) {
                console.log("EmailFunctions:send: no provider configured, logged only:", kind);
                return { success: true, skipped: true, reason: "NO_PROVIDER", emailLogId: logEntry.emailLogId };
            }

            const delivery = await this._deliver({ to, subject, text: rendered.text, replyTo: data && data.replyTo });
            logEntry.delivered = delivery.success;
            logEntry.providerMessageId = delivery.messageId || null;
            logEntry.error = delivery.success ? null : String(delivery.error || "").slice(0, 500);
            await logEntry.save();

            return { success: delivery.success, skipped: false, emailLogId: logEntry.emailLogId };
        } catch (error) {
            console.error("EmailFunctions:send: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, skipped: false, reason: "ERROR" };
        }
    }

    // §4.8 — escalation notice to the team. Respects the workspace's escalation
    // mode: INBOX means someone is watching the dashboard and does not want an
    // email per handoff.
    async sendEscalationNotice({ org, conversationId, lastMessage, rule }) {
        console.log("EmailFunctions:sendEscalationNotice: conversationId:", conversationId);
        try {
            const escalation = org.escalation || {};
            if (escalation.mode !== EscalationMode.EMAIL) {
                return { success: true, skipped: true, reason: "MODE_NOT_EMAIL" };
            }

            // A rule can override where its own escalations land (§2.2).
            const to = (rule && rule.target && rule.target.memberEmail) || escalation.email || org.ownerEmail;

            return await this.send({
                orgId: org.orgId,
                kind: EmailKind.ESCALATION_NOTICE,
                to,
                // Per conversation, not per turn: a thread that escalates, gets
                // a reply, and escalates again should not email the team twice
                // about the same thread.
                dedupeKey: `${org.orgId}:ESCALATION:${conversationId}`,
                data: {
                    orgName: org.name,
                    conversationId,
                    lastMessage,
                    ruleTitle: rule ? rule.title : null,
                    appUrl: config.APP_URL,
                },
            });
        } catch (error) {
            console.error("EmailFunctions:sendEscalationNotice: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, skipped: false, reason: "ERROR" };
        }
    }

    async listLog({ orgId, limit }) {
        console.log("EmailFunctions:listLog: orgId:", orgId);
        try {
            const entries = await EmailLog.find({ orgId })
                .sort({ createdAt: -1 })
                .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
                .lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: entries.map((entry) => {
                        const copy = { ...entry };
                        delete copy._id;
                        delete copy.__v;
                        return copy;
                    }),
                    // Told rather than left to be inferred from a column of
                    // delivered:false rows.
                    providerConfigured: !!config.EMAIL_API_KEY,
                },
            };
        } catch (error) {
            console.error("EmailFunctions:listLog: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Resend's REST API, chosen because it needs no SDK — one fetch, and
    // swapping providers is this method. `fetchImpl` is injectable so the tests
    // can assert on what would be sent without a network or an API key.
    async _deliver({ to, subject, text, replyTo, fetchImpl = fetch }) {
        try {
            const response = await fetchImpl(`${config.EMAIL_API_BASE_URL}/emails`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.EMAIL_API_KEY}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    from: config.EMAIL_FROM,
                    to: [to],
                    subject,
                    text,
                    ...(replyTo ? { reply_to: replyTo } : {}),
                }),
            });

            if (!response.ok) {
                const body = await response.text();
                return { success: false, error: `provider returned ${response.status}: ${body}` };
            }
            const data = await response.json();
            return { success: true, messageId: data.id || null };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = new EmailFunctions();
module.exports.MAX_BODY_STORED = MAX_BODY_STORED;

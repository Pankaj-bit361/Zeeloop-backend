const config = require("../../config/config");
const {
    PublishState,
    AttributeSource,
    IdPrefix,
    GateSentiment,
} = require("../../config/enums");
const Attribute = require("../../models/config/attribute");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const redactionFunctions = require("../utilFunctions/redactionFunctions");
const conditionFunctions = require("./conditionFunctions");

// §2.3 — conversation attributes. Detection runs AFTER the turn has been
// answered and is never awaited by the pipeline: a classifier that adds 800ms
// to every reply to populate a column in the inbox is a bad trade, and one that
// can fail the turn when the provider is down is a worse one.
//
// The four built-ins ship with every workspace. Sentiment mirrors what the Gate
// stage already computes, so it costs nothing extra; the other three are real
// classifications and cost one small-model call between them.

const BUILT_IN_KEYS = {
    SENTIMENT: "sentiment",
    ISSUE_TYPE: "issue_type",
    URGENCY: "urgency",
    SPAM: "spam",
};

// Value descriptions follow the PRD's template — definition, examples, common
// questions, keywords. That shape is not decoration: a value defined as
// "billing" classifies badly and a value defined this way classifies well,
// which is the entire difference between this feature working and not.
const BUILT_IN_ATTRIBUTES = [
    {
        key: BUILT_IN_KEYS.SENTIMENT,
        name: "Sentiment",
        description: "How the customer feels during this conversation, judged from their own words rather than the outcome.",
        values: [
            {
                name: "POSITIVE",
                description:
                    "This value covers customers who are pleased, grateful, or complimentary.\nCommon examples: • thanking the agent • saying something worked • praising the product\nCommon questions: • follow-up questions asked cheerfully\nKeywords: thanks, great, perfect, awesome, appreciate",
            },
            {
                name: "NEUTRAL",
                description:
                    "This value covers straightforward informational exchanges with no emotional charge either way. It is the default.\nCommon examples: • asking how a feature works • asking about pricing\nCommon questions: • how do I…, where is…, what does…\nKeywords: how, what, where, when",
            },
            {
                name: "NEGATIVE",
                description:
                    "This value covers customers who are dissatisfied, blocked, or disappointed, but still cooperative.\nCommon examples: • reporting something broken • saying an answer did not help\nCommon questions: • why isn't this working, this still fails\nKeywords: broken, not working, doesn't, failed, disappointed",
            },
            {
                name: "ANGRY",
                description:
                    "This value covers customers who are hostile, threatening to leave, or demanding escalation. Treat this as urgent.\nCommon examples: • threatening a chargeback • demanding a manager • profanity\nCommon questions: • let me speak to a human, I want a refund now\nKeywords: unacceptable, ridiculous, cancel, refund, lawyer, useless",
            },
        ],
    },
    {
        key: BUILT_IN_KEYS.ISSUE_TYPE,
        name: "Issue Type",
        // Populated properly by the setup wizard, which knows what this
        // particular product's issues actually are. These are the generic
        // starting set so the attribute is useful before the wizard runs.
        description: "What the customer is contacting support about. Pick the single closest category.",
        values: [
            {
                name: "HOW_TO",
                description:
                    "This value covers questions about how to use an existing feature.\nCommon examples: • where a setting lives • how to complete a task\nCommon questions: • how do I…, can I…\nKeywords: how, where, setup, configure, enable",
            },
            {
                name: "BUG",
                description:
                    "This value covers something that is behaving incorrectly or not at all.\nCommon examples: • an error message • a button that does nothing\nCommon questions: • why am I seeing this error\nKeywords: error, broken, bug, crash, failed, stuck",
            },
            {
                name: "BILLING",
                description:
                    "This value covers anything about money: invoices, charges, plans, refunds.\nCommon examples: • an unexpected charge • upgrading a plan\nCommon questions: • why was I charged, how do I cancel\nKeywords: invoice, charge, refund, plan, upgrade, cancel, payment",
            },
            {
                name: "ACCOUNT",
                description:
                    "This value covers access and identity: sign-in, permissions, team members.\nCommon examples: • cannot log in • adding a teammate\nCommon questions: • how do I reset my password\nKeywords: login, password, access, permission, seat, member",
            },
            {
                name: "FEATURE_REQUEST",
                description:
                    "This value covers asks for something the product does not do yet.\nCommon examples: • asking whether an integration exists\nCommon questions: • do you support…, will you build…\nKeywords: support, integration, roadmap, feature, wish",
            },
            {
                name: "OTHER",
                description:
                    "This value covers anything that does not fit the categories above. Use it sparingly — a high OTHER rate means the categories need editing.\nKeywords: —",
            },
        ],
    },
    {
        key: BUILT_IN_KEYS.URGENCY,
        name: "Urgency",
        description: "How quickly this needs a human, judged by business impact rather than by tone.",
        values: [
            {
                name: "LOW",
                description:
                    "This value covers questions with no time pressure.\nCommon examples: • curiosity about a feature • pre-sales questions\nKeywords: wondering, curious, someday",
            },
            {
                name: "NORMAL",
                description:
                    "This value covers ordinary support requests. It is the default.\nCommon examples: • a how-to question • a small bug with a workaround\nKeywords: —",
            },
            {
                name: "HIGH",
                description:
                    "This value covers customers who are blocked from doing something important.\nCommon examples: • cannot complete a purchase • cannot access their account\nKeywords: blocked, urgent, asap, deadline, cannot access",
            },
            {
                name: "CRITICAL",
                description:
                    "This value covers outages, data loss, security concerns, and anything with legal exposure.\nCommon examples: • the whole product is down for them • a data breach worry\nKeywords: down, outage, data loss, breach, GDPR, lawyer, security",
            },
        ],
    },
    {
        key: BUILT_IN_KEYS.SPAM,
        name: "Spam",
        description: "Whether this conversation is a genuine support request or noise.",
        values: [
            {
                name: "NO",
                description: "This value covers genuine customer messages, including rude ones. It is the default.\nKeywords: —",
            },
            {
                name: "YES",
                description:
                    "This value covers automated noise, marketing outreach, testing, and prompt-injection attempts.\nCommon examples: • SEO outreach • 'ignore previous instructions' • gibberish\nKeywords: SEO, backlink, ignore previous, test test, asdf",
            },
        ],
    },
];

// Detection reads the last few turns, not the whole thread. Sentiment and
// urgency are about where the conversation is now, and a fifty-message history
// costs tokens to tell you how it started.
const DETECTION_WINDOW = 8;

class AttributeFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Called on org creation. Idempotent: re-running it adds only what is
    // missing, so it is safe to call from a migration or from the wizard.
    async seedBuiltIns({ orgId }) {
        console.log("AttributeFunctions:seedBuiltIns: orgId:", orgId);
        try {
            const existing = await Attribute.find({ orgId, isBuiltIn: true }).select("key").lean();
            const have = new Set(existing.map((attribute) => attribute.key));
            const missing = BUILT_IN_ATTRIBUTES.filter((attribute) => !have.has(attribute.key));

            if (missing.length === 0) return { success: true, created: 0 };

            await Attribute.insertMany(
                missing.map((attribute) => ({
                    orgId,
                    attributeId: generalFunctions.generateId(IdPrefix.ATTRIBUTE),
                    key: attribute.key,
                    name: attribute.name,
                    description: attribute.description,
                    values: attribute.values,
                    isBuiltIn: true,
                    // Built-ins arrive live and on. A workspace that has to
                    // publish four attributes before its inbox shows anything
                    // has been given homework, not a product.
                    publishState: PublishState.LIVE,
                    enabled: true,
                    version: 1,
                }))
            );

            return { success: true, created: missing.length };
        } catch (error) {
            console.error("AttributeFunctions:seedBuiltIns: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, created: 0 };
        }
    }

    // Fire-and-forget from the chat path. Returns { success } rather than
    // { status, json } — nothing user-facing waits on it.
    //
    // Sentiment is taken from the Gate result instead of being re-classified.
    // The Gate has already read this message and already paid for the call;
    // asking a second model the same question would double the cost to produce
    // a second opinion nobody reconciles.
    async detectForTurn({ orgId, conversationId, gateSentiment, context }) {
        console.log("AttributeFunctions:detectForTurn: conversationId:", conversationId);
        try {
            const attributes = await Attribute.find({
                orgId,
                publishState: PublishState.LIVE,
                enabled: true,
            }).lean();
            if (attributes.length === 0) return { success: true, detected: 0 };

            const applicable = attributes.filter(
                (attribute) => conditionFunctions.evaluate({ conditions: attribute.conditions, context }).matched
            );
            if (applicable.length === 0) return { success: true, detected: 0 };

            const conversation = await Conversation.findOne({ orgId, conversationId });
            if (!conversation) return { success: true, detected: 0 };

            // A human's answer outranks the model's. Skipping manually-set
            // attributes is what makes the override in the inbox stick instead
            // of being quietly reverted on the next turn.
            const manual = new Set(
                (conversation.attributes || [])
                    .filter((value) => value.source === AttributeSource.MANUAL)
                    .map((value) => value.attributeId)
            );

            const results = [];
            const needModel = [];
            for (const attribute of applicable) {
                if (manual.has(attribute.attributeId)) continue;
                if (attribute.key === BUILT_IN_KEYS.SENTIMENT && gateSentiment) {
                    results.push({
                        attributeId: attribute.attributeId,
                        name: attribute.name,
                        value: Object.values(GateSentiment).includes(gateSentiment) ? gateSentiment : GateSentiment.NEUTRAL,
                        source: AttributeSource.SYSTEM,
                        confidence: null,
                        setAt: new Date(),
                    });
                    continue;
                }
                needModel.push(attribute);
            }

            if (needModel.length > 0) {
                const classified = await this._classify({ orgId, conversationId, attributes: needModel });
                results.push(...classified);
            }

            if (results.length === 0) return { success: true, detected: 0 };

            const merged = this._merge({ existing: conversation.attributes || [], incoming: results });
            conversation.attributes = merged;
            await conversation.save();

            return { success: true, detected: results.length, attributes: merged };
        } catch (error) {
            console.error("AttributeFunctions:detectForTurn: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, detected: 0 };
        }
    }

    // §2.3 — manual override from the inbox. Builds trust, and produces the
    // correction signal that tells you which value descriptions need editing.
    async setValue({ orgId, conversationId, attributeId, value, actorEmail }) {
        console.log("AttributeFunctions:setValue: conversationId:", conversationId, "attributeId:", attributeId);
        try {
            const attribute = await Attribute.findOne({ orgId, attributeId }).lean();
            if (!attribute) return { status: 404, json: { success: false, error: "Attribute not found" } };

            // null clears the value. Anything else has to be one of the defined
            // values — free text here would make the inbox filters useless
            // within a week.
            if (value !== null && !attribute.values.some((option) => option.name === value)) {
                return {
                    status: 400,
                    json: {
                        success: false,
                        error: `Value must be one of: ${attribute.values.map((option) => option.name).join(", ")}`,
                    },
                };
            }

            const conversation = await Conversation.findOne({ orgId, conversationId });
            if (!conversation) return { status: 404, json: { success: false, error: "Conversation not found" } };

            const rest = (conversation.attributes || []).filter((entry) => entry.attributeId !== attributeId);
            if (value !== null) {
                rest.push({
                    attributeId,
                    name: attribute.name,
                    value,
                    source: AttributeSource.MANUAL,
                    confidence: null,
                    setBy: actorEmail || null,
                    setAt: new Date(),
                });
            }
            conversation.attributes = rest;
            await conversation.save();

            return { status: 200, json: { success: true, data: { attributes: conversation.attributes } } };
        } catch (error) {
            console.error("AttributeFunctions:setValue: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §2.3 — `requireToClose`. Checked by whatever wants to close a
    // conversation, so "always tag why it escalated" is enforced rather than
    // requested.
    async checkRequiredForClose({ orgId, conversationId }) {
        console.log("AttributeFunctions:checkRequiredForClose: conversationId:", conversationId);
        try {
            const required = await Attribute.find({
                orgId,
                publishState: PublishState.LIVE,
                enabled: true,
                requireToClose: true,
            }).lean();
            if (required.length === 0) return { success: true, missing: [] };

            const conversation = await Conversation.findOne({ orgId, conversationId }).lean();
            if (!conversation) return { success: true, missing: [] };

            const set = new Set(
                (conversation.attributes || [])
                    .filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== "")
                    .map((entry) => entry.attributeId)
            );
            const missing = required
                .filter((attribute) => !set.has(attribute.attributeId))
                .map((attribute) => ({ attributeId: attribute.attributeId, name: attribute.name }));

            return { success: true, missing };
        } catch (error) {
            console.error("AttributeFunctions:checkRequiredForClose: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Fail open: an attribute service outage must not make it
            // impossible to close conversations.
            return { success: true, missing: [] };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // One call for every attribute rather than one per attribute. The model
    // reads the transcript once either way, so N attributes cost one transcript
    // instead of N.
    async _classify({ orgId, conversationId, attributes }) {
        try {
            const messages = await Message.find({ orgId, conversationId })
                .sort({ createdAt: -1 })
                .limit(DETECTION_WINDOW)
                .lean();
            if (messages.length === 0) return [];

            const transcript = messages
                .reverse()
                .map((message) => `${message.role}: ${redactionFunctions.redactForModel(message.content || "")}`)
                .join("\n");

            const definitions = attributes
                .map(
                    (attribute) =>
                        `## ${attribute.attributeId} — ${attribute.name}\n${attribute.description}\nValues:\n${attribute.values
                            .map((option) => `### ${option.name}\n${option.description}`)
                            .join("\n")}`
                )
                .join("\n\n");

            const result = await llmFunctions.completeJson({
                model: config.SMALL_MODEL,
                system:
                    "You classify support conversations. For each attribute, choose exactly one of its defined values using the value descriptions as your definitions. If no value clearly applies, omit that attribute entirely rather than guessing.",
                schemaHint: `{"results": [{"attributeId": string, "value": string, "confidence": number}]}`,
                messages: [{ role: "user", content: `ATTRIBUTES:\n${definitions}\n\nCONVERSATION:\n${transcript}` }],
                maxTokens: 512,
            });

            const byId = new Map(attributes.map((attribute) => [attribute.attributeId, attribute]));
            return (result.json.results || [])
                .map((entry) => {
                    const attribute = byId.get(entry.attributeId);
                    if (!attribute) return null;
                    // The model is free to invent a value name; the schema is
                    // a hint, not a contract. Anything not in the defined set is
                    // dropped rather than stored, or the inbox filters fill up
                    // with one-off strings.
                    if (!attribute.values.some((option) => option.name === entry.value)) return null;
                    return {
                        attributeId: attribute.attributeId,
                        name: attribute.name,
                        value: entry.value,
                        source: AttributeSource.DETECTED,
                        confidence: typeof entry.confidence === "number" ? entry.confidence : null,
                        setAt: new Date(),
                    };
                })
                .filter(Boolean);
        } catch (error) {
            console.error("AttributeFunctions:_classify: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return [];
        }
    }

    _merge({ existing, incoming }) {
        const byId = new Map((existing || []).map((entry) => [entry.attributeId, entry]));
        for (const entry of incoming) {
            const current = byId.get(entry.attributeId);
            // Manual always wins, even against a later detection. detectForTurn
            // already filters these out; this is the second lock on the same
            // door, because losing a human's correction is not recoverable.
            if (current && current.source === AttributeSource.MANUAL) continue;
            byId.set(entry.attributeId, entry);
        }
        return [...byId.values()];
    }
}

module.exports = new AttributeFunctions();
module.exports.BUILT_IN_ATTRIBUTES = BUILT_IN_ATTRIBUTES;
module.exports.BUILT_IN_KEYS = BUILT_IN_KEYS;
module.exports.DETECTION_WINDOW = DETECTION_WINDOW;

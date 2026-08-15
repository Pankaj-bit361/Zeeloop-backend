const {
    AnswerLength,
    LanguagePolicy,
    ConfigObjectType,
    IdPrefix,
} = require("../../config/enums");
const Org = require("../../models/org/org");
const ConfigVersion = require("../../models/config/configVersion");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §2.7 and §2.8 — the two config objects that live ON the org rather than in
// their own collection, because there is exactly one of each per workspace.
//
// They still get version history, using the same ConfigVersion collection: a
// business-context edit that quietly changes what the agent tells customers
// about pricing is exactly the kind of change someone wants to undo.
//
// They are deliberately NOT draft/live. A single-instance object with a draft
// copy needs somewhere to keep the draft, which means a shadow document and a
// merge — a lot of machinery for a form with six fields. The version log covers
// the same need: change it, and roll back if it reads wrong.

// Only these three languages, per the non-goals. Rejecting a fourth at write
// time is kinder than accepting it and producing answers nobody at the
// workspace can proofread.
const SUPPORTED_LANGUAGES = ["en", "es", "de"];

const AGENT_FIELDS = [
    "name",
    "greeting",
    "avatarUrl",
    "formality",
    "answerLength",
    "languagePolicy",
    "fixedLanguage",
];

const BUSINESS_FIELDS = [
    "productOneLiner",
    "pricingSummary",
    "docsUrl",
    "freeTierTerms",
    "supportHours",
    "facts",
];

class OrgConfigFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async getAgentConfig({ orgId }) {
        console.log("OrgConfigFunctions:getAgentConfig: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId }).lean();
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        agent: org.agent || {},
                        businessContext: org.businessContext || {},
                        // The dashboard renders these as selects; sending them
                        // keeps one source of truth for what the options are.
                        options: {
                            answerLength: Object.values(AnswerLength),
                            languagePolicy: Object.values(LanguagePolicy),
                            formality: ["friendly", "neutral", "formal"],
                            languages: SUPPORTED_LANGUAGES,
                        },
                    },
                },
            };
        } catch (error) {
            console.error("OrgConfigFunctions:getAgentConfig: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async updateAgentConfig({ orgId, agent, businessContext, actorEmail }) {
        console.log("OrgConfigFunctions:updateAgentConfig: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            if (agent) {
                const validation = this._validateAgent(agent);
                if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };
            }
            if (businessContext && businessContext.facts !== undefined) {
                if (!Array.isArray(businessContext.facts)) {
                    return { status: 400, json: { success: false, error: "businessContext.facts must be an array" } };
                }
                if (businessContext.facts.some((fact) => !fact || !fact.label)) {
                    return { status: 400, json: { success: false, error: "Every fact needs a label" } };
                }
            }

            await this._snapshot({ org, actorEmail });

            for (const field of AGENT_FIELDS) {
                if (agent && agent[field] !== undefined) org.agent[field] = agent[field];
            }
            for (const field of BUSINESS_FIELDS) {
                if (businessContext && businessContext[field] !== undefined) {
                    org.businessContext[field] = businessContext[field];
                }
            }

            // The agent's name and greeting are rendered by the widget, so a
            // change here has to bust the cached bootstrap config or customers
            // see the old name until the CDN entry expires.
            if (agent && (agent.name !== undefined || agent.greeting !== undefined || agent.avatarUrl !== undefined)) {
                org.widget.configVersion = (org.widget.configVersion || 1) + 1;
            }

            await org.save();

            return {
                status: 200,
                json: { success: true, data: { agent: org.agent, businessContext: org.businessContext } },
            };
        } catch (error) {
            console.error("OrgConfigFunctions:updateAgentConfig: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _validateAgent(agent) {
        if (agent.name !== undefined && !String(agent.name).trim()) {
            return { success: false, error: "Agent name cannot be empty" };
        }
        if (agent.answerLength !== undefined && !Object.values(AnswerLength).includes(agent.answerLength)) {
            return { success: false, error: `answerLength must be one of: ${Object.values(AnswerLength).join(", ")}` };
        }
        if (agent.languagePolicy !== undefined && !Object.values(LanguagePolicy).includes(agent.languagePolicy)) {
            return { success: false, error: `languagePolicy must be one of: ${Object.values(LanguagePolicy).join(", ")}` };
        }
        if (agent.formality !== undefined && !["friendly", "neutral", "formal"].includes(agent.formality)) {
            return { success: false, error: "formality must be one of: friendly, neutral, formal" };
        }
        if (agent.fixedLanguage !== undefined && !SUPPORTED_LANGUAGES.includes(agent.fixedLanguage)) {
            return {
                success: false,
                error: `Only ${SUPPORTED_LANGUAGES.join(", ")} are supported. Adding a fourth language is an explicit non-goal.`,
            };
        }
        return { success: true };
    }

    // Best effort, same as configFunctions._snapshot — a missing history row
    // must not fail the save it was describing.
    async _snapshot({ org, actorEmail }) {
        try {
            const previous = await ConfigVersion.countDocuments({
                orgId: org.orgId,
                objectType: ConfigObjectType.BUSINESS_CONTEXT,
                objectId: org.orgId,
            });
            await ConfigVersion.create({
                orgId: org.orgId,
                versionId: generalFunctions.generateId(IdPrefix.CONFIG_VERSION),
                objectType: ConfigObjectType.BUSINESS_CONTEXT,
                objectId: org.orgId,
                version: previous + 1,
                snapshot: { agent: org.agent, businessContext: org.businessContext },
                changedBy: actorEmail || null,
                note: "edited",
            });
            return { success: true };
        } catch (error) {
            console.error("OrgConfigFunctions:_snapshot: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }
}

module.exports = new OrgConfigFunctions();
module.exports.SUPPORTED_LANGUAGES = SUPPORTED_LANGUAGES;

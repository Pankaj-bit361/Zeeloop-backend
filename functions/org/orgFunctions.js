const crypto = require("crypto");
const Org = require("../../models/org/org");
const { deriveThemes } = require("../utilFunctions/themeDerivation");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Action = require("../../models/action/action");
const Table = require("../../models/table/table");
const Conversation = require("../../models/conversation/conversation");
const { SourceStatus, TestStatus, EscalationMode, OnboardingStep } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

const DEFAULT_AGENT_NAME = "Zea";
const DEFAULT_GREETING = "Hi! How can I help?";

class OrgFunctions {
    // GET /api/org/:orgId/settings
    async getSettings({ orgId }) {
        console.log("OrgFunctions:getSettings: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const org = await Org.findOne({ orgId });
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }

            // toJSON strips widgetSecret, so build the mask from the raw document.
            const data = org.toJSON();
            data.widgetSecretMasked = this._maskSecret(org.widgetSecret);
            return { status: 200, json: { success: true, data } };
        } catch (error) {
            console.log("OrgFunctions:getSettings: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // PATCH /api/org/:orgId/settings
    async updateSettings({
        orgId,
        name,
        website,
        agentName,
        greeting,
        language,
        escalationMode,
        escalationEmail,
        widgetPosition,
        allowedOrigins,
        widgetTheme,
        widgetAccentColor,
        widgetBackground,
    }) {
        console.log("OrgFunctions:updateSettings: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            if (name !== undefined && !String(name).trim()) {
                return { status: 400, json: { success: false, error: "Organization name cannot be empty" } };
            }
            if (agentName !== undefined && !String(agentName).trim()) {
                return { status: 400, json: { success: false, error: "Agent name cannot be empty" } };
            }
            if (escalationMode !== undefined && !Object.values(EscalationMode).includes(escalationMode)) {
                return { status: 400, json: { success: false, error: "Unknown escalation mode" } };
            }
            // An email route with nowhere to send is a silent dead end, not a setting.
            if (escalationMode === EscalationMode.EMAIL && !String(escalationEmail || "").includes("@")) {
                return { status: 400, json: { success: false, error: "Email escalation needs a valid address" } };
            }
            if (widgetTheme !== undefined && !["light", "dark", "auto"].includes(widgetTheme)) {
                return { status: 400, json: { success: false, error: "Theme must be light, dark or auto" } };
            }
            // Empty string clears the accent back to the default ink.
            if (widgetAccentColor !== undefined && widgetAccentColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(widgetAccentColor)) {
                return { status: 400, json: { success: false, error: "Accent color must be a 6-digit hex value" } };
            }
            if (widgetBackground !== undefined && !["aurora", "mint", "sky", "sunset", "ink"].includes(widgetBackground)) {
                return { status: 400, json: { success: false, error: "Unknown background preset" } };
            }

            const update = {
                ...(name !== undefined && { name: String(name).trim() }),
                ...(website !== undefined && { website: String(website).trim() }),
                ...(agentName !== undefined && { "agent.name": String(agentName).trim() }),
                ...(greeting !== undefined && { "agent.greeting": String(greeting).trim() }),
                ...(language !== undefined && { "agent.language": language }),
                ...(escalationMode !== undefined && { "escalation.mode": escalationMode }),
                ...(escalationEmail !== undefined && { "escalation.email": String(escalationEmail).trim() }),
                ...(widgetPosition !== undefined && { "widget.position": widgetPosition }),
                ...(Array.isArray(allowedOrigins) && {
                    "widget.allowedOrigins": allowedOrigins.map((origin) => String(origin).trim()).filter(Boolean),
                }),
                ...(widgetTheme !== undefined && { "widget.theme": widgetTheme }),
                ...(widgetAccentColor !== undefined && { "widget.accentColor": widgetAccentColor }),
                ...(widgetBackground !== undefined && { "widget.background": widgetBackground }),
            };

            // Derivation runs HERE, on save — the widget ships zero color math.
            if (widgetAccentColor !== undefined) {
                update["widget.themeTokens"] = deriveThemes(widgetAccentColor || null);
            }
            // Any widget-affecting change publishes a new config version.
            const touchesWidget = Object.keys(update).some((key) => key.startsWith("widget."));
            const operations = {
                ...(Object.keys(update).length && { $set: update }),
                ...(touchesWidget && { $inc: { "widget.configVersion": 1 } }),
            };
            const org = await Org.findOneAndUpdate({ orgId }, operations, { new: true });
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }
            const data = org.toJSON();
            data.widgetSecretMasked = this._maskSecret(org.widgetSecret);
            return { status: 200, json: { success: true, data } };
        } catch (error) {
            console.log("OrgFunctions:updateSettings: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/org/:orgId/widget-secret/reveal — decrypts and returns it once.
    async revealSecret({ orgId }) {
        console.log("OrgFunctions:revealSecret: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const org = await Org.findOne({ orgId });
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }
            const plaintext = generalFunctions.safeDecrypt(org.widgetSecret);
            if (!plaintext) {
                return {
                    status: 409,
                    json: {
                        success: false,
                        error: "Secret could not be decrypted — the ENCRYPTION_KEY changed. Rotate to issue a new one.",
                    },
                };
            }
            return { status: 200, json: { success: true, data: { widgetSecret: plaintext } } };
        } catch (error) {
            console.log("OrgFunctions:revealSecret: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/org/:orgId/widget-secret/rotate — invalidates every existing signature.
    async rotateSecret({ orgId }) {
        console.log("OrgFunctions:rotateSecret: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const plaintext = `ws_live_${crypto.randomBytes(24).toString("hex")}`;
            const org = await Org.findOneAndUpdate(
                { orgId },
                { widgetSecret: generalFunctions.encrypt(plaintext), secretRotatedAt: new Date() },
                { new: true }
            );
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }
            console.log("OrgFunctions:rotateSecret: rotated for orgId:", orgId);
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        widgetSecret: plaintext,
                        widgetSecretMasked: this._maskSecret(org.widgetSecret),
                        secretRotatedAt: org.secretRotatedAt,
                    },
                },
            };
        } catch (error) {
            console.log("OrgFunctions:rotateSecret: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // GET /api/org/:orgId/onboarding — the Get Started checklist, derived from
    // real data every time. Nothing about progress is stored.
    async getOnboarding({ orgId }) {
        console.log("OrgFunctions:getOnboarding: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const org = await Org.findOne({ orgId }).lean();
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }

            const [readySources, conversations, testedActions, tables] = await Promise.all([
                KnowledgeSource.countDocuments({ orgId, status: SourceStatus.READY }),
                Conversation.countDocuments({ orgId }),
                Action.countDocuments({ orgId, enabled: true, lastTestStatus: TestStatus.PASS }),
                Table.countDocuments({ orgId }),
            ]);

            const agentConfigured =
                (org.agent?.name && org.agent.name !== DEFAULT_AGENT_NAME) ||
                (org.agent?.greeting && org.agent.greeting !== DEFAULT_GREETING);

            const steps = [
                {
                    key: OnboardingStep.KNOWLEDGE,
                    label: "Add a knowledge source",
                    done: readySources > 0,
                    href: "/app/knowledge",
                },
                {
                    key: OnboardingStep.AGENT,
                    label: "Name your agent",
                    done: Boolean(agentConfigured),
                    href: "/app/configuration",
                },
                {
                    key: OnboardingStep.INSTALL,
                    label: "Install the widget",
                    done: conversations > 0,
                    href: "/app/dashboard",
                },
                {
                    key: OnboardingStep.ACTIONS,
                    label: "Connect an API or table",
                    done: testedActions > 0 || tables > 0,
                    href: "/app/apis",
                },
            ];
            const completed = steps.filter((step) => step.done).length;

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        steps,
                        completed,
                        total: steps.length,
                        percent: Math.round((completed / steps.length) * 100),
                    },
                },
            };
        } catch (error) {
            console.log("OrgFunctions:getOnboarding: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Renders ws_live_abc…xyz as ws_live_••••3f7a. Never returns the middle.
    _maskSecret(ciphertext) {
        const plaintext = generalFunctions.safeDecrypt(ciphertext);
        if (!plaintext) return "ws_live_••••••••••••••••";
        return `ws_live_${"•".repeat(16)}${plaintext.slice(-4)}`;
    }
}

module.exports = new OrgFunctions();

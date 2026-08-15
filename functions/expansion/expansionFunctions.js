const crypto = require("crypto");
const {
    ApiScope,
    CredentialType,
    IdPrefix,
    AuditAction,
    BlocklistType,
    MemberRole,
} = require("../../config/enums");
const { ApiKey, Credential, Team, Macro, BlocklistEntry, ChangelogEntry } = require("../../models/org/expansion");
const Action = require("../../models/action/action");
const Conversation = require("../../models/conversation/conversation");
const EndUser = require("../../models/user/endUser");
const generalFunctions = require("../utilFunctions/generalFunctions");
const auditFunctions = require("../audit/auditFunctions");

// §5.3, §5.6, §5.7, §5.8 and §8.2 — the CRUD for the smaller expansion objects.
// One file, because each is under a hundred lines and five near-identical files
// is five places to fix the same tenancy bug.

const KEY_PREFIX = "zk_live_";

class ExpansionFunctions {
    // ── API keys (§5.6) ──────────────────────────────────────────────

    async listApiKeys({ orgId }) {
        console.log("ExpansionFunctions:listApiKeys: orgId:", orgId);
        try {
            const keys = await ApiKey.find({ orgId, revokedAt: null }).sort({ createdAt: -1 });
            return {
                status: 200,
                json: { success: true, data: keys.map((key) => key.toJSON()), scopes: Object.values(ApiScope) },
            };
        } catch (error) {
            console.error("ExpansionFunctions:listApiKeys: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createApiKey({ orgId, name, scopes, rateLimitPerMinute, actorEmail }) {
        console.log("ExpansionFunctions:createApiKey: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) {
                return { status: 400, json: { success: false, error: "Give the key a name so you know what to revoke later" } };
            }
            const requested = Array.isArray(scopes) ? scopes : [];
            const unknown = requested.filter((scope) => !Object.values(ApiScope).includes(scope));
            if (unknown.length > 0) {
                return { status: 400, json: { success: false, error: `Unknown scopes: ${unknown.join(", ")}` } };
            }
            if (requested.length === 0) {
                return { status: 400, json: { success: false, error: "A key with no scopes can do nothing — pick at least one" } };
            }

            const secret = `${KEY_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
            const key = await ApiKey.create({
                orgId,
                apiKeyId: generalFunctions.generateId(IdPrefix.API_KEY),
                name: String(name).trim(),
                // Hashed, not encrypted. Nothing ever needs to read it back —
                // authentication hashes the presented key and compares.
                keyHash: this.hashKey(secret),
                keyPreview: `${secret.slice(0, KEY_PREFIX.length + 4)}…${secret.slice(-4)}`,
                scopes: requested,
                rateLimitPerMinute: Math.min(600, Math.max(1, Number(rateLimitPerMinute) || 60)),
                createdBy: actorEmail || null,
            });

            await auditFunctions.record({
                orgId,
                action: AuditAction.API_KEY_CREATED,
                actorEmail,
                targetType: "API_KEY",
                targetId: key.apiKeyId,
                detail: { name: key.name, scopes: requested },
            });

            // The only time the plaintext key exists outside the caller's
            // memory. There is no endpoint that returns it again.
            return { status: 201, json: { success: true, data: { ...key.toJSON(), key: secret } } };
        } catch (error) {
            console.error("ExpansionFunctions:createApiKey: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async revokeApiKey({ orgId, apiKeyId, actorEmail }) {
        console.log("ExpansionFunctions:revokeApiKey: apiKeyId:", apiKeyId);
        try {
            // Revoked, not deleted. The audit trail needs the key to still
            // exist so "which key did that" stays answerable.
            const result = await ApiKey.updateOne({ orgId, apiKeyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
            if (result.matchedCount === 0) {
                return { status: 404, json: { success: false, error: "Key not found" } };
            }
            await auditFunctions.record({
                orgId,
                action: AuditAction.API_KEY_REVOKED,
                actorEmail,
                targetType: "API_KEY",
                targetId: apiKeyId,
            });
            return { status: 200, json: { success: true, data: { revoked: apiKeyId } } };
        } catch (error) {
            console.error("ExpansionFunctions:revokeApiKey: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    hashKey(key) {
        return crypto.createHash("sha256").update(String(key)).digest("hex");
    }

    // ── Credential store (§5.3) ──────────────────────────────────────

    async listCredentials({ orgId }) {
        console.log("ExpansionFunctions:listCredentials: orgId:", orgId);
        try {
            const credentials = await Credential.find({ orgId }).sort({ createdAt: 1 });
            const usage = await Action.aggregate([
                { $match: { orgId, credentialId: { $ne: null } } },
                { $group: { _id: "$credentialId", count: { $sum: 1 } } },
            ]);
            const counts = new Map(usage.map((row) => [row._id, row.count]));

            return {
                status: 200,
                json: {
                    success: true,
                    data: credentials.map((credential) => ({
                        ...credential.toJSON(),
                        // Shown so deleting one is an informed decision rather
                        // than a surprise outage across four actions.
                        usedByActions: counts.get(credential.credentialId) || 0,
                    })),
                    types: Object.values(CredentialType),
                },
            };
        } catch (error) {
            console.error("ExpansionFunctions:listCredentials: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createCredential({ orgId, name, type, secret, headerName, username }) {
        console.log("ExpansionFunctions:createCredential: orgId:", orgId, "type:", type);
        try {
            if (!name || !String(name).trim()) return { status: 400, json: { success: false, error: "name is required" } };
            if (!Object.values(CredentialType).includes(type)) {
                return { status: 400, json: { success: false, error: `type must be one of: ${Object.values(CredentialType).join(", ")}` } };
            }
            if (!secret) return { status: 400, json: { success: false, error: "secret is required" } };
            if (type === CredentialType.API_KEY_HEADER && !headerName) {
                return { status: 400, json: { success: false, error: "headerName is required for API_KEY_HEADER credentials" } };
            }
            if (type === CredentialType.BASIC && !username) {
                return { status: 400, json: { success: false, error: "username is required for BASIC credentials" } };
            }

            const credential = await Credential.create({
                orgId,
                credentialId: generalFunctions.generateId(IdPrefix.CREDENTIAL),
                name: String(name).trim(),
                type,
                secret: generalFunctions.encrypt(secret),
                headerName: headerName || null,
                username: username || null,
            });

            return { status: 201, json: { success: true, data: credential.toJSON() } };
        } catch (error) {
            console.error("ExpansionFunctions:createCredential: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async rotateCredential({ orgId, credentialId, secret }) {
        console.log("ExpansionFunctions:rotateCredential: credentialId:", credentialId);
        try {
            if (!secret) return { status: 400, json: { success: false, error: "secret is required" } };

            const credential = await Credential.findOne({ orgId, credentialId });
            if (!credential) return { status: 404, json: { success: false, error: "Credential not found" } };

            credential.secret = generalFunctions.encrypt(secret);
            credential.lastRotatedAt = new Date();
            await credential.save();

            // Every action using this credential is now untested against the new
            // secret. Resetting lastTestStatus takes them out of the model's
            // reach until someone re-tests — an action calling an API with a key
            // that may not work is exactly what NEVER_TESTED exists to stop.
            const affected = await Action.updateMany(
                { orgId, credentialId },
                { $set: { lastTestStatus: null } }
            );

            return {
                status: 200,
                json: {
                    success: true,
                    data: { rotated: credentialId, actionsRequiringRetest: affected.modifiedCount || 0 },
                    note:
                        (affected.modifiedCount || 0) > 0
                            ? `${affected.modifiedCount} action(s) need re-testing before the agent will use them again.`
                            : null,
                },
            };
        } catch (error) {
            console.error("ExpansionFunctions:rotateCredential: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteCredential({ orgId, credentialId }) {
        console.log("ExpansionFunctions:deleteCredential: credentialId:", credentialId);
        try {
            const inUse = await Action.countDocuments({ orgId, credentialId });
            if (inUse > 0) {
                return {
                    status: 409,
                    json: { success: false, error: `${inUse} action(s) still use this credential. Point them elsewhere first.` },
                };
            }
            const result = await Credential.deleteOne({ orgId, credentialId });
            if (result.deletedCount === 0) return { status: 404, json: { success: false, error: "Credential not found" } };
            return { status: 200, json: { success: true, data: { deleted: credentialId } } };
        } catch (error) {
            console.error("ExpansionFunctions:deleteCredential: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Teams and assignment (§5.7) ──────────────────────────────────

    async listTeams({ orgId }) {
        console.log("ExpansionFunctions:listTeams: orgId:", orgId);
        try {
            const teams = await Team.find({ orgId }).sort({ createdAt: 1 });
            const counts = await Conversation.aggregate([
                { $match: { orgId, teamId: { $ne: null } } },
                { $group: { _id: "$teamId", count: { $sum: 1 } } },
            ]);
            const byTeam = new Map(counts.map((row) => [row._id, row.count]));

            return {
                status: 200,
                json: {
                    success: true,
                    data: teams.map((team) => ({ ...team.toJSON(), conversationCount: byTeam.get(team.teamId) || 0 })),
                },
            };
        } catch (error) {
            console.error("ExpansionFunctions:listTeams: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createTeam({ orgId, name, description, memberEmails, assignmentRules }) {
        console.log("ExpansionFunctions:createTeam: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) return { status: 400, json: { success: false, error: "name is required" } };

            const team = await Team.create({
                orgId,
                teamId: generalFunctions.generateId(IdPrefix.TEAM),
                name: String(name).trim(),
                description: description || "",
                memberEmails: (memberEmails || []).map((email) => String(email).toLowerCase()),
                assignmentRules: assignmentRules || [],
            });

            return { status: 201, json: { success: true, data: team.toJSON() } };
        } catch (error) {
            console.error("ExpansionFunctions:createTeam: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteTeam({ orgId, teamId }) {
        console.log("ExpansionFunctions:deleteTeam: teamId:", teamId);
        try {
            const result = await Team.deleteOne({ orgId, teamId });
            if (result.deletedCount === 0) return { status: 404, json: { success: false, error: "Team not found" } };
            // Assignments are cleared rather than left pointing at nothing —
            // a conversation assigned to a deleted team would show a blank team
            // name and be unfindable in every view.
            await Conversation.updateMany({ orgId, teamId }, { $set: { teamId: null } });
            return { status: 200, json: { success: true, data: { deleted: teamId } } };
        } catch (error) {
            console.error("ExpansionFunctions:deleteTeam: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async assignConversation({ orgId, conversationId, assignedTo, teamId }) {
        console.log("ExpansionFunctions:assignConversation: conversationId:", conversationId);
        try {
            const conversation = await Conversation.findOne({ orgId, conversationId });
            if (!conversation) return { status: 404, json: { success: false, error: "Conversation not found" } };

            // undefined leaves a field alone; null clears it. Without this
            // distinction, assigning to a person would silently unassign the
            // team.
            if (assignedTo !== undefined) conversation.assignedTo = assignedTo || null;
            if (teamId !== undefined) conversation.teamId = teamId || null;
            await conversation.save();

            return {
                status: 200,
                json: { success: true, data: { assignedTo: conversation.assignedTo, teamId: conversation.teamId } },
            };
        } catch (error) {
            console.error("ExpansionFunctions:assignConversation: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Applies each team's attribute rules to unassigned conversations. First
    // match wins — a conversation matching two teams' rules goes to the one
    // defined first, rather than to both or to neither.
    async autoAssign({ orgId }) {
        console.log("ExpansionFunctions:autoAssign: orgId:", orgId);
        try {
            const teams = await Team.find({ orgId }).sort({ createdAt: 1 }).lean();
            const withRules = teams.filter((team) => (team.assignmentRules || []).length > 0);
            if (withRules.length === 0) return { status: 200, json: { success: true, data: { assigned: 0 } } };

            const unassigned = await Conversation.find({ orgId, teamId: null }).limit(200);
            let assigned = 0;

            for (const conversation of unassigned) {
                const attributes = conversation.attributes || [];
                const team = withRules.find((candidate) =>
                    candidate.assignmentRules.some((rule) =>
                        attributes.some(
                            (attribute) => attribute.attributeId === rule.attributeId && attribute.value === rule.value
                        )
                    )
                );
                if (!team) continue;
                conversation.teamId = team.teamId;
                await conversation.save();
                assigned += 1;
            }

            return { status: 200, json: { success: true, data: { assigned, teamsWithRules: withRules.length } } };
        } catch (error) {
            console.error("ExpansionFunctions:autoAssign: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Macros (§5.8) ────────────────────────────────────────────────

    async listMacros({ orgId, role }) {
        console.log("ExpansionFunctions:listMacros: orgId:", orgId);
        try {
            const macros = await Macro.find({ orgId }).sort({ usageCount: -1, createdAt: 1 }).lean();
            // An empty visibleToRoles means everyone, matching how `channels`
            // works on config objects.
            const visible = macros.filter(
                (macro) => (macro.visibleToRoles || []).length === 0 || !role || macro.visibleToRoles.includes(role)
            );
            return {
                status: 200,
                json: {
                    success: true,
                    data: visible.map((macro) => {
                        const copy = { ...macro };
                        delete copy._id;
                        delete copy.__v;
                        return copy;
                    }),
                    roles: Object.values(MemberRole),
                },
            };
        } catch (error) {
            console.error("ExpansionFunctions:listMacros: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createMacro({ orgId, name, shortcut, body, visibleToRoles }) {
        console.log("ExpansionFunctions:createMacro: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) return { status: 400, json: { success: false, error: "name is required" } };
            if (!body || !String(body).trim()) return { status: 400, json: { success: false, error: "body is required" } };

            const clean = shortcut ? `/${String(shortcut).replace(/^\//, "").toLowerCase()}` : null;
            if (clean) {
                const taken = await Macro.findOne({ orgId, shortcut: clean }).lean();
                if (taken) {
                    return { status: 409, json: { success: false, error: `The shortcut ${clean} is already used by "${taken.name}"` } };
                }
            }

            const macro = await Macro.create({
                orgId,
                macroId: generalFunctions.generateId(IdPrefix.MACRO),
                name: String(name).trim(),
                shortcut: clean,
                body,
                visibleToRoles: visibleToRoles || [],
            });

            return { status: 201, json: { success: true, data: macro.toJSON() } };
        } catch (error) {
            console.error("ExpansionFunctions:createMacro: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteMacro({ orgId, macroId }) {
        console.log("ExpansionFunctions:deleteMacro: macroId:", macroId);
        try {
            const result = await Macro.deleteOne({ orgId, macroId });
            if (result.deletedCount === 0) return { status: 404, json: { success: false, error: "Macro not found" } };
            return { status: 200, json: { success: true, data: { deleted: macroId } } };
        } catch (error) {
            console.error("ExpansionFunctions:deleteMacro: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Substitutes the variables and returns the text. Rendered server-side so
    // the variable set is defined in one place rather than in the composer's
    // JavaScript.
    async renderMacro({ orgId, macroId, conversationId, agentName }) {
        console.log("ExpansionFunctions:renderMacro: macroId:", macroId);
        try {
            const macro = await Macro.findOne({ orgId, macroId });
            if (!macro) return { status: 404, json: { success: false, error: "Macro not found" } };

            const Org = require("../../models/org/org");
            const org = await Org.findOne({ orgId }).select("name agent").lean();

            let firstName = "";
            if (conversationId) {
                const conversation = await Conversation.findOne({ orgId, conversationId }).select("endUserId").lean();
                if (conversation && conversation.endUserId) {
                    const endUser = await EndUser.findOne({ orgId, endUserId: conversation.endUserId }).select("name").lean();
                    if (endUser && endUser.name) firstName = endUser.name.trim().split(/\s+/)[0];
                }
            }

            const body = String(macro.body)
                // Same collapse as the widget's welcome message: no name means
                // the clause goes, rather than leaving "Hi ," in a reply
                // somebody is about to send to a customer.
                .replace(/,?\s*\{first_name\}/g, firstName ? `${macro.body.includes(", {first_name}") ? ", " : " "}${firstName}` : "")
                .replace(/\{first_name\}/g, firstName)
                .replace(/\{agent_name\}/g, agentName || (org && org.agent && org.agent.name) || "")
                .replace(/\{org_name\}/g, (org && org.name) || "")
                .replace(/\s{2,}/g, " ")
                .trim();

            macro.usageCount += 1;
            await macro.save();

            return { status: 200, json: { success: true, data: { body } } };
        } catch (error) {
            console.error("ExpansionFunctions:renderMacro: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Blocklist (§8.2) ─────────────────────────────────────────────

    async listBlocklist({ orgId }) {
        console.log("ExpansionFunctions:listBlocklist: orgId:", orgId);
        try {
            const entries = await BlocklistEntry.find({ orgId }).sort({ createdAt: -1 });
            return {
                status: 200,
                json: { success: true, data: entries.map((entry) => entry.toJSON()), types: Object.values(BlocklistType) },
            };
        } catch (error) {
            console.error("ExpansionFunctions:listBlocklist: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async addBlocklistEntry({ orgId, type, value, reason, expiresAt, actorEmail }) {
        console.log("ExpansionFunctions:addBlocklistEntry: type:", type);
        try {
            if (!Object.values(BlocklistType).includes(type)) {
                return { status: 400, json: { success: false, error: `type must be one of: ${Object.values(BlocklistType).join(", ")}` } };
            }
            if (!value || !String(value).trim()) return { status: 400, json: { success: false, error: "value is required" } };

            const entry = await BlocklistEntry.create({
                orgId,
                blocklistEntryId: generalFunctions.generateId(IdPrefix.BLOCKLIST_ENTRY),
                type,
                value: String(value).trim().toLowerCase(),
                reason: reason || "",
                createdBy: actorEmail || null,
                expiresAt: expiresAt ? new Date(expiresAt) : null,
            });

            return { status: 201, json: { success: true, data: entry.toJSON() } };
        } catch (error) {
            if (error && error.code === 11000) {
                return { status: 409, json: { success: false, error: "That value is already blocked" } };
            }
            console.error("ExpansionFunctions:addBlocklistEntry: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async removeBlocklistEntry({ orgId, blocklistEntryId }) {
        console.log("ExpansionFunctions:removeBlocklistEntry: id:", blocklistEntryId);
        try {
            const result = await BlocklistEntry.deleteOne({ orgId, blocklistEntryId });
            if (result.deletedCount === 0) return { status: 404, json: { success: false, error: "Entry not found" } };
            return { status: 200, json: { success: true, data: { deleted: blocklistEntryId } } };
        } catch (error) {
            console.error("ExpansionFunctions:removeBlocklistEntry: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Called on the widget path, before the pipeline. Returns { blocked, reason }
    // and never throws — a blocklist lookup failure must not take the widget
    // down, and failing open is the right call for a feature that exists to stop
    // abuse rather than to protect data.
    async checkBlocked({ orgId, email, ip }) {
        try {
            const candidates = [];
            if (email) {
                const clean = String(email).toLowerCase();
                candidates.push({ type: BlocklistType.IDENTITY, value: clean });
                const at = clean.lastIndexOf("@");
                if (at !== -1) candidates.push({ type: BlocklistType.EMAIL_DOMAIN, value: clean.slice(at + 1) });
            }
            if (ip) candidates.push({ type: BlocklistType.IP, value: String(ip).toLowerCase() });
            if (candidates.length === 0) return { blocked: false };

            const entry = await BlocklistEntry.findOne({
                orgId,
                $or: candidates,
                $and: [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }],
            });
            if (!entry) return { blocked: false };

            // Counted so the list can be sorted by what is actually being hit,
            // which is how someone finds the entry worth making permanent.
            await BlocklistEntry.updateOne({ _id: entry._id }, { $inc: { hitCount: 1 } });
            return { blocked: true, reason: entry.reason || "Blocked by workspace policy", type: entry.type };
        } catch (error) {
            console.error("ExpansionFunctions:checkBlocked: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { blocked: false };
        }
    }

    // ── Changelog (§8.5) ─────────────────────────────────────────────

    async listChangelog({ limit }) {
        console.log("ExpansionFunctions:listChangelog");
        try {
            const entries = await ChangelogEntry.find({ publishedAt: { $lte: new Date() } })
                .sort({ publishedAt: -1 })
                .limit(Math.min(50, Number(limit) || 20))
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
                },
            };
        } catch (error) {
            console.error("ExpansionFunctions:listChangelog: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }
}

module.exports = new ExpansionFunctions();
module.exports.KEY_PREFIX = KEY_PREFIX;

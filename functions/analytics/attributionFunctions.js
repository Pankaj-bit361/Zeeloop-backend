const { TurnOutcome, ConfigObjectType } = require("../../config/enums");
const TurnTrace = require("../../models/trace/turnTrace");
const GuidanceRule = require("../../models/config/guidanceRule");
const EscalationRule = require("../../models/config/escalationRule");
const EscalationGuidance = require("../../models/config/escalationGuidance");
const Procedure = require("../../models/procedure/procedure");
const Action = require("../../models/action/action");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §2.5 — `used`, `resolved`, `escalated` per rule, per procedure, per action.
//
// Computed FROM TurnTrace by cron, never incremented at write time. Three
// reasons, in order of how much they hurt:
//
//   1. Incrementing on the hot path means one write per applied rule per turn.
//      Ten rules on a busy workspace turns one conversation into ten extra
//      writes for a number nobody reads in real time.
//   2. Counters incremented at write time double-count on retries and drift
//      permanently, because nothing ever recomputes them.
//   3. A recomputed number can be recomputed differently. When the definition of
//      "resolved" changes, this is one function to edit rather than a backfill
//      across five collections.
//
// The window is the whole trace history rather than a rolling period, because
// "this rule has been used 4,000 times" is the number a support manager wants —
// not "4,000 times in the last 30 days" — and the aggregation is cheap enough on
// the appliedRuleIds index that a period filter would be optimising the wrong
// thing.

// Attribution reads a lot of traces at once. Aggregating in Mongo rather than
// pulling them into memory keeps a large workspace from becoming a heap problem
// on a cron tick.
const COUNTED_MODELS = [
    { Model: GuidanceRule, idField: "guidanceRuleId", type: ConfigObjectType.GUIDANCE_RULE },
    { Model: EscalationRule, idField: "escalationRuleId", type: ConfigObjectType.ESCALATION_RULE },
    { Model: EscalationGuidance, idField: "escalationGuidanceId", type: ConfigObjectType.ESCALATION_GUIDANCE },
];

class AttributionFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Every org, or one. Called by cron with no argument and by tests with one.
    async computeAttribution({ orgId }) {
        console.log("AttributionFunctions:computeAttribution: orgId:", orgId || "ALL");
        try {
            const orgIds = orgId ? [orgId] : await TurnTrace.distinct("orgId");
            let updated = 0;

            for (const currentOrgId of orgIds) {
                const counts = await this._aggregateRuleCounts({ orgId: currentOrgId });
                updated += await this._writeRuleCounts({ orgId: currentOrgId, counts });
                updated += await this._writeProcedureCounts({ orgId: currentOrgId });
                updated += await this._writeActionCounts({ orgId: currentOrgId });
            }

            console.log("AttributionFunctions:computeAttribution: updated:", updated);
            return { success: true, updated };
        } catch (error) {
            console.error("AttributionFunctions:computeAttribution: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, updated: 0 };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // One pass over the org's traces produces the counts for every rule at once.
    // $unwind on appliedRuleIds turns "this turn used rules A, B, C" into three
    // rows, which is exactly the shape a $group needs.
    async _aggregateRuleCounts({ orgId }) {
        const rows = await TurnTrace.aggregate([
            { $match: { orgId, appliedRuleIds: { $exists: true, $ne: [] } } },
            { $unwind: "$appliedRuleIds" },
            {
                $group: {
                    _id: "$appliedRuleIds",
                    used: { $sum: 1 },
                    // "Resolved" here means the turn produced an answer, not
                    // that the conversation was resolved — a rule cannot be
                    // credited with a conversation-level outcome it only
                    // partly influenced. analyticsFunctions owns the
                    // conversation-level definition (§3.3) and this is
                    // deliberately the narrower, honest one.
                    resolved: { $sum: { $cond: [{ $eq: ["$outcome", TurnOutcome.ANSWERED] }, 1, 0] } },
                    escalated: { $sum: { $cond: [{ $eq: ["$outcome", TurnOutcome.ESCALATED] }, 1, 0] } },
                },
            },
        ]);

        return new Map(rows.map((row) => [row._id, { used: row.used, resolved: row.resolved, escalated: row.escalated }]));
    }

    async _writeRuleCounts({ orgId, counts }) {
        let updated = 0;
        const computedAt = new Date();

        for (const { Model, idField } of COUNTED_MODELS) {
            const documents = await Model.find({ orgId }).select(idField).lean();
            if (documents.length === 0) continue;

            const operations = documents.map((document) => {
                const stats = counts.get(document[idField]) || { used: 0, resolved: 0, escalated: 0 };
                return {
                    updateOne: {
                        filter: { orgId, [idField]: document[idField] },
                        update: { $set: { stats: { ...stats, computedAt } } },
                    },
                };
            });

            // One round-trip per collection rather than per rule. A workspace
            // with sixty rules should not produce sixty updates on every tick.
            const result = await Model.bulkWrite(operations);
            updated += result.modifiedCount || 0;
        }

        return updated;
    }

    // Procedures are attributed by procedureId, which the trace already carries
    // as a single field rather than in the appliedRuleIds array.
    async _writeProcedureCounts({ orgId }) {
        const rows = await TurnTrace.aggregate([
            { $match: { orgId, procedureId: { $ne: null } } },
            {
                $group: {
                    _id: "$procedureId",
                    used: { $sum: 1 },
                    resolved: { $sum: { $cond: [{ $eq: ["$outcome", TurnOutcome.ANSWERED] }, 1, 0] } },
                    escalated: { $sum: { $cond: [{ $eq: ["$outcome", TurnOutcome.ESCALATED] }, 1, 0] } },
                },
            },
        ]);
        if (rows.length === 0) return 0;

        const computedAt = new Date();
        const result = await Procedure.bulkWrite(
            rows.map((row) => ({
                updateOne: {
                    filter: { orgId, procedureId: row._id },
                    update: {
                        $set: {
                            stats: { used: row.used, resolved: row.resolved, escalated: row.escalated, computedAt },
                        },
                    },
                },
            }))
        );
        return result.modifiedCount || 0;
    }

    // Actions are attributed from their own execution records rather than from
    // traces: an action can be executed by a procedure, by the model, or from
    // the inbox, and only the execution log sees all three.
    async _writeActionCounts({ orgId }) {
        const ActionExecution = require("../../models/action/actionExecution");
        const rows = await ActionExecution.aggregate([
            { $match: { orgId } },
            {
                $group: {
                    _id: "$actionId",
                    used: { $sum: 1 },
                    resolved: { $sum: { $cond: [{ $eq: ["$status", "EXECUTED"] }, 1, 0] } },
                    escalated: { $sum: { $cond: [{ $eq: ["$status", "FAILED"] }, 1, 0] } },
                },
            },
        ]);
        if (rows.length === 0) return 0;

        const computedAt = new Date();
        const result = await Action.bulkWrite(
            rows.map((row) => ({
                updateOne: {
                    filter: { orgId, actionId: row._id },
                    update: {
                        $set: {
                            stats: { used: row.used, resolved: row.resolved, escalated: row.escalated, computedAt },
                        },
                    },
                },
            }))
        );
        return result.modifiedCount || 0;
    }
}

module.exports = new AttributionFunctions();

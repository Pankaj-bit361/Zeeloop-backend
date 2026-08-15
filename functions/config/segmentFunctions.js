const { IdPrefix, ConfigObjectType } = require("../../config/enums");
const Segment = require("../../models/config/segment");
const GuidanceRule = require("../../models/config/guidanceRule");
const EscalationRule = require("../../models/config/escalationRule");
const EscalationGuidance = require("../../models/config/escalationGuidance");
const Attribute = require("../../models/config/attribute");
const generalFunctions = require("../utilFunctions/generalFunctions");
const conditionFunctions = require("./conditionFunctions");

// §2.6 — audiences, built once and referenced everywhere.
//
// Segments get their own functions file rather than joining the registry
// because they are not publishable and because they are referenced BY the
// registry types, which means delete needs to check for references. That check
// is the whole reason this file exists: a segment deleted out from under five
// guidance rules turns them all into rules that match nobody, silently.

const REFERENCING_MODELS = [
    { Model: GuidanceRule, idField: "guidanceRuleId", type: ConfigObjectType.GUIDANCE_RULE },
    { Model: EscalationRule, idField: "escalationRuleId", type: ConfigObjectType.ESCALATION_RULE },
    { Model: EscalationGuidance, idField: "escalationGuidanceId", type: ConfigObjectType.ESCALATION_GUIDANCE },
    { Model: Attribute, idField: "attributeId", type: ConfigObjectType.ATTRIBUTE },
];

class SegmentFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async listSegments({ orgId }) {
        console.log("SegmentFunctions:listSegments: orgId:", orgId);
        try {
            const segments = await Segment.find({ orgId }).sort({ createdAt: 1 }).lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: segments.map((segment) => ({
                        segmentId: segment.segmentId,
                        name: segment.name,
                        description: segment.description,
                        conditions: segment.conditions,
                        // Rendered here rather than in the dashboard so the API
                        // and the UI can never disagree about what a segment means.
                        summary: conditionFunctions.describe({ conditions: segment.conditions }),
                        createdAt: segment.createdAt,
                    })),
                },
            };
        } catch (error) {
            console.error("SegmentFunctions:listSegments: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createSegment({ orgId, name, description, conditions }) {
        console.log("SegmentFunctions:createSegment: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) {
                return { status: 400, json: { success: false, error: "name is required" } };
            }
            const validation = conditionFunctions.validate({ conditions: conditions || [] });
            if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };

            const segment = await Segment.create({
                orgId,
                segmentId: generalFunctions.generateId(IdPrefix.SEGMENT),
                name: String(name).trim(),
                description: description || "",
                conditions: conditions || [],
            });

            return { status: 201, json: { success: true, data: segment.toJSON() } };
        } catch (error) {
            console.error("SegmentFunctions:createSegment: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async updateSegment({ orgId, segmentId, name, description, conditions }) {
        console.log("SegmentFunctions:updateSegment: segmentId:", segmentId);
        try {
            const segment = await Segment.findOne({ orgId, segmentId });
            if (!segment) return { status: 404, json: { success: false, error: "Segment not found" } };

            if (conditions !== undefined) {
                const validation = conditionFunctions.validate({ conditions });
                if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };
                segment.conditions = conditions;
            }
            if (name !== undefined) segment.name = String(name).trim();
            if (description !== undefined) segment.description = description;
            await segment.save();

            return { status: 200, json: { success: true, data: segment.toJSON() } };
        } catch (error) {
            console.error("SegmentFunctions:updateSegment: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Refuses while anything still points at it, and says what. Cascading
    // instead would silently widen five rules from "paid customers" to
    // "everyone", which is a behaviour change nobody asked for and nobody sees.
    async deleteSegment({ orgId, segmentId }) {
        console.log("SegmentFunctions:deleteSegment: segmentId:", segmentId);
        try {
            const segment = await Segment.findOne({ orgId, segmentId });
            if (!segment) return { status: 404, json: { success: false, error: "Segment not found" } };

            const references = await this._findReferences({ orgId, segmentId });
            if (references.length > 0) {
                return {
                    status: 409,
                    json: {
                        success: false,
                        error: `This segment is used by ${references.length} object${references.length === 1 ? "" : "s"}. Point them elsewhere first.`,
                        references,
                    },
                };
            }

            await Segment.deleteOne({ orgId, segmentId });
            return { status: 200, json: { success: true, data: { deleted: segmentId } } };
        } catch (error) {
            console.error("SegmentFunctions:deleteSegment: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Returns the segment ids an end-user context falls into. Called once per
    // turn and passed down, so ten rules referencing four segments cost four
    // evaluations rather than ten.
    async resolveMembership({ orgId, context }) {
        console.log("SegmentFunctions:resolveMembership: orgId:", orgId);
        try {
            const segments = await Segment.find({ orgId }).lean();
            const memberOf = segments
                .filter((segment) => conditionFunctions.evaluate({ conditions: segment.conditions, context }).matched)
                .map((segment) => segment.segmentId);
            return { success: true, segmentIds: memberOf };
        } catch (error) {
            console.error("SegmentFunctions:resolveMembership: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Fail to "member of nothing" rather than "member of everything":
            // an audience-restricted rule should go quiet on error, not leak to
            // every visitor.
            return { success: false, segmentIds: [] };
        }
    }

    // Does a config object's audience include this visitor? The single place
    // that decision is made, so guidance, escalation and attributes cannot
    // drift apart on what "everyone" means.
    appliesToAudience({ audience, segmentIds }) {
        if (!audience || audience.type !== "segment") return true;
        if (!audience.segmentId) return true;
        return (segmentIds || []).includes(audience.segmentId);
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _findReferences({ orgId, segmentId }) {
        const found = [];
        for (const { Model, idField, type } of REFERENCING_MODELS) {
            const documents = await Model.find({ orgId, "audience.segmentId": segmentId })
                .select(`${idField} title name`)
                .lean();
            for (const document of documents) {
                found.push({ objectType: type, objectId: document[idField], name: document.title || document.name });
            }
        }
        return found;
    }
}

module.exports = new SegmentFunctions();

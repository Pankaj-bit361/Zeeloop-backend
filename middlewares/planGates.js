const { FeatureKey } = require("../config/enums");
const { attachPlan, requireFeature, requireCapacity } = require("./plan");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const Action = require("../models/action/action");
const Table = require("../models/table/table");
const Member = require("../models/org/member");

// Pre-composed gates, one per gated resource. Route files import these and stay
// thin (Rule 1) rather than each assembling attachPlan + a counter by hand.
//
// Every gate is [attachPlan, ...], because a gate with no plan attached fails
// open and would silently stop gating.

const sourceCapacity = [attachPlan, requireCapacity("sources", (orgId) => KnowledgeSource.countDocuments({ orgId }))];

const actionCapacity = [
    attachPlan,
    requireFeature(FeatureKey.ACTIONS),
    requireCapacity("actions", (orgId) => Action.countDocuments({ orgId })),
];

const tableCapacity = [
    attachPlan,
    requireFeature(FeatureKey.TABLES),
    requireCapacity("tables", (orgId) => Table.countDocuments({ orgId })),
];

// Seats count invited members too — an invitation that cannot be accepted
// because the workspace is full is a worse experience than being told now.
const seatCapacity = [attachPlan, requireCapacity("seats", (orgId) => Member.countDocuments({ orgId }))];

module.exports = { sourceCapacity, actionCapacity, tableCapacity, seatCapacity };

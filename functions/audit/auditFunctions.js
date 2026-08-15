const { IdPrefix } = require("../../config/enums");
const AuditLog = require("../../models/org/auditLog");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §8.4. Deliberately tiny: one write, one read, no update, no delete.

const MAX_PAGE_SIZE = 200;

class AuditFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Returns { success } rather than { status, json } because it is called
    // from inside other public functions, never straight from a route. It also
    // never throws: an audit row failing to write must not roll back the change
    // it was describing. The alternative — refusing to remove a member because
    // the log is unavailable — trades a real operation for a paper one.
    async record({ orgId, action, actorEmail, targetType, targetId, detail, ip }) {
        console.log("AuditFunctions:record: orgId:", orgId, "action:", action);
        try {
            await AuditLog.create({
                orgId,
                auditLogId: generalFunctions.generateId(IdPrefix.AUDIT_LOG),
                action,
                actorEmail: actorEmail || null,
                targetType: targetType || null,
                targetId: targetId || null,
                detail: detail || {},
                ip: ip || null,
            });
            return { success: true };
        } catch (error) {
            console.error("AuditFunctions:record: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    async list({ orgId, action, page, limit }) {
        console.log("AuditFunctions:list: orgId:", orgId);
        try {
            const pageNumber = Math.max(1, Number(page) || 1);
            const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || 50));

            const query = { orgId };
            if (action) query.action = action;

            const [entries, total] = await Promise.all([
                AuditLog.find(query)
                    .sort({ createdAt: -1 })
                    .skip((pageNumber - 1) * pageSize)
                    .limit(pageSize)
                    .lean(),
                AuditLog.countDocuments(query),
            ]);

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
                    pagination: { page: pageNumber, limit: pageSize, total },
                },
            };
        } catch (error) {
            console.error("AuditFunctions:list: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }
}

module.exports = new AuditFunctions();
module.exports.MAX_PAGE_SIZE = MAX_PAGE_SIZE;

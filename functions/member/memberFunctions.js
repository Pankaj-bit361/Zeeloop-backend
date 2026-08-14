const Member = require("../../models/org/member");
const Org = require("../../models/org/org");
const { MemberRole, MemberStatus, IdPrefix } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

class MemberFunctions {
    // GET /api/org/:orgId/me — the signed-in seat. Self-healing: an org that has
    // never had a seat row gets one on first read, so the dashboard never has to
    // render a placeholder name.
    async getMe({ orgId, email }) {
        console.log("MemberFunctions:getMe: orgId:", orgId, "email:", email);
        try {
            if (!orgId || !email) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and email" } };
            }
            const result = await this._ensureMember({ orgId, email });
            if (!result.success) {
                return { status: result.status || 500, json: { success: false, error: result.error } };
            }
            await Member.updateOne({ memberId: result.member.memberId }, { lastActiveAt: new Date() });
            return { status: 200, json: { success: true, data: result.member } };
        } catch (error) {
            console.error("MemberFunctions:getMe: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // PATCH /api/org/:orgId/me
    async updateMe({ orgId, email, name, designation }) {
        console.log("MemberFunctions:updateMe: orgId:", orgId, "email:", email);
        try {
            if (!orgId || !email) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and email" } };
            }
            if (name !== undefined && !String(name).trim()) {
                return { status: 400, json: { success: false, error: "Name cannot be empty" } };
            }
            const ensured = await this._ensureMember({ orgId, email });
            if (!ensured.success) {
                return { status: ensured.status || 500, json: { success: false, error: ensured.error } };
            }
            const member = await Member.findOneAndUpdate(
                { memberId: ensured.member.memberId },
                {
                    ...(name !== undefined && { name: String(name).trim() }),
                    ...(designation !== undefined && { designation: String(designation).trim() }),
                },
                { new: true }
            );
            return { status: 200, json: { success: true, data: member } };
        } catch (error) {
            console.error("MemberFunctions:updateMe: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // GET /api/org/:orgId/members
    async listMembers({ orgId }) {
        console.log("MemberFunctions:listMembers: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const members = await Member.find({ orgId }).sort({ createdAt: 1 });
            return { status: 200, json: { success: true, data: members, total: members.length } };
        } catch (error) {
            console.error("MemberFunctions:listMembers: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/org/:orgId/members — creates an INVITED seat. Delivering the
    // invite email is out of scope; the seat is real and shows as pending.
    async inviteMember({ orgId, email, role }) {
        console.log("MemberFunctions:inviteMember: orgId:", orgId, "email:", email);
        try {
            if (!orgId || !email) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and email" } };
            }
            const normalized = String(email).trim().toLowerCase();
            if (!normalized.includes("@")) {
                return { status: 400, json: { success: false, error: "Enter a valid email address" } };
            }
            const memberRole = role && Object.values(MemberRole).includes(role) ? role : MemberRole.AGENT;
            if (memberRole === MemberRole.OWNER) {
                return { status: 400, json: { success: false, error: "An org has exactly one owner" } };
            }

            const existing = await Member.findOne({ orgId, email: normalized });
            if (existing) {
                return { status: 409, json: { success: false, error: "That email already has a seat" } };
            }

            const member = await Member.create({
                orgId,
                memberId: generalFunctions.generateId(IdPrefix.MEMBER),
                email: normalized,
                name: normalized.split("@")[0],
                role: memberRole,
                status: MemberStatus.INVITED,
            });
            return { status: 201, json: { success: true, data: member } };
        } catch (error) {
            console.error("MemberFunctions:inviteMember: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // DELETE /api/org/:orgId/members/:memberId
    async removeMember({ orgId, memberId }) {
        console.log("MemberFunctions:removeMember: orgId:", orgId, "memberId:", memberId);
        try {
            if (!orgId || !memberId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and memberId" } };
            }
            const member = await Member.findOne({ orgId, memberId });
            if (!member) {
                return { status: 404, json: { success: false, error: "Member not found" } };
            }
            if (member.role === MemberRole.OWNER) {
                return { status: 409, json: { success: false, error: "The owner seat cannot be removed" } };
            }
            await Member.deleteOne({ orgId, memberId });
            return { status: 200, json: { success: true, data: { memberId } } };
        } catch (error) {
            console.error("MemberFunctions:removeMember: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Finds or creates the seat for this email. The org's ownerEmail always maps
    // to the OWNER seat, so a freshly reset org still has a real identity.
    async _ensureMember({ orgId, email }) {
        const normalized = String(email).trim().toLowerCase();
        const existing = await Member.findOne({ orgId, email: normalized });
        if (existing) return { success: true, member: existing };

        const org = await Org.findOne({ orgId }).lean();
        if (!org) return { success: false, status: 404, error: "Org not found" };

        const isOwner = String(org.ownerEmail).trim().toLowerCase() === normalized;
        const member = await Member.create({
            orgId,
            memberId: generalFunctions.generateId(IdPrefix.MEMBER),
            email: normalized,
            name: normalized.split("@")[0],
            role: isOwner ? MemberRole.OWNER : MemberRole.AGENT,
            status: MemberStatus.ACTIVE,
            lastActiveAt: new Date(),
        });
        console.log("MemberFunctions:_ensureMember: created seat:", member.memberId);
        return { success: true, member };
    }
}

module.exports = new MemberFunctions();

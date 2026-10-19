const express = require("express");
const adminFunctions = require("../functions/admin/adminFunctions");
const { requireAdmin } = require("../middlewares/admin");

// /api/admin — the admin panel (functions/admin/adminFunctions.js). Staff only
// (ADMIN_EMAILS), on the dashboard session cookie; every change needs a reason.
const router = express.Router();
router.use(requireAdmin);

const send = (work) => async (req, res) => {
    const { status, json } = await work(req);
    return res.status(status).json(json);
};
const by = (req) => req.adminEmail;

router.get("/overview", send(() => adminFunctions.overview()));
router.get("/workspaces", send((req) => adminFunctions.listWorkspaces(req.query)));
router.get("/workspaces/:orgId", send((req) => adminFunctions.getWorkspace({ orgId: req.params.orgId })));
router.post("/workspaces/:orgId/plan", send((req) => adminFunctions.setPlan({ adminEmail: by(req), orgId: req.params.orgId, plan: req.body.plan, reason: req.body.reason })));
router.post("/workspaces/:orgId/trial", send((req) => adminFunctions.extendTrial({ adminEmail: by(req), orgId: req.params.orgId, days: req.body.days, plan: req.body.plan, reason: req.body.reason })));
router.post("/workspaces/:orgId/suspend", send((req) => adminFunctions.setSuspended({ adminEmail: by(req), orgId: req.params.orgId, suspended: req.body.suspended, reason: req.body.reason })));
router.post("/accounts/:accountId/verify-email", send((req) => adminFunctions.verifyAccountEmail({ adminEmail: by(req), accountId: req.params.accountId, reason: req.body.reason })));
router.post("/accounts/:accountId/sign-out", send((req) => adminFunctions.signOutAccount({ adminEmail: by(req), accountId: req.params.accountId, reason: req.body.reason })));
router.get("/audit", send((req) => adminFunctions.listAudit({ orgId: req.query.orgId, limit: req.query.limit })));

module.exports = router;

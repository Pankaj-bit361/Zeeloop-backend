const express = require("express");
const tableFunctions = require("../functions/table/tableFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

router.get("/:orgId/tables", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.listTables({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/tables", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.createTable({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            columns: req.body.columns,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/tables/:tableId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.getTable({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/tables/:tableId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.updateTable({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
            name: req.body.name,
            description: req.body.description,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.delete("/:orgId/tables/:tableId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.deleteTable({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/tables/:tableId/rows", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.listRows({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
            search: req.query.search,
            page: req.query.page,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/tables/:tableId/rows", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.createRow({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
            data: req.body.data,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/tables/:tableId/rows/:rowId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.updateRow({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
            rowId: req.params.rowId,
            data: req.body.data,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.delete("/:orgId/tables/:tableId/rows/:rowId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.deleteRow({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
            rowId: req.params.rowId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/tables/:tableId/import", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await tableFunctions.importRows({
            orgId: req.params.orgId,
            tableId: req.params.tableId,
            csv: req.body.csv,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Table router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;

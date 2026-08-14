const Action = require("../../models/action/action");
const ActionExecution = require("../../models/action/actionExecution");
const { AccessType, ExecutionStatus, BlockReason, TestStatus, IdPrefix } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

class ActionFunctions {
    async listActions({ orgId }) {
        console.log("ActionFunctions:listActions: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const actions = await Action.find({ orgId }).sort({ createdAt: -1 });
            return { status: 200, json: { success: true, data: actions } };
        } catch (error) {
            console.error("ActionFunctions:listActions: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createAction({ orgId, name, description, accessType, method, urlTemplate, params, headers, secret, requiresIdentity, requiresConfirmation }) {
        console.log("ActionFunctions:createAction: orgId:", orgId);
        try {
            if (!orgId || !name || !description || !urlTemplate) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass orgId, name, description and urlTemplate" },
                };
            }
            // accessType is required with no default — the author must declare it
            if (!Object.values(AccessType).includes(accessType)) {
                return { status: 400, json: { success: false, error: "accessType must be READ or WRITE" } };
            }

            const action = await Action.create({
                orgId,
                actionId: generalFunctions.generateId(IdPrefix.ACTION),
                name,
                description,
                accessType,
                method: method || "GET",
                urlTemplate,
                params: params || [],
                headers: headers || {},
                ...(secret && { secret: generalFunctions.encrypt(secret) }),
                enabled: false,
                requiresIdentity: requiresIdentity !== false,
                requiresConfirmation: requiresConfirmation !== false,
                lastTestStatus: null,
            });
            return { status: 201, json: { success: true, data: action } };
        } catch (error) {
            console.error("ActionFunctions:createAction: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async updateAction({ orgId, actionId, name, description, accessType, method, urlTemplate, params, headers, secret, enabled, requiresIdentity, requiresConfirmation }) {
        console.log("ActionFunctions:updateAction: orgId:", orgId, "actionId:", actionId);
        try {
            if (!orgId || !actionId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and actionId" } };
            }
            if (accessType !== undefined && !Object.values(AccessType).includes(accessType)) {
                return { status: 400, json: { success: false, error: "accessType must be READ or WRITE" } };
            }

            // Changing url, params or secret resets lastTestStatus — the action
            // disappears from the model until it passes a test call again.
            const resetsTest = urlTemplate !== undefined || params !== undefined || secret !== undefined;

            const action = await Action.findOneAndUpdate(
                { orgId, actionId },
                {
                    ...(name !== undefined && { name }),
                    ...(description !== undefined && { description }),
                    ...(accessType !== undefined && { accessType }),
                    ...(method !== undefined && { method }),
                    ...(urlTemplate !== undefined && { urlTemplate }),
                    ...(params !== undefined && { params }),
                    ...(headers !== undefined && { headers }),
                    ...(secret !== undefined && { secret: generalFunctions.encrypt(secret) }),
                    ...(enabled !== undefined && { enabled }),
                    ...(requiresIdentity !== undefined && { requiresIdentity }),
                    ...(requiresConfirmation !== undefined && { requiresConfirmation }),
                    ...(resetsTest && { lastTestStatus: null, lastTestedAt: null }),
                },
                { new: true }
            );

            if (!action) {
                return { status: 404, json: { success: false, error: "Action not found" } };
            }
            return { status: 200, json: { success: true, data: action } };
        } catch (error) {
            console.error("ActionFunctions:updateAction: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteAction({ orgId, actionId }) {
        console.log("ActionFunctions:deleteAction: orgId:", orgId, "actionId:", actionId);
        try {
            if (!orgId || !actionId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and actionId" } };
            }
            const action = await Action.findOneAndDelete({ orgId, actionId });
            if (!action) {
                return { status: 404, json: { success: false, error: "Action not found" } };
            }
            return { status: 200, json: { success: true } };
        } catch (error) {
            console.error("ActionFunctions:deleteAction: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST .../actions/:actionId/test — a real call with sample args, setting lastTestStatus.
    async testAction({ orgId, actionId, args }) {
        console.log("ActionFunctions:testAction: orgId:", orgId, "actionId:", actionId);
        try {
            if (!orgId || !actionId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and actionId" } };
            }
            const action = await Action.findOne({ orgId, actionId }).select("+secret");
            if (!action) {
                return { status: 404, json: { success: false, error: "Action not found" } };
            }

            const callResult = await this._callEndpoint({ action, args: args || {} });
            const passed = callResult.success && callResult.httpStatus >= 200 && callResult.httpStatus < 300;

            action.lastTestStatus = passed ? TestStatus.PASS : TestStatus.FAIL;
            action.lastTestedAt = new Date();
            await action.save();

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        lastTestStatus: action.lastTestStatus,
                        httpStatus: callResult.httpStatus || null,
                        durationMs: callResult.durationMs,
                        body: callResult.body || null,
                        error: callResult.error || null,
                    },
                },
            };
        } catch (error) {
            console.error("ActionFunctions:testAction: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Internal — called by the agent pipeline and the confirm flow, not by routes.
    // Every execution (including blocked ones) leaves an ActionExecution audit row.
    async executeAction({ orgId, actionId, args, conversationId, endUserId, confirmed, identityVerified }) {
        console.log("ActionFunctions:executeAction: orgId:", orgId, "actionId:", actionId);
        try {
            const action = await Action.findOne({ orgId, actionId }).select("+secret");

            const blockReason = this._guardCheck({ action, identityVerified, confirmed });
            if (blockReason) {
                await this._recordExecution({
                    orgId,
                    actionId,
                    conversationId,
                    endUserId,
                    status: ExecutionStatus.BLOCKED,
                    blockReason,
                    request: { method: action ? action.method : null, url: action ? action.urlTemplate : null, args },
                    response: {},
                });
                return { success: false, blocked: true, blockReason };
            }

            const callResult = await this._callEndpoint({ action, args });
            const execution = await this._recordExecution({
                orgId,
                actionId,
                conversationId,
                endUserId,
                status: callResult.success ? ExecutionStatus.EXECUTED : ExecutionStatus.FAILED,
                blockReason: null,
                request: { method: action.method, url: callResult.url || action.urlTemplate, args },
                response: { status: callResult.httpStatus, body: callResult.body, durationMs: callResult.durationMs },
            });

            if (!callResult.success) {
                return { success: false, error: callResult.error || `Endpoint returned ${callResult.httpStatus}`, executionId: execution.executionId };
            }
            return { success: true, data: callResult.body, executionId: execution.executionId };
        } catch (error) {
            console.error("ActionFunctions:executeAction: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, error: "Action execution failed" };
        }
    }

    // Private Helper Functions

    _guardCheck({ action, identityVerified, confirmed }) {
        if (!action || !action.enabled) return BlockReason.NOT_AVAILABLE;
        if (action.lastTestStatus !== TestStatus.PASS) return BlockReason.NEVER_TESTED;
        if (action.requiresIdentity && !identityVerified) return BlockReason.IDENTITY_REQUIRED;
        if (action.accessType === AccessType.WRITE && action.requiresConfirmation && !confirmed) {
            return BlockReason.CONFIRMATION_REQUIRED;
        }
        return null;
    }

    async _callEndpoint({ action, args }) {
        const start = Date.now();
        try {
            let url = action.urlTemplate;
            const bodyArgs = {};
            for (const [key, value] of Object.entries(args || {})) {
                const placeholder = `{${key}}`;
                if (url.includes(placeholder)) {
                    url = url.replace(placeholder, encodeURIComponent(String(value)));
                } else {
                    bodyArgs[key] = value;
                }
            }

            const headers = { "content-type": "application/json", ...(action.headers || {}) };
            if (action.secret) {
                headers.authorization = `Bearer ${generalFunctions.decrypt(action.secret)}`;
            }

            const method = (action.method || "GET").toUpperCase();
            const response = await fetch(url, {
                method,
                headers,
                ...(method !== "GET" && method !== "HEAD" && { body: JSON.stringify(bodyArgs) }),
            });

            let body = null;
            try {
                body = await response.json();
            } catch (parseError) {
                body = null;
            }

            return {
                success: response.ok,
                httpStatus: response.status,
                body,
                url,
                durationMs: Date.now() - start,
                ...(response.ok ? {} : { error: `Endpoint returned ${response.status}` }),
            };
        } catch (error) {
            return { success: false, error: error.message, durationMs: Date.now() - start };
        }
    }

    async _recordExecution({ orgId, actionId, conversationId, endUserId, status, blockReason, request, response }) {
        const execution = await ActionExecution.create({
            orgId,
            executionId: generalFunctions.generateId(IdPrefix.ACTION_EXECUTION),
            actionId,
            conversationId: conversationId || null,
            endUserId: endUserId || null,
            status,
            blockReason,
            request,
            response,
        });
        return execution;
    }
}

module.exports = new ActionFunctions();

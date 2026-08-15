const Action = require("../../models/action/action");
const ActionExecution = require("../../models/action/actionExecution");
const {
    AccessType,
    ExecutionStatus,
    BlockReason,
    TestStatus,
    IdPrefix,
    ActionKind,
    CredentialType,
    DataInputSource,
} = require("../../config/enums");
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

    async _callEndpoint({ action, args, identity }) {
        const start = Date.now();

        // §5.3 — mock response. Lets an action be configured, wired into a
        // procedure and tested before the API behind it exists.
        //
        // The result says `mocked: true` and _recordExecution stores it, so a
        // mocked call is never mistaken for a real one in the audit trail. An
        // action that silently returned fabricated data to a customer would be
        // far worse than one that does not work yet.
        if (action.mockEnabled) {
            console.log("ActionFunctions:_callEndpoint: returning mock response for", action.actionId);
            return {
                success: true,
                httpStatus: 200,
                body: action.mockResponse ?? {},
                url: action.urlTemplate || `mcp://${action.mcp && action.mcp.toolName}`,
                durationMs: Date.now() - start,
                mocked: true,
            };
        }

        // §5.2 — MCP actions call a tool on the customer's own MCP server.
        if (action.kind === ActionKind.MCP) {
            return this._callMcp({ action, args, start });
        }

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
            const authorised = await this._applyCredential({ action, headers });
            if (!authorised.success) {
                return { success: false, error: authorised.error, durationMs: Date.now() - start };
            }

            // §5.3 — the verified-identity header. Signed with the widget
            // secret so the customer's backend can distinguish "Zealoop
            // verified this person" from "someone typed this address into a
            // chat box". An unsigned header would be worth nothing: anything
            // that can reach their endpoint could set it.
            if (action.sendIdentityHeader && identity && identity.email && identity.verified) {
                const Org = require("../../models/org/org");
                const org = await Org.findOne({ orgId: action.orgId }).select("widgetSecret").lean();
                const secret = org ? generalFunctions.safeDecrypt(org.widgetSecret) : null;
                if (secret) {
                    headers["zealoop-identity"] = identity.email;
                    headers["zealoop-identity-signature"] = generalFunctions.createIdentityHmac({
                        widgetSecret: secret,
                        email: identity.email,
                    });
                }
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

    // §5.2 — MCP over the Streamable HTTP transport. One JSON-RPC POST to
    // `tools/call`, which is the whole protocol surface an action needs: we are
    // a client calling one named tool with named arguments, not a host managing
    // a session.
    //
    // Worth building over adding REST config forms one vendor at a time: Stripe,
    // Linear and Shopify all publish MCP servers, so one integration reaches all
    // of a customer's existing tools rather than one of them.
    async _callMcp({ action, args, start }) {
        try {
            const serverUrl = action.mcp && action.mcp.serverUrl;
            const toolName = action.mcp && action.mcp.toolName;
            if (!serverUrl || !toolName) {
                return { success: false, error: "This MCP action is missing its server URL or tool name", durationMs: Date.now() - start };
            }

            const headers = {
                "content-type": "application/json",
                // Streamable HTTP servers may answer with either, so accept both.
                accept: "application/json, text/event-stream",
                ...(action.headers || {}),
            };
            const authorised = await this._applyCredential({ action, headers });
            if (!authorised.success) {
                return { success: false, error: authorised.error, durationMs: Date.now() - start };
            }

            const response = await fetch(serverUrl, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: generalFunctions.generateId("rpc"),
                    method: "tools/call",
                    params: { name: toolName, arguments: args || {} },
                }),
            });

            const raw = await response.text();
            if (!response.ok) {
                return {
                    success: false,
                    httpStatus: response.status,
                    error: `MCP server returned ${response.status}`,
                    body: raw.slice(0, 500),
                    url: serverUrl,
                    durationMs: Date.now() - start,
                };
            }

            const payload = this._parseMcpPayload(raw);
            if (!payload) {
                return { success: false, error: "MCP server returned an unreadable response", url: serverUrl, durationMs: Date.now() - start };
            }

            // JSON-RPC signals failure in the body with a 200 status, so
            // response.ok is not the whole answer here.
            if (payload.error) {
                return {
                    success: false,
                    httpStatus: response.status,
                    error: payload.error.message || "MCP tool call failed",
                    body: payload.error,
                    url: serverUrl,
                    durationMs: Date.now() - start,
                };
            }

            const result = payload.result || {};
            // isError is how MCP reports a tool that ran and failed, as opposed
            // to a call that could not be made. Both are failures to us.
            if (result.isError) {
                return {
                    success: false,
                    httpStatus: response.status,
                    error: this._mcpText(result) || "The tool reported an error",
                    body: result,
                    url: serverUrl,
                    durationMs: Date.now() - start,
                };
            }

            return {
                success: true,
                httpStatus: response.status,
                // structuredContent when the server provides it, the text
                // blocks otherwise — the model reads this either way.
                body: result.structuredContent || this._mcpText(result) || result,
                url: serverUrl,
                durationMs: Date.now() - start,
            };
        } catch (error) {
            return { success: false, error: error.message, durationMs: Date.now() - start };
        }
    }

    // Streamable HTTP may answer with a plain JSON body or with SSE frames.
    _parseMcpPayload(raw) {
        try {
            return JSON.parse(raw);
        } catch (error) {
            // SSE: one or more `data:` lines. The last complete one is the
            // response to our call.
            const frames = String(raw)
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .filter(Boolean);
            for (let index = frames.length - 1; index >= 0; index--) {
                try {
                    return JSON.parse(frames[index]);
                } catch (frameError) {
                    continue;
                }
            }
            return null;
        }
    }

    _mcpText(result) {
        return (result.content || [])
            .filter((block) => block && block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim();
    }

    // §5.3 — resolves a stored Credential onto the outgoing headers. Falls back
    // to the action's own legacy `secret` field, so actions created before the
    // credential store existed keep working unchanged.
    async _applyCredential({ action, headers }) {
        try {
            if (action.credentialId) {
                const { Credential } = require("../../models/org/expansion");
                const credential = await Credential.findOne({
                    orgId: action.orgId,
                    credentialId: action.credentialId,
                }).lean();
                if (!credential) {
                    return { success: false, error: "The credential this action uses no longer exists" };
                }

                const secret = generalFunctions.safeDecrypt(credential.secret);
                if (!secret) {
                    // A rotated ENCRYPTION_KEY makes every stored secret
                    // unreadable. Saying so beats a 401 from the customer's API
                    // that sends everyone hunting in the wrong place.
                    return { success: false, error: "That credential could not be decrypted — re-enter it in Settings" };
                }

                if (credential.type === CredentialType.BEARER) {
                    headers.authorization = `Bearer ${secret}`;
                } else if (credential.type === CredentialType.API_KEY_HEADER) {
                    headers[credential.headerName || "x-api-key"] = secret;
                } else if (credential.type === CredentialType.BASIC) {
                    headers.authorization = `Basic ${Buffer.from(`${credential.username}:${secret}`).toString("base64")}`;
                }
                return { success: true };
            }

            if (action.secret) {
                const secret = generalFunctions.safeDecrypt(action.secret);
                if (!secret) return { success: false, error: "This action's secret could not be decrypted — re-enter it" };
                headers.authorization = `Bearer ${secret}`;
            }
            return { success: true };
        } catch (error) {
            console.error("ActionFunctions:_applyCredential: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, error: "Could not apply this action's credentials" };
        }
    }

    // §5.3 — data inputs. Which declared inputs are still missing, and what to
    // ask for. Returned to the pipeline so the agent asks the customer rather
    // than the model inventing an order id.
    resolveDataInputs({ action, args, context }) {
        const inputs = action.dataInputs || [];
        if (inputs.length === 0) return { ready: true, missing: [], resolved: args || {} };

        const resolved = { ...(args || {}) };
        const missing = [];

        for (const input of inputs) {
            if (resolved[input.name] !== undefined && resolved[input.name] !== null && resolved[input.name] !== "") continue;

            if (input.source === DataInputSource.IDENTITY && context && context.email) {
                resolved[input.name] = context.email;
                continue;
            }
            if (input.source === DataInputSource.PRIOR_ACTION && context && context.priorResults && input.path) {
                const value = input.path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), context.priorResults);
                if (value !== undefined) {
                    resolved[input.name] = value;
                    continue;
                }
            }
            if (input.source === DataInputSource.TABLE && context && context.tableValues && input.path) {
                const value = context.tableValues[input.path];
                if (value !== undefined) {
                    resolved[input.name] = value;
                    continue;
                }
            }

            if (input.required) {
                missing.push({
                    name: input.name,
                    source: input.source,
                    // The configured question, not one the model makes up —
                    // otherwise "what is your order id" becomes "please provide
                    // your customer reference number".
                    prompt: input.prompt || `What is the ${input.label || input.name}?`,
                });
            }
        }

        return { ready: missing.length === 0, missing, resolved };
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

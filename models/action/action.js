const mongoose = require("mongoose");
const { AccessType, TestStatus, ActionKind, DataInputSource } = require("../../config/enums");
const { statsSchema, publishableFields } = require("../config/shared");

const paramSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        description: { type: String },
        required: { type: Boolean, default: false },
    },
    { _id: false }
);

// §5.3 — data inputs. What must be collected BEFORE the action may run, and
// where each value comes from. Declaring this is what turns "the model
// hallucinated an order id" into "the agent asked for the order id".
const dataInputSchema = new mongoose.Schema(
    {
        _id: false,
        name: { type: String, required: true },
        description: { type: String, default: "" },
        source: { type: String, enum: Object.values(DataInputSource), required: true },
        required: { type: Boolean, default: true },
        // What to ask, when source is ASK_CUSTOMER. Without this the model
        // invents the question, which is how "what is your order id" becomes
        // "please provide your customer reference number".
        prompt: { type: String, default: "" },
        // Which prior action's output field, when source is PRIOR_ACTION.
        // Which table column, when source is TABLE.
        path: { type: String, default: null },
    },
    { _id: false }
);

const actionSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        actionId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, required: true },
        // required with no default: forcing the author to declare READ or WRITE is the point
        accessType: { type: String, enum: Object.values(AccessType), required: true },
        // §5.2 — REST posts to a URL; MCP calls a tool on the customer's own MCP
        // server. One MCP integration unlocks their entire existing tool
        // ecosystem, which is considerably more leverage than building REST
        // config forms one vendor at a time.
        kind: { type: String, enum: Object.values(ActionKind), default: ActionKind.REST },
        method: { type: String, default: "GET" },
        // Required for REST. Validated in actionFunctions rather than by the
        // schema, because an MCP action legitimately has neither.
        urlTemplate: { type: String, default: "" },
        // MCP: which server, which tool on it.
        mcp: {
            serverUrl: { type: String, default: "" },
            toolName: { type: String, default: "" },
        },
        params: { type: [paramSchema], default: [] },
        dataInputs: { type: [dataInputSchema], default: [] },
        headers: { type: mongoose.Schema.Types.Mixed, default: {} },
        // AES-256-GCM encrypted at rest. Legacy per-action secret; new actions
        // should reference a Credential instead, which is reusable and rotatable
        // in one place.
        secret: { type: String },
        // §5.3 — reference into the credential store.
        credentialId: { type: String, default: null },
        // §5.3 — a canned response so an action can be built and tested before
        // the API behind it exists. Only used when mockEnabled is on, and the
        // test call says loudly that it was mocked; an action that silently
        // returned fake data to a customer would be far worse than one that did
        // not work yet.
        mockEnabled: { type: Boolean, default: false },
        mockResponse: { type: mongoose.Schema.Types.Mixed, default: null },
        enabled: { type: Boolean, default: false },
        requiresIdentity: { type: Boolean, default: true },
        requiresConfirmation: { type: Boolean, default: true },
        // §5.3 — a header carrying the verified identity, so the customer's own
        // backend can distinguish "the agent says this is maya@" from "someone
        // typed maya@ into a chat box". Signed with the widget secret.
        sendIdentityHeader: { type: Boolean, default: false },
        // null = never tested. Changing url/params/secret resets this to null.
        lastTestStatus: { type: String, enum: [...Object.values(TestStatus), null], default: null },
        lastTestedAt: { type: Date },
        // §2.5 — computed by cron from ActionExecution, never at write time.
        stats: { type: statsSchema, default: () => ({}) },
        // §5.3 — actions join the draft/live system. `publishState` is what the
        // agent filters on; the existing `enabled` flag stays as the pause
        // switch it already was.
        publishState: publishableFields.publishState,
        version: publishableFields.version,
        updatedBy: publishableFields.updatedBy,
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                delete ret.secret;
                return ret;
            },
        },
    }
);

module.exports = mongoose.model("Action", actionSchema);

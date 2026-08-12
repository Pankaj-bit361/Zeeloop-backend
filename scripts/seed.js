/**
 * Seeds a demo org with knowledge, actions, conversations and traces so the
 * dashboard has real data to render. Safe to re-run — it wipes the demo org
 * first. Usage: npm run seed
 */
const mongoose = require("mongoose");
const config = require("../config/config");
const {
    SourceType,
    SourceStatus,
    AccessType,
    TestStatus,
    ConversationStatus,
    MessageRole,
    ToolCallStatus,
    TurnOutcome,
    GateIntent,
    ExecutionStatus,
    MemberRole,
    MemberStatus,
    EscalationMode,
    ColumnType,
    AuthProvider,
    IdPrefix,
} = require("../config/enums");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const sessionFunctions = require("../functions/utilFunctions/sessionFunctions");

const Org = require("../models/org/org");
const Member = require("../models/org/member");
const Account = require("../models/user/account");
const EndUser = require("../models/user/endUser");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const Chunk = require("../models/knowledge/chunk");
const Table = require("../models/table/table");
const TableRow = require("../models/table/tableRow");
const Action = require("../models/action/action");
const ActionExecution = require("../models/action/actionExecution");
const Procedure = require("../models/procedure/procedure");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const TurnTrace = require("../models/trace/turnTrace");

const ORG_ID = "org_demo_acmeship";

// The three seats below double as sign-in accounts so the dashboard has a real
// login on a fresh database. Obviously a demo credential, and devLogin already
// refuses to run in production, but the password is only ever written here.
const DEMO_SEATS = [
    { email: "ops@acmeship.com", name: "Pankaj Vashisht", designation: "Support Lead", role: MemberRole.OWNER },
    { email: "rhea@acmeship.com", name: "Rhea Kapoor", designation: "Support Agent", role: MemberRole.AGENT },
    { email: "sam@acmeship.com", name: "Sam Ortiz", designation: "Ops", role: MemberRole.ADMIN },
];
const DEMO_EMAILS = DEMO_SEATS.map((seat) => seat.email);
const DEMO_PASSWORD = "zealoop-demo";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();
const at = (msAgo) => new Date(now - msAgo);
const stamps = (msAgo) => ({ createdAt: at(msAgo), updatedAt: at(msAgo) });

// Deterministic pseudo-random so re-seeding produces the same shape
let seedState = 42;
function rand() {
    seedState = (seedState * 1664525 + 1013904223) % 4294967296;
    return seedState / 4294967296;
}
function pick(list) {
    return list[Math.floor(rand() * list.length)];
}

async function seed() {
    console.log("seed: connecting to", config.MONGODB_URI);
    await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

    // Workspaces the demo accounts created on a previous run — onboarding tests
    // leave these behind, and they outlive the demo org because they have their
    // own orgId. Left in place they quietly break the seed's contract: the demo
    // account ends up with two workspaces and lands in whichever it used last.
    const strayOrgIds = (await Org.find({ ownerEmail: { $in: DEMO_EMAILS }, orgId: { $ne: ORG_ID } }).lean()).map(
        (org) => org.orgId
    );
    if (strayOrgIds.length) {
        console.log(`seed: removing ${strayOrgIds.length} stray workspace(s) left by earlier runs`);
    }

    console.log("seed: clearing existing demo org");
    await Promise.all([
        Org.deleteMany({ orgId: { $in: [ORG_ID, ...strayOrgIds] } }),
        Member.deleteMany({ orgId: { $in: [ORG_ID, ...strayOrgIds] } }),
        // Accounts are not org-scoped, so they are cleared by the addresses this
        // script owns rather than by orgId — wiping the collection would take
        // out any account you created by hand.
        Account.deleteMany({ email: { $in: DEMO_EMAILS } }),
        EndUser.deleteMany({ orgId: ORG_ID }),
        KnowledgeSource.deleteMany({ orgId: ORG_ID }),
        Chunk.deleteMany({ orgId: ORG_ID }),
        Table.deleteMany({ orgId: ORG_ID }),
        TableRow.deleteMany({ orgId: ORG_ID }),
        Action.deleteMany({ orgId: ORG_ID }),
        ActionExecution.deleteMany({ orgId: ORG_ID }),
        Procedure.deleteMany({ orgId: ORG_ID }),
        Conversation.deleteMany({ orgId: ORG_ID }),
        Message.deleteMany({ orgId: ORG_ID }),
        TurnTrace.deleteMany({ orgId: ORG_ID }),
    ]);

    /* ---------------- Org ---------------- */
    const widgetSecret = "ws_live_demo_secret_do_not_use_in_production";
    await Org.create({
        orgId: ORG_ID,
        name: "AcmeShip",
        website: "https://acmeship.com",
        ownerEmail: "ops@acmeship.com",
        publicKey: "pk_live_zea_4Jw9TqXhK2mNvL8s",
        widgetSecret: generalFunctions.encrypt(widgetSecret),
        agent: {
            name: "Zea",
            greeting: "Hi! I'm Zea. Ask me anything about AcmeShip — orders, billing, shipping.",
            language: "en",
        },
        escalation: { mode: EscalationMode.INBOX, email: "" },
        widget: { position: "bottom-right", allowedOrigins: ["https://acmeship.com"] },
        credits: { plan: "GROWTH", conversationsUsed: 412, conversationsLimit: 3000 },
    });

    /* ---------------- Dashboard seats ---------------- */
    // ownerEmail must have a seat — it is what the dev JWT resolves to, and
    // what /api/auth/me joins on to decide which workspaces an account can open.
    await Member.insertMany(
        DEMO_SEATS.map((member, index) => ({
            orgId: ORG_ID,
            memberId: generalFunctions.generateId(IdPrefix.MEMBER),
            ...member,
            status: MemberStatus.ACTIVE,
            lastActiveAt: at(index * 3 * HOUR),
            ...stamps(30 * DAY),
        })),
        { timestamps: false }
    );

    /* ---------------- Sign-in accounts ---------------- */
    // One account per seat, same address. The seat carries the role inside the
    // org; the account is the person who signs in. Both are needed — a seat with
    // no account cannot log in, an account with no seat sees no workspaces.
    await Account.insertMany(
        DEMO_SEATS.map((seat) => ({
            accountId: generalFunctions.generateId(IdPrefix.ACCOUNT),
            email: seat.email,
            name: seat.name,
            passwordHash: sessionFunctions.hashPassword(DEMO_PASSWORD),
            passwordSetAt: new Date(),
            emailVerifiedAt: new Date(),
            providers: [AuthProvider.PASSWORD],
        }))
    );

    /* ---------------- End users ---------------- */
    const endUsers = [
        { name: "Maya Okafor", email: "maya@brightloop.io", verified: true },
        { name: "Dan Reyes", email: "dan@corvid.app", verified: true },
        { name: "Priya Shah", email: "priya@nexafab.com", verified: true },
        { name: "Tomás Silva", email: "tomas@vela.co", verified: true },
        { name: "Ana Willis", email: "ana@fernpost.com", verified: true },
        { name: "Jordan Blake", email: "jordan@tidalworks.io", verified: true },
    ].map((user, index) => ({
        orgId: ORG_ID,
        endUserId: generalFunctions.generateId(IdPrefix.END_USER),
        ...user,
        lastSeenAt: at(index * HOUR),
        ...stamps(10 * DAY),
    }));
    await EndUser.insertMany(endUsers, { timestamps: false });

    /* ---------------- Knowledge sources + chunks ---------------- */
    const sourceSeeds = [
        {
            type: SourceType.SITEMAP,
            name: "docs.acmeship.com",
            url: "https://docs.acmeship.com/sitemap.xml",
            status: SourceStatus.READY,
            syncedAgo: 2 * HOUR,
            sections: [
                ["Shipping", "Delays", "Carrier handoffs"],
                ["Shipping", "Tracking notifications"],
                ["Orders", "Delivery estimates"],
                ["Orders", "Changing an address"],
                ["Billing", "Duplicate charges"],
                ["Billing", "Refund timelines"],
                ["International", "Customs and duties"],
                ["API", "Rate limits"],
            ],
        },
        {
            type: SourceType.URL,
            name: "Pricing page",
            url: "https://acmeship.com/pricing",
            status: SourceStatus.READY,
            syncedAgo: 2 * HOUR,
            sections: [
                ["Pricing", "Plans"],
                ["Pricing", "Growth vs Scale"],
            ],
        },
        {
            type: SourceType.FILE,
            name: "returns-policy-2026.pdf",
            status: SourceStatus.READY,
            syncedAgo: DAY,
            sections: [
                ["Returns", "Eligibility window"],
                ["Returns", "Damaged goods"],
            ],
        },
        {
            type: SourceType.SNIPPET,
            name: "Holiday shipping cutoffs",
            status: SourceStatus.READY,
            syncedAgo: 3 * DAY,
            content: "Orders placed after Dec 18 ship in January. Express cutoff is Dec 21 at noon ET.",
            sections: [["Holiday shipping cutoffs"]],
        },
        {
            type: SourceType.SITEMAP,
            name: "help.acmeship.com",
            url: "https://help.acmeship.com/sitemap.xml",
            status: SourceStatus.CRAWLING,
            syncedAgo: 5 * 60 * 1000,
            sections: [["Help center", "Getting started"]],
        },
        {
            type: SourceType.URL,
            name: "API changelog",
            url: "https://acmeship.com/changelog",
            status: SourceStatus.FAILED,
            syncedAgo: 4 * HOUR,
            lastError: "Fetch failed with status 403",
            sections: [],
        },
    ];

    const chunkDocs = [];
    const sourceDocs = [];
    const chunkIdsByHeading = {};

    for (const seedSource of sourceSeeds) {
        const sourceId = generalFunctions.generateId(IdPrefix.KNOWLEDGE_SOURCE);
        // Chunk counts are inflated to look like a real crawl; we store a
        // representative chunk per section for the browser and traces.
        const inflate = seedSource.type === SourceType.SITEMAP ? 160 : seedSource.type === SourceType.FILE ? 48 : 1;
        seedSource.sections.forEach((headingPath, position) => {
            const chunkId = generalFunctions.generateId(IdPrefix.CHUNK);
            chunkIdsByHeading[headingPath.join(" › ")] = chunkId;
            chunkDocs.push({
                orgId: ORG_ID,
                chunkId,
                sourceId,
                text: `${headingPath.join(" — ")}. ${seedSource.content || "Reference content indexed from " + (seedSource.url || seedSource.name) + "."}`,
                headingPath,
                tokenCount: 380 + Math.floor(rand() * 200),
                position,
                ...stamps(seedSource.syncedAgo),
            });
        });
        sourceDocs.push({
            orgId: ORG_ID,
            sourceId,
            type: seedSource.type,
            name: seedSource.name,
            url: seedSource.url,
            content: seedSource.content,
            status: seedSource.status,
            chunkCount: seedSource.status === SourceStatus.FAILED ? 0 : seedSource.sections.length * inflate,
            lastSyncedAt: seedSource.status === SourceStatus.FAILED ? null : at(seedSource.syncedAgo),
            lastError: seedSource.lastError,
            ...stamps(12 * DAY),
        });
    }
    await KnowledgeSource.insertMany(sourceDocs, { timestamps: false });
    await Chunk.insertMany(chunkDocs, { timestamps: false });

    /* ---------------- Tables ---------------- */
    const tableId = generalFunctions.generateId(IdPrefix.TABLE);
    await Table.create({
        orgId: ORG_ID,
        tableId,
        name: "Customers",
        description: "Plan and account status per customer.",
        columns: [
            { name: "email", type: "string", isIdentityKey: true },
            { name: "plan", type: "string" },
            { name: "accountStatus", type: "string" },
        ],
        rowCount: endUsers.length,
    });
    await TableRow.insertMany(
        endUsers.map((user) => ({
            orgId: ORG_ID,
            rowId: generalFunctions.generateId(IdPrefix.TABLE_ROW),
            tableId,
            identityValue: user.email,
            data: { email: user.email, plan: pick(["Growth", "Scale", "Free"]), accountStatus: "active" },
        }))
    );

    const ordersTableId = generalFunctions.generateId(IdPrefix.TABLE);
    const orderRows = endUsers.flatMap((user, index) =>
        [0, 1].map((offset) => ({
            orderId: `A-${58200 + index * 7 + offset}`,
            email: user.email,
            status: pick(["shipped", "in transit", "delivered", "processing"]),
            total: 40 + ((index * 13 + offset * 29) % 260),
        }))
    );
    await Table.create({
        orgId: ORG_ID,
        tableId: ordersTableId,
        name: "Orders",
        description: "Recent orders the agent can look up by id.",
        columns: [
            { name: "orderId", type: ColumnType.STRING, isIdentityKey: true },
            { name: "email", type: ColumnType.STRING },
            { name: "status", type: ColumnType.STRING },
            { name: "total", type: ColumnType.NUMBER },
        ],
        rowCount: orderRows.length,
    });
    await TableRow.insertMany(
        orderRows.map((row) => ({
            orgId: ORG_ID,
            rowId: generalFunctions.generateId(IdPrefix.TABLE_ROW),
            tableId: ordersTableId,
            identityValue: row.orderId.toLowerCase(),
            data: row,
        }))
    );

    /* ---------------- Actions ---------------- */
    const actionSeeds = [
        {
            name: "Get order status",
            description: "Look up an order by id and return status, carrier and ETA.",
            accessType: AccessType.READ,
            method: "GET",
            urlTemplate: "https://api.acmeship.com/v1/orders/{orderId}",
            params: [{ name: "orderId", description: "The order id, e.g. A-58291", required: true }],
            enabled: true,
            requiresIdentity: true,
            requiresConfirmation: false,
            lastTestStatus: TestStatus.PASS,
            testedAgo: 2 * DAY,
            executions: 1841,
        },
        {
            name: "List recent invoices",
            description: "Return the last five invoices for the identified customer.",
            accessType: AccessType.READ,
            method: "GET",
            urlTemplate: "https://api.acmeship.com/v1/customers/{customerId}/invoices",
            params: [{ name: "customerId", description: "Internal customer id", required: true }],
            enabled: true,
            requiresIdentity: true,
            requiresConfirmation: false,
            lastTestStatus: TestStatus.PASS,
            testedAgo: 4 * DAY,
            executions: 412,
        },
        {
            name: "Issue refund",
            description: "Refund an order up to $200. Above the ceiling the agent escalates.",
            accessType: AccessType.WRITE,
            method: "POST",
            urlTemplate: "https://api.acmeship.com/v1/orders/{orderId}/refund",
            params: [
                { name: "orderId", description: "The order to refund", required: true },
                { name: "amountUsd", description: "Refund amount in USD", required: true },
            ],
            enabled: true,
            requiresIdentity: true,
            requiresConfirmation: true,
            lastTestStatus: TestStatus.PASS,
            testedAgo: DAY,
            executions: 67,
        },
        {
            name: "Update shipping address",
            description: "Change the delivery address on an order that has not shipped.",
            accessType: AccessType.WRITE,
            method: "PATCH",
            urlTemplate: "https://api.acmeship.com/v1/orders/{orderId}/address",
            params: [{ name: "orderId", description: "The order to update", required: true }],
            enabled: true,
            requiresIdentity: true,
            requiresConfirmation: true,
            lastTestStatus: TestStatus.FAIL,
            testedAgo: 6 * HOUR,
            executions: 0,
        },
        {
            name: "Cancel subscription",
            description: "Cancel a subscription at period end. Never immediate.",
            accessType: AccessType.WRITE,
            method: "POST",
            urlTemplate: "https://api.acmeship.com/v1/subscriptions/{subId}/cancel",
            params: [{ name: "subId", description: "Subscription id", required: true }],
            enabled: false,
            requiresIdentity: true,
            requiresConfirmation: true,
            lastTestStatus: null,
            testedAgo: null,
            executions: 0,
        },
    ];

    const actionDocs = actionSeeds.map((action) => ({
        orgId: ORG_ID,
        actionId: generalFunctions.generateId(IdPrefix.ACTION),
        name: action.name,
        description: action.description,
        accessType: action.accessType,
        method: action.method,
        urlTemplate: action.urlTemplate,
        params: action.params,
        headers: {},
        secret: generalFunctions.encrypt("demo-api-token"),
        enabled: action.enabled,
        requiresIdentity: action.requiresIdentity,
        requiresConfirmation: action.requiresConfirmation,
        lastTestStatus: action.lastTestStatus,
        lastTestedAt: action.testedAgo === null ? null : at(action.testedAgo),
        ...stamps(20 * DAY),
    }));
    await Action.insertMany(actionDocs, { timestamps: false });
    const actionByName = new Map(actionDocs.map((a) => [a.name, a]));

    /* ---------------- Procedure ---------------- */
    await Procedure.create({
        orgId: ORG_ID,
        procedureId: generalFunctions.generateId(IdPrefix.PROCEDURE),
        name: "Refund request",
        description: "How to handle a customer asking for money back.",
        keywords: ["refund", "money back", "double charge", "charged twice"],
        steps: [
            "Verify the customer's identity before discussing any charge.",
            "Look up the charge with List recent invoices and confirm the duplicate.",
            "If the amount is $200 or less, propose Issue refund and wait for confirmation.",
            "If the amount exceeds $200, escalate to a human teammate instead.",
        ],
        enabled: true,
    });

    /* ---------------- Conversations, messages, traces ---------------- */
    const scripted = [
        {
            userIndex: 0,
            startedAgo: 24 * 60 * 1000,
            status: ConversationStatus.RESOLVED,
            isResolved: true,
            outcome: TurnOutcome.ANSWERED,
            costUsd: 0.031,
            turns: [
                {
                    user: "Where is my order #A-58291? It was supposed to arrive Tuesday.",
                    assistant:
                        "Order A-58291 shipped with DHL on Aug 4 and is currently at the Chicago sorting facility. The revised delivery estimate is tomorrow before 8pm.",
                    tool: { name: "Get order status", status: ToolCallStatus.EXECUTED },
                    citations: ["Shipping › Delays › Carrier handoffs"],
                    trace: {
                        gateIntent: GateIntent.ACTION_REQUEST,
                        candidateCount: 38,
                        chunks: ["Shipping › Delays › Carrier handoffs", "Shipping › Tracking notifications", "Orders › Delivery estimates"],
                        scores: [0.91, 0.84, 0.79],
                        outcome: TurnOutcome.ANSWERED,
                        latency: { gate: 142, rewrite: 0, retrieve: 118, rerank: 87, generate: 1460, validate: 233 },
                        tokens: [3120, 214],
                        cost: 0.011,
                    },
                },
                {
                    user: "Great, will I get a tracking notification?",
                    assistant:
                        "Yes — you'll receive an email and an SMS when it's out for delivery. You can also follow the live tracking link from your order page at any time.",
                    citations: ["Shipping › Tracking notifications"],
                    trace: {
                        gateIntent: GateIntent.QUESTION,
                        rewritten: "will I get a tracking notification for order A-58291",
                        candidateCount: 31,
                        chunks: ["Shipping › Tracking notifications", "Orders › Delivery estimates"],
                        scores: [0.88, 0.71],
                        outcome: TurnOutcome.ANSWERED,
                        latency: { gate: 131, rewrite: 168, retrieve: 104, rerank: 79, generate: 1180, validate: 210 },
                        tokens: [2740, 168],
                        cost: 0.009,
                    },
                },
            ],
        },
        {
            userIndex: 1,
            startedAgo: HOUR,
            status: ConversationStatus.OPEN,
            isResolved: false,
            outcome: TurnOutcome.CLARIFIED,
            costUsd: 0.058,
            pendingActionName: "Issue refund",
            turns: [
                {
                    user: "I was double charged for July, can you refund one of the charges?",
                    assistant:
                        "I can see two charges of $49 on July 1 and July 2. I can refund the duplicate charge of $49 from July 2. Do you want me to proceed?",
                    tool: { name: "Issue refund", status: ToolCallStatus.AWAITING_CONFIRMATION },
                    citations: ["Billing › Duplicate charges"],
                    trace: {
                        gateIntent: GateIntent.ACTION_REQUEST,
                        candidateCount: 34,
                        chunks: ["Billing › Duplicate charges", "Billing › Refund timelines"],
                        scores: [0.93, 0.81],
                        outcome: TurnOutcome.CLARIFIED,
                        latency: { gate: 138, rewrite: 0, retrieve: 122, rerank: 91, generate: 1620, validate: 0 },
                        tokens: [3480, 196],
                        cost: 0.013,
                    },
                },
            ],
        },
        {
            userIndex: null,
            startedAgo: 2 * HOUR,
            status: ConversationStatus.RESOLVED,
            isResolved: true,
            outcome: TurnOutcome.ANSWERED,
            costUsd: 0.019,
            turns: [
                {
                    user: "Do you support shipping to Brazil? What are the customs fees?",
                    assistant:
                        "Yes, we ship to Brazil. Customs duties are assessed by Brazilian authorities on arrival and are the recipient's responsibility — we can't collect them at checkout.",
                    citations: ["International › Customs and duties"],
                    trace: {
                        gateIntent: GateIntent.QUESTION,
                        candidateCount: 29,
                        chunks: ["International › Customs and duties"],
                        scores: [0.76],
                        outcome: TurnOutcome.ANSWERED,
                        latency: { gate: 128, rewrite: 0, retrieve: 96, rerank: 74, generate: 1290, validate: 198 },
                        tokens: [2410, 152],
                        cost: 0.008,
                    },
                },
            ],
        },
        {
            userIndex: 2,
            startedAgo: 3 * HOUR,
            status: ConversationStatus.ESCALATED,
            isResolved: false,
            outcome: TurnOutcome.ESCALATED,
            costUsd: 0.044,
            turns: [
                {
                    user: "Your API returns a 429 on the /rates endpoint even under our limit.",
                    assistant:
                        "I don't have enough in my knowledge base to answer that confidently. I've brought in a teammate from the AcmeShip team who can dig into your account's rate limiting.",
                    trace: {
                        gateIntent: GateIntent.QUESTION,
                        candidateCount: 22,
                        chunks: ["API › Rate limits"],
                        scores: [0.38],
                        belowThreshold: true,
                        outcome: TurnOutcome.ESCALATED,
                        latency: { gate: 144, rewrite: 0, retrieve: 131, rerank: 88, generate: 0, validate: 0 },
                        tokens: [980, 64],
                        cost: 0.004,
                    },
                },
            ],
            humanReply: "Hi Priya — engineering here. We found a stale limit on your account and raised it. Can you retry?",
        },
        {
            userIndex: null,
            startedAgo: 5 * HOUR,
            status: ConversationStatus.RESOLVED,
            isResolved: true,
            outcome: TurnOutcome.ANSWERED,
            costUsd: 0.012,
            turns: [
                {
                    user: "what's the difference between the Growth and Scale plan",
                    assistant:
                        "Growth covers 3,000 conversations a month with actions and identity. Scale raises that to 15,000 and adds content-gap drafting, turn-level traces and a support SLA.",
                    citations: ["Pricing › Growth vs Scale"],
                    trace: {
                        gateIntent: GateIntent.QUESTION,
                        candidateCount: 26,
                        chunks: ["Pricing › Growth vs Scale", "Pricing › Plans"],
                        scores: [0.89, 0.83],
                        outcome: TurnOutcome.ANSWERED,
                        latency: { gate: 119, rewrite: 0, retrieve: 88, rerank: 71, generate: 1120, validate: 187 },
                        tokens: [2180, 141],
                        cost: 0.007,
                    },
                },
            ],
        },
        {
            userIndex: 3,
            startedAgo: 6 * HOUR,
            status: ConversationStatus.OPEN,
            isResolved: false,
            outcome: TurnOutcome.BLOCKED,
            costUsd: 0.026,
            turns: [
                {
                    user: "Cancel my Pro subscription effective immediately please.",
                    assistant:
                        "I'm not able to cancel subscriptions from chat just yet — that action hasn't been enabled by the AcmeShip team. I've flagged this conversation for a teammate who can help you directly.",
                    tool: { name: "Cancel subscription", status: ToolCallStatus.BLOCKED },
                    trace: {
                        gateIntent: GateIntent.ACTION_REQUEST,
                        candidateCount: 18,
                        chunks: ["Billing › Refund timelines"],
                        scores: [0.44],
                        outcome: TurnOutcome.BLOCKED,
                        latency: { gate: 136, rewrite: 0, retrieve: 92, rerank: 68, generate: 940, validate: 0 },
                        tokens: [1840, 118],
                        cost: 0.006,
                    },
                },
            ],
        },
        {
            userIndex: 4,
            startedAgo: 8 * HOUR,
            status: ConversationStatus.RESOLVED,
            isResolved: true,
            outcome: TurnOutcome.ABSTAINED,
            costUsd: 0.014,
            turns: [
                {
                    user: "how do I ship lithium batteries internationally",
                    assistant:
                        "I don't have enough in my knowledge base to answer that confidently. Would you like me to connect you with the team?",
                    trace: {
                        gateIntent: GateIntent.QUESTION,
                        candidateCount: 24,
                        chunks: ["International › Customs and duties"],
                        scores: [0.31],
                        belowThreshold: true,
                        outcome: TurnOutcome.ABSTAINED,
                        latency: { gate: 133, rewrite: 0, retrieve: 108, rerank: 82, generate: 0, validate: 0 },
                        tokens: [860, 48],
                        cost: 0.003,
                    },
                },
            ],
        },
        {
            userIndex: 5,
            startedAgo: 11 * HOUR,
            status: ConversationStatus.RESOLVED,
            isResolved: true,
            outcome: TurnOutcome.ANSWERED,
            costUsd: 0.022,
            turns: [
                {
                    user: "Can I change the delivery address on order A-61044?",
                    assistant:
                        "Yes — as long as the order hasn't shipped. A-61044 is still at the warehouse, so I can update it. What's the new address?",
                    citations: ["Orders › Changing an address"],
                    trace: {
                        gateIntent: GateIntent.ACTION_REQUEST,
                        candidateCount: 33,
                        chunks: ["Orders › Changing an address", "Orders › Delivery estimates"],
                        scores: [0.9, 0.72],
                        outcome: TurnOutcome.CLARIFIED,
                        latency: { gate: 127, rewrite: 0, retrieve: 111, rerank: 76, generate: 1340, validate: 205 },
                        tokens: [2960, 174],
                        cost: 0.01,
                    },
                },
            ],
        },
    ];

    const conversationDocs = [];
    const messageDocs = [];
    const traceDocs = [];
    const executionDocs = [];

    for (const convo of scripted) {
        const conversationId = generalFunctions.generateId(IdPrefix.CONVERSATION);
        const endUser = convo.userIndex === null ? null : endUsers[convo.userIndex];
        const lastTurn = convo.turns[convo.turns.length - 1];
        const lastAgo = convo.startedAgo - (convo.turns.length - 1) * 2 * 60 * 1000;
        const pendingAction = convo.pendingActionName ? actionByName.get(convo.pendingActionName) : null;

        conversationDocs.push({
            orgId: ORG_ID,
            conversationId,
            endUserId: endUser ? endUser.endUserId : null,
            status: convo.status,
            isResolved: convo.isResolved,
            turnCount: convo.turns.length,
            totalCostUsd: convo.costUsd,
            lastMessageAt: at(lastAgo),
            lastMessagePreview: lastTurn.user.slice(0, 140),
            hasHumanReply: !!convo.humanReply,
            feedback: null,
            endedAt: convo.isResolved ? at(lastAgo) : null,
            pendingAction: pendingAction ? { actionId: pendingAction.actionId, args: { orderId: "A-58291", amountUsd: 49 } } : { actionId: null, args: null },
            ...stamps(convo.startedAgo),
        });

        convo.turns.forEach((turn, index) => {
            const turnAgo = convo.startedAgo - index * 2 * 60 * 1000;
            const action = turn.tool ? actionByName.get(turn.tool.name) : null;
            let executionId = null;

            if (action && turn.tool.status !== ToolCallStatus.AWAITING_CONFIRMATION) {
                executionId = generalFunctions.generateId(IdPrefix.ACTION_EXECUTION);
                executionDocs.push({
                    orgId: ORG_ID,
                    executionId,
                    actionId: action.actionId,
                    conversationId,
                    endUserId: endUser ? endUser.endUserId : null,
                    status: turn.tool.status === ToolCallStatus.EXECUTED ? ExecutionStatus.EXECUTED : ExecutionStatus.BLOCKED,
                    blockReason: turn.tool.status === ToolCallStatus.BLOCKED ? "NOT_AVAILABLE" : null,
                    request: { method: action.method, url: action.urlTemplate, args: { orderId: "A-58291" } },
                    response:
                        turn.tool.status === ToolCallStatus.EXECUTED
                            ? { status: 200, body: { status: "in_transit", carrier: "DHL" }, durationMs: 240 }
                            : {},
                    ...stamps(turnAgo),
                });
            }

            messageDocs.push({
                orgId: ORG_ID,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.USER,
                content: turn.user,
                citations: [],
                toolCalls: [],
                ...stamps(turnAgo),
            });
            messageDocs.push({
                orgId: ORG_ID,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.ASSISTANT,
                content: turn.assistant,
                citations: (turn.citations || []).map((heading) => ({
                    chunkId: chunkIdsByHeading[heading],
                    sourceId: null,
                    heading,
                })),
                toolCalls: action
                    ? [
                          {
                              actionId: action.actionId,
                              actionName: action.name,
                              args: { orderId: "A-58291" },
                              status: turn.tool.status,
                              executionId,
                          },
                      ]
                    : [],
                ...stamps(turnAgo - 30 * 1000),
            });

            const t = turn.trace;
            traceDocs.push({
                orgId: ORG_ID,
                traceId: generalFunctions.generateId(IdPrefix.TURN_TRACE),
                conversationId,
                turn: index + 1,
                rawQuery: turn.user,
                rewrittenQuery: t.rewritten || null,
                gateIntent: t.gateIntent,
                gateLanguage: "en",
                gateSentiment: "NEUTRAL",
                gateSafe: true,
                gateFailedOpen: false,
                candidateCount: t.candidateCount,
                topChunks: t.chunks.map((heading, chunkIndex) => ({
                    chunkId: chunkIdsByHeading[heading],
                    vectorScore: Number((t.scores[chunkIndex] - 0.05).toFixed(2)),
                    textScore: Number((t.scores[chunkIndex] - 0.12).toFixed(2)),
                    rerankScore: t.scores[chunkIndex],
                })),
                belowThreshold: !!t.belowThreshold,
                procedureId: null,
                model: config.LARGE_MODEL,
                inputTokens: t.tokens[0],
                outputTokens: t.tokens[1],
                iterations: 1,
                grounded: t.outcome === TurnOutcome.ANSWERED ? true : null,
                answersQuery: t.outcome === TurnOutcome.ANSWERED ? true : null,
                unsupportedClaims: [],
                outcome: t.outcome,
                latencyMs: t.latency,
                costUsd: t.cost,
                ...stamps(turnAgo - 30 * 1000),
            });
        });

        if (convo.humanReply) {
            messageDocs.push({
                orgId: ORG_ID,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.HUMAN_AGENT,
                content: convo.humanReply,
                citations: [],
                toolCalls: [],
                ...stamps(lastAgo - 60 * 1000),
            });
        }
    }

    /* ---- Historical volume: 14 days of conversations for the chart + gaps ---- */
    const gapQueries = [
        "how do I ship lithium batteries internationally",
        "acmeship shopify app not syncing orders",
        "customs fees for shipments to brazil",
        "can I change carrier after label is printed",
        "bulk import orders via csv",
        "insurance claim for damaged package",
    ];
    const historyQuestions = [
        "when will my order arrive",
        "how do I print a return label",
        "do you deliver on weekends",
        "how long do refunds take",
        "can I upgrade my plan mid-month",
        "what carriers do you support",
    ];

    for (let dayOffset = 13; dayOffset >= 1; dayOffset--) {
        // Resolution rate climbs from ~58% to ~75% across the window
        const targetRate = 0.58 + (13 - dayOffset) * 0.013;
        const volume = 22 + Math.floor(rand() * 12);

        for (let i = 0; i < volume; i++) {
            const startedAgo = dayOffset * DAY - Math.floor(rand() * 20 * HOUR);
            const resolved = rand() < targetRate;
            const isGap = rand() < 0.12;
            const escalated = !resolved && rand() < 0.35;
            // A small slice of answers are caught by the validator and abstained
            const validatorCaught = !isGap && rand() < 0.02;
            const conversationId = generalFunctions.generateId(IdPrefix.CONVERSATION);
            const endUser = pick(endUsers);
            const query = isGap ? pick(gapQueries) : pick(historyQuestions);
            const cost = Number((0.008 + rand() * 0.03).toFixed(4));
            const outcome = isGap
                ? TurnOutcome.ABSTAINED
                : validatorCaught
                  ? TurnOutcome.ABSTAINED
                  : escalated
                    ? TurnOutcome.ESCALATED
                    : resolved
                      ? TurnOutcome.ANSWERED
                      : TurnOutcome.CLARIFIED;

            conversationDocs.push({
                orgId: ORG_ID,
                conversationId,
                endUserId: endUser.endUserId,
                status: escalated ? ConversationStatus.ESCALATED : resolved ? ConversationStatus.RESOLVED : ConversationStatus.OPEN,
                isResolved: resolved,
                turnCount: 1 + Math.floor(rand() * 3),
                totalCostUsd: cost,
                lastMessageAt: at(startedAgo),
                lastMessagePreview: query,
                hasHumanReply: escalated,
                feedback: null,
                endedAt: resolved ? at(startedAgo) : null,
                pendingAction: { actionId: null, args: null },
                ...stamps(startedAgo),
            });

            messageDocs.push({
                orgId: ORG_ID,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.USER,
                content: query,
                citations: [],
                toolCalls: [],
                ...stamps(startedAgo),
            });

            traceDocs.push({
                orgId: ORG_ID,
                traceId: generalFunctions.generateId(IdPrefix.TURN_TRACE),
                conversationId,
                turn: 1,
                rawQuery: query,
                rewrittenQuery: null,
                gateIntent: GateIntent.QUESTION,
                gateLanguage: "en",
                gateSentiment: "NEUTRAL",
                gateSafe: true,
                gateFailedOpen: false,
                candidateCount: 20 + Math.floor(rand() * 20),
                topChunks: [
                    {
                        chunkId: chunkIdsByHeading[pick(Object.keys(chunkIdsByHeading))],
                        vectorScore: 0.5,
                        textScore: 0.4,
                        rerankScore: isGap ? Number((0.26 + rand() * 0.2).toFixed(2)) : Number((0.6 + rand() * 0.35).toFixed(2)),
                    },
                ],
                belowThreshold: isGap,
                procedureId: null,
                model: config.LARGE_MODEL,
                inputTokens: 1800 + Math.floor(rand() * 2000),
                outputTokens: 90 + Math.floor(rand() * 180),
                iterations: 1,
                // Retrieval abstentions never reach the validator, so grounded stays null
                grounded: validatorCaught ? false : outcome === TurnOutcome.ANSWERED ? true : null,
                answersQuery: outcome === TurnOutcome.ANSWERED,
                unsupportedClaims: [],
                outcome,
                latencyMs: { gate: 120 + Math.floor(rand() * 40), rewrite: 0, retrieve: 90 + Math.floor(rand() * 60), rerank: 70 + Math.floor(rand() * 30), generate: isGap ? 0 : 1000 + Math.floor(rand() * 800), validate: isGap ? 0 : 180 + Math.floor(rand() * 90) },
                costUsd: cost,
                ...stamps(startedAgo),
            });
        }
    }

    await Conversation.insertMany(conversationDocs, { timestamps: false });
    await Message.insertMany(messageDocs, { timestamps: false });
    await TurnTrace.insertMany(traceDocs, { timestamps: false });
    if (executionDocs.length > 0) {
        await ActionExecution.insertMany(executionDocs, { timestamps: false });
    }

    console.log("seed: done");
    console.log(`  org           ${ORG_ID}`);
    console.log(`  sources       ${sourceDocs.length} (${chunkDocs.length} chunks)`);
    console.log(`  actions       ${actionDocs.length}`);
    console.log(`  conversations ${conversationDocs.length}`);
    console.log(`  messages      ${messageDocs.length}`);
    console.log(`  traces        ${traceDocs.length}`);
    console.log("");
    console.log(`  widget secret (for HMAC identify): ${widgetSecret}`);
    console.log("");
    console.log("  Sign in at http://localhost:5173/login with any of:");
    DEMO_SEATS.forEach((seat) => console.log(`    ${seat.email}  /  ${DEMO_PASSWORD}   (${seat.role})`));

    await mongoose.disconnect();
}

seed().catch(async (error) => {
    console.log("seed: failed");
    console.log(error);
    await mongoose.disconnect();
    process.exit(1);
});

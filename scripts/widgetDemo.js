/**
 * Seeds a deterministic "kitchen sink" conversation for widget UI work: every
 * message type the messenger can render — citations, executed and blocked tool
 * calls, a human reply, and a pending action so the confirmation card shows.
 *
 * Also repairs the live demo org if it predates the Ema→Zea rename.
 *
 * Usage: node scripts/widgetDemo.js
 */

const mongoose = require("mongoose");
const config = require("../config/config");
const Org = require("../models/org/org");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const { ConversationStatus, MessageRole, ToolCallStatus } = require("../config/enums");

const PUBLIC_KEY = "pk_live_zea_4Jw9TqXhK2mNvL8s";
const CONV_ID = "conv_widget_demo_rich";
const CONV_RESOLVED = "conv_widget_demo_resolved";

async function main() {
    await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

    const org = await Org.findOne({ publicKey: PUBLIC_KEY });
    if (!org) throw new Error("Demo org not found — run seed.js first");

    if (org.agent.name !== "Zea") {
        org.agent.name = "Zea";
        org.agent.greeting = "Hi! I'm Zea. Ask me anything about AcmeShip — orders, billing, shipping.";
        await org.save();
        console.log("repaired org agent name → Zea");
    }

    await Conversation.deleteOne({ orgId: org.orgId, conversationId: CONV_ID });
    await Message.deleteMany({ orgId: org.orgId, conversationId: CONV_ID });

    const minutesAgo = (m) => new Date(Date.now() - m * 60000);
    const rows = [
        {
            role: MessageRole.USER,
            content: "Where is my order #A-58291? It was supposed to arrive Tuesday.",
            createdAt: minutesAgo(42),
        },
        {
            role: MessageRole.ASSISTANT,
            content:
                "Order **A-58291** shipped with DHL on Aug 4 and is at the Chicago sorting facility. Revised delivery estimate: **tomorrow before 8pm**. You can follow it live here: https://track.example.com/A-58291",
            citations: [{ chunkId: "chk_demo1", sourceId: "src_demo", heading: "Shipping delays — carrier handoffs" }],
            toolCalls: [{ actionId: "act_demo_get", actionName: "Get order status", status: ToolCallStatus.EXECUTED }],
            receipt: {
                searched: 14,
                read: ["Shipping delays — carrier handoffs", "Shipping › Tracking notifications"],
                grounded: true,
                answersQuery: true,
                tookMs: 4180,
            },
            createdAt: minutesAgo(41),
        },
        {
            role: MessageRole.USER,
            content: "Thanks. Also my last invoice charged me twice — can you refund the duplicate `INV-2210`?",
            createdAt: minutesAgo(39),
        },
        {
            role: MessageRole.ASSISTANT,
            content:
                "I can see the duplicate charge on INV-2210 for **$49.00**. I've prepared the refund — please confirm below and I'll process it right away.",
            toolCalls: [
                {
                    actionId: "act_demo_refund",
                    actionName: "Issue refund",
                    args: { invoice: "INV-2210", amount: "$49.00" },
                    status: ToolCallStatus.AWAITING_CONFIRMATION,
                },
            ],
            createdAt: minutesAgo(38),
        },
        {
            role: MessageRole.HUMAN_AGENT,
            content: "Hi, this is Maya from AcmeShip — just double-checked the duplicate charge, the refund is approved on our side. 👍",
            createdAt: minutesAgo(20),
        },
    ];

    for (const row of rows) {
        await Message.create({
            orgId: org.orgId,
            messageId: `msg_wdemo_${Math.random().toString(36).slice(2, 10)}`,
            conversationId: CONV_ID,
            role: row.role,
            content: row.content,
            citations: row.citations || [],
            toolCalls: row.toolCalls || [],
            receipt: row.receipt || null,
            createdAt: row.createdAt,
            updatedAt: row.createdAt,
        });
    }

    await Conversation.create({
        orgId: org.orgId,
        conversationId: CONV_ID,
        status: ConversationStatus.ESCALATED,
        turnCount: 2,
        hasHumanReply: true,
        lastMessageAt: minutesAgo(20),
        lastMessagePreview: "Refund the duplicate INV-2210",
        pendingAction: { actionId: "act_demo_refund", args: { invoice: "INV-2210", amount: "$49.00" } },
    });

    // second, resolved conversation so the Messages tab has a real list
    await Conversation.deleteOne({ orgId: org.orgId, conversationId: CONV_RESOLVED });
    await Message.deleteMany({ orgId: org.orgId, conversationId: CONV_RESOLVED });
    const resolvedRows = [
        { role: MessageRole.USER, content: "Can I get the invoice PDF for order A-57104?", createdAt: minutesAgo(60 * 26) },
        {
            role: MessageRole.ASSISTANT,
            content: "Here you go — the invoice for **A-57104** is available from your account page under Billing → Invoices. It covers the $129.00 charge from Aug 2.",
            citations: [{ chunkId: "chk_demo2", sourceId: "src_demo", heading: "Billing — Refund timelines" }],
            createdAt: minutesAgo(60 * 26 - 1),
        },
        { role: MessageRole.USER, content: "Perfect, got it. Thanks!", createdAt: minutesAgo(60 * 26 - 3) },
    ];
    for (const row of resolvedRows) {
        await Message.create({
            orgId: org.orgId,
            messageId: `msg_wdemo_${Math.random().toString(36).slice(2, 10)}`,
            conversationId: CONV_RESOLVED,
            role: row.role,
            content: row.content,
            citations: row.citations || [],
            toolCalls: [],
            createdAt: row.createdAt,
            updatedAt: row.createdAt,
        });
    }
    await Conversation.create({
        orgId: org.orgId,
        conversationId: CONV_RESOLVED,
        status: ConversationStatus.RESOLVED,
        turnCount: 2,
        lastMessageAt: minutesAgo(60 * 26 - 3),
        lastMessagePreview: "Perfect, got it. Thanks!",
        endedAt: minutesAgo(60 * 26 - 3),
    });

    console.log(`seeded ${CONV_ID} + ${CONV_RESOLVED}`);
    await mongoose.disconnect();
}

// Guarded like seed.js and reset.js: without this, merely requiring the file
// runs it against whatever MONGODB_URI is set — which by default is production.
// That has already happened once on this project.
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { main };

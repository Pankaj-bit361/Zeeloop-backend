/**
 * Wipes ALL data and creates one empty org so you can build a workspace from
 * scratch — your own name, your own sources, your own actions. Nothing is
 * pre-filled, so the dashboard starts on its empty states.
 *
 *   npm run reset -- "Your Company"   (name is optional, defaults to "My Workspace")
 *
 * Env: OWNER_EMAIL and OWNER_PASSWORD set the sign-in account for the new org.
 */
const mongoose = require("mongoose");
const crypto = require("crypto");
const config = require("../config/config");
const { MemberRole, MemberStatus, AuthProvider, IdPrefix } = require("../config/enums");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const sessionFunctions = require("../functions/utilFunctions/sessionFunctions");

const Org = require("../models/org/org");
const Member = require("../models/org/member");
const Account = require("../models/user/account");
const AuthToken = require("../models/user/authToken");
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

async function reset() {
    const orgName = process.argv[2] || "My Workspace";
    console.log("reset: connecting to", config.MONGODB_URI);
    await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

    console.log("reset: deleting every document in this database");
    await Promise.all([
        Org.deleteMany({}),
        Member.deleteMany({}),
        Account.deleteMany({}),
        AuthToken.deleteMany({}),
        EndUser.deleteMany({}),
        KnowledgeSource.deleteMany({}),
        Chunk.deleteMany({}),
        Table.deleteMany({}),
        TableRow.deleteMany({}),
        Action.deleteMany({}),
        ActionExecution.deleteMany({}),
        Procedure.deleteMany({}),
        Conversation.deleteMany({}),
        Message.deleteMany({}),
        TurnTrace.deleteMany({}),
    ]);

    const orgId = generalFunctions.generateId(IdPrefix.ORG);
    const widgetSecret = `ws_live_${crypto.randomBytes(24).toString("hex")}`;
    const publicKey = `pk_live_${crypto.randomBytes(12).toString("hex")}`;
    const ownerEmail = (process.env.OWNER_EMAIL || "owner@example.com").trim().toLowerCase();
    const ownerPassword = process.env.OWNER_PASSWORD || "zealoop-demo";

    await Org.create({
        orgId,
        name: orgName,
        ownerEmail,
        publicKey,
        widgetSecret: generalFunctions.encrypt(widgetSecret),
        agent: { name: "Zea", greeting: `Hi! Ask me anything about ${orgName}.`, language: "en" },
        widget: { position: "bottom-right", allowedOrigins: [] },
        credits: { plan: "FREE", conversationsUsed: 0, conversationsLimit: 500 },
    });

    // An org with no owner seat is a workspace nobody can open: /api/auth/me
    // resolves workspaces by joining Member on the signed-in address, so
    // skipping this leaves the org invisible and the account stuck in onboarding.
    await Member.create({
        orgId,
        memberId: generalFunctions.generateId(IdPrefix.MEMBER),
        email: ownerEmail,
        name: ownerEmail.split("@")[0],
        role: MemberRole.OWNER,
        status: MemberStatus.ACTIVE,
        lastActiveAt: new Date(),
    });

    await Account.create({
        accountId: generalFunctions.generateId(IdPrefix.ACCOUNT),
        email: ownerEmail,
        name: ownerEmail.split("@")[0],
        passwordHash: sessionFunctions.hashPassword(ownerPassword),
        passwordSetAt: new Date(),
        emailVerifiedAt: new Date(),
        providers: [AuthProvider.PASSWORD],
    });

    console.log("");
    console.log("reset: done — empty workspace created");
    console.log(`  org name       ${orgName}`);
    console.log(`  orgId          ${orgId}`);
    console.log(`  publicKey      ${publicKey}`);
    console.log(`  widgetSecret   ${widgetSecret}`);
    console.log("");
    console.log("  Sign in at http://localhost:5173/login with:");
    console.log(`    ${ownerEmail}  /  ${ownerPassword}`);
    console.log("");
    console.log("  Then clear any cached token in your browser console:");
    console.log("    localStorage.clear(); location.reload()");

    await mongoose.disconnect();
}

reset().catch(async (error) => {
    console.log("reset: failed");
    console.log(error);
    await mongoose.disconnect();
    process.exit(1);
});

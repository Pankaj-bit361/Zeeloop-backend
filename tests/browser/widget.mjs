// CI browser checks use the real vendored widget and API, deterministic model
// fixtures, and mock actions in the disposable backend test database.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import mongoose from "mongoose";
import Conversation from "../../models/conversation/conversation.js";
import Message from "../../models/conversation/message.js";
import Action from "../../models/action/action.js";
import ActionExecution from "../../models/action/actionExecution.js";
import client from "../helpers/client.js";

const { BASE_URL: base, devLogin, post, authHeader } = client;
if (process.env.NODE_ENV !== "test" || !/^mongodb:\/\/(localhost|127\.0\.0\.1):\d+\/zealoop_test_/.test(process.env.TEST_MONGODB_URI || "")) {
  throw new Error("Use npm run test:browser with the disposable test runner");
}
await mongoose.connect(process.env.TEST_MONGODB_URI);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 860 } });
const frame = () => page.frameLocator('iframe[title="Zealoop messenger"]');
const orgId = "org_demo_acmeship", publicKey = "pk_live_zea_4Jw9TqXhK2mNvL8s";
await mkdir("test-results", { recursive: true });
try {
  await page.goto(`${base}/widget/demo?conv=fresh`);
  await page.getByRole("button", { name: "Chat with Zea", exact: true }).click();
  const sent = page.waitForResponse(response => response.url().endsWith("/api/widget/messages") && response.request().method() === "POST");
  await frame().getByRole("textbox", { name: "Ask Zea a question" }).fill("Local fixture question");
  await frame().getByRole("textbox", { name: "Ask Zea a question" }).press("Enter");
  const turn = await (await sent).json();
  assert.equal(turn.success, true);
  const conversationId = turn.data.conversationId;
  const token = await devLogin(orgId);
  const human = await post(`/api/org/${orgId}/conversations/${conversationId}/reply`, {
    headers: authHeader(token), body: { content: "A human is here for this local fixture" },
  });
  assert.equal(human.status, 200);
  await frame().getByText("A human is here for this local fixture").waitFor({ timeout: 10_000 });
  const before = await Message.countDocuments({ conversationId, role: "ASSISTANT" });
  const followup = page.waitForResponse(response => response.url().endsWith("/api/widget/messages") && response.request().method() === "POST");
  await frame().getByRole("textbox", { name: "Message", exact: true }).fill("More information for the team");
  await frame().getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal((await (await followup).json()).data.awaitingHuman, true);
  assert.equal(await Message.countDocuments({ conversationId, role: "ASSISTANT" }), before);
  await page.screenshot({ path: "test-results/handoff.png" });

  await Action.create({ orgId, actionId: "act_browser_fixture", name: "Local mock approval", description: "No external side effect",
    accessType: "WRITE", method: "POST", urlTemplate: "https://example.com/fixture", enabled: true,
    lastTestStatus: "PASS", requiresIdentity: false, mockEnabled: true, mockResponse: { ok: true } });
  for (const confirmed of [true, false]) {
    const id = `conv_browser_${confirmed}`, proposalId = `proposal_browser_${confirmed}`;
    await Conversation.create({ orgId, conversationId: id, lastMessageAt: new Date(), lastMessagePreview: "Local mock proposal",
      pendingAction: { actionId: "act_browser_fixture", proposalId, state: "PENDING", args: {}, expiresAt: new Date(Date.now() + 60_000) } });
    await Message.create({ orgId, conversationId: id, messageId: `msg_browser_${confirmed}`, role: "ASSISTANT", content: "Local mock proposal" });
    await page.goto(`${base}/widget/demo?conv=${id}`);
    await page.getByRole("button", { name: "Chat with Zea", exact: true }).click();
    await frame().getByRole("button", { name: /Recent message/ }).click();
    await frame().getByRole("button", { name: confirmed ? "Confirm" : "Cancel", exact: true }).click();
    await frame().getByRole("button", { name: "Confirm", exact: true }).waitFor({ state: "detached" });
    assert.equal(await ActionExecution.countDocuments({ idempotencyKey: proposalId, status: "EXECUTED" }), confirmed ? 1 : 0);
    const replay = await post("/api/widget/actions/confirm", { body: { publicKey, conversationId: id, proposalId, confirmed: true } });
    assert.equal(replay.status, 409);
  }
  console.log("Browser fixtures passed: chat, real-time human reply, handoff, approval, cancellation, replay rejection");
} catch (error) {
  await page.screenshot({ path: "test-results/failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await mongoose.disconnect();
}

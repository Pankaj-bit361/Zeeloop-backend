// CI browser checks use the real vendored widget and API, deterministic model
// fixtures, and mock actions in the disposable backend test database.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import mongoose from "mongoose";
import Conversation from "../../models/conversation/conversation.js";
import Message from "../../models/conversation/message.js";
import Action from "../../models/action/action.js";
import ActionExecution from "../../models/action/actionExecution.js";
import EndUser from "../../models/user/endUser.js";
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

async function checkHistory() {
  const context = await browser.newContext();
  const historyPage = await context.newPage();
  const historyFrame = () => historyPage.frameLocator('iframe[title="Zealoop messenger"]');
  const identity = { email: "browser-history@example.com", name: "History visitor" };
  const id = "conv_browser_saved_history";
  await Conversation.create({ orgId, conversationId: id, lastMessageAt: new Date(), lastMessagePreview: "Saved browser conversation" });
  await Message.create({ orgId, conversationId: id, messageId: "msg_browser_saved_history", role: "USER", content: "Saved browser conversation" });
  await historyPage.addInitScript(({ publicKey, identity, id }) => {
    if (window !== window.top || localStorage.getItem("history-fixture-seeded")) return;
    localStorage.setItem("history-fixture-seeded", "1");
    localStorage.setItem(`zealoop:visitor:${publicKey}`, identity.email);
    localStorage.setItem(`zealoop:conv:${publicKey}`, id);
    localStorage.setItem(`zealoop:convs:${publicKey}`, JSON.stringify([id]));
  }, { publicKey, identity, id });
  await historyPage.route(`${base}/history-fixture`, route => route.fulfill({ contentType: "text/html", body:
    `<html><body><script>window.zealoop=${JSON.stringify({ publicKey, apiUrl: base })}</script><script src="${base}/widget.js"></script></body></html>` }));
  const startDelayedIdentity = async () => {
    await historyPage.getByRole("button", { name: "Chat with Zea", exact: true }).click();
    await historyFrame().locator(".hero-title").waitFor();
    // Seovyn's auth request finishes after the frame has booted anonymously.
    // Unsigned identity deliberately prevents server recovery hiding storage bugs.
    await historyPage.evaluate(identity => window.Zealoop("identify", identity), identity);
    await historyFrame().getByRole("button", { name: "Messages", exact: true }).click();
    await historyFrame().getByRole("button", { name: /Saved browser conversation/ }).waitFor({ timeout: 5000 });
    await historyFrame().getByRole("button", { name: /Saved browser conversation/ }).click();
    await historyFrame().getByRole("log").getByText("Saved browser conversation", { exact: true }).waitFor();
  };
  try {
    await historyPage.goto(`${base}/history-fixture`);
    await startDelayedIdentity();
    await historyPage.reload();
    await startDelayedIdentity();
    // Another person on this browser gets neither the old row nor transcript.
    await historyPage.evaluate(() => window.Zealoop("identify", { email: "another-browser-visitor@example.com" }));
    await historyFrame().getByRole("button", { name: "Messages", exact: true }).click();
    await historyFrame().getByText("No conversations yet", { exact: true }).waitFor();
    assert.equal(await historyFrame().getByText("Saved browser conversation").count(), 0);
    await historyPage.evaluate(identity => window.Zealoop("identify", identity), identity);
    await historyFrame().getByRole("button", { name: "Messages", exact: true }).click();
    await historyFrame().getByRole("button", { name: /Saved browser conversation/ }).waitFor();
    await historyPage.screenshot({ path: "test-results/restored-history.png" });
    console.log("Browser history passed: delayed identity, reload, visitor isolation and return");

    const endUser = await EndUser.findOne({ orgId, email: identity.email });
    await Conversation.updateOne({ orgId, conversationId: id }, { $set: { endUserId: endUser.endUserId } });
    const token = await devLogin(orgId);
    const secret = (await post(`/api/org/${orgId}/widget-secret/reveal`, { headers: authHeader(token) })).json.data.widgetSecret;
    const signedIdentity = { ...identity, signature: createHmac("sha256", secret).update(identity.email).digest("hex") };
    // A new browser has no registry at all. Verify actual widget recovery through
    // the signed API, not just a direct backend call with handcrafted IDs.
    const freshContext = await browser.newContext();
    try {
      for (const storageBlocked of [false, true]) {
        const freshPage = await freshContext.newPage();
        if (storageBlocked) await freshPage.addInitScript(() => {
          Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage blocked", "SecurityError"); } });
        });
        await freshPage.route(`${base}/history-fixture`, route => route.fulfill({ contentType: "text/html", body:
          `<html><body><script>window.zealoop=${JSON.stringify({ publicKey, apiUrl: base })};window.Zealoop=function(){window.Zealoop.q.push(Array.from(arguments))};window.Zealoop.q=[["identify",null],["identify",${JSON.stringify(signedIdentity)}],["boot"]]</script><script src="${base}/widget.js"></script></body></html>` }));
        let recoveredWithoutIds = false;
        freshPage.on("request", request => {
          if (request.url().endsWith("/api/widget/conversations") && request.method() === "POST") {
            const body = request.postDataJSON();
            if (body.identity?.signature && body.conversationIds?.length === 0) recoveredWithoutIds = true;
          }
        });
        await freshPage.goto(`${base}/history-fixture`);
        const recoveredFrame = freshPage.frameLocator('iframe[title="Zealoop messenger"]');
        const assertRecovered = async () => {
          await freshPage.getByRole("button", { name: "Chat with Zea", exact: true }).click();
          await recoveredFrame.getByRole("button", { name: "Messages", exact: true }).click();
          await recoveredFrame.getByRole("button", { name: /Saved browser conversation/ }).click();
          await recoveredFrame.getByRole("log").getByText("Saved browser conversation", { exact: true }).waitFor();
        };
        await assertRecovered();
        assert.equal(recoveredWithoutIds, true, "server recovery used the signature and no saved IDs");
        if (storageBlocked) {
          await freshPage.reload();
          await assertRecovered();
        }
        await freshPage.close();
        await freshContext.clearCookies();
      }
    } finally { await freshContext.close(); }
    console.log("Browser account history passed: fresh browser and blocked storage recovery");
  } finally {
    await context.close();
  }
}

try {
  await checkHistory();
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

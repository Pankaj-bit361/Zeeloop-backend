import assert from "node:assert/strict";

// Exercise the production bundle with controlled slow HTTP and WebSocket
// deliveries. All content and responses here are local browser fixtures.
export async function checkConversationMotion(browser, base, publicKey) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 860 } });
  const page = await context.newPage();
  const frame = () => page.frameLocator('iframe[title="Zealoop messenger"]');
  const now = new Date().toISOString();
  const a = "conv_motion_a", b = "conv_motion_b", c = "conv_motion_c";
  const histories = {
    [a]: Array.from({ length: 14 }, (_, index) => ({
      messageId: `msg_motion_${index}`, role: index % 2 ? "ASSISTANT" : "USER",
      content: index % 2 ? `Saved answer ${index}. Your order is on its way. We can help you track its progress and check the delivery details.` : `Saved question ${index}`,
      createdAt: now, ...(index === 13 ? { receipt: { grounded: true, searched: 2, read: ["Delivery guide"] } } : {}),
    })),
    [b]: [{ messageId: "msg_motion_b", role: "USER", content: "Another conversation", createdAt: now }],
    [c]: [{ messageId: "msg_motion_c", role: "USER", content: "Retry conversation", createdAt: now }],
  };
  let socket, heldHistory, failHistory, pendingTurn, failSend = false;
  const gate = () => {
    let release, start;
    const started = new Promise(resolve => { start = resolve; });
    return { wait: new Promise(resolve => { release = resolve; }), started: async () => {
      let timer;
      try { await Promise.race([started, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Expected fixture request did not start")), 10_000);
      })]); } finally { clearTimeout(timer); }
    }, release: () => release(), start: () => start() };
  };
  const open = async name => {
    await frame().getByRole("button", { name: "Back", exact: true }).click();
    await frame().getByRole("button", { name: "Messages", exact: true }).click();
    await frame().getByRole("button", { name: new RegExp(name) }).click();
  };
  await page.addInitScript(({ publicKey, ids }) => {
    if (window !== window.top) return;
    localStorage.setItem(`zealoop:convs:${publicKey}`, JSON.stringify(ids));
  }, { publicKey, ids: [a, b, c] });
  await page.route(`${base}/motion-fixture`, route => route.fulfill({ contentType: "text/html", body:
    `<html><body style="background:#eef2ef"><script>window.zealoop=${JSON.stringify({ publicKey, apiUrl: base, accentColor: "#477a12" })}</script><script src="${base}/widget.js"></script></body></html>` }));
  await context.routeWebSocket("**/motion-socket**", ws => { socket = ws; });
  await page.route("**/api/widget/rtm/connect", route => route.fulfill({ json: { success: true, data: { endpoints: [{ endpoint: base.replace(/^http/, "ws") + "/motion-socket" }] } } }));
  await page.route("**/api/widget/conversations", route => route.fulfill({ json: { success: true, data: [
    { conversationId: a, preview: "Saved conversation", status: "OPEN", lastMessageAt: now },
    { conversationId: b, preview: "Another conversation", status: "OPEN", lastMessageAt: now },
    { conversationId: c, preview: "Retry conversation", status: "OPEN", lastMessageAt: now },
  ] } }));
  await page.route("**/api/widget/bootstrap", async route => {
    const id = route.request().postDataJSON().conversationId;
    if (!id) return route.continue();
    const messages = structuredClone(histories[id]);
    if (heldHistory?.id === id) {
      const held = heldHistory; heldHistory = null;
      held.start(); await held.wait;
    }
    if (failHistory === id) {
      failHistory = null;
      return route.fulfill({ status: 503, json: { success: false, error: "Local history failure" } });
    }
    await route.fulfill({ json: { success: true, data: { conversationId: id, messages } } });
  });
  await page.route("**/api/widget/messages", async route => {
    if (failSend) {
      failSend = false;
      return route.fulfill({ status: 503, json: { success: false, error: "Local send failure" } });
    }
    const body = route.request().postDataJSON(), id = body.conversationId || a;
    const turn = pendingTurn; pendingTurn = null;
    turn.start(); await turn.wait;
    const reply = { messageId: `msg_motion_reply_${histories[id].length}`, role: "ASSISTANT", content: "Thanks — I can help you with that.", createdAt: now };
    histories[id].push({ messageId: `msg_motion_sent_${histories[id].length}`, role: "USER", content: body.content, createdAt: now }, reply);
    await route.fulfill({ json: { success: true, data: { conversationId: id, message: reply } } });
  });
  const push = message => socket.send(JSON.stringify({ type: "message", conversationId: a, message }));
  try {
    heldHistory = { id: a, ...gate() };
    const firstLoad = heldHistory;
    await page.goto(`${base}/motion-fixture`);
    await page.getByRole("button", { name: "Chat with Zea", exact: true }).click();
    await frame().getByRole("button", { name: "Messages", exact: true }).click();
    await frame().getByRole("button", { name: /Saved conversation/ }).click();
    await firstLoad.started();
    await frame().locator(".thread-loading").waitFor();
    assert.equal(await frame().locator(".starter-chip, .thread .bubble").count(), 0, "history never flashes a new-chat greeting or starters");
    assert.equal(await frame().getByRole("log").getAttribute("aria-busy"), "true");
    await frame().getByRole("textbox", { name: "Message", exact: true }).fill("Draft while loading");
    assert.equal(await frame().getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
    await page.screenshot({ path: "test-results/conversation-loading.png", animations: "disabled" });
    firstLoad.release();
    await frame().getByText("Saved question 12", { exact: true }).waitFor();
    const savedBubble = await frame().locator('[data-mid="msg_motion_13"] .bubble').elementHandle();
    await frame().locator(".receipt-toggle").click();
    const receipt = await frame().locator(".receipt.open").elementHandle();

    pendingTurn = gate(); const turn = pendingTurn;
    const composer = frame().getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("Can you help with delivery?");
    await composer.press("Enter");
    await turn.started();
    const sentBubble = await frame().getByText("Can you help with delivery?", { exact: true }).elementHandle();
    await frame().getByText(/Sending…/).waitFor();
    await frame().locator(".typing").waitFor();
    assert.equal(await savedBubble.evaluate(node => node.isConnected), true);
    assert.equal(await receipt.evaluate(node => node.isConnected && node.classList.contains("open")), true);
    assert.equal(await composer.evaluate(node => node === document.activeElement), true);
    assert.equal(await frame().locator(".thread-spacer").count(), 0);

    // Push arrives first, HTTP arrives later with the same ID. The reply and
    // optimistic user bubble must retain their exact DOM nodes throughout.
    const reply = { messageId: `msg_motion_reply_${histories[a].length}`, role: "ASSISTANT", content: "Thanks — I can help you with that.", createdAt: now };
    push(reply);
    await frame().getByText(reply.content, { exact: true }).waitFor();
    await frame().locator(".typing").waitFor({ state: "detached" });
    const replyBubble = await frame().getByText(reply.content, { exact: true }).elementHandle();
    turn.release();
    await frame().getByText(/ · Sent$/).waitFor();
    assert.equal(await sentBubble.evaluate(node => node.isConnected), true);
    assert.equal(await replyBubble.evaluate(node => node.isConnected), true);
    assert.equal(await frame().getByText(reply.content, { exact: true }).count(), 1);

    const scrollTop = await frame().getByRole("log").evaluate(async node => {
      node.scrollTo({ top: 60, behavior: "instant" });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return node.scrollTop;
    });
    push({ messageId: "msg_motion_live", role: "ASSISTANT", content: "An additional live reply", createdAt: now });
    await frame().getByText("An additional live reply", { exact: true }).waitFor();
    const afterReply = await frame().getByRole("log").evaluate(node => node.scrollTop);
    assert.ok(Math.abs(afterReply - scrollTop) < 2, `new replies preserve a reader's scroll position (${scrollTop} -> ${afterReply})`);
    await frame().getByRole("button", { name: "New messages ↓" }).click();

    // Cached history paints immediately. A late response from A cannot
    // replace B after navigating again.
    await open("Another conversation");
    await frame().getByRole("log").getByText("Another conversation", { exact: true }).waitFor();
    heldHistory = { id: a, ...gate() }; const stale = heldHistory;
    await open("Saved conversation"); await stale.started();
    assert.equal(await frame().locator(".thread-loading").count(), 0);
    assert.equal(await frame().getByText("Saved question 12", { exact: true }).isVisible(), true);
    await open("Another conversation");
    const staleResponse = page.waitForResponse(response => response.url().endsWith("/bootstrap") && response.request().postDataJSON().conversationId === a);
    stale.release(); await staleResponse;
    await composer.fill("Still in the other thread");
    assert.equal(await frame().getByText("Saved question 12", { exact: true }).count(), 0);
    assert.equal(await frame().getByRole("log").getByText("Another conversation", { exact: true }).isVisible(), true);

    failHistory = c;
    await open("Retry conversation");
    await frame().getByText("Couldn't load this conversation.", { exact: true }).waitFor();
    assert.equal(await frame().locator(".starter-chip").count(), 0);
    await frame().getByRole("button", { name: "Try again", exact: true }).click();
    await frame().getByRole("log").getByText("Retry conversation", { exact: true }).waitFor();

    // Failed sends retain the bubble and retry it once, with honest status.
    failSend = true;
    await composer.fill("Retry this message"); await composer.press("Enter");
    await frame().getByRole("button", { name: "Not sent · Retry", exact: true }).waitFor();
    const failedBubble = await frame().getByText("Retry this message", { exact: true }).elementHandle();
    pendingTurn = gate(); const retry = pendingTurn;
    await frame().getByRole("button", { name: "Not sent · Retry", exact: true }).click();
    await retry.started(); retry.release();
    await frame().getByText(/ · Sent$/).waitFor();
    assert.equal(await failedBubble.evaluate(node => node.isConnected), true);
    assert.equal(await frame().getByText("Retry this message", { exact: true }).count(), 1);

    pendingTurn = gate(); const offscreen = pendingTurn;
    await composer.fill("A reply should stay in this thread");
    await frame().getByRole("button", { name: "Send message", exact: true }).click();
    assert.equal(await composer.evaluate(node => node === document.activeElement), true, "send returns focus to the composer");
    await offscreen.started();
    await open("Another conversation");
    const finished = page.waitForResponse(response => response.url().endsWith("/messages"));
    offscreen.release(); await finished;
    assert.equal(await frame().getByRole("log").getByText("Another conversation", { exact: true }).isVisible(), true);
    assert.equal(await frame().getByRole("log").getByText("Thanks — I can help you with that.", { exact: true }).count(), 0);
    await open("Retry conversation");
    await frame().getByText("A reply should stay in this thread", { exact: true }).waitFor();
    assert.ok(await composer.evaluate(node => node.clientHeight >= 26), "composer stays usable after navigating between hidden views");
    await page.screenshot({ path: "test-results/conversation-smooth.png", animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    assert.equal(await frame().locator(".bubble").last().evaluate(node => getComputedStyle(node).animationName), "none");
    assert.equal(await frame().getByRole("log").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: "test-results/conversation-mobile.png", animations: "disabled" });
    console.log("Browser motion passed: slow history, cached reopen, stable bubbles/receipts/focus, socket + HTTP deduplication, scroll, stale response, load/send retry, mobile, reduced motion");
  } catch (error) {
    await page.screenshot({ path: "test-results/conversation-failure.png" }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

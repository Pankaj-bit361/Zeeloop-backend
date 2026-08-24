"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { BASE_URL, SEED_PUBLIC_KEY, post } = require("./helpers/client");

/* The dashboard's Conversation view used to poll every 5 seconds regardless
   of whether anything happened, which unmounted the whole page on every tick
   (see ConversationDetail.tsx's fix — bare `loading` gated the render). The
   replacement is the same socket the widget already uses
   (functions/realtime/realtimeHub.js): connect via /rtm?pk=..., subscribe to
   a conversation id, and treat any `{type:"message"}` event on it as "go
   refetch".

   That only works if every message on the thread is actually published —
   and only the assistant's reply was. A dashboard subscribed to the channel
   would sit silent through the one event it most needs: the visitor's own
   message. This pins that both sides of the conversation are on the wire. */

const wsUrl = () => BASE_URL.replace(/^http/, "ws") + "/rtm";

function openSocket() {
    return new WebSocket(`${wsUrl()}?pk=${encodeURIComponent(SEED_PUBLIC_KEY)}`);
}

/* A one-shot listener per call races with frames that arrive back-to-back —
   two events published within the same tick (the visitor's message and the
   assistant's reply both land almost immediately) can both fire before the
   test re-attaches its listener for the second one, and the second is lost
   forever. A persistent listener queues every frame as it arrives; callers
   drain the queue instead of racing to catch each one live. */
function frameQueue(ws) {
    const queue = [];
    const waiters = [];
    ws.on("message", (raw) => {
        const parsed = JSON.parse(String(raw));
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(parsed);
        else queue.push(parsed);
    });
    ws.on("error", (error) => {
        const waiter = waiters.shift();
        if (waiter) waiter.reject(error);
    });
    return function next() {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = waiters.findIndex((w) => w.resolve === resolve);
                if (index !== -1) waiters.splice(index, 1);
                reject(new Error("timed out waiting for a socket frame"));
            }, 20000);
            waiters.push({
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
    };
}

async function subscribe(ws, next, conversationId) {
    await next(); // {type: "connected"}
    ws.send(JSON.stringify({ type: "subscribe", conversationIds: [conversationId] }));
    const reply = await next();
    assert.equal(reply.type, "subscribed");
    assert.deepEqual(reply.conversationIds, [conversationId]);
}

describe("realtimeHub — a dashboard subscriber sees both sides of the conversation", () => {
    test("the visitor's own message is published, not only the assistant's reply", async () => {
        const first = await post("/api/widget/messages", { body: { publicKey: SEED_PUBLIC_KEY, content: "hello" } });
        assert.equal(first.status, 200);
        const conversationId = first.json.data.conversationId;

        const ws = openSocket();
        const next = frameQueue(ws);
        try {
            await subscribe(ws, next, conversationId);

            const sendSecond = post("/api/widget/messages", {
                body: { publicKey: SEED_PUBLIC_KEY, conversationId, content: "does this reach a dashboard socket" },
            });

            // Two events are expected off this one turn: the visitor's message
            // (this is the one that was missing) and the assistant's reply.
            const first_event = await next();
            const second_event = await next();
            await sendSecond;

            const roles = [first_event, second_event].map((event) => event.message.role);
            assert.ok(
                roles.includes("USER"),
                `expected a USER-role message event on the socket, got roles: ${JSON.stringify(roles)} — ` +
                    "a dashboard subscribed to this channel would never learn the visitor said anything"
            );
            assert.ok(roles.includes("ASSISTANT"), `expected an ASSISTANT-role message event too, got: ${JSON.stringify(roles)}`);
            for (const event of [first_event, second_event]) {
                assert.equal(event.type, "message");
                assert.equal(event.conversationId, conversationId);
            }
        } finally {
            ws.close();
        }
    });

    test("a human agent's reply is published too", async () => {
        const first = await post("/api/widget/messages", { body: { publicKey: SEED_PUBLIC_KEY, content: "hi" } });
        const conversationId = first.json.data.conversationId;

        const ws = openSocket();
        const next = frameQueue(ws);
        try {
            await subscribe(ws, next, conversationId);

            const { devLogin, authHeader, SEED_ORG_ID } = require("./helpers/client");
            const auth = authHeader(await devLogin(SEED_ORG_ID));
            const replyPromise = post(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}/reply`, {
                headers: auth,
                body: { content: "an agent typed this" },
            });

            const event = await next();
            await replyPromise;

            assert.equal(event.type, "message");
            assert.equal(event.message.role, "HUMAN_AGENT");
            assert.equal(event.message.content, "an agent typed this");
        } finally {
            ws.close();
        }
    });
});

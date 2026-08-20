/**
 * Real-time hub — WebSocket push for the widget.
 *
 * Why this exists: polling delivers a human's reply in ~5s. That is fine for
 * most support, and it stays as the fallback, but when an agent is actually
 * typing to a visitor the gap is felt. This closes it.
 *
 * Shape borrowed from what Intercom's messenger actually does (observed on the
 * wire), minus the parts that only make sense at their scale:
 *
 *   - The client never hardcodes the socket URL. It asks POST /rtm/connect,
 *     which returns a channel and an endpoint list. That indirection is what
 *     lets the socket tier move, split by region or fail over without shipping
 *     new widget JS.
 *   - One connection, many channels. A visitor with three conversations opens
 *     one socket and subscribes three times.
 *   - Heartbeats, because a TCP connection through a proxy can be dead for
 *     minutes before either side notices.
 *
 * Deliberately NOT copied: Intercom pushes the entire conversation object on
 * every event (13 KB observed for a one-line reply). We push the message and
 * the ids, and the client already knows how to render that.
 *
 * Authorisation is the same boundary the REST widget API uses: conversation
 * ids are unguessable, and the server only ever confirms ids the client
 * already presented. A socket cannot enumerate or discover conversations.
 */

const { WebSocketServer } = require("ws");
const Conversation = require("../../models/conversation/conversation");
const Org = require("../../models/org/org");

const HEARTBEAT_MS = 25000;
const MAX_CHANNELS_PER_SOCKET = 20;
const MAX_SOCKETS_PER_IP = 24;

// channel id -> Set<ws>
const channels = new Map();
// ip -> count
const socketsByIp = new Map();

let wss = null;
let heartbeatTimer = null;

const channelId = (orgId, conversationId) => `conv:${orgId}:${conversationId}`;

function subscribe(ws, channel) {
    if (!channels.has(channel)) channels.set(channel, new Set());
    channels.get(channel).add(ws);
    ws.channels.add(channel);
}

function unsubscribeAll(ws) {
    for (const channel of ws.channels) {
        const set = channels.get(channel);
        if (!set) continue;
        set.delete(ws);
        if (set.size === 0) channels.delete(channel);
    }
    ws.channels.clear();
}

function send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch (error) {
        console.log("realtimeHub:send: failed", error.message);
        return false;
    }
}

/**
 * Publish an event to everyone watching a conversation. Called from the write
 * paths (agent reply, human reply, status change). Never throws: a socket
 * problem must not fail the request that produced the message.
 */
function publish(orgId, conversationId, event) {
    try {
        if (!orgId || !conversationId) return 0;
        const set = channels.get(channelId(orgId, conversationId));
        if (!set || set.size === 0) return 0;
        const payload = { ...event, conversationId, at: new Date().toISOString() };
        let delivered = 0;
        for (const ws of set) if (send(ws, payload)) delivered += 1;
        console.log("realtimeHub:publish:", event.type, conversationId, "→", delivered, "socket(s)");
        return delivered;
    } catch (error) {
        console.log("realtimeHub:publish: Catch block");
        console.log(error);
        return 0;
    }
}

async function handleSubscribe(ws, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const room = MAX_CHANNELS_PER_SOCKET - ws.channels.size;
    if (room <= 0) return;

    // Only ids that exist inside this socket's workspace are honoured, and the
    // reply lists exactly what was accepted — a client that guesses learns
    // nothing, because an unknown id is simply absent from the response.
    const wanted = ids.filter((id) => typeof id === "string" && id).slice(0, room);
    const found = await Conversation.find({ orgId: ws.orgId, conversationId: { $in: wanted } })
        .select("conversationId")
        .lean();

    for (const conversation of found) subscribe(ws, channelId(ws.orgId, conversation.conversationId));
    send(ws, { type: "subscribed", conversationIds: found.map((c) => c.conversationId) });
}

function attach(server) {
    wss = new WebSocketServer({ server, path: "/rtm", maxPayload: 16 * 1024 });

    wss.on("connection", async (ws, req) => {
        const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
        const count = (socketsByIp.get(ip) || 0) + 1;
        if (count > MAX_SOCKETS_PER_IP) {
            send(ws, { type: "error", error: "Too many connections" });
            ws.close(1008, "too many connections");
            return;
        }
        socketsByIp.set(ip, count);

        ws.channels = new Set();
        ws.isAlive = true;
        ws.on("pong", () => {
            ws.isAlive = true;
        });

        try {
            const url = new URL(req.url, "http://localhost");
            const publicKey = url.searchParams.get("pk");
            const org = publicKey ? await Org.findOne({ publicKey }).select("orgId").lean() : null;
            if (!org) {
                send(ws, { type: "error", error: "Unknown publicKey" });
                ws.close(1008, "unknown publicKey");
                return;
            }
            ws.orgId = org.orgId;
            ws.ip = ip;
            send(ws, { type: "connected", heartbeatMs: HEARTBEAT_MS });
        } catch (error) {
            console.log("realtimeHub:connection: Catch block");
            console.log(error);
            ws.close(1011, "server error");
            return;
        }

        ws.on("message", async (raw) => {
            let data;
            try {
                data = JSON.parse(String(raw));
            } catch {
                return; // a client that speaks nonsense is simply ignored
            }
            if (!data || typeof data !== "object") return;
            if (data.type === "subscribe") {
                await handleSubscribe(ws, data.conversationIds).catch((error) => {
                    console.log("realtimeHub:subscribe: Catch block");
                    console.log(error);
                });
            } else if (data.type === "ping") {
                send(ws, { type: "pong" });
            }
        });

        ws.on("close", () => {
            unsubscribeAll(ws);
            const left = (socketsByIp.get(ws.ip) || 1) - 1;
            if (left <= 0) socketsByIp.delete(ws.ip);
            else socketsByIp.set(ws.ip, left);
        });

        ws.on("error", (error) => console.log("realtimeHub:socket error:", error.message));
    });

    // A dead socket behind a proxy looks open forever. Ping every cycle and
    // drop anything that missed the previous one.
    heartbeatTimer = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            try {
                ws.ping();
            } catch {
                ws.terminate();
            }
        }
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    console.log("realtimeHub: attached at /rtm");
    return wss;
}

function stats() {
    return {
        sockets: wss ? wss.clients.size : 0,
        channels: channels.size,
        subscriptions: [...channels.values()].reduce((total, set) => total + set.size, 0),
    };
}

async function close() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (wss) await new Promise((resolve) => wss.close(resolve));
    channels.clear();
    socketsByIp.clear();
    wss = null;
}

module.exports = { attach, publish, stats, close, channelId };

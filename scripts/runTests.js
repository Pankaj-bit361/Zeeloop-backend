"use strict";
// A disposable local database and provider fixtures make npm test reproducible
// without production secrets, email delivery, or paid model requests.
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");

async function main() {
    const mongo = new URL(process.env.TEST_MONGO_HOST || "mongodb://127.0.0.1:27017");
    if (mongo.protocol !== "mongodb:" || !["localhost", "127.0.0.1", "[::1]"].includes(mongo.hostname)) throw new Error("Tests require a local MongoDB host");
    mongo.pathname = `/zealoop_test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zealoop-tests-"));
    const children = new Set();
    const provider = http.createServer(async (req, res) => {
        let input = "";
        for await (const chunk of req) input += chunk;
        const body = JSON.parse(input || "{}");
        res.setHeader("content-type", "application/json");
        if (req.url === "/embeddings") {
            const texts = Array.isArray(body.input) ? body.input : [body.input];
            res.end(JSON.stringify({ data: texts.map((_, index) => ({ index, embedding: Array.from({ length: 1024 }, (__, i) => i === 0 ? 1 : 0) })) }));
        } else if (req.url === "/chat/completions") {
            res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "clarify", text: "Could you share more details?", intent: "SUPPORT", sentiment: "NEUTRAL", language: "en", safe: true }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        } else { res.statusCode = 404; res.end("{}"); }
    });
    await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://${process.argv[2] === "--serve" ? "localhost" : "127.0.0.1"}:${port}`;
    const env = { ...process.env, NODE_ENV: "test", MONGODB_URI: mongo.href, TEST_MONGODB_URI: mongo.href,
        PORT: String(port), API_URL: base, TEST_BASE_URL: base, APP_URL: "http://localhost:4176", CORS_DASHBOARD_ORIGINS: "http://localhost:4176",
        SESSION_SECRET: crypto.randomBytes(32).toString("hex"), JWT_SECRET: crypto.randomBytes(32).toString("hex"), ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
        ENABLE_DEV_LOGIN: "true", ALLOW_DEV_AUTH_LINKS: "true", ALLOW_TEST_LOOPBACK: "true", ALLOW_INSECURE_DEFAULTS: "false", ALLOW_INSECURE_WEBHOOKS: "false",
        DISABLE_SIGNUPS: "false", NEW_RELIC_ENABLED: "false", NEW_RELIC_LICENSE_KEY: "", LOG_FORMAT: "pretty",
        OPENROUTER_API_KEY: "local-provider-fixture", OPENROUTER_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
        GEMINI_API_KEY: "", VOYAGE_API_KEY: "", EMAIL_API_KEY: "", BRANDFETCH_API_KEY: "", SENTRY_DSN: "",
        RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "", RAZORPAY_WEBHOOK_SECRET: "test_webhook_secret",
        BILLING_PROVIDER: "LEMON_SQUEEZY", LEMON_SQUEEZY_API_KEY: "test_key", LEMON_SQUEEZY_STORE_ID: "1", LEMON_SQUEEZY_WEBHOOK_SECRET: "test_webhook_secret",
        GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "",
        RATE_LIMIT_PER_END_USER: "10000", RATE_LIMIT_PER_ORG: "100000", RATE_LIMIT_PER_IP: "100000", AUTH_RATE_LIMIT_PER_IP: "100000", AUTH_RATE_LIMIT_PER_ACCOUNT: "100000",
        CRAWL_WORKER_ENABLED: "false", SCHEDULED_JOBS_ENABLED: "false", RETENTION_DAYS: "0", QUALITY_CRON: "0 0 1 1 *", ATTRIBUTION_CRON: "0 0 1 1 *", LIFECYCLE_CRON: "0 0 1 1 *", RESOLUTION_CRON: "0 0 1 1 *" };
    function run(args, logName) {
        const stream = logName ? fs.openSync(path.join(directory, logName), "w") : null;
        const child = spawn(process.execPath, args, { cwd: path.resolve(__dirname, ".."), env, stdio: stream == null ? "inherit" : ["ignore", stream, stream] });
        if (stream != null) fs.closeSync(stream);
        children.add(child);
        child.once("exit", () => children.delete(child));
        return child;
    }
    async function finish(child) { return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); }); }
    async function cleanup() {
        for (const child of children) child.kill("SIGTERM");
        await Promise.all([...children].map(finish));
        await new Promise(resolve => provider.close(resolve));
        if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
    }
    try {
        await mongoose.connect(mongo.href, { serverSelectionTimeoutMS: 5000 });
        console.log(`Isolated API + MongoDB tests; AI responses/embeddings use local fixtures. Logs: ${directory}`);
        if (await finish(run(["scripts/seed.js"], "seed.log")) !== 0) throw new Error(`Seed failed; see ${directory}/seed.log`);
        const api = run(["server.js"], "api.log");
        let ready = false;
        for (let attempt = 0; attempt < 120; attempt++) {
            if (api.exitCode != null) throw new Error(`API exited; see ${directory}/api.log`);
            try { ready = (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!ready) throw new Error(`API readiness timed out; see ${directory}/api.log`);
        if (["--serve", "--browser"].includes(process.argv[2])) {
            if (await finish(run(["scripts/widgetDemo.js"], "widget-seed.log")) !== 0) throw new Error("Widget demo seed failed");
        }
        if (process.argv[2] === "--browser") {
            process.exitCode = await finish(run(["tests/browser/widget.mjs"]));
            return;
        }
        if (process.argv[2] === "--serve") {
            const envFile = path.join(directory, "environment.json");
            fs.writeFileSync(envFile, JSON.stringify(env), { mode: 0o600 });
            console.log(`Test API ready at ${base}. Environment for local checks: ${envFile}`);
            await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
            return;
        }
        const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.resolve(__dirname, "../tests")).filter(name => name.endsWith(".test.js")).map(name => `tests/${name}`);
        process.exitCode = await finish(run(["--test", ...files]));
    } finally { await cleanup(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

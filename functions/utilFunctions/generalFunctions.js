const crypto = require("crypto");
const config = require("../../config/config");

// Sentry is optional — the backend must run without it.
let Sentry = null;
if (config.SENTRY_DSN) {
    try {
        Sentry = require("@sentry/node");
        Sentry.init({ dsn: config.SENTRY_DSN });
    } catch (error) {
        console.error("GeneralFunctions: @sentry/node not installed, continuing without Sentry");
        Sentry = null;
    }
}

// Same deal for New Relic. server.js has already loaded the agent by the time
// this module is required, so this just picks up the cached instance.
let newrelic = null;
if (config.NEW_RELIC_LICENSE_KEY && config.NEW_RELIC_ENABLED) {
    try {
        newrelic = require("newrelic");
    } catch (error) {
        console.error("GeneralFunctions: newrelic not installed, continuing without it");
        newrelic = null;
    }
}

class GeneralFunctions {
    generateId(prefix) {
        return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
    }

    encrypt(plaintext) {
        const key = Buffer.from(config.ENCRYPTION_KEY, "hex");
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return `${iv.toString("hex")}.${authTag.toString("hex")}.${encrypted.toString("hex")}`;
    }

    decrypt(ciphertext) {
        const [ivHex, tagHex, dataHex] = String(ciphertext).split(".");
        const key = Buffer.from(config.ENCRYPTION_KEY, "hex");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
        decipher.setAuthTag(Buffer.from(tagHex, "hex"));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
        return decrypted.toString("utf8");
    }

    // decrypt() throws when the ciphertext is malformed or ENCRYPTION_KEY has
    // changed. Callers that only want to display or mask a secret use this and
    // handle null, rather than turning a rotated key into a 500.
    safeDecrypt(ciphertext) {
        try {
            return this.decrypt(ciphertext);
        } catch (error) {
            console.log("GeneralFunctions:safeDecrypt: could not decrypt, returning null");
            return null;
        }
    }

    createIdentityHmac({ widgetSecret, email }) {
        return crypto.createHmac("sha256", widgetSecret).update(String(email)).digest("hex");
    }

    verifyIdentityHmac({ widgetSecret, email, signature }) {
        if (!signature) return false;
        const expected = this.createIdentityHmac({ widgetSecret, email });
        const expectedBuf = Buffer.from(expected, "hex");
        let providedBuf;
        try {
            providedBuf = Buffer.from(String(signature), "hex");
        } catch (error) {
            return false;
        }
        if (providedBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, providedBuf);
    }

    // Every catch block in the codebase routes through here, which makes it the
    // one place worth teaching about new error sinks.
    captureException(error) {
        if (Sentry) {
            Sentry.captureException(error);
        }
        // Without this New Relic only ever learns "a 500 happened" from the
        // response status: the catch blocks swallow the exception and return a
        // generic body, so the stack never reaches the Errors Inbox on its own.
        if (newrelic) {
            newrelic.noticeError(error);
        }
    }

    // ~4 chars per token is close enough for budgets and traces
    estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(String(text).length / 4);
    }

    estimateCostUsd({ model, inputTokens, outputTokens }) {
        const price = config.PRICE_PER_MTOK[model];
        if (!price) return 0;
        return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
    }
}

/* §8.6 — the coercion every id-shaped lookup value goes through.

   Mongoose will happily take an object where a string was meant and treat it
   as a query operator, so `findOne({ publicKey })` with a body-supplied
   `{"$ne": null}` matches an arbitrary tenant's row. Coercing at the lookup is
   the real fix; middlewares/sanitize.js is the second line.

   Returns null rather than throwing, and null is never a valid id, so callers
   that already handle "not found" handle a hostile value the same way with no
   new branch. A non-string is rejected outright rather than String()-ed,
   because String({$ne:null}) is "[object Object]" — harmless, but it turns an
   attack into a confusing 404 instead of something greppable. */
function asId(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 200) return null;
    return trimmed;
}

module.exports = new GeneralFunctions();
module.exports.asId = asId;

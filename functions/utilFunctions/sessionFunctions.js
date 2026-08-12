const crypto = require("crypto");
const config = require("../../config/config");

// Dashboard sign-in mechanics: password hashing and the signed session cookie.
//
// Deliberately separate from the org JWT in middlewares/auth.js. They answer
// different questions — the cookie says *who you are*, the JWT says *which org
// this request may touch* — and conflating them is how a token that outlives a
// sign-out ends up still working.
//
// The token is stateless: base64url(payload).hmac, with no server-side session
// store to keep consistent. Signing out clears the cookie; the 7-day expiry in
// the payload is the backstop.

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SessionFunctions {
    hashPassword(password) {
        const salt = crypto.randomBytes(16).toString("hex");
        return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
    }

    verifyPassword(password, stored) {
        // An OAuth-only account has no hash. Returning false here (rather than
        // throwing) is what makes "sign in with a password to a Google-only
        // account" a normal failed login instead of a 500.
        if (!stored) return false;
        const [scheme, salt, hash] = String(stored).split("$");
        if (scheme !== "scrypt" || !salt || !hash) return false;

        const candidate = crypto.scryptSync(password, salt, 64);
        const expected = Buffer.from(hash, "hex");
        // timingSafeEqual throws on a length mismatch rather than returning
        // false, so this guard is load-bearing, not defensive noise.
        if (candidate.length !== expected.length) return false;
        return crypto.timingSafeEqual(candidate, expected);
    }

    createSessionToken(accountId) {
        const payload = Buffer.from(JSON.stringify({ sub: accountId, exp: Date.now() + SESSION_TTL_MS })).toString(
            "base64url"
        );
        return `${payload}.${this._sign(payload)}`;
    }

    verifySessionToken(token) {
        if (!token) return null;
        const [payload, signature] = String(token).split(".");
        if (!payload || !signature) return null;

        const expected = Buffer.from(this._sign(payload));
        const provided = Buffer.from(signature);
        if (provided.length !== expected.length) return null;
        if (!crypto.timingSafeEqual(provided, expected)) return null;

        try {
            const { sub, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
            return exp > Date.now() ? sub : null;
        } catch (error) {
            return null;
        }
    }

    setSessionCookie(res, accountId) {
        res.cookie(config.SESSION_COOKIE, this.createSessionToken(accountId), {
            httpOnly: true,
            // Lax, not Strict: the OAuth callback arrives as a top-level
            // navigation from Google, and Strict would withhold the cookie we
            // just set on the very next hop.
            sameSite: "lax",
            secure: config.COOKIE_SECURE,
            path: "/",
            maxAge: SESSION_TTL_MS,
        });
    }

    clearSessionCookie(res) {
        // Same attributes as when it was set — a mismatched path or sameSite
        // leaves the original cookie in place and sign-out silently does nothing.
        res.clearCookie(config.SESSION_COOKIE, {
            httpOnly: true,
            sameSite: "lax",
            secure: config.COOKIE_SECURE,
            path: "/",
        });
    }

    setOAuthStateCookie(res, state) {
        res.cookie(config.OAUTH_STATE_COOKIE, state, {
            httpOnly: true,
            sameSite: "lax",
            secure: config.COOKIE_SECURE,
            path: "/",
            maxAge: 10 * 60 * 1000,
        });
    }

    clearOAuthStateCookie(res) {
        res.clearCookie(config.OAUTH_STATE_COOKIE, {
            httpOnly: true,
            sameSite: "lax",
            secure: config.COOKIE_SECURE,
            path: "/",
        });
    }

    randomToken() {
        return crypto.randomBytes(32).toString("base64url");
    }

    _sign(payload) {
        return crypto.createHmac("sha256", config.SESSION_SECRET).update(payload).digest("base64url");
    }
}

module.exports = new SessionFunctions();

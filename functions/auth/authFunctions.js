const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const config = require("../../config/config");
const Account = require("../../models/user/account");
const AuthToken = require("../../models/user/authToken");
const Member = require("../../models/org/member");
const Org = require("../../models/org/org");
const { AuthProvider, TokenPurpose, MemberRole, MemberStatus, IdPrefix, PlanId } = require("../../config/enums");
const { getPlan } = require("../../config/plans");
const generalFunctions = require("../utilFunctions/generalFunctions");
const geoFunctions = require("../utilFunctions/geoFunctions");
const sessionFunctions = require("../utilFunctions/sessionFunctions");
const attributeFunctions = require("../config/attributeFunctions");
const subscriptionFunctions = require("../billing/subscriptionFunctions");
const emailFunctions = require("../email/emailFunctions");

const GENERIC_ERROR = "Internal server error, please contact support";
// One message for "no such account" and "wrong password" alike. Two distinct
// messages turn the login form into an account-enumeration oracle.
const BAD_CREDENTIALS = "That email and password don't match";
const MIN_PASSWORD_LENGTH = 8;
const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Dashboard sign-in: password, Google, and GitHub.
 *
 * Two token types meet here and stay separate on purpose:
 *
 *   session cookie  — who you are. Set by this file, HttpOnly, 7 days.
 *   org JWT         — which org a request may touch. Minted by mintOrgToken()
 *                     only after membership is checked, then carried by the
 *                     dashboard as a Bearer token on every /api/org/* call.
 *
 * Membership is not stored on the account. It is derived from Member rows
 * matching the account's email, so inviting someone to an org and them signing
 * up are two independent events that meet at the address.
 *
 * The OAuth halves are redirect-shaped rather than {status, json} — they hand
 * back a URL for the route to bounce the browser to.
 */
class AuthFunctions {
    // GET /api/auth/config — the login page has to know which buttons to render
    // before any session exists, so this is public.
    async getConfig() {
        console.log("AuthFunctions:getConfig: run");
        try {
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        googleEnabled: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
                        githubEnabled: Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
                        signupsDisabled: config.DISABLE_SIGNUPS,
                    },
                },
            };
        } catch (error) {
            console.error("AuthFunctions:getConfig: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // POST /api/auth/signup
    async signup({ name, email, password }) {
        console.log("AuthFunctions:signup: email:", email);
        try {
            if (config.DISABLE_SIGNUPS) {
                return { status: 403, json: { success: false, error: "Signups are currently closed" } };
            }
            const normalized = String(email || "").trim().toLowerCase();
            if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
                return { status: 400, json: { success: false, error: "Enter a valid email address" } };
            }
            if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
                return {
                    status: 400,
                    json: { success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
                };
            }
            const displayName = String(name || "").trim() || normalized.split("@")[0];
            if (!config.EMAIL_API_KEY && !config.ALLOW_DEV_AUTH_LINKS) {
                return { status: 503, json: { success: false, error: "Email sign-up is temporarily unavailable. Please try again later." } };
            }

            /* §8.6 — ANY existing account is a conflict. No exceptions.

               This used to return 409 only when `passwordSetAt` was set, and
               claim the account otherwise. Every Google and GitHub account is
               created with passwordSetAt null by design, so the exception was
               the rule: posting a victim's address with a password of your
               choosing overwrote their credential and signed you in as them.
               The address is not a secret — it is the org's ownerEmail, listed
               in the members table.

               The old comment said "the provider already proved they own it".
               It proved the VICTIM owns it. It proved nothing whatsoever about
               the anonymous request now claiming it.

               An OAuth user who wants a password uses the reset flow, which
               sends a token to the address and therefore actually establishes
               that the person asking can receive mail there. */
            const existing = await Account.findOne({ email: normalized });
            if (existing) {
                return { status: 409, json: { success: false, error: "An account with that email already exists" } };
            }

            const account = await Account.create({
                accountId: generalFunctions.generateId(IdPrefix.ACCOUNT),
                email: normalized,
                name: displayName,
                passwordHash: await sessionFunctions.hashPasswordAsync(String(password)),
                passwordSetAt: new Date(),
                providers: [AuthProvider.PASSWORD],
                lastLoginAt: new Date(),
            });
            const verification = await this.sendVerification({ account });
            return { status: 201, json: { success: true, data: { accountId: account.accountId, sessionVersion: account.sessionVersion, ...verification.json.data } } };
        } catch (error) {
            console.error("AuthFunctions:signup: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // POST /api/auth/login
    async login({ email, password }) {
        console.log("AuthFunctions:login: email:", email);
        try {
            const normalized = String(email || "").trim().toLowerCase();
            if (!normalized || typeof password !== "string" || !password || password.length > 256) {
                return { status: 400, json: { success: false, error: "Enter your email and password" } };
            }

            const account = await Account.findOne({ email: normalized });
            // verifyPassword tolerates a null hash, so an OAuth-only account
            // takes the same path and the same generic failure as a bad password.
            if (!account || !(await sessionFunctions.verifyPasswordAsync(String(password), account.passwordHash))) {
                return { status: 401, json: { success: false, error: BAD_CREDENTIALS } };
            }

            await Account.updateOne({ accountId: account.accountId }, { lastLoginAt: new Date() });
            return { status: 200, json: { success: true, data: { accountId: account.accountId, sessionVersion: account.sessionVersion } } };
        } catch (error) {
            console.error("AuthFunctions:login: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // POST /api/auth/logout — the cookie clearing itself is the route's job.
    async logout({ session } = {}) {
        console.log("AuthFunctions:logout: run");
        if (session) {
            await Account.updateOne({ accountId: session.sub, ...this._sessionVersionFilter(session.ver) }, { $inc: { sessionVersion: 1 } });
        }
        return { status: 200, json: { success: true, data: { ok: true } } };
    }

    // GET /api/auth/me — identity plus every org this account can open. The
    // dashboard uses the org list for the workspace switcher and for deciding
    // whether to send a new account to onboarding.
    async me({ account }) {
        console.log("AuthFunctions:me: accountId:", account && account.accountId);
        try {
            if (!account) {
                return { status: 401, json: { success: false, error: "Not signed in" } };
            }
            const orgs = await this._orgsForAccount(account);
            if (!orgs.success) {
                return { status: 500, json: { success: false, error: GENERIC_ERROR } };
            }
            return {
                status: 200,
                json: { success: true, data: { user: this._publicAccount(account), orgs: orgs.orgs } },
            };
        } catch (error) {
            console.error("AuthFunctions:me: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // PATCH /api/auth/me — name only. The email is the identity every Member row
    // joins on, so changing it would silently orphan every seat.
    async updateMe({ account, name }) {
        console.log("AuthFunctions:updateMe: accountId:", account && account.accountId);
        try {
            if (!account) {
                return { status: 401, json: { success: false, error: "Not signed in" } };
            }
            const trimmed = String(name || "").trim();
            if (!trimmed) {
                return { status: 400, json: { success: false, error: "Name cannot be empty" } };
            }
            const updated = await Account.findOneAndUpdate(
                { accountId: account.accountId },
                { name: trimmed },
                { new: true }
            );
            return { status: 200, json: { success: true, data: this._publicAccount(updated) } };
        } catch (error) {
            console.error("AuthFunctions:updateMe: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // POST /api/auth/token — exchange the session for an org-scoped JWT.
    //
    // This is the only place an org token is minted for a real user, and the
    // membership check is the whole point: before this existed, anyone could ask
    // dev-login for a token to any org id they could guess.
    async mintOrgToken({ account, orgId }) {
        console.log("AuthFunctions:mintOrgToken: accountId:", account && account.accountId, "orgId:", orgId);
        try {
            if (!account) {
                return { status: 401, json: { success: false, error: "Not signed in" } };
            }
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }

            if (!account.emailVerifiedAt) {
                return { status: 403, json: { success: false, error: "Verify your email before opening a workspace", reason: "EMAIL_VERIFICATION_REQUIRED" } };
            }

            const member = await Member.findOne({ orgId, email: account.email });
            if (!member) {
                return { status: 403, json: { success: false, error: "You don't have access to that workspace" } };
            }
            if (![MemberStatus.ACTIVE, MemberStatus.INVITED].includes(member.status)) {
                return { status: 403, json: { success: false, error: "Your workspace access is suspended" } };
            }
            const org = await Org.findOne({ orgId }).lean();
            if (!org) {
                return { status: 404, json: { success: false, error: "Workspace not found" } };
            }

            // Stamp the seat on every open, not just the first. It is what
            // orders the workspace list, so "the one you were last in" is the
            // one you come back to. An invited seat also becomes active here —
            // that is what "accepted the invite" means when there is no invite
            // email to click.
            await Member.updateOne(
                { memberId: member.memberId },
                {
                    lastActiveAt: new Date(),
                    ...(member.status === MemberStatus.INVITED && { status: MemberStatus.ACTIVE }),
                }
            );

            const token = jwt.sign({ orgId: org.orgId, email: account.email, accountId: account.accountId, sessionVersion: account.sessionVersion || 0 }, config.JWT_SECRET, { expiresIn: "1h" });
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        token,
                        orgId: org.orgId,
                        orgName: org.name,
                        publicKey: org.publicKey,
                        role: member.role,
                    },
                },
            };
        } catch (error) {
            console.error("AuthFunctions:mintOrgToken: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // POST /api/auth/orgs — onboarding. Creates the workspace and the owner seat
    // in one step, because an org whose ownerEmail has no Member row is a
    // workspace nobody can administer.
    async createOrg({ account, name, website, country }) {
        console.log("AuthFunctions:createOrg: accountId:", account && account.accountId, "name:", name);
        try {
            if (!account) {
                return { status: 401, json: { success: false, error: "Not signed in" } };
            }
            const orgName = String(name || "").trim();
            if (!orgName) {
                return { status: 400, json: { success: false, error: "Give your workspace a name" } };
            }
            if (!account.emailVerifiedAt) {
                return { status: 403, json: { success: false, error: "Verify your email before creating a workspace", reason: "EMAIL_VERIFICATION_REQUIRED" } };
            }

            const orgId = generalFunctions.generateId(IdPrefix.ORG);
            const widgetSecret = `ws_live_${crypto.randomBytes(24).toString("hex")}`;
            const publicKey = `pk_live_${crypto.randomBytes(12).toString("hex")}`;

            const org = await Org.create({
                orgId,
                name: orgName,
                website: String(website || "").trim(),
                ownerEmail: account.email,
                publicKey,
                widgetSecret: generalFunctions.encrypt(widgetSecret),
                agent: { name: "Zea", greeting: `Hi! Ask me anything about ${orgName}.`, language: "en" },
                widget: { position: "bottom-right", allowedOrigins: [] },
                credits: { plan: PlanId.FREE, conversationsUsed: 0, conversationsLimit: getPlan(PlanId.FREE).limits.conversations },
                // Decided here, at the first request that tells us where the
                // workspace is, so the billing page is in the right currency
                // from its very first load.
                billing: { country: country || null, currency: geoFunctions.currencyForCountry(country) },
            });

            await Member.create({
                orgId,
                memberId: generalFunctions.generateId(IdPrefix.MEMBER),
                email: account.email,
                name: account.name || account.email.split("@")[0],
                role: MemberRole.OWNER,
                status: MemberStatus.ACTIVE,
                lastActiveAt: new Date(),
            });

            // §2.3 — Sentiment, Issue Type, Urgency and Spam ship live and on.
            // A workspace whose inbox has four permanently empty columns until
            // someone discovers a settings page has been given homework.
            // Awaited rather than fired off, because a workspace created without
            // them looks broken and there is no later moment that fixes it.
            await attributeFunctions.seedBuiltIns({ orgId });

            // §0.5 — the 14-day trial starts here, not at first payment. No card
            // is required, so an expired trial drops to FREE rather than
            // suspending anything.
            await subscriptionFunctions.startTrial({ orgId });

            return {
                status: 201,
                json: { success: true, data: { orgId: org.orgId, name: org.name, role: MemberRole.OWNER, plan: "FREE" } },
            };
        } catch (error) {
            console.error("AuthFunctions:createOrg: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    // Session-bound resend: it can only send to this account's own address.
    async sendVerification({ account }) {
        if (!account) return { status: 401, json: { success: false, error: "Not signed in" } };
        if (account.emailVerifiedAt) return { status: 200, json: { success: true, data: { ok: true, verified: true } } };
        if (!config.EMAIL_API_KEY && !config.ALLOW_DEV_AUTH_LINKS) {
            return { status: 503, json: { success: false, error: "Email delivery is temporarily unavailable" } };
        }
        const url = await this._createAccountLink({ account, purpose: TokenPurpose.EMAIL_VERIFY, path: "verify-email" });
        const delivery = config.EMAIL_API_KEY
            ? await emailFunctions.sendAccountLink({ to: account.email, url, purpose: TokenPurpose.EMAIL_VERIFY })
            : { success: true };
        return { status: 200, json: { success: true, data: {
            ok: true, verificationRequired: true, verificationSent: delivery.success,
            verificationUrl: config.ALLOW_DEV_AUTH_LINKS ? url : null,
        } } };
    }

    async verifyEmail({ token, account }) {
        if (!token || typeof token !== "string") return { status: 400, json: { success: false, error: "Invalid verification link" } };
        // A verification link must not switch the browser into another account.
        if (!account) return { status: 401, json: { success: false, error: "Sign in to verify your email" } };
        const consumed = await this._consumeToken({ token, purpose: TokenPurpose.EMAIL_VERIFY, accountId: account.accountId });
        if (!consumed.success) return { status: 400, json: { success: false, error: "That verification link has expired or already been used" } };
        await Account.updateOne({ accountId: account.accountId }, { $set: { emailVerifiedAt: new Date() } });
        return { status: 200, json: { success: true, data: { ok: true } } };
    }

    // Known and unknown addresses get the same response. Development link
    // exposure is explicit and can never be enabled in production.
    async forgotPassword({ email }) {
        if (!config.EMAIL_API_KEY && !config.ALLOW_DEV_AUTH_LINKS) {
            return { status: 503, json: { success: false, error: "Password recovery is temporarily unavailable. Please try again later." } };
        }
        const answer = { status: 200, json: { success: true, data: {
            ok: true, resetUrl: null, delivery: config.ALLOW_DEV_AUTH_LINKS ? "dev-response" : "email",
        } } };
        try {
            const account = await Account.findOne({ email: String(email || "").trim().toLowerCase() });
            if (!account) return answer;
            const url = await this._createAccountLink({ account, purpose: TokenPurpose.PASSWORD_RESET, path: "reset-password" });
            if (config.EMAIL_API_KEY) {
                const delivery = await emailFunctions.sendAccountLink({ to: account.email, url, purpose: TokenPurpose.PASSWORD_RESET });
                if (!delivery.success) console.error("AuthFunctions:forgotPassword: recovery delivery failed");
            }
            if (config.ALLOW_DEV_AUTH_LINKS) answer.json.data.resetUrl = url;
            return answer;
        } catch (error) {
            // Do not turn a database/provider failure for a known address into
            // an account enumeration signal.
            generalFunctions.captureException(error);
            return answer;
        }
    }

    async _createAccountLink({ account, purpose, path }) {
        const token = sessionFunctions.randomToken();
        await AuthToken.create({
            tokenId: generalFunctions.generateId(IdPrefix.AUTH_TOKEN), accountId: account.accountId,
            sessionVersion: account.sessionVersion || 0,
            token: crypto.createHash("sha256").update(token).digest("hex"), purpose,
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
        });
        return `${config.APP_URL}/${path}?token=${encodeURIComponent(token)}`;
    }

    // POST /api/auth/reset-password
    async resetPassword({ token, password }) {
        console.log("AuthFunctions:resetPassword: run");
        try {
            if (!token) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass token" } };
            }
            if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
                return {
                    status: 400,
                    json: { success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
                };
            }

            const consumed = await this._consumeToken({ token, purpose: TokenPurpose.PASSWORD_RESET });
            if (!consumed.success) {
                return { status: 400, json: { success: false, error: "That reset link has expired or already been used" } };
            }

            const account = await Account.findOne({ accountId: consumed.accountId });
            if (!account) {
                return { status: 404, json: { success: false, error: "Account not found" } };
            }
            const version = consumed.sessionVersion ?? (account.sessionVersion || 0);
            const changed = await Account.findOneAndUpdate({ accountId: account.accountId, ...this._sessionVersionFilter(version) }, {
                $set: { passwordHash: await sessionFunctions.hashPasswordAsync(password), emailVerifiedAt: account.emailVerifiedAt || new Date(),
                    passwordSetAt: new Date(), lastLoginAt: new Date() },
                $inc: { sessionVersion: 1 }, $addToSet: { providers: AuthProvider.PASSWORD },
            }, { new: true });
            if (!changed) return { status: 400, json: { success: false, error: "That reset link is no longer valid. Request a fresh link." } };

            await AuthToken.updateMany({ accountId: account.accountId, purpose: TokenPurpose.PASSWORD_RESET, usedAt: null }, { $set: { usedAt: new Date() } });
            return { status: 200, json: { success: true, data: { accountId: changed.accountId, sessionVersion: changed.sessionVersion } } };
        } catch (error) {
            console.error("AuthFunctions:resetPassword: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    /* ──────────────────────── Google OAuth ────────────────────────
       A full redirect round-trip, so it stays server-side. Google bounces the
       browser back to this API, which is why the URI registered in Google Cloud
       Console must be exactly `${API_URL}/auth/google/callback`, port included.
       Redirect-shaped results, not {status, json} — the route needs a URL. */
    googleAuthorize() {
        console.log("AuthFunctions:googleAuthorize: run");
        if (!config.GOOGLE_CLIENT_ID) {
            return { url: `${config.APP_URL}/login?error=google_disabled` };
        }
        const state = crypto.randomBytes(16).toString("base64url");
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        url.searchParams.set("client_id", config.GOOGLE_CLIENT_ID);
        url.searchParams.set("redirect_uri", `${config.API_URL}/auth/google/callback`);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", "openid email profile");
        url.searchParams.set("state", state);
        return { url: url.toString(), state };
    }

    async googleCallback({ code, state, expectedState }) {
        console.log("AuthFunctions:googleCallback: run");
        const fail = (reason) => ({ redirectUrl: `${config.APP_URL}/login?error=${reason}` });
        try {
            // The state cookie is the CSRF defence: without it, an attacker can
            // hand someone a callback URL carrying their own auth code and log
            // that person into the attacker's account.
            if (!code || !state || !expectedState || state !== expectedState) {
                return fail("google");
            }
            if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
                return fail("google_disabled");
            }

            const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    code,
                    client_id: config.GOOGLE_CLIENT_ID,
                    client_secret: config.GOOGLE_CLIENT_SECRET,
                    redirect_uri: `${config.API_URL}/auth/google/callback`,
                    grant_type: "authorization_code",
                }),
            });
            if (!tokenResponse.ok) {
                console.log("AuthFunctions:googleCallback: token exchange failed:", tokenResponse.status);
                return fail("google");
            }

            const { id_token: idToken } = await tokenResponse.json();
            if (!idToken) return fail("google");

            // The id_token arrived straight from Google's token endpoint over
            // TLS inside this request, so the payload needs no signature check —
            // there was no untrusted hop for anyone to forge it on.
            let claims;
            try {
                claims = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
            } catch (error) {
                return fail("google");
            }

            const email = claims.email && String(claims.email).trim().toLowerCase();
            if (!email || claims.email_verified !== true) return fail("google");

            const resolved = await this._findOrCreateAccount({
                email,
                name: claims.name,
                provider: AuthProvider.GOOGLE,
            });
            if (!resolved.success) return fail(resolved.reason);

            return { redirectUrl: `${config.APP_URL}/app`, accountId: resolved.account.accountId, sessionVersion: resolved.account.sessionVersion || 0 };
        } catch (error) {
            console.error("AuthFunctions:googleCallback: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return fail("google");
        }
    }

    /* ──────────────────────── GitHub OAuth ────────────────────────
       Same round-trip shape as Google. GitHub has no OIDC id_token, so the
       callback makes two follow-up calls with the access token: /user for the
       profile and /user/emails for a verified primary address — GitHub lets
       accounts keep the primary email private, so it is not reliably on /user. */
    githubAuthorize() {
        console.log("AuthFunctions:githubAuthorize: run");
        if (!config.GITHUB_CLIENT_ID) {
            return { url: `${config.APP_URL}/login?error=github_disabled` };
        }
        const state = crypto.randomBytes(16).toString("base64url");
        const url = new URL("https://github.com/login/oauth/authorize");
        url.searchParams.set("client_id", config.GITHUB_CLIENT_ID);
        url.searchParams.set("redirect_uri", `${config.API_URL}/auth/github/callback`);
        url.searchParams.set("scope", "read:user user:email");
        url.searchParams.set("state", state);
        return { url: url.toString(), state };
    }

    async githubCallback({ code, state, expectedState }) {
        console.log("AuthFunctions:githubCallback: run");
        const fail = (reason) => ({ redirectUrl: `${config.APP_URL}/login?error=${reason}` });
        try {
            if (!code || !state || !expectedState || state !== expectedState) {
                return fail("github");
            }
            if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
                return fail("github_disabled");
            }

            const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                body: new URLSearchParams({
                    code,
                    client_id: config.GITHUB_CLIENT_ID,
                    client_secret: config.GITHUB_CLIENT_SECRET,
                    redirect_uri: `${config.API_URL}/auth/github/callback`,
                }),
            });
            if (!tokenResponse.ok) {
                console.log("AuthFunctions:githubCallback: token exchange failed:", tokenResponse.status);
                return fail("github");
            }

            const { access_token: accessToken } = await tokenResponse.json();
            if (!accessToken) return fail("github");

            const headers = {
                authorization: `Bearer ${accessToken}`,
                accept: "application/vnd.github+json",
                "user-agent": "Zealoop",
            };
            const [userResponse, emailsResponse] = await Promise.all([
                fetch("https://api.github.com/user", { headers }),
                fetch("https://api.github.com/user/emails", { headers }),
            ]);
            if (!userResponse.ok || !emailsResponse.ok) return fail("github");

            const profile = await userResponse.json();
            const emails = await emailsResponse.json();
            const primary = Array.isArray(emails) && emails.find((row) => row.primary && row.verified);
            const email = primary && String(primary.email).trim().toLowerCase();
            // An unverified GitHub address is not proof of anything, and taking
            // it would let someone claim an org seat they were invited to but
            // don't own.
            if (!email) return fail("github_no_verified_email");

            const resolved = await this._findOrCreateAccount({
                email,
                name: profile.name || profile.login,
                provider: AuthProvider.GITHUB,
            });
            if (!resolved.success) return fail(resolved.reason);

            return { redirectUrl: `${config.APP_URL}/app`, accountId: resolved.account.accountId, sessionVersion: resolved.account.sessionVersion || 0 };
        } catch (error) {
            console.error("AuthFunctions:githubCallback: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return fail("github");
        }
    }

    /* ──────────────────────── dev helpers ──────────────────────── */

    // POST /api/auth/dev-login — mints an org token with no session and no
    // membership check. Kept for the API test harness and local poking only;
    // it refuses outright in production. Real users go through mintOrgToken.
    async devLogin({ orgId }) {
        console.log("AuthFunctions:devLogin: orgId:", orgId);
        try {
            /* §8.6 — fails CLOSED, on an explicit opt-in.

               This route mints a 7-day JWT as the org owner for any orgId you
               name, and reqOrgOwnerAuth accepts it everywhere. It was gated on
               NODE_ENV !== "production" — a variable set nowhere in this repo:
               not in .env, not in .env.example, not in package.json's start
               script, and there is no Dockerfile or deploy manifest to set it.
               An absent variable is not "production", so the gate was open,
               and the orgId it needs is handed to any anonymous visitor by the
               widget bootstrap using a publicKey scraped from page source.

               ENABLE_DEV_LOGIN must now be present and exactly "true".
               Absence disables it, which is the direction a mistake should
               fail in. NODE_ENV is kept as a second veto so that setting it
               correctly also closes this, whichever one an operator remembers. */
            if (config.ENABLE_DEV_LOGIN !== true || process.env.NODE_ENV === "production") {
                return { status: 404, json: { success: false, error: "Not found" } };
            }
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const org = await Org.findOne({ orgId });
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found. Run the seed script first: npm run seed" } };
            }

            const token = jwt.sign({ orgId: org.orgId, email: org.ownerEmail, dev: true }, config.JWT_SECRET, { expiresIn: "7d" });
            return {
                status: 200,
                json: { success: true, data: { token, orgId: org.orgId, orgName: org.name, publicKey: org.publicKey } },
            };
        } catch (error) {
            console.error("AuthFunctions:devLogin: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: GENERIC_ERROR } };
        }
    }

    /* ──────────────────────── private ──────────────────────── */
    _sessionVersionFilter(version) {
        return version === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion: version };
    }

    // Resolves an OAuth identity to an account, creating one if the address is
    // new. Returns {success} like every other private helper here.
    async _findOrCreateAccount({ email, name, provider }) {
        const existing = await Account.findOne({ email });
        if (existing) {
            const update = { $set: { lastLoginAt: new Date() }, $addToSet: { providers: provider } };
            // The provider already verified this address, so an account that
            // signed up with a password and never confirmed its email becomes
            // verified here. Left alone if it already was, to keep the original
            // timestamp.
            if (!existing.emailVerifiedAt) {
                // A stranger may have pre-registered this email. OAuth proves
                // ownership, but must not make the stranger's password/session
                // valid for the now-verified account.
                const claimed = await Account.findOneAndUpdate({ accountId: existing.accountId, emailVerifiedAt: null }, {
                    $set: { emailVerifiedAt: new Date(), passwordHash: null, passwordSetAt: null, lastLoginAt: new Date() },
                    $inc: { sessionVersion: 1 }, $addToSet: { providers: provider },
                }, { new: true });
                if (claimed) {
                    await AuthToken.updateMany({ accountId: existing.accountId, usedAt: null }, { $set: { usedAt: new Date() } });
                    return { success: true, account: claimed };
                }
            }

            const refreshed = await Account.findOneAndUpdate({ accountId: existing.accountId }, update, { new: true });
            return { success: true, account: refreshed };
        }

        if (config.DISABLE_SIGNUPS) {
            return { success: false, reason: "signups_disabled" };
        }

        const account = await Account.create({
            accountId: generalFunctions.generateId(IdPrefix.ACCOUNT),
            email,
            name: String(name || "").trim() || email.split("@")[0],
            // Passwords can be added only through the emailed reset flow.
            passwordHash: null,
            passwordSetAt: null,
            emailVerifiedAt: new Date(),
            providers: [provider],
            lastLoginAt: new Date(),
        });
        console.log("AuthFunctions:_findOrCreateAccount: provisioned account:", account.accountId);
        return { success: true, account };
    }

    // Every org this account holds a seat in, most recently used first, with the
    // role that seat carries. Two queries rather than an aggregate join, because
    // Member and Org live in separate collections and the list is small by nature.
    //
    // The order is not cosmetic: the dashboard opens orgs[0] when it has no
    // stored preference, so sorting by this account's own last activity is what
    // makes "come back and you're where you left off" true. Sorting by org
    // creation date instead would drop a returning user into whichever workspace
    // happened to be made first.
    async _orgsForAccount(account) {
        try {
            if (!account.emailVerifiedAt) return { success: true, orgs: [] };
            const seats = await Member.find({ email: account.email }).lean();
            if (!seats.length) return { success: true, orgs: [] };

            const orgs = await Org.find({ orgId: { $in: seats.map((seat) => seat.orgId) } }).lean();
            const seatByOrg = new Map(seats.map((seat) => [seat.orgId, seat]));

            const sorted = orgs.sort((a, b) => {
                const aSeen = seatByOrg.get(a.orgId)?.lastActiveAt;
                const bSeen = seatByOrg.get(b.orgId)?.lastActiveAt;
                // A seat never opened sorts last rather than first — an invite
                // you have not accepted should not become your landing page.
                if (aSeen && bSeen) return new Date(bSeen) - new Date(aSeen);
                if (aSeen) return -1;
                if (bSeen) return 1;
                return new Date(a.createdAt) - new Date(b.createdAt);
            });

            return {
                success: true,
                orgs: sorted.map((org) => ({
                    orgId: org.orgId,
                    name: org.name,
                    ownerEmail: org.ownerEmail,
                    plan: (org.credits && org.credits.plan) || "FREE",
                    role: (seatByOrg.get(org.orgId) || {}).role || MemberRole.AGENT,
                })),
            };
        } catch (error) {
            console.error("AuthFunctions:_orgsForAccount: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // Atomic compare-and-swap: the `usedAt: null` filter is what closes the
    // double-redemption race between two clicks on the same link.
    async _consumeToken({ token, purpose, accountId }) {
        if (typeof token !== "string" || token.length > 256) return { success: false };
        const row = await AuthToken.findOneAndUpdate(
            { token: { $in: [crypto.createHash("sha256").update(token).digest("hex"), token] }, purpose, ...(accountId && { accountId }), usedAt: null, expiresAt: { $gt: new Date() } },
            { $set: { usedAt: new Date() } }
        );
        if (!row) return { success: false };
        return { success: true, accountId: row.accountId, sessionVersion: row.sessionVersion };
    }

    _publicAccount(account) {
        return {
            accountId: account.accountId,
            email: account.email,
            name: account.name,
            emailVerified: Boolean(account.emailVerifiedAt),
            providers: account.providers || [],
            hasPassword: Boolean(account.passwordSetAt),
        };
    }
}

module.exports = new AuthFunctions();

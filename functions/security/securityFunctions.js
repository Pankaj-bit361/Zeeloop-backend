const crypto = require("crypto");
const config = require("../../config/config");
const { AuditAction } = require("../../config/enums");
const Org = require("../../models/org/org");
const generalFunctions = require("../utilFunctions/generalFunctions");
const auditFunctions = require("../audit/auditFunctions");

// §8.4 — the security settings a workspace owns: which origins may embed the
// widget, and rotating the secret that signs identify() payloads.

class SecurityFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async getSecuritySettings({ orgId }) {
        console.log("SecurityFunctions:getSecuritySettings: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId }).lean();
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            const graceActive = !!(org.previousSecretExpiresAt && org.previousSecretExpiresAt > new Date());

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        allowedOrigins: (org.widget && org.widget.allowedOrigins) || [],
                        enforceOriginAllowlist: !!(org.widget && org.widget.enforceOriginAllowlist),
                        secretRotatedAt: org.secretRotatedAt,
                        // The old secret is still accepted, and when that stops.
                        // Surfaced because "why is identify() still working with
                        // the old key" is otherwise a mystery.
                        previousSecretActive: graceActive,
                        previousSecretExpiresAt: graceActive ? org.previousSecretExpiresAt : null,
                        graceHours: config.SECRET_ROTATION_GRACE_HOURS,
                    },
                },
            };
        } catch (error) {
            console.error("SecurityFunctions:getSecuritySettings: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §8.4 — origin allowlist, so a stolen embed id cannot be used from another
    // domain.
    //
    // Enforcement is opt-in and refuses to turn on with an empty list. Turning
    // it on for a workspace that has not listed its own domains would take their
    // widget down instantly, and the person who clicked the toggle would have no
    // reason to connect the two.
    async updateOriginAllowlist({ orgId, allowedOrigins, enforce, actorEmail, ip }) {
        console.log("SecurityFunctions:updateOriginAllowlist: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            let origins = org.widget.allowedOrigins || [];
            if (allowedOrigins !== undefined) {
                if (!Array.isArray(allowedOrigins)) {
                    return { status: 400, json: { success: false, error: "allowedOrigins must be an array" } };
                }
                const normalised = [];
                for (const entry of allowedOrigins) {
                    const origin = this.normaliseOrigin(entry);
                    if (!origin) {
                        return {
                            status: 400,
                            json: { success: false, error: `"${entry}" is not a valid origin. Use the scheme and host, like https://acme.com` },
                        };
                    }
                    normalised.push(origin);
                }
                origins = [...new Set(normalised)];
            }

            if (enforce === true && origins.length === 0) {
                return {
                    status: 400,
                    json: {
                        success: false,
                        error: "Add at least one origin before turning enforcement on — otherwise your widget stops working everywhere.",
                    },
                };
            }

            org.widget.allowedOrigins = origins;
            if (enforce !== undefined) org.widget.enforceOriginAllowlist = enforce === true;
            org.widget.configVersion = (org.widget.configVersion || 1) + 1;
            await org.save();

            await auditFunctions.record({
                orgId,
                action: AuditAction.ORIGIN_ALLOWLIST_CHANGED,
                actorEmail,
                targetType: "ORG",
                targetId: orgId,
                detail: { allowedOrigins: origins, enforce: org.widget.enforceOriginAllowlist },
                ip,
            });

            return {
                status: 200,
                json: {
                    success: true,
                    data: { allowedOrigins: origins, enforceOriginAllowlist: org.widget.enforceOriginAllowlist },
                },
            };
        } catch (error) {
            console.error("SecurityFunctions:updateOriginAllowlist: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §8.4 — rotation without downtime.
    //
    // The old secret keeps verifying for a grace window. Without it, rotation is
    // a hard cutover: every identify() call signed by the customer's not-yet-
    // redeployed backend fails, and every verified user silently becomes
    // anonymous — which means tables and write actions stop working for
    // everyone, with no error anywhere that says why.
    async rotateWidgetSecret({ orgId, actorEmail, ip }) {
        console.log("SecurityFunctions:rotateWidgetSecret: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            const next = `ws_live_${crypto.randomBytes(24).toString("hex")}`;
            const expiresAt = new Date(Date.now() + config.SECRET_ROTATION_GRACE_HOURS * 3600_000);

            org.previousWidgetSecret = org.widgetSecret;
            org.previousSecretExpiresAt = expiresAt;
            org.widgetSecret = generalFunctions.encrypt(next);
            org.secretRotatedAt = new Date();
            await org.save();

            await auditFunctions.record({
                orgId,
                action: AuditAction.SECRET_ROTATED,
                actorEmail,
                targetType: "ORG",
                targetId: orgId,
                detail: { graceUntil: expiresAt },
                ip,
            });

            // Returned once. There is no endpoint that reads it back.
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        widgetSecret: next,
                        previousSecretExpiresAt: expiresAt,
                    },
                    note: `Your previous secret keeps working until ${expiresAt.toISOString()}. Deploy the new one before then, or revoke the old one now if it leaked.`,
                },
            };
        } catch (error) {
            console.error("SecurityFunctions:rotateWidgetSecret: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async revokePreviousSecret({ orgId, actorEmail }) {
        console.log("SecurityFunctions:revokePreviousSecret: orgId:", orgId);
        try {
            const org = await Org.findOne({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            org.previousWidgetSecret = null;
            org.previousSecretExpiresAt = null;
            await org.save();

            await auditFunctions.record({
                orgId,
                action: AuditAction.SECRET_ROTATED,
                actorEmail,
                targetType: "ORG",
                targetId: orgId,
                detail: { revokedPrevious: true },
            });

            return { status: 200, json: { success: true, data: { revoked: true } } };
        } catch (error) {
            console.error("SecurityFunctions:revokePreviousSecret: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Verifies an identify() signature against the current secret and, within
    // the grace window, the previous one. The ONE place that decision is made.
    //
    // Both are checked in full even when the first matches — the comparison
    // itself is already timing-safe, and short-circuiting would leak which
    // secret was used through response time.
    verifyIdentitySignature({ org, email, signature }) {
        const current = generalFunctions.safeDecrypt(org.widgetSecret);
        let matched = false;
        let usedPrevious = false;

        if (current && generalFunctions.verifyIdentityHmac({ widgetSecret: current, email, signature })) {
            matched = true;
        }

        const graceActive = org.previousWidgetSecret && org.previousSecretExpiresAt && org.previousSecretExpiresAt > new Date();
        if (graceActive) {
            const previous = generalFunctions.safeDecrypt(org.previousWidgetSecret);
            if (previous && generalFunctions.verifyIdentityHmac({ widgetSecret: previous, email, signature })) {
                if (!matched) usedPrevious = true;
                matched = true;
            }
        }

        return { verified: matched, usedPrevious };
    }

    // §8.4 — is this Origin allowed to embed? Called on the widget path.
    //
    // Returns allowed:true when enforcement is off, so this can be wired in
    // everywhere without changing behaviour for any workspace that has not opted
    // in.
    isOriginAllowed({ org, origin }) {
        const widget = org.widget || {};
        if (!widget.enforceOriginAllowlist) return { allowed: true, enforced: false };

        const allowlist = widget.allowedOrigins || [];
        if (allowlist.length === 0) return { allowed: true, enforced: false };

        // No Origin header at all means a server-to-server call or a same-origin
        // navigation, not a browser embedding from another site. Refusing those
        // would break the demo pages and any legitimate curl.
        if (!origin) return { allowed: true, enforced: true, reason: "No Origin header" };

        const normalised = this.normaliseOrigin(origin);
        const allowed = allowlist.some((entry) => this._originMatches(normalised, entry));
        return {
            allowed,
            enforced: true,
            reason: allowed ? null : `${normalised} is not in this workspace's allowed origins`,
        };
    }

    // "https://acme.com/path?x=1" → "https://acme.com". Anything unparseable
    // returns null so the caller rejects it rather than storing a value that can
    // never match.
    normaliseOrigin(value) {
        try {
            const raw = String(value || "").trim();
            if (!raw) return null;
            // A wildcard subdomain is stored as written and expanded at match
            // time; URL() cannot parse it.
            if (raw.startsWith("https://*.") || raw.startsWith("http://*.")) return raw.toLowerCase();
            const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
            return `${url.protocol}//${url.host}`.toLowerCase();
        } catch (error) {
            return null;
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _originMatches(origin, pattern) {
        if (!origin || !pattern) return false;
        if (origin === pattern) return true;

        // "https://*.acme.com" matches any subdomain of acme.com, and does NOT
        // match acme.com itself — someone writing the wildcard form means the
        // subdomains, and matching the apex too would silently widen it.
        const wildcard = pattern.match(/^(https?:\/\/)\*\.(.+)$/);
        if (!wildcard) return false;
        const [, scheme, domain] = wildcard;
        return origin.startsWith(scheme) && origin.endsWith(`.${domain}`);
    }
}

module.exports = new SecurityFunctions();

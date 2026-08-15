// Pure unit tests for §8.4 — origin allowlist, widget secret rotation with a
// grace window, and the outbound webhook SSRF guard.
//
// Everything here is a security boundary or the thing that stops a security
// measure from causing an outage, so both directions matter: it must reject
// what it should, and it must NOT reject what it should not.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const securityFunctions = require("../functions/security/securityFunctions");
const outboundWebhookFunctions = require("../functions/webhook/outboundWebhookFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

const org = (widget) => ({ orgId: "org_test", widget: widget || {} });

describe("origin normalisation", () => {
    test("strips path, query and case", () => {
        assert.equal(securityFunctions.normaliseOrigin("https://Acme.com/docs?x=1"), "https://acme.com");
    });

    test("assumes https when no scheme is given", () => {
        assert.equal(securityFunctions.normaliseOrigin("acme.com"), "https://acme.com");
    });

    test("keeps the port, because a port is part of an origin", () => {
        assert.equal(securityFunctions.normaliseOrigin("http://localhost:5173"), "http://localhost:5173");
    });

    test("preserves a wildcard pattern rather than mangling it", () => {
        // URL() cannot parse "https://*.acme.com", so it is stored as written
        // and expanded at match time.
        assert.equal(securityFunctions.normaliseOrigin("https://*.acme.com"), "https://*.acme.com");
    });

    test("returns null for unparseable input so the caller rejects it", () => {
        assert.equal(securityFunctions.normaliseOrigin(""), null);
        assert.equal(securityFunctions.normaliseOrigin(null), null);
    });
});

describe("origin allowlist enforcement", () => {
    test("allows everything when enforcement is off", () => {
        // Off by default: turning it on for an existing workspace with an empty
        // list would take their widget down.
        const result = securityFunctions.isOriginAllowed({
            org: org({ enforceOriginAllowlist: false, allowedOrigins: ["https://acme.com"] }),
            origin: "https://evil.example",
        });
        assert.equal(result.allowed, true);
        assert.equal(result.enforced, false);
    });

    test("allows everything when the list is empty, even with enforcement on", () => {
        const result = securityFunctions.isOriginAllowed({
            org: org({ enforceOriginAllowlist: true, allowedOrigins: [] }),
            origin: "https://anything.example",
        });
        assert.equal(result.allowed, true);
    });

    test("refuses an origin that is not listed", () => {
        const result = securityFunctions.isOriginAllowed({
            org: org({ enforceOriginAllowlist: true, allowedOrigins: ["https://acme.com"] }),
            origin: "https://evil.example",
        });
        assert.equal(result.allowed, false);
        assert.match(result.reason, /not in this workspace/);
    });

    test("allows a listed origin", () => {
        const result = securityFunctions.isOriginAllowed({
            org: org({ enforceOriginAllowlist: true, allowedOrigins: ["https://acme.com"] }),
            origin: "https://acme.com",
        });
        assert.equal(result.allowed, true);
    });

    test("a wildcard matches subdomains but NOT the apex", () => {
        // Someone writing "https://*.acme.com" means the subdomains. Matching
        // the apex too would silently widen what they asked for.
        const workspace = org({ enforceOriginAllowlist: true, allowedOrigins: ["https://*.acme.com"] });
        assert.equal(securityFunctions.isOriginAllowed({ org: workspace, origin: "https://help.acme.com" }).allowed, true);
        assert.equal(securityFunctions.isOriginAllowed({ org: workspace, origin: "https://acme.com" }).allowed, false);
    });

    test("a wildcard does not match a lookalike domain", () => {
        // "https://evilacme.com" must not match "https://*.acme.com".
        const workspace = org({ enforceOriginAllowlist: true, allowedOrigins: ["https://*.acme.com"] });
        assert.equal(securityFunctions.isOriginAllowed({ org: workspace, origin: "https://evilacme.com" }).allowed, false);
    });

    test("a missing Origin header is allowed", () => {
        // No Origin means a server-to-server call, not a browser embedding from
        // another site. Refusing those would break every legitimate curl.
        const result = securityFunctions.isOriginAllowed({
            org: org({ enforceOriginAllowlist: true, allowedOrigins: ["https://acme.com"] }),
            origin: null,
        });
        assert.equal(result.allowed, true);
    });
});

describe("widget secret rotation grace window (§8.4)", () => {
    const email = "maya@brightloop.io";

    function makeOrg({ current, previous, previousExpiresAt }) {
        return {
            widgetSecret: generalFunctions.encrypt(current),
            previousWidgetSecret: previous ? generalFunctions.encrypt(previous) : null,
            previousSecretExpiresAt: previousExpiresAt || null,
        };
    }

    test("the current secret verifies", () => {
        const workspace = makeOrg({ current: "ws_new" });
        const signature = generalFunctions.createIdentityHmac({ widgetSecret: "ws_new", email });

        const result = securityFunctions.verifyIdentitySignature({ org: workspace, email, signature });
        assert.equal(result.verified, true);
        assert.equal(result.usedPrevious, false);
    });

    test("the previous secret verifies during the grace window", () => {
        // Without this, rotation is a hard cutover: every identify() call from
        // a not-yet-redeployed backend fails and every verified user silently
        // becomes anonymous, with no error anywhere saying why.
        const workspace = makeOrg({
            current: "ws_new",
            previous: "ws_old",
            previousExpiresAt: new Date(Date.now() + 3600_000),
        });
        const signature = generalFunctions.createIdentityHmac({ widgetSecret: "ws_old", email });

        const result = securityFunctions.verifyIdentitySignature({ org: workspace, email, signature });
        assert.equal(result.verified, true);
        assert.equal(result.usedPrevious, true);
    });

    test("the previous secret stops verifying once the window expires", () => {
        const workspace = makeOrg({
            current: "ws_new",
            previous: "ws_old",
            previousExpiresAt: new Date(Date.now() - 1000),
        });
        const signature = generalFunctions.createIdentityHmac({ widgetSecret: "ws_old", email });

        assert.equal(securityFunctions.verifyIdentitySignature({ org: workspace, email, signature }).verified, false);
    });

    test("a wrong signature never verifies against either secret", () => {
        const workspace = makeOrg({
            current: "ws_new",
            previous: "ws_old",
            previousExpiresAt: new Date(Date.now() + 3600_000),
        });
        const signature = generalFunctions.createIdentityHmac({ widgetSecret: "ws_attacker", email });

        assert.equal(securityFunctions.verifyIdentitySignature({ org: workspace, email, signature }).verified, false);
    });

    test("a signature for a different email does not verify", () => {
        // The signature binds the address; otherwise one leaked signature would
        // authenticate every user.
        const workspace = makeOrg({ current: "ws_new" });
        const signature = generalFunctions.createIdentityHmac({ widgetSecret: "ws_new", email: "someone@else.com" });

        assert.equal(securityFunctions.verifyIdentitySignature({ org: workspace, email, signature }).verified, false);
    });

    test("no signature at all does not verify", () => {
        const workspace = makeOrg({ current: "ws_new" });
        assert.equal(securityFunctions.verifyIdentitySignature({ org: workspace, email, signature: null }).verified, false);
    });
});

describe("outbound webhook URL validation (SSRF guard)", () => {
    const validate = (url) => outboundWebhookFunctions._validateUrl(url);

    test("accepts a public https URL", () => {
        assert.equal(validate("https://hooks.acme.com/zealoop").success, true);
    });

    test("refuses http", () => {
        assert.equal(validate("http://hooks.acme.com/zealoop").success, false);
    });

    test("refuses localhost and loopback", () => {
        // Without this a webhook is an SSRF primitive: the customer names a URL
        // and we fetch it from inside our own network.
        assert.equal(validate("https://localhost/x").success, false);
        assert.equal(validate("https://127.0.0.1/x").success, false);
        assert.equal(validate("https://[::1]/x").success, false);
    });

    test("refuses private ranges", () => {
        assert.equal(validate("https://10.0.0.5/x").success, false);
        assert.equal(validate("https://192.168.1.1/x").success, false);
        assert.equal(validate("https://172.16.0.1/x").success, false);
        assert.equal(validate("https://172.31.255.254/x").success, false);
    });

    test("172.32.x is public and is allowed", () => {
        // The private range is 172.16–172.31. A regex that matched all of 172.
        // would wrongly refuse a real customer host.
        assert.equal(validate("https://172.32.0.1/x").success, true);
    });

    test("refuses the cloud metadata endpoint specifically", () => {
        // 169.254.169.254 is where every cloud provider's instance credentials
        // live. This is the single most valuable SSRF target.
        assert.equal(validate("https://169.254.169.254/latest/meta-data/").success, false);
        assert.equal(validate("https://metadata.google.internal/x").success, false);
    });

    test("refuses .internal and .local hosts", () => {
        assert.equal(validate("https://payments.internal/x").success, false);
        assert.equal(validate("https://printer.local/x").success, false);
    });

    test("refuses a malformed URL", () => {
        assert.equal(validate("not a url").success, false);
        assert.equal(validate("").success, false);
    });
});

describe("outbound webhook signature", () => {
    test("signs over timestamp AND body, not body alone", () => {
        // Signing the body alone lets anyone who captures one delivery replay
        // it forever. With the timestamp inside the signed payload, a receiver
        // can reject anything old.
        const secret = "whsec_test";
        const body = JSON.stringify({ event: "conversation.created" });

        const atOne = outboundWebhookFunctions.computeSignature({ secret, timestamp: 1000, body });
        const atTwo = outboundWebhookFunctions.computeSignature({ secret, timestamp: 2000, body });
        assert.notEqual(atOne, atTwo);
    });

    test("a different secret produces a different signature", () => {
        const body = "{}";
        const a = outboundWebhookFunctions.computeSignature({ secret: "a", timestamp: 1, body });
        const b = outboundWebhookFunctions.computeSignature({ secret: "b", timestamp: 1, body });
        assert.notEqual(a, b);
    });

    test("the same inputs are reproducible, so a receiver can verify", () => {
        const args = { secret: "whsec_test", timestamp: 1755000000, body: '{"event":"x"}' };
        assert.equal(outboundWebhookFunctions.computeSignature(args), outboundWebhookFunctions.computeSignature(args));
    });
});

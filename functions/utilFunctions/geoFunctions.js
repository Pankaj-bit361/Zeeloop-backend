const { Currency } = require("../../config/enums");

/* Country detection for pricing.

   The country decides the price list, and the price list decides whether an
   Indian card can pay at all — Razorpay confirmed an Indian card will not clear
   a USD plan on this account. So a wrong answer here is not a cosmetic
   mis-pricing; it is a checkout that fails on the last screen.

   The answer comes from the edge, not from us. Every CDN this could sit behind
   stamps the viewer's country onto the request from its own IP database, which
   is more accurate and more current than anything shipped in this repo. We
   read the header; we never geolocate.

   What this is NOT: authorisation. It picks a DEFAULT, and the default is
   stored on the workspace and shown back to the person, who can change it
   until they subscribe. A spoofed header changes which price list someone
   sees — and an INR plan still needs an Indian payment instrument to pay for,
   so it buys nothing. */

// Checked in order; the first present wins. Names are lower-case because Node
// lower-cases every incoming header.
const COUNTRY_HEADERS = [
    // Explicit override — set by tests, and by a reverse proxy an operator
    // controls. Listed first so it beats whatever the CDN thinks.
    "x-zealoop-country",
    "cf-ipcountry", // Cloudflare
    "x-vercel-ip-country", // Vercel
    "cloudfront-viewer-country", // AWS CloudFront
    "x-country-code", // common reverse-proxy convention
];

// Cloudflare sends these for requests it could not place; they are not
// countries and must not be stored as one.
const NOT_A_COUNTRY = new Set(["XX", "T1", ""]);

class GeoFunctions {
    /** ISO-3166 alpha-2 country from the request's edge headers, or null. */
    countryFromRequest(req) {
        const headers = (req && req.headers) || {};
        for (const name of COUNTRY_HEADERS) {
            const raw = headers[name];
            if (!raw) continue;
            const code = String(Array.isArray(raw) ? raw[0] : raw).trim().toUpperCase();
            if (NOT_A_COUNTRY.has(code) || !/^[A-Z]{2}$/.test(code)) continue;
            return code;
        }
        return null;
    }

    /** The price list a country sees. India is the only rupee market; everyone
        else — including an unknown country — is USD, because a USD plan is
        the one that works for the most cards. */
    currencyForCountry(country) {
        return country === "IN" ? Currency.INR : Currency.USD;
    }
}

module.exports = new GeoFunctions();

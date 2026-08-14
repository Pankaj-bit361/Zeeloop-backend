const config = require("../../config/config");

// PII redaction (§8.1). Two separate questions, deliberately configured
// separately, because they have opposite failure modes:
//
//   Storage  — redacting too little leaks customer PII into TurnTrace, which is
//              retained for months and read by the eval tooling. Default ON.
//   Model    — redacting too much breaks answers. "My card ending 4242 was
//              declined" is fine to scrub; scrubbing the email out of "check
//              the order for maya@brightloop.io" removes the thing the question
//              was about. Cards and phones default ON, email defaults OFF.
//
// Emails are load-bearing in a support agent in a way card numbers never are,
// and identity here is proven by a signed identify() payload rather than by
// text in a message — so an email in message text is not what unlocks data
// anyway. Flip PII_REDACT_MODEL_EMAIL to true for a stricter posture.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Several narrow patterns rather than one greedy one. A single permissive
// "digits with separators" rule cannot tell 2026-08-15 from a phone number —
// and this system writes ISO dates into almost every trace.
//
// None of these match a bare 4-2-2 date shape: the national forms require
// 3-3-4 or 5-5 grouping, and the international form requires a leading +.
const PHONE_RES = [
    // +91 98765 43210, +1-555-867-5309, +442079460958
    /\+\d{1,3}[\s.-]?\d{2,5}[\s.-]?\d{3,6}(?:[\s.-]?\d{1,6})?/g,
    // (555) 867-5309
    /\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}/g,
    // 555-867-5309
    /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,
    // 98765 43210
    /\b\d{5}[\s.-]\d{5}\b/g,
];

// 13–19 digits with optional single separators. Anchored on a digit at both
// ends so a trailing space is not swallowed into the match. The regex alone
// matches plenty of non-cards, which is why every hit is Luhn-checked.
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

const EMAIL_TOKEN = "[email]";
const PHONE_TOKEN = "[phone]";
const CARD_TOKEN = "[card]";

// The check every card issuer's numbers satisfy. Without it an 8-digit order id
// followed by a 6-digit tracking code reads as a card and gets scrubbed out of
// the trace that was supposed to explain the conversation.
function passesLuhn(digits) {
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let value = digits.charCodeAt(i) - 48;
        if (value < 0 || value > 9) return false;
        if (double) {
            value *= 2;
            if (value > 9) value -= 9;
        }
        sum += value;
        double = !double;
    }
    return sum % 10 === 0;
}

class RedactionFunctions {
    // Order matters: cards first, because a card number with separators can
    // also satisfy the phone pattern, and losing a card to a [phone] token
    // would be the wrong redaction for audit purposes.
    redactText(text, { email = true, phone = true, card = true } = {}) {
        if (text === null || text === undefined) return text;
        if (typeof text !== "string") return text;

        let output = text;

        if (card) {
            output = output.replace(CARD_RE, (match) => {
                const digits = match.replace(/[ -]/g, "");
                return passesLuhn(digits) ? CARD_TOKEN : match;
            });
        }
        // Email before phone: an address can contain digit runs that the phone
        // patterns would otherwise claim.
        if (email) output = output.replace(EMAIL_RE, EMAIL_TOKEN);

        if (phone) {
            for (const pattern of PHONE_RES) {
                output = output.replace(pattern, (match) => {
                    const digits = match.replace(/\D/g, "");
                    // Below seven digits it is an order reference, not a number
                    // anyone could dial.
                    return digits.length >= 7 && digits.length <= 15 ? PHONE_TOKEN : match;
                });
            }
        }

        return output;
    }

    // Walks an object graph redacting every string. Used on TurnTrace before it
    // is written, since the PII can be anywhere — raw query, rewritten query,
    // retrieved chunk text, tool call arguments.
    redactDeep(value, options, depth = 0) {
        // Bounded so a cyclic or pathological structure cannot hang a turn.
        if (depth > 8) return value;
        if (value === null || value === undefined) return value;
        if (typeof value === "string") return this.redactText(value, options);
        if (Array.isArray(value)) return value.map((item) => this.redactDeep(item, options, depth + 1));
        if (value instanceof Date) return value;
        if (typeof value === "object") {
            const output = {};
            for (const [key, item] of Object.entries(value)) {
                output[key] = this.redactDeep(item, options, depth + 1);
            }
            return output;
        }
        return value;
    }

    // What gets written to TurnTrace. Retained for months and read by eval
    // tooling, so this is the strict one.
    redactForStorage(value) {
        if (!config.PII_REDACTION_ENABLED) return value;
        return this.redactDeep(value, { email: true, phone: true, card: true });
    }

    // What gets sent to a third-party model. Cards and phones always; email
    // only when explicitly configured, because it changes answers.
    redactForModel(text) {
        if (!config.PII_REDACTION_ENABLED) return text;
        return this.redactText(text, {
            email: config.PII_REDACT_MODEL_EMAIL,
            phone: true,
            card: true,
        });
    }

    // True when a string contains anything the storage policy would remove.
    // Used by tests and by the erasure endpoint to report what it found.
    containsPii(text) {
        if (typeof text !== "string") return false;
        return this.redactText(text) !== text;
    }
}

module.exports = new RedactionFunctions();

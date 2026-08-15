const { currentRequestId } = require("../../middlewares/requestContext");

// §8.3 — structured logging with turn-id correlation.
//
// The problem this solves is specific and was diagnosed rather than guessed at:
// the New Relic agent forwards logs from pino, winston and bunyan. It does NOT
// forward `console.log`. This codebase logs exclusively through `console.*`, so
// the Logs tab in New Relic is empty and always will be, no matter how much is
// logged.
//
// The fix is NOT to rewrite ~400 console.log call sites — that is a large
// diff whose only effect is on log transport, and every line of it is a chance
// to change a message someone greps for. Instead this module REPLACES the global
// console methods with wrappers that write structured JSON through pino,
// preserving the exact message text.
//
// Monkey-patching the global console is not a decision to take lightly, so the
// reasoning, plainly:
//
//   - Every existing log line keeps working and keeps saying the same thing. The
//     project convention "every method logs entry and catch" is untouched.
//   - The request id gets attached automatically from AsyncLocalStorage, which
//     is the correlation §8.3 asks for. Doing that at 400 call sites by hand is
//     not going to stay correct.
//   - It is opt-in: without pino installed, or with LOG_FORMAT=pretty, console
//     is left completely alone and behaves exactly as it does today.
//
// The alternative — a `logger.info()` used by new code while old code keeps
// using console — gives two log streams, one of which is invisible in
// production, which is worse than either choice made consistently.

const LEVELS = { log: "info", info: "info", warn: "warn", error: "error", debug: "debug" };

let pino = null;
let baseLogger = null;
let installed = false;

function _load() {
    if (pino !== null) return pino;
    try {
        pino = require("pino");
    } catch (error) {
        // Not installed. Everything below no-ops and console stays as it is —
        // same rule as Sentry and New Relic: the backend must run without it.
        pino = false;
    }
    return pino;
}

// console.log("a:", 1, {b: 2}) has to become one message plus structured fields.
// Objects go into the record so they stay queryable; primitives are joined into
// the message so the line still reads the way it was written.
function _split(args) {
    const parts = [];
    const fields = {};
    let index = 0;

    for (const argument of args) {
        if (argument instanceof Error) {
            fields.err = { message: argument.message, stack: argument.stack, name: argument.name };
            parts.push(argument.message);
            continue;
        }
        if (argument !== null && typeof argument === "object") {
            fields[`arg${index++}`] = argument;
            continue;
        }
        parts.push(String(argument));
    }

    return { message: parts.join(" "), fields };
}

class Logger {
    // ── Public Functions ─────────────────────────────────────────────

    // Called once from server.js, before anything logs. Returns
    // { success, installed, reason } rather than throwing — a logging setup that
    // can take the process down is worse than no logging.
    install({ format, level } = {}) {
        if (installed) return { success: true, installed: true, reason: "ALREADY_INSTALLED" };

        // Local development wants readable lines, not JSON. Default to leaving
        // console alone unless something asks for structured output.
        if (format === "pretty") {
            console.log("Logger: pretty format, console left untouched");
            return { success: true, installed: false, reason: "PRETTY" };
        }

        if (!_load()) {
            console.log("Logger: pino not installed, continuing with plain console");
            return { success: true, installed: false, reason: "NO_PINO" };
        }

        baseLogger = pino({
            level: level || "info",
            // New Relic's log forwarder reads these names. Renaming them means
            // the Logs tab shows records with no level and no timestamp.
            messageKey: "message",
            timestamp: pino.stdTimeFunctions.isoTime,
            base: { service: process.env.NEW_RELIC_APP_NAME || "zealoop-backend" },
        });

        const original = {
            log: console.log.bind(console),
            info: console.info.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
            debug: console.debug.bind(console),
        };

        for (const [method, level_] of Object.entries(LEVELS)) {
            console[method] = (...args) => {
                try {
                    const { message, fields } = _split(args);
                    const requestId = currentRequestId();
                    baseLogger[level_]({ ...fields, ...(requestId ? { requestId } : {}) }, message);
                } catch (error) {
                    // If structured logging itself fails, fall back to the real
                    // console. Losing a log line is acceptable; losing the
                    // process because logging threw is not.
                    original[method](...args);
                }
            };
        }

        installed = true;
        // Through the new console, so the first structured line proves it works.
        console.log("Logger: structured logging installed, requestId correlation active");
        return { success: true, installed: true, reason: null };
    }

    // Explicit structured logging for new code that wants fields rather than a
    // formatted string. Falls through to console when pino is absent, so a
    // caller never has to check.
    emit({ level, message, fields }) {
        const requestId = currentRequestId();
        if (baseLogger) {
            baseLogger[LEVELS[level] || "info"]({ ...(fields || {}), ...(requestId ? { requestId } : {}) }, message);
            return { success: true };
        }
        const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
        (level === "error" ? console.error : console.log)(line);
        return { success: true };
    }

    // §8.3 — turn correlation. A trace id ties every stage of one pipeline run
    // together, which is what makes "why did this answer happen" answerable from
    // logs alone rather than only from the TurnTrace document.
    turn({ traceId, conversationId, stage, message, fields }) {
        return this.emit({
            level: "info",
            message: `[turn ${stage}] ${message}`,
            fields: { traceId, conversationId, stage, ...(fields || {}) },
        });
    }

    isInstalled() {
        return installed;
    }
}

module.exports = new Logger();
module.exports.LEVELS = LEVELS;

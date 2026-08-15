const { ResponseComponentType, ToolCallStatus } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §4.6 — the rich response contract.
//
// The agent can only send text today. Defining this now rather than later is the
// whole point: once embeds are deployed against a plain-string message format,
// every future component type has to coexist with clients that cannot render it,
// forever. Shipping the envelope early means old widgets already know to skip
// what they do not understand.
//
// Two rules the widget implements and this file guarantees:
//
//   1. Every component carries `fallbackText`. A client that cannot render a
//      `card` renders its fallback, so a message is never blank.
//   2. Unknown `type` values are skipped, not errored. Adding a component type
//      must never break an embed that has been sitting on a customer's site
//      since last year.
//
// `confirm` is the one that is needed immediately: write-action confirmation
// currently has no first-class UI, which is a correctness gap rather than
// polish — the most important guard in the system is expressed as a sentence
// the customer has to answer in prose.

class ResponseComponentFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    text({ content }) {
        return { type: ResponseComponentType.TEXT, text: content, fallbackText: content };
    }

    // The write-action confirmation. The actionId and args are echoed back by
    // the widget on confirm, and re-validated server-side — a component the
    // client can edit is not a security boundary, and the guard that matters
    // lives in agentFunctions._checkGuards either way.
    confirm({ actionName, actionId, args, prompt }) {
        const question = prompt || `Shall I run “${actionName}” for you?`;
        return {
            type: ResponseComponentType.CONFIRM,
            text: question,
            actionId,
            actionName,
            // Shown so the customer confirms what will happen rather than
            // confirming a button. "Cancel subscription" and "cancel
            // subscription for account 4471" are different questions.
            args: args || {},
            confirmLabel: "Yes, do it",
            cancelLabel: "No, cancel",
            fallbackText: `${question} Reply "yes" to confirm.`,
        };
    }

    // Clarifying questions. Bounded at six: a list longer than that is a form,
    // and a form is a different component.
    choices({ prompt, options }) {
        const clean = (options || [])
            .filter((option) => option && (option.label || typeof option === "string"))
            .slice(0, 6)
            .map((option) =>
                typeof option === "string"
                    ? { label: option, value: option }
                    : { label: option.label, value: option.value ?? option.label }
            );

        return {
            type: ResponseComponentType.CHOICES,
            text: prompt,
            options: clean,
            fallbackText: `${prompt}\n${clean.map((option, index) => `${index + 1}. ${option.label}`).join("\n")}`,
        };
    }

    // Table row results. An order status reads far better as a card than as a
    // sentence, and the fallback is that sentence.
    card({ title, subtitle, fields, imageUrl, action }) {
        const rows = (fields || []).filter((field) => field && field.label);
        return {
            type: ResponseComponentType.CARD,
            title,
            subtitle: subtitle || null,
            fields: rows,
            imageUrl: imageUrl || null,
            action: action || null,
            fallbackText: [title, subtitle, ...rows.map((field) => `${field.label}: ${field.value}`)]
                .filter(Boolean)
                .join("\n"),
        };
    }

    link({ label, url, description }) {
        return {
            type: ResponseComponentType.LINK,
            label,
            url,
            description: description || null,
            fallbackText: `${label}: ${url}`,
        };
    }

    form({ prompt, fields, submitLabel }) {
        const clean = (fields || [])
            .filter((field) => field && field.name)
            .slice(0, 8)
            .map((field) => ({
                name: field.name,
                label: field.label || field.name,
                type: field.type || "text",
                required: field.required !== false,
                placeholder: field.placeholder || "",
            }));

        return {
            type: ResponseComponentType.FORM,
            text: prompt,
            fields: clean,
            submitLabel: submitLabel || "Send",
            fallbackText: `${prompt}\nPlease reply with: ${clean.map((field) => field.label).join(", ")}`,
        };
    }

    // Turns a finished pipeline turn into the component list the widget renders.
    // Called by the chat path, so the model never has to emit component JSON
    // itself — a model that can emit arbitrary UI is a model that can emit
    // arbitrary UI, and the confirm component in particular must be produced by
    // code that knows a real guard fired.
    fromTurn({ turn, tableContext }) {
        console.log("ResponseComponentFunctions:fromTurn: outcome:", turn.outcome);
        try {
            const components = [];

            if (turn.reply) components.push(this.text({ content: turn.reply }));

            // The halt path. This is the case §4.6 calls out as coupled to
            // Phase 0: a proposed write action that the customer must confirm.
            const pending = (turn.toolCalls || []).find(
                (call) => call.status === ToolCallStatus.AWAITING_CONFIRMATION
            );
            if (turn.halted && pending) {
                components.push(
                    this.confirm({
                        actionName: pending.actionName,
                        actionId: pending.actionId,
                        args: pending.args,
                    })
                );
            }

            // Table rows as cards. Only the rows this turn actually used —
            // rendering every row the customer is entitled to would dump their
            // whole order history into a chat bubble.
            for (const row of (tableContext && tableContext.rows) || []) {
                const data = row.data || {};
                const entries = Object.entries(data).slice(0, 6);
                if (entries.length === 0) continue;
                components.push(
                    this.card({
                        title: String(data.title || data.name || data.id || "Record"),
                        fields: entries.map(([label, value]) => ({ label, value: String(value) })),
                    })
                );
            }

            return { success: true, components };
        } catch (error) {
            console.error("ResponseComponentFunctions:fromTurn: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Degrade to plain text rather than sending nothing. The reply is
            // the part that matters; the components are an enhancement.
            return { success: false, components: turn.reply ? [this.text({ content: turn.reply })] : [] };
        }
    }

    // Defensive read for anything arriving from a client or from storage.
    // Unknown types are dropped here so the widget never has to.
    sanitise({ components }) {
        if (!Array.isArray(components)) return [];
        const known = new Set(Object.values(ResponseComponentType));
        return components.filter((component) => component && known.has(component.type));
    }
}

module.exports = new ResponseComponentFunctions();

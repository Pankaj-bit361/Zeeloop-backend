const config = require("../../config/config");
const { ProcedureStepType, ProcedureTriggerType, IdPrefix } = require("../../config/enums");
const Procedure = require("../../models/procedure/procedure");
const Action = require("../../models/action/action");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const conditionFunctions = require("../config/conditionFunctions");

// §5.4 — procedures v2.
//
// v1 was keyword triggers and a flat array of strings. Three things are added,
// and one thing is deliberately NOT:
//
//   added: event and intent triggers, IF/ELSE branching, inline @action refs,
//          and AI drafting from a prose description
//   not added: nested branching. A branch inside a branch is a visual workflow
//          builder, which is an explicit non-goal — and every support process
//          that genuinely needs one is better served by an action calling the
//          customer's own system.
//
// Legacy documents keep working. A step stored as a plain string is read as an
// INSTRUCTION step, which is exactly what it always was, so nothing needs
// migrating and no deploy window matters.

const MAX_STEPS = 30;

class ProcedureFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async listProcedures({ orgId }) {
        console.log("ProcedureFunctions:listProcedures: orgId:", orgId);
        try {
            const procedures = await Procedure.find({ orgId }).sort({ createdAt: 1 }).lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: procedures.map((procedure) => ({
                        ...this._strip(procedure),
                        steps: this.normaliseSteps(procedure.steps),
                    })),
                    triggerTypes: Object.values(ProcedureTriggerType),
                    stepTypes: Object.values(ProcedureStepType),
                },
            };
        } catch (error) {
            console.error("ProcedureFunctions:listProcedures: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createProcedure({ orgId, name, description, triggerType, keywords, intentDescription, eventName, steps }) {
        console.log("ProcedureFunctions:createProcedure: orgId:", orgId);
        try {
            const validation = await this._validate({ orgId, name, triggerType, keywords, intentDescription, eventName, steps });
            if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };

            const procedure = await Procedure.create({
                orgId,
                procedureId: generalFunctions.generateId(IdPrefix.PROCEDURE),
                name: String(name).trim(),
                description: description || "",
                triggerType: triggerType || ProcedureTriggerType.KEYWORD,
                keywords: keywords || [],
                intentDescription: intentDescription || "",
                eventName: eventName || null,
                steps: this.normaliseSteps(steps),
                enabled: true,
            });

            return { status: 201, json: { success: true, data: procedure.toJSON() } };
        } catch (error) {
            console.error("ProcedureFunctions:createProcedure: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async updateProcedure({ orgId, procedureId, ...fields }) {
        console.log("ProcedureFunctions:updateProcedure: procedureId:", procedureId);
        try {
            const procedure = await Procedure.findOne({ orgId, procedureId });
            if (!procedure) return { status: 404, json: { success: false, error: "Procedure not found" } };

            const merged = {
                name: fields.name !== undefined ? fields.name : procedure.name,
                triggerType: fields.triggerType !== undefined ? fields.triggerType : procedure.triggerType,
                keywords: fields.keywords !== undefined ? fields.keywords : procedure.keywords,
                intentDescription: fields.intentDescription !== undefined ? fields.intentDescription : procedure.intentDescription,
                eventName: fields.eventName !== undefined ? fields.eventName : procedure.eventName,
                steps: fields.steps !== undefined ? fields.steps : procedure.steps,
            };
            const validation = await this._validate({ orgId, ...merged });
            if (!validation.success) return { status: 400, json: { success: false, error: validation.error } };

            for (const field of ["name", "description", "triggerType", "keywords", "intentDescription", "eventName", "enabled"]) {
                if (fields[field] !== undefined) procedure[field] = fields[field];
            }
            if (fields.steps !== undefined) procedure.steps = this.normaliseSteps(fields.steps);
            await procedure.save();

            return { status: 200, json: { success: true, data: procedure.toJSON() } };
        } catch (error) {
            console.error("ProcedureFunctions:updateProcedure: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteProcedure({ orgId, procedureId }) {
        console.log("ProcedureFunctions:deleteProcedure: procedureId:", procedureId);
        try {
            const result = await Procedure.deleteOne({ orgId, procedureId });
            if (result.deletedCount === 0) return { status: 404, json: { success: false, error: "Procedure not found" } };
            return { status: 200, json: { success: true, data: { deleted: procedureId } } };
        } catch (error) {
            console.error("ProcedureFunctions:deleteProcedure: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §5.4 — AI draft. Prose describing a process becomes ordered steps with
    // the right actions referenced. Returns a proposal; the author edits and
    // saves, same contract as the setup wizard.
    async draftFromProse({ orgId, prose }) {
        console.log("ProcedureFunctions:draftFromProse: orgId:", orgId);
        try {
            if (!prose || !String(prose).trim()) {
                return { status: 400, json: { success: false, error: "Describe the process you want to turn into a procedure" } };
            }

            const actions = await Action.find({ orgId, enabled: true })
                .select("actionId name description accessType")
                .lean();

            const result = await llmFunctions.completeJson({
                model: config.LARGE_MODEL,
                system: `You turn a support manager's description of a process into an ordered procedure for an AI support agent.

Step types:
- INSTRUCTION: a plain instruction the agent must follow.
- TOOL: call a specific action. Use only the actionIds listed below; never invent one.
- BRANCH: an IF on a condition, with thenSteps and elseSteps as arrays of plain instruction strings.

Rules:
- Keep it to the steps actually described. Do not add a "greet the customer" step nobody asked for.
- Prefer INSTRUCTION unless the description clearly calls for looking something up or making a change.
- Never nest a BRANCH inside a BRANCH.`,
                schemaHint: `{"name": string, "description": string, "keywords": string[], "intentDescription": string, "steps": [{"type": string, "text": string, "actionId": string, "conditions": [], "thenSteps": string[], "elseSteps": string[]}]}`,
                messages: [
                    {
                        role: "user",
                        content: `AVAILABLE ACTIONS:\n${
                            actions.length > 0
                                ? actions.map((action) => `- ${action.actionId}: ${action.name} (${action.accessType}) — ${action.description}`).join("\n")
                                : "none"
                        }\n\nPROCESS:\n${String(prose).slice(0, 4000)}`,
                    },
                ],
                maxTokens: 2048,
            });

            const validActionIds = new Set(actions.map((action) => action.actionId));
            const steps = this.normaliseSteps(result.json.steps).map((step) => {
                // A TOOL step naming an action that does not exist becomes an
                // instruction. Storing the invented id would produce a
                // procedure that silently does nothing at that step.
                if (step.type === ProcedureStepType.TOOL && !validActionIds.has(step.actionId)) {
                    return {
                        ...step,
                        type: ProcedureStepType.INSTRUCTION,
                        actionId: null,
                        text: step.text || "TODO: this step needs an action that does not exist yet.",
                    };
                }
                return step;
            });

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        name: result.json.name || "Untitled procedure",
                        description: result.json.description || "",
                        keywords: (result.json.keywords || []).slice(0, 10),
                        intentDescription: result.json.intentDescription || "",
                        steps,
                    },
                    note: "A draft. Nothing is saved until you save it.",
                },
            };
        } catch (error) {
            console.error("ProcedureFunctions:draftFromProse: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Could not draft that procedure — try again" } };
        }
    }

    // §5.4 — event trigger. Fired by the customer's site or from the inbox.
    // Returns the procedure so the caller can inject it into the next turn.
    async triggerByEvent({ orgId, eventName }) {
        console.log("ProcedureFunctions:triggerByEvent: eventName:", eventName);
        try {
            const procedure = await Procedure.findOne({
                orgId,
                enabled: true,
                triggerType: ProcedureTriggerType.EVENT,
                eventName,
            }).lean();
            if (!procedure) return { status: 404, json: { success: false, error: "No enabled procedure for that event" } };
            return { status: 200, json: { success: true, data: { ...this._strip(procedure), steps: this.normaliseSteps(procedure.steps) } } };
        } catch (error) {
            console.error("ProcedureFunctions:triggerByEvent: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Called by the pipeline. Keyword matching first because it is free and
    // exact; the intent classifier only runs when nothing matched and there is
    // actually an intent-triggered procedure to consider — otherwise every turn
    // would pay for a classification that could not change the outcome.
    async selectForTurn({ orgId, query, gateIntent }) {
        console.log("ProcedureFunctions:selectForTurn: orgId:", orgId);
        try {
            const procedures = await Procedure.find({ orgId, enabled: true }).lean();
            if (procedures.length === 0) return { success: true, procedure: null };

            const lower = String(query || "").toLowerCase();
            const byKeyword = procedures.find(
                (procedure) =>
                    procedure.triggerType === ProcedureTriggerType.KEYWORD &&
                    (procedure.keywords || []).some((keyword) => lower.includes(String(keyword).toLowerCase()))
            );
            if (byKeyword) return { success: true, procedure: byKeyword, matchedBy: "keyword" };

            const intentDriven = procedures.filter(
                (procedure) => procedure.triggerType === ProcedureTriggerType.INTENT && procedure.intentDescription
            );
            if (intentDriven.length === 0) return { success: true, procedure: null };

            const classified = await this._classifyIntent({ query, procedures: intentDriven });
            return { success: true, procedure: classified, matchedBy: classified ? "intent" : null };
        } catch (error) {
            console.error("ProcedureFunctions:selectForTurn: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Fail to no procedure. An agent answering without an SOP is worse
            // than one following it; an agent that errors is worse than both.
            return { success: false, procedure: null };
        }
    }

    // Renders a procedure into the prompt, resolving branches against the turn's
    // context so the model sees ONLY the applicable path.
    //
    // Resolving here rather than handing the model an IF/ELSE is the point: a
    // model shown both branches picks whichever it prefers, which makes the
    // condition decorative. Evaluated in code, the branch is a guarantee.
    renderForPrompt({ procedure, context, actionsById }) {
        const steps = this.normaliseSteps(procedure.steps);
        const lines = [];
        let number = 1;

        for (const step of steps) {
            if (step.type === ProcedureStepType.BRANCH) {
                const matched = conditionFunctions.evaluate({ conditions: step.conditions, context }).matched;
                const branch = matched ? step.thenSteps : step.elseSteps;
                for (const text of branch || []) {
                    lines.push(`${number++}. ${text}`);
                }
                continue;
            }

            if (step.type === ProcedureStepType.TOOL) {
                const action = actionsById && actionsById.get(step.actionId);
                if (!action) {
                    // The action was deleted or is untested. Named rather than
                    // silently dropped, so the model does not skip a step the
                    // author considered mandatory without anyone knowing.
                    lines.push(`${number++}. ${step.text || "Tell the customer you cannot complete this step right now and offer a human."}`);
                    continue;
                }
                lines.push(
                    `${number++}. ${step.text || `Call the action "${action.name}"`} — use {"type":"tool_call","actionId":"${action.actionId}",...}${
                        step.continueOnFailure ? "" : ". If it fails, stop and hand off to a human rather than continuing."
                    }`
                );
                continue;
            }

            lines.push(`${number++}. ${step.text}`);
        }

        return lines.join("\n");
    }

    // Legacy strings in, structured steps out. The single reason v1 documents
    // keep working with no migration.
    normaliseSteps(steps) {
        if (!Array.isArray(steps)) return [];
        return steps
            .slice(0, MAX_STEPS)
            .map((step) => {
                if (typeof step === "string") {
                    return { type: ProcedureStepType.INSTRUCTION, text: step, actionId: null, conditions: [], thenSteps: [], elseSteps: [] };
                }
                if (!step || typeof step !== "object") return null;

                const type = Object.values(ProcedureStepType).includes(step.type) ? step.type : ProcedureStepType.INSTRUCTION;
                return {
                    type,
                    text: step.text || "",
                    actionId: step.actionId || null,
                    continueOnFailure: !!step.continueOnFailure,
                    conditions: Array.isArray(step.conditions) ? step.conditions : [],
                    // Flattened to strings: a branch holding full step objects
                    // is the nesting this design refuses.
                    thenSteps: (step.thenSteps || []).map((entry) => (typeof entry === "string" ? entry : entry.text || "")).filter(Boolean),
                    elseSteps: (step.elseSteps || []).map((entry) => (typeof entry === "string" ? entry : entry.text || "")).filter(Boolean),
                };
            })
            .filter(Boolean)
            .filter((step) => step.text || step.actionId || step.thenSteps.length > 0);
    }

    // §5.4 — inline @action references inside step text. Resolved to real ids at
    // save time, so a renamed action does not break the reference and an
    // author can type what they mean.
    async resolveMentions({ orgId, text }) {
        const mentions = [...String(text || "").matchAll(/@([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
        if (mentions.length === 0) return { text, actionIds: [] };

        const actions = await Action.find({ orgId }).select("actionId name").lean();
        const byName = new Map(actions.map((action) => [action.name.toLowerCase().replace(/\s+/g, "-"), action]));

        const resolved = [];
        let output = String(text);
        for (const mention of mentions) {
            const action = byName.get(mention.toLowerCase()) || actions.find((entry) => entry.actionId === mention);
            if (!action) continue;
            resolved.push(action.actionId);
            output = output.replace(new RegExp(`@${mention}\\b`, "g"), `"${action.name}" (${action.actionId})`);
        }

        return { text: output, actionIds: [...new Set(resolved)] };
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _validate({ orgId, name, triggerType, keywords, intentDescription, eventName, steps }) {
        if (!name || !String(name).trim()) return { success: false, error: "name is required" };

        const type = triggerType || ProcedureTriggerType.KEYWORD;
        if (!Object.values(ProcedureTriggerType).includes(type)) {
            return { success: false, error: `triggerType must be one of: ${Object.values(ProcedureTriggerType).join(", ")}` };
        }
        if (type === ProcedureTriggerType.KEYWORD && (!keywords || keywords.length === 0)) {
            return { success: false, error: "A keyword-triggered procedure needs at least one keyword" };
        }
        if (type === ProcedureTriggerType.INTENT && (!intentDescription || !String(intentDescription).trim())) {
            return { success: false, error: "An intent-triggered procedure needs a description of when it applies" };
        }
        if (type === ProcedureTriggerType.EVENT && !eventName) {
            return { success: false, error: "An event-triggered procedure needs an event name" };
        }

        const normalised = this.normaliseSteps(steps);
        if (normalised.length === 0) return { success: false, error: "A procedure needs at least one step" };

        // A TOOL step pointing at an action that does not exist would be a step
        // the agent silently skips.
        const toolIds = normalised
            .filter((step) => step.type === ProcedureStepType.TOOL && step.actionId)
            .map((step) => step.actionId);
        if (toolIds.length > 0) {
            const found = await Action.find({ orgId, actionId: { $in: toolIds } }).select("actionId").lean();
            const known = new Set(found.map((action) => action.actionId));
            const missing = toolIds.filter((actionId) => !known.has(actionId));
            if (missing.length > 0) {
                return { success: false, error: `These steps reference actions that do not exist: ${missing.join(", ")}` };
            }
        }

        for (const step of normalised) {
            if (step.type !== ProcedureStepType.BRANCH) continue;
            const conditions = conditionFunctions.validate({ conditions: step.conditions });
            if (!conditions.success) return conditions;
            if (step.thenSteps.length === 0 && step.elseSteps.length === 0) {
                return { success: false, error: "A branch step needs at least one instruction on one side" };
            }
        }

        return { success: true };
    }

    async _classifyIntent({ query, procedures }) {
        try {
            const result = await llmFunctions.completeJson({
                model: config.SMALL_MODEL,
                system:
                    "Decide which support procedure applies to a customer's message, if any. Choose only when it clearly applies — returning none is the right answer most of the time.",
                schemaHint: `{"procedureId": string|null}`,
                messages: [
                    {
                        role: "user",
                        content: `PROCEDURES:\n${procedures
                            .map((procedure) => `- ${procedure.procedureId}: ${procedure.name} — applies when: ${procedure.intentDescription}`)
                            .join("\n")}\n\nCUSTOMER MESSAGE: ${query}`,
                    },
                ],
                maxTokens: 128,
            });

            const chosen = result.json.procedureId;
            return procedures.find((procedure) => procedure.procedureId === chosen) || null;
        } catch (error) {
            console.log("ProcedureFunctions:_classifyIntent: failed, no procedure selected");
            console.error(error);
            return null;
        }
    }

    _strip(document) {
        const copy = { ...document };
        delete copy._id;
        delete copy.__v;
        return copy;
    }
}

module.exports = new ProcedureFunctions();
module.exports.MAX_STEPS = MAX_STEPS;

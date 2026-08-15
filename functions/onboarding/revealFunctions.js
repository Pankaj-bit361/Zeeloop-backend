const Org = require("../../models/org/org");
const Member = require("../../models/org/member");
const Conversation = require("../../models/conversation/conversation");
const Table = require("../../models/table/table");
const { ApiKey } = require("../../models/org/expansion");
const { NavSection, MemberStatus, ConversationStatus } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

/* §1.9 — progressive reveal, and the approval model that rides on the same
   signal.

   The product exists because Fin is too much on day one. Shipping every one of
   its capabilities behind twelve sidebar entries and seventeen tabs reproduces
   the exact problem, so sections stay out of the way until the workspace has a
   reason to care about them.

   Three rules this file exists to enforce:

     Reveal is a RATCHET. Once earned, always shown. Thresholds are read from
     live counts, but the result is unioned with what was already revealed and
     persisted, because a section that vanishes when a billing period resets is
     worse than one that never appeared.

     There is always an escape hatch. `reveal.showAll` unhides everything
     permanently, in one switch. Nobody gets trapped in a simplified view.

     Nothing here gates ACCESS. A hidden section is hidden from the sidebar and
     nothing else — the routes still answer, the API still works, a bookmarked
     URL still loads. This is presentation, not permission, and confusing the
     two would turn a UX affordance into a security control that was never
     designed to be one. */

// Always in the sidebar. This is the job on day one: see what happened, read
// the conversations, feed it documents, put it on the site.
const ALWAYS_VISIBLE = ["DASHBOARD", "INBOX", "KNOWLEDGE", "WIDGET"];

/* Each rule answers "has this workspace hit the moment where this section
   starts being useful?" — not "is it allowed to have it". The numbers are
   deliberately low: the aim is to avoid a bewildering first session, not to
   withhold the product. */
const RULES = {
    // Editing how it answers is meaningless before you have watched it answer.
    [NavSection.AGENT]: ({ conversations }) => conversations >= 10,

    // Charts of nothing are worse than no charts.
    [NavSection.ANALYTICS]: ({ conversations }) => conversations >= 10,

    // Evaluation needs traffic to evaluate. Five tabs of simulations and
    // monitors on a workspace with nine conversations is intimidating and
    // useless in the same breath.
    [NavSection.EVALUATION]: ({ conversations }) => conversations >= 100,

    // Tables appear once the agent starts handing conversations to a human.
    // An escalation is the closest honest signal that it lacked something —
    // often the customer's own data. Falls back to volume for workspaces whose
    // agent copes fine, and short-circuits if they already built a table.
    [NavSection.TABLES]: ({ escalations, conversations, tables }) =>
        tables > 0 || escalations >= 3 || conversations >= 50,

    // Actions are what you do with a table once you have one, so they follow it.
    [NavSection.APIS]: ({ tables, escalations, conversations }) =>
        tables > 0 || escalations >= 3 || conversations >= 50,

    // Both of these are about other people. Alone they are noise: an audit log
    // of your own actions, and a list containing you.
    [NavSection.SECURITY]: ({ members, apiKeys }) => members > 1 || apiKeys > 0,
    [NavSection.USERS]: ({ members, conversations }) => members > 1 || conversations >= 25,
};

class RevealFunctions {
    /** Counts the reveal rules read. One place, so a rule cannot quietly start
        depending on something nobody counted. */
    async _signals({ orgId }) {
        const [conversations, escalations, members, tables, apiKeys] = await Promise.all([
            Conversation.countDocuments({ orgId }),
            Conversation.countDocuments({ orgId, status: ConversationStatus.ESCALATED }),
            Member.countDocuments({ orgId, status: MemberStatus.ACTIVE }),
            Table.countDocuments({ orgId }),
            ApiKey.countDocuments({ orgId }),
        ]);
        return { conversations, escalations, members, tables, apiKeys };
    }

    /* Returns the sections this workspace should see, and persists any newly
       earned ones. Safe to call on every dashboard load: it writes only when
       the set actually grows. */
    async getSections({ orgId }) {
        console.log("RevealFunctions:getSections: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }

            const org = await Org.findOne({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            const everything = Object.values(NavSection);

            const signals = await this._signals({ orgId });
            // Same signal as the Security section, deliberately — see
            // requiresApproval below. Returned here so the dashboard learns it
            // from the call it already makes on every load.
            const requiresApproval = signals.members > 1;

            if (org.reveal?.showAll) {
                return {
                    status: 200,
                    json: {
                        success: true,
                        data: {
                            sections: [...ALWAYS_VISIBLE, ...everything],
                            showAll: true,
                            hidden: [],
                            justRevealed: [],
                            requiresApproval,
                        },
                    },
                };
            }

            const already = org.reveal?.sections || [];

            const earned = everything.filter((section) => {
                const rule = RULES[section];
                // A section with no rule is one someone added to the enum and
                // forgot here. Showing it is the safe failure: the worst case
                // is a visible section, not a missing one.
                if (!rule) return true;
                return rule(signals);
            });

            const next = [...new Set([...already, ...earned])];

            /* Sections crossing the line on THIS call. The dashboard announces
               these, so it matters that the list is computed before the write
               and returned exactly once: the write is what makes the next call
               return an empty `justRevealed`, which is what stops the same
               celebration firing on every page load forever.

               A workspace's very first call is excluded. Someone who signs up,
               imports a busy help centre and lands on the dashboard has not
               "unlocked" four things — they simply have a workspace, and
               congratulating them for it is noise. */
            const firstEver = !org.reveal?.firstLoadAt;
            const justRevealed = firstEver ? [] : next.filter((section) => !already.includes(section));

            // Write only on growth. A findOneAndUpdate on every dashboard load
            // is a write per page view for a value that changes a handful of
            // times in a workspace's life.
            const changes = {};
            if (next.length !== already.length) changes["reveal.sections"] = next;
            // Stamped even when nothing was earned, so the NEXT call is not
            // still treated as the first one.
            if (firstEver) changes["reveal.firstLoadAt"] = new Date();

            if (Object.keys(changes).length > 0) {
                await Org.updateOne({ orgId }, { $set: changes });
                if (justRevealed.length) {
                    console.log("RevealFunctions:getSections: revealed", justRevealed.join(","));
                }
            }

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        sections: [...ALWAYS_VISIBLE, ...next],
                        showAll: false,
                        hidden: everything.filter((section) => !next.includes(section)),
                        justRevealed,
                        requiresApproval,
                    },
                },
            };
        } catch (error) {
            console.error("RevealFunctions:getSections: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    /** The escape hatch. One way only — having seen everything, you cannot be
        put back in the simplified view, because that would read as the product
        taking features away. */
    async showEverything({ orgId }) {
        console.log("RevealFunctions:showEverything: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }

            const approval = await this.requiresApproval({ orgId });
            const updated = await Org.findOneAndUpdate(
                { orgId },
                { $set: { "reveal.showAll": true, "reveal.sections": Object.values(NavSection) } },
                { new: true }
            );
            if (!updated) return { status: 404, json: { success: false, error: "Org not found" } };

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        sections: [...ALWAYS_VISIBLE, ...Object.values(NavSection)],
                        showAll: true,
                        hidden: [],
                        justRevealed: [],
                        requiresApproval: approval.required,
                    },
                },
            };
        } catch (error) {
            console.error("RevealFunctions:showEverything: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    /* Move #2 — whether this workspace should use the draft/publish model at
       all.

       Draft → publish → enable → version → restore is five concepts. For one
       person with three rules they are five concepts that do nothing: there is
       nobody to review the draft, and the only effect is that a rule you wrote
       does not work until you find the Publish button. It is the single most
       common way a solo founder concludes the product is broken.

       So approval switches itself on at the moment it starts meaning something
       — when there is a second person who might want to review a change. Same
       signal as the Security section, deliberately: they are the same event. */
    async requiresApproval({ orgId }) {
        try {
            const members = await Member.countDocuments({ orgId, status: MemberStatus.ACTIVE });
            return { success: true, required: members > 1, members };
        } catch (error) {
            console.error("RevealFunctions:requiresApproval: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Fail towards the safe, familiar behaviour rather than silently
            // auto-publishing on a workspace that may well have a team.
            return { success: false, required: true, members: 0 };
        }
    }
}

module.exports = new RevealFunctions();
module.exports.ALWAYS_VISIBLE = ALWAYS_VISIBLE;
module.exports.RULES = RULES;

"use strict";
// Campaign bases: dressed, ready-to-edit starting points for the emails a person
// sends by hand from Volanea — announcements, newsletters, invitations. No
// event: they're filled in and sent as campaigns, not by workflows.
const { APP, SITE, b, button, buttons, h2, lead, p, points, signature, stats, tiles } = require("../layout");
const { hi, t } = require("./types");

const REASON = "You're getting this because you have a Zealoop account and haven't opted out of product news.";

const CAMPAIGNS = [
    t("campaign-product-update", "Campaign · Product update", "marketing", null, "What's new in Zealoop this month", {
        preheader: "The three changes worth knowing about, in two minutes.",
        eyebrow: "Product update",
        heading: "What's new this month",
        tint: "teal",
        body: [
            lead(hi),
            p("Three things shipped this month that change how your agent works. [Edit: one line of context.]"),
            h2("New"),
            points([`${b("[Feature one]")} — what it does and who it's for.`, `${b("[Feature two]")} — what it does and who it's for.`]),
            h2("Improved"),
            points([`${b("[Improvement]")} — what's faster, clearer or more accurate.`], "sand"),
            button("See it in your workspace", `${APP}/dashboard`),
        ],
        reason: REASON,
    }),

    t("campaign-feature-launch", "Campaign · Feature launch", "marketing", null, "Introducing [feature]", {
        preheader: "[One sentence on the problem it solves.]",
        eyebrow: "New",
        heading: "Introducing [feature]",
        tint: "sky",
        body: [
            lead(hi),
            p("[The problem, in your customer's words.] Until now, the only answer was [the workaround]."),
            p(`${b("[Feature]")} [does what, in one sentence].`),
            tiles([
                { title: "[Benefit one]", body: "[A line on why it matters.]", tint: "teal" },
                { title: "[Benefit two]", body: "[A line on why it matters.]", tint: "sky" },
            ]),
            buttons({ label: "Try it now", href: `${APP}/dashboard` }, { label: "Read more", href: SITE }),
        ],
        reason: REASON,
    }),

    t("campaign-newsletter", "Campaign · Newsletter", "marketing", null, "Zealoop notes: [topic]", {
        preheader: "[A line that makes the main piece worth opening.]",
        eyebrow: "Zealoop notes",
        heading: "[This edition's headline]",
        tint: "sand",
        body: [
            lead(hi),
            p("[The main piece: a lesson from real support conversations, a customer story, or a change in how AI support works.]"),
            h2("Worth reading"),
            points([`${b("[Link one]")} — why it's worth your time.`, `${b("[Link two]")} — why it's worth your time.`], "sand"),
            h2("By the numbers"),
            stats([{ label: "[Metric]", value: "[0]" }, { label: "[Metric]", value: "[0]" }], "sand"),
            signature(),
        ],
        reason: REASON,
    }),

    t("campaign-webinar", "Campaign · Webinar invite", "marketing", null, "Live: [webinar title]", {
        preheader: "[Date and time]. Thirty minutes, real workspaces, your questions.",
        eyebrow: "Live session",
        heading: "[Webinar title]",
        tint: "clay",
        body: [
            lead(hi),
            p("Join us on [date] at [time] for thirty minutes on [topic]. We'll build it live in a real workspace and answer questions as we go."),
            points(["[What they'll learn, one]", "[What they'll learn, two]", "[What they'll learn, three]"], "clay"),
            button("Save your seat", SITE),
        ],
        reason: REASON,
    }),

    t("campaign-survey", "Campaign · Survey", "marketing", null, "Two minutes to shape what we build next", {
        preheader: "Five questions. Every answer is read by the team.",
        eyebrow: "Survey",
        heading: "Help us decide what's next",
        tint: "stone",
        body: [
            lead(hi),
            p("We're choosing what to build next quarter and we'd rather ask than guess. Five questions, about two minutes."),
            button("Take the survey", SITE),
            signature(),
        ],
        reason: REASON,
    }),

    t("campaign-changelog", "Campaign · Changelog", "marketing", null, "Zealoop changelog — [month]", {
        preheader: "Everything that shipped, in one list.",
        eyebrow: "Changelog",
        heading: "Shipped in [month]",
        tint: "sage",
        body: [
            lead(hi),
            h2("Added"),
            points(["[Change]", "[Change]"], "sage"),
            h2("Improved"),
            points(["[Change]", "[Change]"], "sky"),
            h2("Fixed"),
            points(["[Change]"], "stone"),
            button("Open Zealoop", `${APP}/dashboard`),
        ],
        reason: REASON,
    }),
];

module.exports = { CAMPAIGNS };

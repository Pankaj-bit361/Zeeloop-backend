"use strict";
// Getting started: from sign-up to an agent that answers real visitors, one step at a time.
const { APP, SITE, b, button, buttons, chat, checklist, code, codeBlock, fig, flow, h2, lead, more, p, points, quote, signature, small, steps, tiles, tok, zea } = require("../layout");
const { hi, t } = require("./types");

const REASON = "You're getting this because you signed up for Zealoop. It's one of a few short emails to help you get your agent live.";
const SNIPPET = [
    `${tok.dim("&lt;script&gt;")}`,
    `  window.zealoop = { ${tok.key("publicKey")}: ${tok.str(`"pk_live_…"`)} };`,
    `${tok.dim("&lt;/script&gt;")}`,
    `${tok.dim("&lt;script async")} ${tok.key("src")}=${tok.str(`"https://api.zealoop.com/widget.js"`)}${tok.dim("&gt;&lt;/script&gt;")}`,
];

const START = [
    t("welcome", "Welcome", "marketing", "user.signed_up", `Welcome to Zealoop, {{firstName | "there"}}`, {
        preheader: "Your support agent, trained on your own content, live on your site in an afternoon.",
        eyebrow: "Welcome",
        heading: "An agent that answers like your best teammate.",
        tint: "teal",
        body: [
            lead(hi),
            p("Thanks for trying Zealoop. You're a few steps from an AI agent that answers your customers from your own docs, looks things up in your systems, and hands over to a person the moment it should."),
            zea(),
            steps([
                { title: "Point it at your content", body: "Your website, help centre, PDFs or a few paragraphs. Zealoop reads it and answers only from what it finds." },
                { title: "Tell it how to behave", body: "Tone, what it must never promise, and when to bring in a human — in plain sentences." },
                { title: "Add one script tag", body: "Paste it into your site. Zealoop confirms the moment it sees the widget." },
            ]),
            button("Set up your workspace", `${APP}/setup`),
            more("Follow the 20-minute quickstart", `${SITE}/docs/quickstart`),
            small("Reply to this email any time. It reaches the team, and a real person answers."),
        ],
        reason: REASON,
    }),

    t("workspace-nudge", "Finish setting up", "marketing", "user.signed_up", "Your Zealoop workspace is one step away", {
        preheader: "Name your workspace and Zealoop starts reading your site straight away.",
        eyebrow: "Getting started",
        heading: "One step to your first workspace.",
        tint: "sand",
        body: [
            lead(hi),
            p("You've signed up but haven't created a workspace yet. It takes a minute: give it a name, add your website, and Zealoop starts learning from it while you set up the rest."),
            checklist([
                { label: "Create your account", done: true },
                { label: "Create a workspace", done: false },
                { label: "Add your content", done: false },
                { label: "Install the widget", done: false },
            ]),
            button("Create your workspace", "https://app.zealoop.com/onboarding"),
            small("Every workspace starts with a 14-day trial of the Growth plan. No card needed."),
        ],
        reason: REASON,
    }),

    t("workspace-created", "Workspace ready", "marketing", "workspace.created", "{{workspace}} is ready — your trial has started", {
        preheader: "{{trial_days}} days of the Growth plan, everything unlocked. Here's what to do first.",
        eyebrow: "New workspace",
        heading: "{{workspace}} is ready.",
        tint: "teal",
        body: [
            lead(hi),
            p(`You just created ${b("{{workspace}}")}. It's on a ${b("{{trial_days}}-day trial of the Growth plan")} — tables, actions, procedures and the email channel all unlocked — until {{trial_ends_on | "the end of the trial"}}. No card needed; if you do nothing, it simply moves to the Free plan.`),
            tiles([
                { title: "Add your content", body: "Sitemap, files or snippets: what the agent knows.", tint: "teal", href: `${APP}/knowledge` },
                { title: "Shape the agent", body: "Rules, tone and when to hand over.", tint: "sand", href: `${APP}/agent` },
                { title: "Install the widget", body: "One script tag on your site.", tint: "sage", href: `${APP}/setup` },
                { title: "Connect an action", body: "Let it look up orders and accounts.", tint: "clay", href: `${APP}/apis` },
            ]),
            p(`Prefer to delegate? Connect Claude or Cursor over MCP and ask it to set the workspace up for you.`),
        ],
        reason: "You're getting this because you created a workspace on Zealoop.",
    }),

    t("knowledge-nudge", "Add your content", "marketing", "workspace.created", "Your agent can't answer what it hasn't read", {
        preheader: "Point Zealoop at your site or docs. It reads, chunks and indexes everything for you.",
        eyebrow: "Getting started · Step 1",
        heading: "Give your agent something to read.",
        tint: "sand",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} doesn't have any content yet, so its agent can only say "I don't know". The fastest fix is your website: Zealoop finds your sitemap, reads every page and keeps it in sync.`),
            points([
                `${b("Website or help centre")} — paste the URL; Zealoop follows the sitemap.`,
                `${b("Files")} — PDFs, Word documents, spreadsheets of FAQs.`,
                `${b("Snippets")} — a few paragraphs for things that aren't written down anywhere.`,
            ], "sand"),
            button("Add your content", `${APP}/knowledge`),
            small("The agent answers only from what you give it, and says so when it doesn't know. That's the point."),
        ],
        reason: REASON,
    }),

    t("knowledge-ready", "Content indexed", "marketing", "knowledge.first_ready", "{{source_name}} is indexed — your agent can answer from it", {
        preheader: "{{chunks_label}} ready. Ask it something your customers ask you.",
        eyebrow: "Getting started · Step 1 done",
        heading: "Your agent has read {{source_name}}.",
        tint: "teal",
        body: [
            lead(hi),
            p(`${b("{{source_name}}")} is indexed: {{chunks_label}} your agent can now cite. Try it before your customers do — open the preview and ask the question you answer most often.`),
            flow(["{{source_name}}", "{{chunks_label}}", "&#10003; Ready"]),
            chat("Do you ship to Canada, and how long does it take?", "Yes — we ship to Canada in 5–7 business days. Orders over $50 ship free. <span style=\"color:#8a877e;\">Source: Shipping policy</span>"),
            fig("Fig. 01 · Answers with receipts"),
            buttons({ label: "Try your agent", href: `${APP}/agent` }, { label: "Add more content", href: `${APP}/knowledge` }),
            small("Every answer shows the passages it came from, so you can see exactly why it said what it said."),
        ],
        reason: REASON,
    }),

    t("install-nudge", "Install the widget", "marketing", "knowledge.first_ready", "One script tag and your agent is live", {
        preheader: "Paste it before </body>. Zealoop tells you the moment it sees it.",
        eyebrow: "Getting started · Step 2",
        heading: "Your agent is ready. Your site isn't — yet.",
        tint: "sage",
        body: [
            lead(hi),
            p(`${b("{{workspace}}")} has content and an agent that can answer from it, but the widget isn't on your site yet. Paste this before ${code("&lt;/body&gt;")} — your own key is on the Setup page:`),
            codeBlock("index.html", SNIPPET),
            fig("Fig. 02 · Paste, crawl, ready"),
            p(`Using React, Vue, WordPress, Shopify or Google Tag Manager? The Setup page has a version for each, and it lights up green as soon as the widget loads.`),
            button("Get your snippet", `${APP}/setup`),
            more("Follow the quickstart", `${SITE}/docs/quickstart`),
        ],
        reason: REASON,
    }),

    t("widget-installed", "Widget live", "marketing", "widget.installed", "Zealoop is live on {{site}}", {
        preheader: "Your agent is answering visitors now. Here's how to watch it work.",
        eyebrow: "You're live",
        heading: "Your agent is live on {{site}}.",
        tint: "teal",
        body: [
            lead(hi),
            p(`We just saw the widget load on ${b("{{site}}")}. From now on every visitor can ask a question and get an answer from your content, any hour of the day.`),
            zea("Fig. 00 · Zea, now answering on {{site}}"),
            h2("Three things worth doing this week"),
            points([
                `${b("Watch the inbox.")} Every conversation lands there, and anything the agent hands over is marked for you.`,
                `${b("Match your brand.")} Colours, position and the greeting live under Widget.`,
                `${b("Check Analytics after a few days.")} It shows what's resolved and the questions your content doesn't answer yet.`,
            ]),
            buttons({ label: "Open the inbox", href: `${APP}/inbox` }, { label: "Style the widget", href: `${APP}/widget` }),
        ],
        reason: "You're getting this because the Zealoop widget was just seen on your site.",
    }),

    t("no-conversations", "No conversations yet", "marketing", "widget.installed", "No conversations yet — three things to check", {
        preheader: "The widget is installed but nobody has talked to it. Usually it's one of these.",
        eyebrow: "Getting started",
        heading: "The widget is up. Let's get people talking to it.",
        tint: "sand",
        body: [
            lead(hi),
            p("Your widget loaded a few days ago, but no visitor has opened a conversation yet. That's common in the first week, and usually one of these:"),
            points([
                `${b("It's on one page only.")} Put the snippet in your site-wide template, not a single page.`,
                `${b("It's hidden by a rule.")} Check the URL and audience rules under Widget → Launcher.`,
                `${b("The greeting is generic.")} "Ask me about delivery, returns or sizing" gets far more clicks than "How can I help?"`,
            ], "sand"),
            button("Review the widget", `${APP}/widget`),
        ],
        reason: REASON,
    }),

    t("first-conversation", "First conversation", "marketing", "conversation.first", "Your agent just had its first conversation", {
        preheader: "A visitor asked, your agent answered. Read the whole thread.",
        eyebrow: "First conversation",
        heading: "Your first visitor said hello.",
        tint: "teal",
        body: [
            lead(hi),
            p("Your agent just had its first real conversation. Here's how it started:"),
            quote("{{preview}}"),
            p("Open it to see the full thread, which passages the agent used, and how it was graded. If an answer could be better, fix the content or add a rule — the next visitor gets the better answer."),
            button("Read the conversation", `${APP}/inbox`),
        ],
        reason: "You're getting this because your Zealoop agent had its first conversation.",
    }),

    t("first-escalation", "First handoff", "marketing", "escalation.first", "Your agent handed its first conversation to you", {
        preheader: "A visitor needed a person. Here's how handoffs work — and how to answer.",
        eyebrow: "First handoff",
        heading: "A visitor needs a person.",
        tint: "clay",
        body: [
            lead(hi),
            p("Your agent just handed over its first conversation — exactly what it should do when it can't help or the visitor asks for a human. Their last message:"),
            quote("{{preview}}"),
            steps([
                { title: "Reply from the inbox", body: "Your answer appears in the visitor's widget, or by email if they've left." },
                { title: "Teach the agent", body: "If the answer is something it should know, add it to your content and next time it won't hand over." },
                { title: "Choose how you hear", body: "Get an email for every handoff, or keep them in the inbox — under Configuration." },
            ]),
            button("Open the conversation", "{{conversation_url}}"),
        ],
        reason: "You're getting this because your Zealoop agent handed a conversation to your team for the first time.",
    }),

    t("guidance-nudge", "Shape your agent", "marketing", "account.day_3", "Teach your agent the rules in plain English", {
        preheader: "What to always say, what never to promise, and when to bring in a human.",
        eyebrow: "Getting started · Tip",
        heading: "Your agent follows rules you write in plain English.",
        tint: "sky",
        body: [
            lead(hi),
            p("Content tells your agent what's true. Rules tell it how to behave. A few minutes here is the difference between an agent that's accurate and one that sounds like your team."),
            points([
                `"Never promise a delivery date — share the tracking link instead."`,
                `"If someone mentions a refund over $200, hand over to a person."`,
                `"Keep answers under three sentences unless they ask for detail."`,
            ], "sky"),
            p("Rules are drafted first, so you can test them in the preview before they reach a single visitor."),
            button("Write your first rules", `${APP}/agent`),
        ],
        reason: REASON,
    }),

    t("help-stuck", "Need a hand?", "marketing", "account.day_3", "Stuck setting up Zealoop? Reply and I'll help", {
        preheader: "A personal note: tell me where you got stuck and I'll sort it out with you.",
        eyebrow: "A note from the founder",
        heading: "Can I help you get set up?",
        tint: "stone",
        body: [
            lead(hi),
            p(`I noticed ${b("{{workspace}}")} doesn't have any content yet, so its agent isn't answering anything. Most people who stop here hit one small snag — a sitemap that wouldn't load, a site behind a login, or just not enough time.`),
            p("If you reply with your website and what you'd like the agent to handle, I'll look at it myself and tell you the fastest way to get it live. It usually takes one reply."),
            signature(),
        ],
        reason: REASON,
    }),

    t("trial-halfway", "Trial halfway", "marketing", "account.day_7", "Halfway through your trial: the parts most people miss", {
        preheader: "Actions, tables and procedures are where the agent stops answering questions and starts solving them.",
        eyebrow: "Trial · Day 7 of 14",
        heading: "From answering questions to solving them.",
        tint: "sand",
        body: [
            lead(hi),
            p(`You're a week into the Growth trial on ${b("{{workspace}}")}. Answering from your docs is the start. These are what let the agent finish a customer's request without a person:`),
            tiles([
                { title: "Actions", body: "Call your API: order status, plan changes, refunds you approve.", tint: "clay", href: `${APP}/apis` },
                { title: "Tables", body: "Upload a spreadsheet; the agent looks up the visitor's row.", tint: "sage", href: `${APP}/tables` },
                { title: "Procedures", body: "Multi-step flows like returns, written as steps.", tint: "sky", href: `${APP}/configuration` },
                { title: "Email channel", body: "The same agent answers your support inbox.", tint: "teal", href: `${APP}/configuration` },
            ]),
            p("Each is included in the trial. Try one now and you'll know whether you need a paid plan before the trial ends."),
            button("Connect your first action", `${APP}/apis`),
        ],
        reason: REASON,
    }),

    t("actions-nudge", "Connect an action", "marketing", "account.day_7", "Let your agent look things up, not just read", {
        preheader: "One API endpoint turns \"where is my order?\" from a handoff into an answer.",
        eyebrow: "Tip",
        heading: "“Where is my order?” shouldn't need a person.",
        tint: "clay",
        body: [
            lead(hi),
            p("The questions your docs can't answer are about the visitor themselves: their order, their plan, their booking. An action lets the agent call your API and answer with their real data."),
            chat("Where's my order #4821?", "It shipped yesterday with UPS and arrives Thursday. Here's the tracking link. <span style=\"color:#8a877e;\">Action: Order lookup</span>"),
            fig("Fig. 03 · Your API, behind four checks"),
            steps([
                { title: "Describe the endpoint", body: "URL, method and the inputs it needs — or paste an OpenAPI spec." },
                { title: "Decide who may run it", body: "Read-only actions run freely; anything that changes data asks the visitor to confirm." },
                { title: "Test it in the preview", body: "Every call is logged with its request and response." },
            ]),
            button("Connect an action", `${APP}/apis`),
        ],
        reason: REASON,
    }),

    t("action-live", "First action live", "marketing", "action.first_live", "{{action_name}} is live — your agent can use it now", {
        preheader: "Every call is logged with its inputs and the response, so you can see exactly what happened.",
        eyebrow: "Action live",
        heading: "{{action_name}} is live.",
        tint: "clay",
        body: [
            lead(hi),
            p(`Your agent can now call ${b("{{action_name}}")} when a visitor needs it. A few habits keep actions trustworthy:`),
            points([
                `${b("Keep descriptions specific.")} The agent decides when to call an action from its description.`,
                `${b("Confirm anything that changes data.")} Write actions can ask the visitor before they run.`,
                `${b("Watch the log for a week.")} Failed calls show the request and the response your API returned.`,
            ], "clay"),
            button("See the action log", `${APP}/apis`),
        ],
        reason: "You're getting this because an action went live in your Zealoop workspace.",
    }),

    t("tables-nudge", "Try tables", "marketing", "action.first_live", "No API? Give your agent a spreadsheet", {
        preheader: "Upload a table and the agent finds the visitor's row — orders, bookings, licences.",
        eyebrow: "Tip",
        heading: "Not everything lives behind an API.",
        tint: "sage",
        body: [
            lead(hi),
            p("Some answers live in a spreadsheet: delivery zones, licence keys, booking slots, price lists. Upload it as a table, mark the column that identifies a visitor, and the agent can look up their row — no endpoint required."),
            button("Create a table", `${APP}/tables`),
            small("Tables can be refreshed any time, and the agent only ever sees the rows that belong to the visitor it's talking to."),
        ],
        reason: REASON,
    }),

    t("table-created", "First table", "marketing", "table.first_created", "{{table_name}} is ready for your agent", {
        preheader: "{{rows_label}} the agent can look up for the right visitor.",
        eyebrow: "Table ready",
        heading: "{{table_name}} is ready.",
        tint: "sage",
        body: [
            lead(hi),
            p(`${b("{{table_name}}")} has {{rows_label}}. Make sure one column is marked as the identity key — an email or an order number — so the agent only ever reads the row of the visitor it's helping.`),
            button("Open the table", `${APP}/tables`),
        ],
        reason: "You're getting this because you created a table in your Zealoop workspace.",
    }),

    t("procedures-nudge", "Try procedures", "marketing", "table.first_created", "Write your returns process once. Your agent follows it every time.", {
        preheader: "Procedures are step-by-step flows: check, ask, act, confirm.",
        eyebrow: "Tip",
        heading: "Turn a process into steps your agent follows.",
        tint: "sky",
        body: [
            lead(hi),
            p("A procedure is how your best teammate handles a returns request or a plan change — written as steps. The agent follows them in order, calls the actions it needs, and branches when the answer depends on the customer."),
            steps([
                { title: "Check eligibility", body: "Look up the order with an action or a table." },
                { title: "Ask what's needed", body: "The reason, a photo, a preferred refund method." },
                { title: "Act and confirm", body: "Create the return and tell the visitor what happens next." },
            ]),
            button("Write a procedure", `${APP}/configuration`),
        ],
        reason: REASON,
    }),

    t("procedure-live", "First procedure live", "marketing", "procedure.first_live", "{{procedure_name}} is live", {
        preheader: "Your agent now follows it step by step whenever it applies.",
        eyebrow: "Procedure live",
        heading: "{{procedure_name}} is live.",
        tint: "sky",
        body: [
            lead(hi),
            p(`Whenever a conversation matches ${b("{{procedure_name}}")}, your agent will follow its steps in order. Run it in the preview once with an awkward customer — a missing order number, a changed mind — to see each branch work.`),
            button("Test it in the preview", `${APP}/agent`),
        ],
        reason: "You're getting this because a procedure went live in your Zealoop workspace.",
    }),

    t("email-channel-live", "Email channel live", "marketing", "email_channel.first_received", "Your agent answered its first email", {
        preheader: "Support email now gets the same agent, the same content and the same handoffs.",
        eyebrow: "Email channel",
        heading: "Your agent now answers email too.",
        tint: "teal",
        body: [
            lead(hi),
            p(`The first email from ${b("{{from_address}}")} just reached your agent. Replies keep the thread's subject, and anything the agent can't handle lands in the same inbox as your chat handoffs.`),
            button("See the thread", `${APP}/inbox`),
        ],
        reason: "You're getting this because your Zealoop email channel received its first message.",
    }),

    t("email-channel-nudge", "Answer email too", "marketing", "account.day_12", "Your agent can answer your support inbox too", {
        preheader: "Forward support@ to Zealoop and the same agent replies by email.",
        eyebrow: "Tip",
        heading: "One agent, chat and email.",
        tint: "teal",
        body: [
            lead(hi),
            p("Your visitors aren't the only ones asking. Forward your support address to the workspace's inbound address and the same agent answers email — same content, same rules, same handoffs to your team."),
            button("Set up the email channel", `${APP}/configuration`),
            small("The email channel is part of the Growth and Scale plans, and included in your trial."),
        ],
        reason: REASON,
    }),

    t("team-nudge", "Invite your team", "marketing", "account.day_12", "Bring your team into {{workspace}}", {
        preheader: "Handoffs go faster when the people who answer them are in the inbox.",
        eyebrow: "Tip",
        heading: "Handoffs go faster with your team here.",
        tint: "sand",
        body: [
            lead(hi),
            p(`You're the only person in ${b("{{workspace}}")}. When the agent hands a conversation over, someone has to answer it — invite the people who usually do.`),
            points([
                `${b("Admins")} manage content, rules, actions and billing.`,
                `${b("Agents")} answer handoffs from the inbox.`,
            ], "sand"),
            button("Invite teammates", `${APP}/users`),
        ],
        reason: REASON,
    }),

    t("insights-tip", "What visitors ask", "marketing", "account.day_30", "The questions your content doesn't answer yet", {
        preheader: "Analytics shows what's resolved, what's handed over, and where your content has gaps.",
        eyebrow: "A month in",
        heading: "Your visitors are telling you what's missing.",
        tint: "sky",
        body: [
            lead(hi),
            p(`A month in, ${b("{{workspace}}")} has a record of what your visitors really ask. Analytics turns it into a to-do list:`),
            points([
                `${b("Content gaps")} — questions the agent couldn't answer from your content.`,
                `${b("Resolution")} — how many conversations ended without a person.`,
                `${b("Quality")} — every conversation is graded, so the weak answers surface on their own.`,
            ], "sky"),
            p("Fix the top three gaps and the handoffs drop the same week."),
            buttons({ label: "Open Analytics", href: `${APP}/analytics` }, { label: "Run an evaluation", href: `${APP}/evaluation` }),
        ],
        reason: REASON,
    }),

    t("mcp-tip", "Let your AI set it up", "marketing", "account.day_30", "Let Claude or Cursor manage Zealoop for you", {
        preheader: "Connect over MCP and ask your coding agent to add content, rules or actions.",
        eyebrow: "Tip",
        heading: "Your coding agent can run Zealoop for you.",
        tint: "stone",
        body: [
            lead(hi),
            p("Zealoop speaks MCP. Connect Claude Code, Cursor or any MCP client and ask it, in plain words, to install the widget in your codebase, add a knowledge source, write a rule or wire up an action."),
            codeBlock("Terminal", [`claude mcp add --transport http zealoop ${tok.str("https://api.zealoop.com/mcp")}`]),
            p(`You'll approve the connection once in the browser, and every change it makes is drafted for you to review.`),
            button("See the MCP setup", `${APP}/setup`),
        ],
        reason: REASON,
    }),
];

module.exports = { START };

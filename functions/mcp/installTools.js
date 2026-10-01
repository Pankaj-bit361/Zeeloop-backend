"use strict";
const z = require("zod");
const install = require("./installFunctions");
const { INSTALL } = require("./scopes");
// Shared by transport registration and the schema reference so discovery
// describes the same operations that clients actually invoke.
const INSTALL_TOOLS = [
    {
        name: "zealoop_get_install_config", group: "installation", scope: INSTALL,
        description: "Read public widget configuration for the authenticated workspace. No signing secrets.",
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        handler: (_args, auth) => install.getConfig(auth.orgId),
    },
    {
        name: "zealoop_get_install_instructions", group: "installation", scope: INSTALL,
        description: "Get framework-specific installation code and steps. The coding agent must edit the website with its existing repository/CMS access.",
        inputSchema: z.object({ framework: z.enum(["html", "react", "next", "wordpress"]).default("html") }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        handler: ({ framework }, auth) => install.instructions(auth.orgId, framework),
    },
    {
        name: "zealoop_verify_installation", group: "installation", scope: INSTALL,
        description: "Fetch a public HTTP(S) website page and check for this workspace's loader/key and embedding policy. Does not execute JavaScript or certify browser runtime.",
        inputSchema: z.object({ websiteUrl: z.string().url().max(2048) }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        handler: ({ websiteUrl }, auth) => install.verify(auth.orgId, websiteUrl),
    },
];
module.exports = { INSTALL_TOOLS };

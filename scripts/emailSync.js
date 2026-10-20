"use strict";
// Sync Zealoop's lifecycle templates and workflows into the "Zealoop" project
// in Volanea (functions/lifecycle/emails). Matches by name, writes only what
// changed, creates workflows as drafts and never flips one live.
//
//   VOLANEA_LIFECYCLE_KEY=sk_test_… node scripts/emailSync.js --dry-run
//   node --env-file=<file with the key> scripts/emailSync.js
//
// A test key is enough: the rows it creates are the project's real rows (only
// sending is test-mode), so the same templates serve the live key.
const { syncEmails } = require("../functions/lifecycle/emails/sync");

async function main() {
    const apiKey = process.env.VOLANEA_LIFECYCLE_KEY || process.env.ZEALOOP_SELF_PROJECT_KEY;
    if (!apiKey) {
        console.error("Set VOLANEA_LIFECYCLE_KEY to the Zealoop project's Volanea key (sk_test_… or sk_live_…).");
        process.exit(1);
    }
    const dryRun = process.argv.includes("--dry-run");
    const report = await syncEmails({ apiKey, baseUrl: process.env.VOLANEA_API_URL || undefined, dryRun });

    const count = (rows, action) => rows.filter((r) => r.action === action).length;
    const tag = dryRun ? "[dry run] " : "";
    console.log(`${tag}templates: ${count(report.templates, "created")} created, ${count(report.templates, "updated")} updated, ${count(report.templates, "unchanged")} unchanged`);
    console.log(`${tag}workflows: ${count(report.workflows, "created")} created, ${count(report.workflows, "updated")} updated, ${count(report.workflows, "unchanged")} unchanged`);
    for (const row of [...report.templates, ...report.workflows].filter((r) => r.action !== "unchanged")) console.log(`  ${row.action.padEnd(8)} ${row.name}`);
    if (report.orphans.length) console.log(`orphans (in Volanea, not in code — left alone):\n${report.orphans.map((o) => `  ${o.kind} ${o.name}`).join("\n")}`);
    if (report.duplicates.length) console.log(`duplicates (tidy by hand):\n${report.duplicates.map((d) => `  ${d.kind} ${d.name}`).join("\n")}`);
    console.log(`${report.workflows.filter((w) => w.status === "active").length} of ${report.workflows.length} workflows are live.`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});

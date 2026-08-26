#!/usr/bin/env node
/* Copies the widget's build output into this repo, so a deploy of the backend
   alone serves the widget.

   Why a vendored copy at all: server.js used to read ../widget/dist — the
   SIBLING repository's gitignored build folder. That exists on a laptop with
   all four repos checked out side by side and built. It does not exist on a
   server that deploys this repository, so production answered 500 on
   /widget.js — the URL in every customer's install snippet — and nobody
   noticed, because nothing tested it and the laptop worked.

   Usage:  npm run widget:sync        (after any change in ../widget)
   The backend suite fails if the copy here drifts from ../widget/dist. */
"use strict";
const fs = require("fs");
const path = require("path");

const SOURCE = path.resolve(__dirname, "../../widget/dist");
const TARGET = path.resolve(__dirname, "../public/widget");

if (!fs.existsSync(path.join(SOURCE, "widget.js"))) {
    console.error(`✗ ${SOURCE} has no widget.js — run \`npm run build\` in the widget repo first`);
    process.exit(1);
}

fs.rmSync(TARGET, { recursive: true, force: true });
fs.cpSync(SOURCE, TARGET, { recursive: true });

const files = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(path.relative(TARGET, full));
    }
})(TARGET);

console.log(`✓ synced ${files.length} files → public/widget`);
for (const file of files.sort()) console.log(`    ${file}`);
console.log("\nCommit public/widget with the backend change that needs it.");

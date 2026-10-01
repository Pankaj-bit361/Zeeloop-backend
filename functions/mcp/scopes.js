"use strict";
const INSTALL = "zealoop:install", READ = "zealoop:read", WRITE = "zealoop:write";
const SCOPES = [INSTALL, READ, WRITE];
const WORKSPACE = SCOPES.join(" ");

function normalizeScope(value = INSTALL) {
    if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Provide valid MCP scopes");
    const values = new Set(value.trim().split(/\s+/));
    if ([...values].some(item => !SCOPES.includes(item))) throw new Error(`Supported MCP scopes: ${SCOPES.join(", ")}`);
    return SCOPES.filter(item => values.has(item)).join(" ");
}
function hasScope(value, required) {
    const granted = normalizeScope(value).split(" ");
    return granted.includes(required) || (required === READ && granted.includes(WRITE));
}
function isSubset(requested, granted) {
    return normalizeScope(requested).split(" ").every(item => hasScope(granted, item));
}
module.exports = { INSTALL, READ, WRITE, SCOPES, WORKSPACE, normalizeScope, hasScope, isSubset };

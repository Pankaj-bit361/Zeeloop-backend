"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { PublishState, ConfigTarget } = require("../../config/enums");
const context = new AsyncLocalStorage();

function run(values, work) { return context.run({ ...context.getStore(), ...values }, work); }
function configFilter(orgId) {
    const active = context.getStore();
    if (active?.orgId === orgId && active.target === ConfigTarget.DRAFT) {
        return { orgId, $or: [{ publishState: PublishState.DRAFT }, { publishState: PublishState.LIVE, enabled: true }] };
    }
    return { orgId, publishState: PublishState.LIVE, enabled: true };
}
function blocksExternalActions(orgId) {
    const active = context.getStore();
    return active?.orgId === orgId && active.blockExternalActions === true;
}
module.exports = { run, configFilter, blocksExternalActions };

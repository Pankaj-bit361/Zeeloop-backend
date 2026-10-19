// One answer to "is this workspace suspended", and one refusal, shared by every
// door into a workspace: the widget, the realtime socket, the dashboard token,
// the public API, MCP and inbound email.

const SUSPENDED = {
    success: false,
    error: "This workspace is suspended. Contact support@zealoop.com.",
    reason: "WORKSPACE_SUSPENDED",
};

function isSuspended(org) {
    return Boolean(org && org.suspended && org.suspended.at);
}

module.exports = { SUSPENDED, isSuspended };

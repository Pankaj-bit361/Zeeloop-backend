const config = require("../../../config/config");
const { BillingProvider } = require("../../../config/enums");
const lemonSqueezyProvider = require("./lemonSqueezyProvider");

// A provider that is selected but unconfigured, or not selected at all. Every
// method answers the same way so callers never branch on null.
const nullProvider = {
    id: BillingProvider.NONE,
    isConfigured: () => false,
    verifySignature: () => false,
    parseEvent: () => null,
    createCheckout: async () => ({ success: false, error: "No billing provider is configured" }),
    cancelSubscription: async () => ({ success: false, error: "No billing provider is configured" }),
};

const REGISTRY = {
    [BillingProvider.LEMON_SQUEEZY]: lemonSqueezyProvider,
};

// Resolved once at require time — the provider cannot change without a restart,
// and pretending otherwise would mean re-reading config on every checkout.
function getProvider() {
    const provider = REGISTRY[config.BILLING_PROVIDER];
    if (!provider) return nullProvider;
    return provider;
}

module.exports = { getProvider, nullProvider };

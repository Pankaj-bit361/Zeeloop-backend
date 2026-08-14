// All enums in one place. No magic strings anywhere else.

const TurnOutcome = {
    ANSWERED: "ANSWERED",
    CLARIFIED: "CLARIFIED",
    ABSTAINED: "ABSTAINED",
    ESCALATED: "ESCALATED",
    BLOCKED: "BLOCKED",
    ERROR: "ERROR",
};

const AccessType = {
    READ: "READ",
    WRITE: "WRITE",
};

const BlockReason = {
    NOT_AVAILABLE: "NOT_AVAILABLE",
    NEVER_TESTED: "NEVER_TESTED",
    IDENTITY_REQUIRED: "IDENTITY_REQUIRED",
    CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
};

const SourceType = {
    URL: "URL",
    SITEMAP: "SITEMAP",
    FILE: "FILE",
    SNIPPET: "SNIPPET",
};

const SourceStatus = {
    PENDING: "PENDING",
    CRAWLING: "CRAWLING",
    EMBEDDING: "EMBEDDING",
    READY: "READY",
    FAILED: "FAILED",
};

const ConversationStatus = {
    OPEN: "OPEN",
    ESCALATED: "ESCALATED",
    RESOLVED: "RESOLVED",
};

const MessageRole = {
    USER: "USER",
    ASSISTANT: "ASSISTANT",
    HUMAN_AGENT: "HUMAN_AGENT",
};

const TestStatus = {
    PASS: "PASS",
    FAIL: "FAIL",
};

const GateIntent = {
    QUESTION: "QUESTION",
    CHITCHAT: "CHITCHAT",
    ACTION_REQUEST: "ACTION_REQUEST",
    HUMAN_REQUEST: "HUMAN_REQUEST",
    ABUSE: "ABUSE",
};

const GateSentiment = {
    POSITIVE: "POSITIVE",
    NEUTRAL: "NEUTRAL",
    NEGATIVE: "NEGATIVE",
    ANGRY: "ANGRY",
};

const ExecutionStatus = {
    EXECUTED: "EXECUTED",
    FAILED: "FAILED",
    BLOCKED: "BLOCKED",
    AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
};

const ToolCallStatus = {
    PROPOSED: "PROPOSED",
    EXECUTED: "EXECUTED",
    BLOCKED: "BLOCKED",
    AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
};

const FeedbackRating = {
    UP: "UP",
    DOWN: "DOWN",
};

// Dashboard seats, not end users. OWNER is the billing contact and cannot be removed.
const MemberRole = {
    OWNER: "OWNER",
    ADMIN: "ADMIN",
    AGENT: "AGENT",
};

const MemberStatus = {
    ACTIVE: "ACTIVE",
    INVITED: "INVITED",
};

const ColumnType = {
    STRING: "string",
    NUMBER: "number",
    BOOLEAN: "boolean",
    DATE: "date",
};

// Where an escalation lands once the agent hands off.
const EscalationMode = {
    INBOX: "INBOX",
    EMAIL: "EMAIL",
    OFF: "OFF",
};

// How an account proved who it is. An account accumulates these rather than
// forking: signing up with a password and later using Google adds GOOGLE to the
// list, because the verified email — not the button pressed — is the identity.
const AuthProvider = {
    PASSWORD: "PASSWORD",
    GOOGLE: "GOOGLE",
    GITHUB: "GITHUB",
};

// One-time links. Purpose is stored on the token so a reset link can never be
// redeemed as a verification link, or the reverse.
const TokenPurpose = {
    PASSWORD_RESET: "PASSWORD_RESET",
    EMAIL_VERIFY: "EMAIL_VERIFY",
};

// Get Started checklist. Each step is derived from real data, never stored.
const OnboardingStep = {
    KNOWLEDGE: "KNOWLEDGE",
    AGENT: "AGENT",
    INSTALL: "INSTALL",
    ACTIONS: "ACTIONS",
};

// Billing plans. The id is what is stored on Subscription and what the plan
// registry in config/plans.js is keyed by, so renaming one is a migration.
const PlanId = {
    FREE: "FREE",
    STARTER: "STARTER",
    GROWTH: "GROWTH",
    SCALE: "SCALE",
};

// Capabilities a plan can grant. Gating reads these, never the plan id — so a
// pricing change is a registry edit rather than a hunt through conditionals.
const FeatureKey = {
    KNOWLEDGE: "KNOWLEDGE",
    TABLES: "TABLES",
    ACTIONS: "ACTIONS",
    PROCEDURES: "PROCEDURES",
    EMAIL_CHANNEL: "EMAIL_CHANNEL",
    COPILOT: "COPILOT",
    PUBLIC_API: "PUBLIC_API",
    REMOVE_BRANDING: "REMOVE_BRANDING",
};

// Mirrors the states every provider models, rather than any one provider's
// vocabulary. The adapter maps its own strings onto these.
const SubscriptionStatus = {
    TRIALING: "TRIALING",
    ACTIVE: "ACTIVE",
    PAST_DUE: "PAST_DUE",
    CANCELLED: "CANCELLED",
    EXPIRED: "EXPIRED",
};

const BillingProvider = {
    LEMON_SQUEEZY: "LEMON_SQUEEZY",
    PADDLE: "PADDLE",
    // No provider — free plans and anything seeded locally.
    NONE: "NONE",
};

// Result of the quota check for one org in the current period.
const QuotaState = {
    OK: "OK",
    // Past the soft threshold: still serving, but the dashboard warns.
    WARNING: "WARNING",
    // Past the hard limit: the widget degrades gracefully, dashboard explains.
    EXCEEDED: "EXCEEDED",
};

// Why a request was refused before it reached the pipeline. Distinct from
// BlockReason, which is about a tool call the model proposed.
const LimitReason = {
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    COST_CEILING: "COST_CEILING",
    RATE_LIMITED: "RATE_LIMITED",
    BLOCKED_IDENTITY: "BLOCKED_IDENTITY",
    PLAN_FEATURE: "PLAN_FEATURE",
    PLAN_LIMIT: "PLAN_LIMIT",
};

const IdPrefix = {
    ORG: "org",
    MEMBER: "mem",
    // "usr" was already spent on the widget's end users, and an account is a
    // different species entirely — the human who signs in, not the customer
    // being helped.
    ACCOUNT: "acc",
    AUTH_TOKEN: "atk",
    END_USER: "usr",
    KNOWLEDGE_SOURCE: "src",
    CHUNK: "chk",
    TABLE: "tbl",
    TABLE_ROW: "row",
    ACTION: "act",
    ACTION_EXECUTION: "exe",
    PROCEDURE: "prc",
    CONVERSATION: "conv",
    MESSAGE: "msg",
    TURN_TRACE: "trc",
    SUBSCRIPTION: "sub",
    USAGE_RECORD: "usg",
    WEBHOOK_EVENT: "whk",
};

module.exports = {
    TurnOutcome,
    AccessType,
    BlockReason,
    SourceType,
    SourceStatus,
    ConversationStatus,
    MessageRole,
    TestStatus,
    GateIntent,
    GateSentiment,
    ExecutionStatus,
    ToolCallStatus,
    FeedbackRating,
    MemberRole,
    MemberStatus,
    ColumnType,
    EscalationMode,
    AuthProvider,
    TokenPurpose,
    OnboardingStep,
    PlanId,
    FeatureKey,
    SubscriptionStatus,
    BillingProvider,
    QuotaState,
    LimitReason,
    IdPrefix,
};

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
// Sections of the dashboard that reveal themselves as a workspace grows (§1.9).
// The product's whole pitch is Fin's capability without Fin's first-week
// bewilderment, and a sidebar with twelve entries on day one is exactly that
// bewilderment. These are the ones that stay hidden until they mean something;
// Dashboard, Inbox, Knowledge and Widget are always present because they are
// the job on day one.
const NavSection = {
    AGENT: "AGENT",
    ANALYTICS: "ANALYTICS",
    EVALUATION: "EVALUATION",
    TABLES: "TABLES",
    APIS: "APIS",
    SECURITY: "SECURITY",
    USERS: "USERS",
};

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

// ── Configuration surface (§2) ───────────────────────────────────────

// Guidance rules are grouped in the dashboard by category, and composed into
// the system prompt grouped the same way — a model given "be concise" next to
// "never quote prices" follows both better than one given a flat list.
const GuidanceCategory = {
    COMMUNICATION_STYLE: "COMMUNICATION_STYLE",
    CONTEXT: "CONTEXT",
    SOURCES: "SOURCES",
    SPAM: "SPAM",
    OTHER: "OTHER",
};

// Conditions on segments, escalation rules and attribute detection all share
// one operator set, so one evaluator covers all three.
const ConditionOperator = {
    EQUALS: "EQUALS",
    NOT_EQUALS: "NOT_EQUALS",
    CONTAINS: "CONTAINS",
    NOT_CONTAINS: "NOT_CONTAINS",
    GREATER_THAN: "GREATER_THAN",
    LESS_THAN: "LESS_THAN",
    IS_SET: "IS_SET",
    IS_NOT_SET: "IS_NOT_SET",
    IN: "IN",
};

// Fields a condition may read. Deliberately an allowlist: a condition that can
// name any path would let a support manager read whatever happens to be on the
// context object, which is a tenancy leak waiting to happen.
const ConditionField = {
    IDENTITY_VERIFIED: "IDENTITY_VERIFIED",
    TURN_COUNT: "TURN_COUNT",
    SENTIMENT: "SENTIMENT",
    INTENT: "INTENT",
    PLAN: "PLAN",
    LANGUAGE: "LANGUAGE",
    CONVERSATION_COUNT: "CONVERSATION_COUNT",
    FIRST_SEEN_DAYS_AGO: "FIRST_SEEN_DAYS_AGO",
    EMAIL_DOMAIN: "EMAIL_DOMAIN",
    ATTRIBUTE: "ATTRIBUTE",
    TABLE_VALUE: "TABLE_VALUE",
};

// Which surface a config object applies to. `channels: []` means every channel
// — an empty list reads as "not restricted", not as "nowhere".
const Channel = {
    CHAT: "CHAT",
    EMAIL: "EMAIL",
};

// Draft / live (§2.4). Every editable config object carries one of these, and
// only LIVE objects reach production traffic.
const PublishState = {
    DRAFT: "DRAFT",
    LIVE: "LIVE",
};

// Version history is one collection across every config type, so restore and
// diff are written once rather than per model.
const ConfigObjectType = {
    GUIDANCE_RULE: "GUIDANCE_RULE",
    ESCALATION_RULE: "ESCALATION_RULE",
    ESCALATION_GUIDANCE: "ESCALATION_GUIDANCE",
    ATTRIBUTE: "ATTRIBUTE",
    SEGMENT: "SEGMENT",
    PROCEDURE: "PROCEDURE",
    ACTION: "ACTION",
    WIDGET_CONFIG: "WIDGET_CONFIG",
    BUSINESS_CONTEXT: "BUSINESS_CONTEXT",
    MACRO: "MACRO",
};

// How an attribute value got onto a conversation. A human override is worth
// more than a model guess — it is both the correction and the training signal.
const AttributeSource = {
    DETECTED: "DETECTED",
    MANUAL: "MANUAL",
    SYSTEM: "SYSTEM",
};

// Agent tone (§2.8). Maps to an explicit instruction and a token ceiling, so
// "concise" actually shortens the answer rather than merely asking nicely.
const AnswerLength = {
    CONCISE: "CONCISE",
    STANDARD: "STANDARD",
    DETAILED: "DETAILED",
};

// Reply in whatever language the customer wrote in, or always in one fixed
// language. Three languages supported, per the non-goals.
const LanguagePolicy = {
    MATCH_USER: "MATCH_USER",
    FIXED: "FIXED",
};

// ── Evaluation (§3) ──────────────────────────────────────────────────

const EvalRating = {
    GOOD: "GOOD",
    POOR: "POOR",
    UNRATED: "UNRATED",
};

const RunStatus = {
    QUEUED: "QUEUED",
    RUNNING: "RUNNING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
};

// Which config a batch test or simulation ran against. A run that cannot say
// which config produced it is not a regression test, it is an anecdote.
const ConfigTarget = {
    LIVE: "LIVE",
    DRAFT: "DRAFT",
};

// Why a conversation landed in the review queue (§3.6).
const MonitorTrigger = {
    ALL_ESCALATIONS: "ALL_ESCALATIONS",
    ALL_ABSTENTIONS: "ALL_ABSTENTIONS",
    NEGATIVE_SENTIMENT: "NEGATIVE_SENTIMENT",
    KEYWORD_MATCH: "KEYWORD_MATCH",
    RANDOM_SAMPLE: "RANDOM_SAMPLE",
    LOW_QUALITY_SCORE: "LOW_QUALITY_SCORE",
};

const ReviewStatus = {
    PENDING: "PENDING",
    IN_REVIEW: "IN_REVIEW",
    REVIEWED: "REVIEWED",
    DISMISSED: "DISMISSED",
};

// ── Widget and channels (§4) ─────────────────────────────────────────

// Home screen sections. The widget skips unknown types silently, so adding one
// here does not break embeds that are already in the wild.
const HomeSectionType = {
    TRUST_BADGE: "trust_badge",
    ASK_QUESTION: "ask_question",
    RECENT_CONVERSATION: "recent_conversation",
    ARTICLE_SEARCH: "article_search",
    EXTERNAL_LINK: "external_link",
};

// Rich responses (§4.6). The contract is defined now because retrofitting a
// message format after embeds are deployed means supporting both forever.
const ResponseComponentType = {
    TEXT: "text",
    CARD: "card",
    CHOICES: "choices",
    LINK: "link",
    CONFIRM: "confirm",
    FORM: "form",
};

// Header text on a gradient cannot be computed from one luminance value,
// because the two stops can straddle the threshold (§4.5).
const HeaderTextMode = {
    AUTO: "AUTO",
    BLACK: "BLACK",
    WHITE: "WHITE",
};

const ConversationChannel = {
    CHAT: "CHAT",
    EMAIL: "EMAIL",
};

// ── Expansion (§5) ───────────────────────────────────────────────────

// REST actions post JSON to a URL. MCP actions call a tool on a customer's own
// MCP server, which unlocks their whole existing tool ecosystem at once.
const ActionKind = {
    REST: "REST",
    MCP: "MCP",
};

// Where a data input's value comes from before an action may run (§5.3).
const DataInputSource = {
    CONVERSATION: "CONVERSATION",
    PRIOR_ACTION: "PRIOR_ACTION",
    ASK_CUSTOMER: "ASK_CUSTOMER",
    IDENTITY: "IDENTITY",
    TABLE: "TABLE",
};

const CredentialType = {
    BEARER: "BEARER",
    API_KEY_HEADER: "API_KEY_HEADER",
    BASIC: "BASIC",
};

// Procedure steps (§5.4). A plain step is an instruction; a branch splits on a
// condition; a tool step names an action the model must call.
const ProcedureStepType = {
    INSTRUCTION: "INSTRUCTION",
    BRANCH: "BRANCH",
    TOOL: "TOOL",
};

const ProcedureTriggerType = {
    KEYWORD: "KEYWORD",
    INTENT: "INTENT",
    EVENT: "EVENT",
    MANUAL: "MANUAL",
};

// Public API (§5.6). Scopes are checked per key, so a read-only integration
// cannot be talked into writing.
const ApiScope = {
    CONVERSATIONS_READ: "conversations:read",
    CONVERSATIONS_WRITE: "conversations:write",
    KNOWLEDGE_READ: "knowledge:read",
    KNOWLEDGE_WRITE: "knowledge:write",
    ANALYTICS_READ: "analytics:read",
};

const OutboundWebhookEvent = {
    CONVERSATION_CREATED: "conversation.created",
    CONVERSATION_ESCALATED: "conversation.escalated",
    CONVERSATION_RESOLVED: "conversation.resolved",
    ACTION_EXECUTED: "action.executed",
};

// ── Compliance and operations (§8) ───────────────────────────────────

const BlocklistType = {
    IDENTITY: "IDENTITY",
    IP: "IP",
    EMAIL_DOMAIN: "EMAIL_DOMAIN",
};

// Admin actions worth an audit row. Anything that changes who can get in, what
// the agent may do, or what is being charged.
const AuditAction = {
    MEMBER_ADDED: "MEMBER_ADDED",
    MEMBER_REMOVED: "MEMBER_REMOVED",
    MEMBER_ROLE_CHANGED: "MEMBER_ROLE_CHANGED",
    SECRET_ROTATED: "SECRET_ROTATED",
    ACTION_SET_LIVE: "ACTION_SET_LIVE",
    CONFIG_PUBLISHED: "CONFIG_PUBLISHED",
    CONFIG_RESTORED: "CONFIG_RESTORED",
    PLAN_CHANGED: "PLAN_CHANGED",
    DATA_EXPORTED: "DATA_EXPORTED",
    DATA_ERASED: "DATA_ERASED",
    API_KEY_CREATED: "API_KEY_CREATED",
    API_KEY_REVOKED: "API_KEY_REVOKED",
    ORIGIN_ALLOWLIST_CHANGED: "ORIGIN_ALLOWLIST_CHANGED",
};

// Transactional email (§0.5, §4.8). Every send is recorded so a trial-ending
// notice is never sent twice, which is the same idempotency problem as webhooks
// and gets the same unique-index answer.
const EmailKind = {
    TRIAL_ENDING_7: "TRIAL_ENDING_7",
    TRIAL_ENDING_2: "TRIAL_ENDING_2",
    TRIAL_ENDED: "TRIAL_ENDED",
    PAYMENT_FAILED: "PAYMENT_FAILED",
    DUNNING_REMINDER: "DUNNING_REMINDER",
    SUBSCRIPTION_SUSPENDED: "SUBSCRIPTION_SUSPENDED",
    QUOTA_WARNING: "QUOTA_WARNING",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    ESCALATION_NOTICE: "ESCALATION_NOTICE",
    AGENT_REPLY: "AGENT_REPLY",
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
    GUIDANCE_RULE: "gdr",
    ESCALATION_RULE: "esr",
    ESCALATION_GUIDANCE: "esg",
    ATTRIBUTE: "atr",
    SEGMENT: "seg",
    CONFIG_VERSION: "ver",
    BATCH_TEST: "bt",
    BATCH_RUN: "btr",
    SIMULATION: "sim",
    SIMULATION_RUN: "smr",
    MONITOR: "mon",
    REVIEW: "rev",
    RECOMMENDATION: "rec",
    MACRO: "mac",
    API_KEY: "key",
    OUTBOUND_WEBHOOK: "owh",
    WEBHOOK_DELIVERY: "wdl",
    TEAM: "team",
    BLOCKLIST_ENTRY: "blk",
    AUDIT_LOG: "aud",
    CREDENTIAL: "cred",
    EMAIL_LOG: "eml",
    COPILOT_THREAD: "cop",
    CRAWL_JOB: "job",
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
    NavSection,
    PlanId,
    FeatureKey,
    SubscriptionStatus,
    BillingProvider,
    QuotaState,
    LimitReason,
    GuidanceCategory,
    ConditionOperator,
    ConditionField,
    Channel,
    PublishState,
    ConfigObjectType,
    AttributeSource,
    AnswerLength,
    LanguagePolicy,
    EvalRating,
    RunStatus,
    ConfigTarget,
    MonitorTrigger,
    ReviewStatus,
    HomeSectionType,
    ResponseComponentType,
    HeaderTextMode,
    ConversationChannel,
    ActionKind,
    DataInputSource,
    CredentialType,
    ProcedureStepType,
    ProcedureTriggerType,
    ApiScope,
    OutboundWebhookEvent,
    BlocklistType,
    AuditAction,
    EmailKind,
    IdPrefix,
};

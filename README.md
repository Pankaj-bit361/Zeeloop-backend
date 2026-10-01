# Zealoop backend

Multi-tenant AI support agent — Express + Mongoose, per `spec.md` (Draft v1).

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT_SECRET, ENCRYPTION_KEY, ANTHROPIC_API_KEY, VOYAGE_API_KEY
npm run dev            # node --watch server.js, port 4000
```

The server boots without MongoDB (connect retries every 5s) and without Sentry
(`SENTRY_DSN` optional). Chat completions (gate/rewrite/generate/validate) and
embeddings all go through OpenRouter — one `OPENROUTER_API_KEY`. Override
`SMALL_MODEL` / `LARGE_MODEL` / `EMBED_MODEL` with any OpenRouter slug
(defaults: `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5`,
`google/gemini-embedding-2`). The embedding model must output `EMBEDDING_DIM`
(1024) vectors to match the Atlas index — gemini-embedding-2 has flexible
output dimensions (128–3072) and the backend requests 1024 explicitly via the
`dimensions` parameter; `embed()` hard-fails with a clear error if the
returned vectors are any other size. Changing embedding models later means
resyncing every source. Reranking is optional Voyage
(`VOYAGE_API_KEY`) since OpenRouter has no rerank API; without it retrieval
falls back to fusion order. If you change chat models, update `PRICE_PER_MTOK`
in `config/config.js` so per-turn cost attribution stays accurate.

## The widget build (served from this repo)

`/widget.js` and `/widget/frame/` — the URL in every customer's install
snippet — are served from `public/widget`, a copy of the widget repo's build
vendored into this repository. It has to live here because this repo is what
gets deployed; the sibling `../widget` checkout on a laptop is not on the
server. (Production served 500 on `/widget.js` for as long as the server read
from the sibling.)

After any change in the widget repo:

```bash
cd ../widget && npm run build
cd ../backend && npm run widget:sync     # copies ../widget/dist → public/widget
git add public/widget && git commit
```

Locally, `../widget/dist` is preferred when present so a fresh build shows
immediately; the suite fails if it differs from `public/widget`, so the copy
cannot be forgotten. `WIDGET_DIST=/path` overrides both.

**Caching and compression.** `server.js` serves widget assets itself rather
than through `express.static`, because production's nginx sends them
uncompressed. It picks the build's `.br` or `.gz` sibling from
`Accept-Encoding` and sets:

| File | Cache-Control |
|---|---|
| `frame/frame.<hash>.js`, `frame/frame.<hash>.css` | `public, max-age=31536000, immutable` |
| `widget.js`, `frame/index.html` | `public, max-age=300, stale-while-revalidate=86400` |
| a fingerprint this deploy no longer has | current build, `no-cache` |

`tests/widgetAssets.test.js` covers encoding choice, cache headers, the stale
fingerprint fallback, path traversal and the trailing-slash redirect.

## Search retrieval and Atlas indexes

The agent and widget Help tab share heading-aware text retrieval; the agent
also blends semantic vector matches. Help searches need no model call. On Atlas,
startup creates missing indexes on `chunks` using `config/searchIndexes.js`;
it never replaces or drops an existing index. Creation is asynchronous, and
health checks report missing or non-queryable indexes. You can also run
`npm run search:indexes` to perform the same idempotent setup and view status.
The database user needs the `createSearchIndexes` privilege.

When an index is missing, building, or unavailable (including local MongoDB),
heading-aware keyword retrieval remains active. It ranks all workspace matches
before limiting results, boosts rare terms and adjacent query words, keeps
two-letter acronyms and Unicode terms, and
matches words rather than arbitrary substrings. Agent answers still pass the
grounding validator. Atlas returns empty arrays for some unavailable indexes,
so fallback applies to both empty results and errors.

Index definitions:

**`chunk_vector_index`** (type: vectorSearch)

```json
{
    "fields": [
        { "type": "vector", "path": "embedding", "numDimensions": 1024, "similarity": "cosine" },
        { "type": "filter", "path": "orgId" },
        { "type": "filter", "path": "sourceId" }
    ]
}
```

**`chunk_text_index`** (type: search)

```json
{
    "mappings": {
        "dynamic": false,
        "fields": {
            "text": { "type": "string" },
            "headingPath": { "type": "string" },
            "orgId": { "type": "token" }
        }
    }
}
```

`orgId` is a token field for exact `equals` filtering, and retrieval also
matches the tenant ID in Mongo before limiting/projecting. A legacy index
with `orgId: string` can be updated in Atlas to the definition above;
keyword fallback covers the migration. See [MongoDB search index management](https://www.mongodb.com/docs/search/indexes/manage-indexes/)
and [exact string filtering](https://www.mongodb.com/docs/search/query/operators-collectors/equals/).

## Context assembly and the repair pass

Two things happen between rerank and the answer that the six-stage table in
`spec.md` §5 did not originally have.

**Neighbour expansion (stage 3b).** Reranking picks the 600-token chunk that
best matches the question; the answer is routinely in the chunk next to it.
`_expandNeighbors` fetches the chunks within `NEIGHBOR_EXPAND_RADIUS` positions
in the same document, merges contiguous windows, trims the 15% overlap so the
model does not read the same sentence twice, and stops widening once
`CONTEXT_MAX_TOKENS` is spent (later chunks arrive bare). A passage cites the
best-scoring chunk inside it, so `citationChunkIds` still resolve, and
`memberChunkIds` records what was actually read. The validator reads the same
widened context. The trace carries `contextChunkCount`.

**Repair pass (stage 5b).** When the validator says an answer addresses the
question but names unsupported claims, the turn gets one more generate call
with those claims listed and an instruction to rewrite from the context alone.
The rewrite is re-validated on the same terms; a second failure abstains as
before. `repairAttempted` / `repairSucceeded` on the trace give the pass its
own hit rate. It never runs for clarifications, tool proposals, or a validator
that produced no claims — "does not answer the question" has no edit that
fixes it.

**Follow-ups.** The answer schema carries `followUps`: up to three short
questions the model expects next and the shown knowledge can answer. They are
sanitised in `_cleanFollowUps` and reach the widget as a `choices` component
under an `ANSWERED` turn only.

**Progress.** `runTurn` accepts `onProgress`; the chat path publishes each
stage to the conversation's socket as `{ type: "progress", stage, sources? }`.
A listener that throws is ignored.

`tests/chatQuality.test.js` covers all of this in-process with the model calls
and the chunk lookup stubbed — it is the one suite here that needs neither the
server nor a database.

## API surface

Public (widget, CORS `*`, no auth — identity via HMAC-signed `identify()` payloads):

```
POST /api/widget/bootstrap          { publicKey, conversationId?, identity? }
POST /api/widget/messages           { publicKey, conversationId, content, identity? }
POST /api/widget/actions/confirm    { publicKey, conversationId, proposalId, confirmed: boolean, identity? }
POST /api/widget/feedback           { publicKey, conversationId, rating: UP|DOWN }
```

Session (cookie-authenticated, `credentials: include`). Establishes *who* the
caller is; on its own it grants access to no workspace data:

```
GET   /api/auth/config              which sign-in methods this server offers
POST  /api/auth/signup              { name, email, password } -> sets session cookie
POST  /api/auth/login               { email, password }       -> sets session cookie
POST  /api/auth/logout              revokes existing sessions and org JWTs, clears the cookie
POST  /api/auth/verification        resend mailbox verification (session required)
POST  /api/auth/verify-email        { token } (session required; explicit confirmation)
GET   /api/auth/me                  { user, orgs[] }
PATCH /api/auth/me                  { name }
POST  /api/auth/token               { orgId } -> org JWT, after a membership check
GET   /api/auth/orgs                workspaces this account holds a seat in
POST  /api/auth/orgs                { name, website } — onboarding: org + owner seat
POST  /api/auth/forgot-password     { email }
POST  /api/auth/reset-password      { token, password } -> sets session cookie
POST  /api/auth/dev-login           { orgId } — no session, no membership check, dev only
```

OAuth round-trip, mounted at the server root because these exact paths are
registered with the providers and cannot carry an `/api` prefix:

```
GET /auth/google    GET /auth/google/callback
GET /auth/github    GET /auth/github/callback
```

Dashboard (`Authorization: Bearer <JWT>`, token orgId must match path orgId):

```
GET|POST      /api/knowledge/:orgId/sources
DELETE        /api/knowledge/:orgId/sources/:sourceId
POST          /api/knowledge/:orgId/sources/:sourceId/resync
GET           /api/knowledge/:orgId/chunks?sourceId=&page=&limit=

GET|POST      /api/org/:orgId/actions
PATCH|DELETE  /api/org/:orgId/actions/:actionId
POST          /api/org/:orgId/actions/:actionId/test

GET           /api/org/:orgId/conversations?status=&search=&page=&limit=
GET           /api/org/:orgId/conversations/:conversationId
PATCH         /api/org/:orgId/conversations/:conversationId   { status }
POST          /api/org/:orgId/conversations/:conversationId/reply

GET|PATCH     /api/org/:orgId/settings
POST          /api/org/:orgId/widget-secret/reveal
POST          /api/org/:orgId/widget-secret/rotate
GET           /api/org/:orgId/onboarding
GET|PATCH     /api/org/:orgId/me
GET|POST      /api/org/:orgId/members
DELETE        /api/org/:orgId/members/:memberId
GET           /api/org/:orgId/users?verified=&search=&page=&limit=
GET           /api/org/:orgId/users/:endUserId

GET|POST      /api/org/:orgId/tables
GET|PATCH|DELETE  /api/org/:orgId/tables/:tableId
GET|POST      /api/org/:orgId/tables/:tableId/rows?search=&page=&limit=
PATCH|DELETE  /api/org/:orgId/tables/:tableId/rows/:rowId
POST          /api/org/:orgId/tables/:tableId/import          { csv }

GET           /api/analytics/:orgId/overview?days=7
GET           /api/analytics/:orgId/content-gaps?days=30
```

Dev-only auth (refuses to run when `NODE_ENV=production`):

```
POST          /api/auth/dev-login   { orgId }
GET           /api/auth/orgs
```

## Architecture

One pattern everywhere (spec §2): thin routes destructure `req` and forward
`{ status, json }` from singleton function classes; `_` helpers return
`{ success }`; every method logs entry + catch and reports to Sentry; every
model carries an indexed `orgId` and a prefixed public id (`act_`, `conv_`,
`src_`, …) — Mongo `_id` never leaves the backend.

The turn pipeline (`functions/agent/agentFunctions.js`) runs gate → rewrite →
retrieve → rerank → generate → validate with per-stage failure behaviour
(gate fails open, validator fails closed) and writes a `TurnTrace` on every
turn. Write actions never execute inside the generation loop — they halt for
user confirmation and execute next turn via `/api/widget/actions/confirm`.
Guards (`enabled`, test-pass, identity, confirmation) are enforced in code in
both the pipeline and `ActionFunctions.executeAction()`.

## Implemented vs deferred

Implemented: all models, the full pipeline, hybrid search + RRF + rerank with
graceful degradation, heading-aware chunking (600 tokens, 15% overlap),
SNIPPET + single-URL ingestion, action CRUD/test/execute with audit trail,
widget chat + confirmation flow, inbox + human reply + status changes, overview
+ content-gap analytics, autonomous-resolution cron (every 15 min, §11
definition), org settings with widget-secret reveal/rotate, dashboard seats
(`Member`) with invites, derived onboarding checklist, table + row CRUD with
CSV import, and per-day token series for billing.

Also implemented: real sign-in — password, Google and GitHub — on an `Account`
model, with session cookies, membership-gated org tokens, onboarding, and
password reset.

Three invariants worth knowing:

- **Manual resolution is not autonomous resolution.** Closing a conversation
  from the inbox sets `status` and `manuallyResolvedAt` but never `isResolved` —
  that flag only ever means "the agent resolved it alone", so the headline
  metric can't be inflated by clicking.
- **A table's identity key is unique per table.** It is what scopes a row to a
  verified customer, so duplicate inserts are rejected (`409`) and CSV import
  upserts on it rather than appending.
- **Identity and authorization are separate credentials.** The session cookie
  says who you are and reaches no workspace data; the org JWT says which
  workspace a request may touch and is only minted after `Member` confirms a
  seat. Conflating them is how a signed-out browser keeps working for a week.

`Account` is deliberately the one model without an `orgId`: a person can hold
seats in several workspaces, and `Member` is the join, keyed on the verified
email. That is also why an OAuth address is only trusted once the provider
reports it verified.

Sitemap crawling, file ingestion, crawl workers, email delivery/channel,
billing adapters, and server-side plan gates are implemented. Their live
provider and infrastructure behavior still needs deployment-specific validation.

## Verification and production setup

`npm test` creates a unique `zealoop_test_*` database on local MongoDB, seeds
it, starts an API on an ephemeral port with deterministic model fixtures,
runs the complete suite, and drops only that database. It never uses the
ordinary development or production database. Set `TEST_MONGO_HOST` only to a
local MongoDB host if port 27017 is unavailable. Fixtures verify API behavior;
they do not measure model quality or Atlas retrieval accuracy.

`npm run test:browser` uses the same disposable runner for Chromium checks of
chat, live human replies, handoff, approval, cancellation, and replay rejection.
Install its browser once with `npx playwright install chromium`. CI installs
Chromium and retains screenshots from these flows; the browser job is distinct
from the API/unit suite.

For isolated browser testing, run `node scripts/runTests.js --serve`. It prints
the temporary API URL and an `environment.json` path for the widget browser
suites. Stop it with Ctrl+C to clean up the API and its disposable database.

Configure `EMAIL_API_KEY` and a verified `EMAIL_FROM` sender in Resend for
verification and password recovery. Without delivery, production signup and
recovery fail explicitly. `ALLOW_DEV_AUTH_LINKS=true` exposes links only on an
explicitly configured development/test instance; it is ignored in production.
Tokens expire in one hour, are stored hashed, and are consumed atomically.
Existing unverified accounts must verify their mailbox before using seats.

Logout and password reset increment the persisted session version. Old org
JWTs without an account/version must be replaced by signing in again after
deployment. OAuth ownership of a previously unverified address clears any
password planted before mailbox ownership was proved.

Set `TRUST_PROXY` to the actual ingress proxy CIDRs, or a fixed hop count only
when every path to the application has exactly that topology. Forwarded IP
headers are ignored by default; HTTP and WebSocket requests share the trust
policy. Auth and widget request budgets use atomic MongoDB counters. Write
approvals and chat leases are also shared across API instances. MongoDB events
relay messages to sockets on other instances; reconnect fetches persisted
history. Socket connection counts remain per process.
Run scheduled jobs on one designated instance and set
`SCHEDULED_JOBS_ENABLED=false` on other API replicas. Schedules use UTC,
await readiness, and prevent overlap within an instance. Crawl job leases
remain independent of the scheduler flag. Scheduler failover still needs an
operational plan; these schedules do not provide distributed leader election.

Origin enforcement sets a workspace-specific `frame-ancestors` policy on the
messenger HTML. The browser checks actual embedding ancestors while the
iframe's own API origin remains allowed. Frame HTML with a real workspace key
is not cached, so an updated embedding policy is checked on the next reload.
This is an abuse barrier for browser embedding, not a replacement for verified
identity or request budgets; server-to-server clients can forge Origin.

Readiness requires the database and critical unique/TTL indexes. Route traffic
only after `/ready` returns 200. User-controlled outbound requests validate
every DNS address/redirect, pin the connection address, and enforce deadlines
and byte limits. `ALLOW_TEST_LOOPBACK` is effective only under `NODE_ENV=test`.

Writes require a fresh boolean approval and proposal ID. Duplicate execution
keys never repeat the network call. An uncertain or interrupted write is
escalated for human investigation, without automatic retry. The model receives
the latest 50 history messages; widget reloads receive the latest 100. Human
handoff suppresses AI replies, including a takeover during generation.

## MCP workspace server

`/mcp` is an authenticated Streamable HTTP endpoint built with the official MCP
SDK. It supports 2026-07-28 clients and stateless legacy 2025 initialization.
Browser sign-in supports discovery, dynamic registration, client metadata,
S256 PKCE, refresh rotation and one-organization consent. Optional named client
credentials and manually issued bearer tokens are managed by owners/admins.

Scopes are explicit: `zealoop:install` exposes three widget installation tools;
`zealoop:read` exposes workspace status, resource/schema discovery, knowledge,
customer conversations/profiles, tables, configuration and analytics;
`zealoop:write` additionally permits creating/updating resources and evaluations.
Write includes read capability. All three scopes expose 38 tools. Legacy grants
and tokens with no scope remain installation-only; no migration silently upgrades
their permissions. New token requests default to installation-only, and the
OAuth consent screen explains the scopes requested by the client.

`zealoop_get_workspace_status` orients an agent with plan, usage and resource
counts. `zealoop_get_api_reference` returns the actual granted tool schemas.
`functions/mcp/workspaceTools.js` registers bounded operations backed by the
same domain services and plan gates as the dashboard. New configuration is
always disabled DRAFT; procedures/actions start disabled. Publication, live
edits, restoration, activation and cleanup require preview/confirmation.
Actions require a passed, non-mock dashboard test before MCP activation; previews
do not execute endpoints. Cleanup checks the MCP artifact ownership ledger and
protects human-created resources, built-ins, live config and active resources.

Draft evaluations use AsyncLocalStorage to include draft guidance only within
that request; database publication state never changes. MCP evaluations block
external REST/MCP action calls, while explicitly configured mocks can run.
Evaluation conversations/traces are ephemeral; suite results remain available.

Owners/admins manage bearer credentials at `/api/org/:orgId/mcp/tokens` (GET/POST)
and `/api/org/:orgId/mcp/tokens/:tokenId` (DELETE). Credentials are shown once,
SHA-256 hashes are stored, and tokens expire in 30 days. Every MCP request
rechecks account verification, session version, current role, revocation,
expiry and shared MongoDB budgets. Sign-out/password reset invalidate issued
credentials. Scopes never grant dashboard REST authentication, billing changes,
customer reply sending, signing secrets or website deployment. Writes are audited
without credential values. Results omit action headers and knowledge embeddings.

`API_URL` must match the public MCP Host header. Browser origins must match
`API_URL` or `CORS_DASHBOARD_ORIGINS`; command-line clients omit Origin. The
endpoint is readiness-gated and uses strict SDK tool schemas, rather than the
Mongo operator middleware that rejects MCP's namespaced metadata keys.

Installation instructions use the hosted loader because the npm SDK is not
published. Verification rejects redirects, private targets and credential-bearing
URLs, fetches at most 1 MB within 10 seconds, and returns source-detection flags,
never remote HTML. Source presence/telemetry do not prove JavaScript execution;
check the launcher and CSP errors in a browser. Coding agents edit the customer's
repository/CMS using their existing permissions and deployment authorization.

Client configuration: <https://www.zealoop.com/docs/mcp>. Regression coverage:
`node scripts/runTests.js tests/mcpWorkspace.test.js tests/mcpOAuth.test.js`;
the full `npm test` also includes protocol, credential and public-page checks.

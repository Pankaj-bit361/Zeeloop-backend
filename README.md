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

## Atlas search indexes (required for retrieval)

Without both indexes `_hybridSearch` returns empty and the agent abstains.
Create them on the `chunks` collection:

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
            "orgId": { "type": "string" }
        }
    }
}
```

## API surface

Public (widget, CORS `*`, no auth — identity via HMAC-signed `identify()` payloads):

```
POST /api/widget/bootstrap          { publicKey, conversationId?, identity? }
POST /api/widget/messages           { publicKey, conversationId, content, identity? }
POST /api/widget/actions/confirm    { publicKey, conversationId, confirmed, identity? }
POST /api/widget/feedback           { publicKey, conversationId, rating: UP|DOWN }
```

Session (cookie-authenticated, `credentials: include`). Establishes *who* the
caller is; on its own it grants access to no workspace data:

```
GET   /api/auth/config              which sign-in methods this server offers
POST  /api/auth/signup              { name, email, password } -> sets session cookie
POST  /api/auth/login               { email, password }       -> sets session cookie
POST  /api/auth/logout              clears the cookie
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

Deferred per spec §13: SITEMAP crawling and FILE parsing (`501`), inline→worker
crawls, email channel, and real billing/checkout. Password-reset links have no
mail provider yet — outside production the link is returned in the response and
logged; in production the flow is a no-op until delivery is wired up. Plan
gating is enforced in the UI from `org.credits.plan`, not yet in the API.

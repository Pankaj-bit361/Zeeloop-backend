# Analytics (Mixpanel)

Mixpanel is the only product analytics tool. Two events are sent from this API, the dashboard only identifies people,
the marketing site records page views, and **nothing is sent for anyone who has not accepted analytics**.

## The tracking plan

| Event | Fires when | Properties | Where |
|---|---|---|---|
| `sign_up_completed` | An account is created (email and password, or the first Google/GitHub sign-in) | `sign_up_method` (`email`/`google`/`github`), `platform`, `is_invited` | `functions/auth/authFunctions.js` (`signup`, `_findOrCreateAccount`) → `productAnalytics/events.js` `announceSignUp` |
| `first_conversation_received` | A workspace's agent answers its **first real visitor**: the Value Moment. Evaluation runs (`conv_eval_…`) don't count, the same rule the lifecycle sweep uses for `conversation.first` | `org_id`, `channel` (`chat`/`email`), `days_since_signup` | `functions/chat/chatFunctions.js` `sendMessage` and `functions/email/inboundEmailFunctions.js`, after the reply → `announceFirstConversation` |
| `$mp_web_page_view` | A page on zealoop.com is viewed | Mixpanel's own | `Zealoop-landing/src/lib/analytics.ts` |

`first_conversation_received` is sent once per workspace: only the workspace's earliest real conversation counts, so a
workspace that had conversations before this shipped never sends it. It goes inline rather than from the hourly
lifecycle sweep, because the sweep spaces its tips 20 hours apart and runs only with `VOLANEA_LIFECYCLE_KEY`, which
would put a day's error into time-to-value.

Naming: `snake_case`, past tense. Booleans start with `is_`/`has_`. Numbers are sent as numbers. One event, one meaning;
if an event exists, extend it with a property instead of adding a near-duplicate.

## Identity

- Mixpanel's `distinct_id` is the Zealoop **account id** (`acc_…`). Never an email.
- The dashboard calls `identify(accountId)` when `/api/auth/me` succeeds (`Zealoop-frontend/src/lib/auth.tsx` →
  `lib/analytics.ts`), which happens every time the dashboard is opened, and `reset()` on sign-out and when the
  session is lost.
- The anonymous id lives in a cookie on `.zealoop.com`, so a visit to zealoop.com and the later sign-up on
  app.zealoop.com are one person. The profile keeps where they first came from (`initial_utm_*`, `initial_referrer`).
- No profile fields with a name or an email.
- Workspace events are attributed to the workspace **owner** (`Org.ownerEmail` → their account id).

## Consent (required before anything is sent)

1. The banner on zealoop.com and app.zealoop.com sets one cookie, `zealoop_consent=granted|denied` on `.zealoop.com`
   (180 days). A browser sending Global Privacy Control counts as `denied` without being asked.
2. The browser SDK is not even downloaded until `granted`.
3. The API reads the same cookie (`productAnalytics/mixpanel.js` `consentFromCookies`) and stores it on the account
   (`Account.analyticsConsent`, set at sign-up and updated on every `/api/auth/me`). `trackEvent` sends nothing unless
   it is `granted`. `null` (never asked, or not seen yet) sends nothing.
4. Withdrawing: the browser SDK opts out and resets at once, and the API stops at the account's next `/api/auth/me`.

The cookie name is shared by three repos (this one, `Zealoop-frontend/src/lib/consent.ts`,
`Zealoop-landing/src/lib/consent.ts`); change it in all three or not at all.

## What is deliberately not sent

No email, name, conversation text or visitor data, and no IP address (the browser SDK runs with `ip: false`, the API
sends `ip=0`), so events carry no location. Autocapture, session replay and automatic page views are off in the
dashboard.

## Where it runs

Production only. The browser SDK loads only on `zealoop.com` hosts. The API sends only when `NODE_ENV=production` (or
`MIXPANEL_TOKEN` is set on purpose). Local runs and tests send nothing. The project token is public by design (every page
ships it) and is baked in as a default so a missing variable can't silently turn analytics off; override it with
`MIXPANEL_TOKEN` (API), `VITE_MIXPANEL_TOKEN` (dashboard) or `NEXT_PUBLIC_MIXPANEL_TOKEN` (landing). `MIXPANEL_ENABLED=off`
switches the API's events off.

## Checks in the Mixpanel project (cannot be done from code)

- **Identity merge must be "Simplified API"** (Project settings → Identity merge). It is the default for projects created
  since April 2024; confirm it **before** real traffic, it cannot be changed safely afterwards.
- **Project timezone** is correct (also not changeable later).
- **Data residency:** if the project is in the EU or India, set `MIXPANEL_HOST` (`api-eu.mixpanel.com` /
  `api-in.mixpanel.com`) on the API and `VITE_MIXPANEL_API_HOST` / `NEXT_PUBLIC_MIXPANEL_API_HOST`
  (`https://api-eu.mixpanel.com`) on the dashboard and landing builds. Events sent to the wrong region do not appear.

## Adding an event

1. Check the table above. Reuse an event if one fits.
2. Track after the action succeeded (after the database write), from the API when it can see it.
3. Go through `trackEvent` (`functions/productAnalytics/mixpanel.js`); never call Mixpanel directly and never add a
   property that could identify a person or carry content.
4. Add a test to `tests/productAnalytics.test.js` for "sent once with consent, nothing without".
5. Update this table, then confirm the event in Mixpanel's Events view.

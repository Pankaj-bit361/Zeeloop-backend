# Customer lifecycle email

Zealoop sends its customers their lifecycle email through Volanea, from the "Zealoop" project there. That covers
onboarding, the trial, team and security notices, usage, things that broke, billing, reports and check-ins. This backend
says what happened, and the templates and workflows in that project decide what to send and when.

Some mail stays out of this:

- verification and password-reset links (`email/emailFunctions.sendAccountLink`);
- escalation notices and agent replies, which are product mail sent on a workspace's behalf.

```
events.js            the event catalog: every event and the fields it carries (the contract)
client.js            announce(): POST /v1/events with VOLANEA_LIFECYCLE_KEY; never throws
owner.js             who hears about a workspace (its owner) and their contact fields
hooks.js             inline events: sign-up, workspace, invites, security, billing, usage limits
rules.js             what's due for a workspace from a snapshot (pure, tested)
sweep.js             hourly: snapshot every workspace, announce what's due, remember it on Org.lifecycle
emails/layout.js     the look, from zealoop.com: warm wash, light Inter headline, eyebrow pill, check lists, light code cards, Zea, mono figure captions
emails/templates/    69 templates: start, trial, account, usage, billing, results, campaign bases
emails/workflows.js  47 workflows: what to send, how long to wait, when to stop
emails/sync.js       pushes templates and workflows into the Zealoop project in Volanea
```

## Guard rails

- **Once only.** A sweep event is flagged on the workspace only after Volanea accepted it, and a refused one is retried
  next hour. Five refusals in a row stop the run. Inline events are once by construction:
  - a conditional update (invite accepted, email verified, usage threshold stamped);
  - or a state transition (billing).
- **No flood for existing customers.** The first time the sweep sees a workspace older than 48 hours, it *baselines* it:
  whatever is already true is flagged without a word.
- **Spaced tips.** Notices (trial, failures, reports) always go. Tips and milestones go at most one per workspace every
  20 hours.
- **Never nudge blindly.** Every step after a delay is a check (test-enforced).
- **Evaluation runs aren't visitors.** Conversations with `conv_eval_` ids are never counted.
- **Plain values.** Counts, dates, percentages and plurals are written by the backend. A test checks that each template
  uses only its event's fields.

## Previewing

```
node scripts/emailPreview.js /tmp/zealoop-emails   # one HTML file per template + gallery.html
```

## Syncing

```
VOLANEA_LIFECYCLE_KEY=sk_test_… node scripts/emailSync.js --dry-run   # see what would change
VOLANEA_LIFECYCLE_KEY=sk_test_… node scripts/emailSync.js             # apply
```

The sync matches by name ("Zealoop · …") and writes only what changed. It creates workflows as **drafts** and never
changes whether one is live. Leftovers are reported, never deleted. A test key is enough: the rows are the project's real
rows; only sending is test-mode.

## Going live

The order matters: **workflows on before events flow.** Volanea drops events for draft workflows, and the sweep counts an
accepted event as told.

1. Sync, read the templates in Volanea, and send yourself tests.
2. Switch the workflows on in Volanea.
3. Set `VOLANEA_LIFECYCLE_KEY=sk_live_…` (the Zealoop project's live key) on the backend and deploy.
   - The hourly sweep (`LIFECYCLE_SWEEP_CRON`, default `17 * * * *`) runs on the scheduler instance.
   - Its first pass baselines every existing workspace silently.
   - From then on, the plain trial and dunning notices in `billing/subscriptionFunctions.js` are skipped, because the
     workflows send them.
4. Set `COMPANY_ADDRESS` in `emails/layout.js` once the legal entity is final (CAN-SPAM), then sync.

Kill switch: `LIFECYCLE_EMAILS=off` stops every lifecycle event without removing the key. The plain notices take over
again.

## Adding an email

1. Add the event and its fields to `events.js`, then the rule (`rules.js`) or the hook that raises it.
2. Add the template under `emails/templates/` and the workflow in `emails/workflows.js`.
3. Run `node scripts/runTests.js tests/lifecycleEmails.test.js tests/lifecycleSweep.test.js`. They fail on:
   - unknown fields;
   - a reserved event prefix (`email.`, `contact.`, `segment.`, `workflow.`);
   - dead ends;
   - a nudge without a check;
   - an event without a flow;
   - a template no flow sends.
4. Sync, review, switch the workflow on.

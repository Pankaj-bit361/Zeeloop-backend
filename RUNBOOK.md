# Backup and restore runbook

§8.3 asks for a runbook, tested at least once. This is that document, and the
verification section is the part that matters — an untested backup is a belief,
not a backup.

**Last tested:** not yet. Run §4 and record the date here.

---

## 1. What has to survive

Everything lives in one MongoDB database. There is no second datastore: no
Redis, no S3, no separate file storage. That is a deliberate simplification and
it makes this document short.

| Collection group | Reconstructable? | Notes |
|---|---|---|
| `orgs`, `accounts`, `members` | **No** | Identity and tenancy. Losing this loses everything else's meaning. |
| `knowledgesources`, `chunks` | Partly | Re-crawlable, but embeddings cost money and time to regenerate. |
| `conversations`, `messages` | **No** | Customer history. |
| `turntraces` | **No** | The eval set, the content-gap source, the cost attribution. Explicitly stated as unreconstructable in the model file. |
| `subscriptions`, `usagerecords` | **No** | Billing history. Disputes are settled from these. |
| Config collections (`guidancerules`, `attributes`, …) | **No** | The workspace's behaviour. |
| `configversions` | **No** | The only way back from a bad edit. |
| `auditlogs` | **No** | Evidence. Never purged by retention, and must never be restored selectively. |

Secrets are AES-256-GCM encrypted **with `ENCRYPTION_KEY`**, which lives in the
environment and **is not in the backup**. A restored database without that key
has unreadable widget secrets, action credentials and webhook secrets.

> **The single most important line in this document:** back up `ENCRYPTION_KEY`
> and `SESSION_SECRET` separately from the database, and store them somewhere
> that survives losing the AWS account. A database restore without them is a
> database of ciphertext.

---

## 2. Taking a backup

### Atlas (production)

Atlas takes continuous cloud backups on M10 and above. Verify, do not assume:

```
Atlas → Cluster → Backup → confirm "Continuous Cloud Backup" is ON
                          → confirm the retention window
```

On M0/M2/M5 there is **no** continuous backup. If production is on a shared
tier, the scheduled dump below is the only backup that exists.

### Scheduled dump (works on any tier)

```bash
# Run from somewhere that is NOT the app instance — a backup that dies with the
# server is not a backup.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

mongodump \
  --uri="$MONGODB_URI" \
  --archive="zealoop-$STAMP.archive" \
  --gzip

# Encrypt before it leaves the machine. The dump contains customer
# conversations and PII.
age -r "$BACKUP_PUBLIC_KEY" -o "zealoop-$STAMP.archive.age" "zealoop-$STAMP.archive"
rm "zealoop-$STAMP.archive"

aws s3 cp "zealoop-$STAMP.archive.age" "s3://$BACKUP_BUCKET/mongo/"
```

The S3 bucket should have versioning on and object-lock or a deny-delete policy.
A backup an attacker can delete is a backup that will be deleted first.

---

## 3. Restoring

### Restore to a scratch database first — always

Never restore over production. Restore beside it, verify, then decide.

```bash
age -d -i "$BACKUP_PRIVATE_KEY_FILE" -o restored.archive "zealoop-$STAMP.archive.age"

mongorestore \
  --uri="$SCRATCH_MONGODB_URI" \
  --archive=restored.archive \
  --gzip \
  --nsFrom='zealoop.*' --nsTo='zealoop_restored.*'
```

### Then

1. Point a local backend at the scratch database:
   ```bash
   MONGODB_URI="$SCRATCH_MONGODB_URI" NEW_RELIC_ENABLED=false npm start
   ```
2. Watch the boot output. Two things must appear:
   - `IndexReadiness:ensureCriticalIndexes: all uniqueness constraints active`
   - either the Atlas search index confirmation, or the loud
     `HYBRID SEARCH IS DISABLED` box (expected on a non-Atlas scratch instance —
     see §5).
3. `curl localhost:4000/health/deep` and confirm `database: ok`.
4. Work through §4.

---

## 4. Verification checklist — this is the test

A restore is not verified because `mongorestore` exited 0. Check each of these
against the scratch instance:

- [ ] **Sign in works.** `POST /api/auth/login` with a known account returns a
      session. This proves `accounts` and `SESSION_SECRET` agree.
- [ ] **A widget secret decrypts.** Reveal one in the dashboard. If it fails,
      `ENCRYPTION_KEY` does not match the data — stop and find the right key.
- [ ] **An identified conversation still resolves.** Call
      `POST /api/widget/bootstrap` with a signed `identify()` payload and
      confirm `identityVerified: true`. This exercises the encrypted secret end
      to end.
- [ ] **Counts are plausible.** Compare `conversations`, `messages` and
      `turntraces` counts against production. A restore missing a collection
      shows up here and nowhere else.
- [ ] **The most recent conversation is recent.** Confirms you restored the
      backup you meant to.
- [ ] **Config objects survived.** At least one LIVE guidance rule, and its
      version history.
- [ ] **Search indexes.** On Atlas, confirm `chunk_vector_index` and
      `chunk_text_index` exist on the restored namespace — see §5.
- [ ] **An action still executes.** Its credential decrypts, which re-proves the
      key across a second code path.

Record the date and the person at the top of this file.

---

## 5. The Atlas search index trap

**Search indexes are not part of a `mongodump`.** A restored database has the
documents and none of the Atlas Search indexes.

Without them, retrieval returns nothing, the agent abstains from every question,
and the product looks like an empty knowledge base rather than a broken one.
This is exactly the failure `healthFunctions.assertSearchIndexes()` shouts about
at boot — believe the box.

After any restore to an Atlas cluster, recreate both indexes on the `chunks`
collection. Definitions are in `backend/README.md`. Index builds take minutes on
a large corpus; the agent abstains until they finish.

---

## 6. Recovery targets

| | Target | Reality today |
|---|---|---|
| **RPO** (data loss) | 1 hour | Continuous backup on Atlas M10+; the dump schedule otherwise. |
| **RTO** (downtime) | 4 hours | Dominated by the search index rebuild, not by the restore. |

Both are stated as targets rather than guarantees, because neither has been
measured against a real restore yet. Do §4 and replace this sentence.

---

## 7. Scenarios

**A workspace deleted something by accident.** Do not restore the whole
database. Config objects have version history (`§2.5`) — restore the object.
Conversations deleted by retention purge are gone by design; that is what the
policy asked for.

**The database is corrupted or ransomed.** Restore to a new cluster from the
most recent verified backup, run §4, repoint `MONGODB_URI`, rebuild search
indexes. Do not delete the compromised cluster until the restore is verified.

**`ENCRYPTION_KEY` was lost.** The database is intact and every encrypted field
is unreadable. Widget secrets, action credentials and webhook secrets must all
be reissued. There is no recovery path — this is why the key is backed up
separately.

**`SESSION_SECRET` was rotated or lost.** Every existing session cookie stops
verifying and everyone is signed out. Sign-in works again immediately. This is
inconvenient, not damaging — and it is the correct response to a suspected
leak.

---

## 8. What is deliberately not backed up

- **Node modules and build artefacts.** Rebuilt from the lockfile.
- **New Relic and Sentry data.** Observability, not a system of record.
- **The widget bundle.** Rebuilt from source.
- **Environment variables**, other than the two named in §1. Everything else is
  reconstructable from the deployment configuration, and storing a full
  environment dump means storing every third-party key in one more place.

---

## 9. Deploying an index change

Eight indexes were added for query performance (§ the `queryPlans` test suite
names every query they serve). On a **fresh** database this is invisible.
On the existing production cluster it is not, and the difference matters:

**Mongoose builds indexes in the background on connect.** The first boot after
this deploy will build eight indexes over collections that already hold data.
Until each finishes, its queries fall back to the plan they used before — so
the app is correct throughout, just no faster yet.

What to expect on Atlas:

- Build time scales with collection size. `conversations`, `messages`,
  `turntraces` and `chunks` are the large ones.
- Background builds take I/O and RAM. On a small tier this can be felt as
  elevated latency while they run. Deploy it when a few minutes of extra load
  is acceptable, not during a peak.
- Nothing needs to be done by hand. Do not pre-create them; mongoose will.

To confirm afterwards, from the Atlas shell:

```js
db.conversations.getIndexes()   // expect orgId_1_createdAt_-1 and resolution_sweep
db.chunks.getIndexes()          // expect orgId_1_sourceId_1_position_1
db.subscriptions.getIndexes()   // expect status_1_trialEndsAt_1
```

**One index is partial.** `resolution_sweep` on `conversations` covers only
documents where `isResolved: false` and `hasHumanReply: false`, which is what
keeps it small on a collection that grows forever. If the autonomous-resolution
cron's filter is ever changed so it no longer includes both of those equalities,
the index silently stops being used and the cron goes back to scanning the
collection. `tests/queryPlans.test.js` fails if that happens.

**The plan tests drop and rebuild indexes.** They run against their own
database (`zealoop_plans_test`). Never point `TEST_MONGODB_URI` at production.

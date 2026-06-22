# DenchClaw CRM cutover — execution record + Prompt D ops runbook
Date: 2026-06-20. This records the engine-cutover work (Prompts A/B/C) executed in a single
ClaudeCowork session, the one extra fix found during review, how it was verified, and the
operator runbook for Prompt D (staging deploy) that the agent cannot run itself.

## TL;DR
- **A (outreach producer)** — already code-complete + committed on `outreach/cp1-cp4-auth-deploy`
  (verified, not re-done).
- **B (content producer)** — DONE: `engager.py` now calls `crm.enqueue_handoff(target_engine=None)`;
  added FK-relax + partial-index migrations.
- **C (nurturing consumer)** — DONE: `dispatcher.drain_handoffs` rewritten to claim → enroll → complete
  with a crash-after-claim sweep; added two backend-agnostic client helpers + FK-relax migration.
- **Extra fix (found in review)** — the postgres backend's `enqueue_handoff` needed partial unique
  indexes on the engine-DB `prospect_inbox` that didn't exist; added idempotent, data-safe migrations
  so the "single backend-agnostic path" actually holds under `CRM_BACKEND=postgres` (rollback safety).
- **Verified** end-to-end (25/25 checks) against a faithful in-memory mock of the CRM contract using
  the REAL `automation_core.crm` api client + REAL nurturing `drain_handoffs`. The live host CRM on
  `:3100` and a real Postgres were NOT reachable from the build sandbox, so the live e2e + `pytest`
  against real Postgres remain operator steps (below).

## Decision recorded: architectural option (a)
Per the "ONE architectural decision" in `SESSION_HANDOFF_2026_06_19_DENCHCLAW_CUTOVER.md`, all three
engines adopt **option (a)**: under `CRM_BACKEND=api`, `contact_id` is an opaque CRM id and each
engine-DB `campaign_events.contact_id → contacts` FK is dropped (kept the column + index for analytics).
`campaigns`/`campaign_events` stay in the engine DB; claim→work→complete is intentionally NOT atomic
across CRM+engine DB, so the flow is claim → engine-side enroll → complete, with a sweep that reverts
rows stuck in `claimed` past a timeout.

## Exact changes (for targeted `git add` — shared trees; never commit to YOGI)
**outreach-engine** (branch `outreach/cp1-cp4-auth-deploy`)
- NEW `backend/migrations/032-prospect-inbox-partial-unique-indexes.sql` (the extra fix; companion to the
  already-committed `031-relax-campaign-events-contact-fk.sql`).
- (Prompt A code in `router.py`/`repo.py` already committed — nothing to re-stage.)

**content-engine** (branch `main`)
- `backend/app/engager.py` — `campaigns_db.push_prospect(...)` → `crm.enqueue_handoff(target_engine=None, ...)`.
- NEW `backend/migrations/003-relax-campaign-events-contact-fk.sql` (option (a) FK relax).
- NEW `backend/migrations/004-prospect-inbox-partial-unique-indexes.sql` (the extra fix).

**nurturing-engine** (branch `main`)
- `backend/app/dispatcher.py` — `drain_handoffs` rewritten (claim/complete + `_sweep_stale_claims`);
  added `from automation_core import crm` and `import os`.
- NEW `backend/migrations/011-relax-campaign-events-contact-fk.sql` (option (a) FK relax).
- DO NOT stage `.specs/NURTURING_ENGINE_SPEC.md` — that change pre-existed this session (another
  session's work). Stage only `backend/app/dispatcher.py` + the new migration.

**pro-workflows / automation_core** (branch `outreach/automation-core-fixes`)
- `automation_core/crm.py` — added public `get_contact(company_id, contact_id)` and
  `add_contact_tags(company_id, contact_id, tags)` (backend-agnostic; both backends implement
  `find_by_id`/`update`).
- `automation_core/campaigns.py` — deprecation comment only above `push_prospect` (the standalone
  `push/poll/mark` lost their last engine call-sites; left in place for a coordinated later removal).

> Note: the build sandbox's git index was read-only, so nothing was committed here — staging/committing
> per the targeted-add rules above is an operator step. Use `git add -p` where a file mixes this work
> with other in-flight hunks.

## How it was verified (in-sandbox, no live deps)
A faithful mock of the CRM prospect-inbox + minimal contacts endpoints (matching
`denchclaw-crm/server/routes/crm.js` semantics: idempotent enqueue with done→pending reset, atomic claim
by `created_at ASC`, target_engine-OR-NULL list, claimed_at on transitions) was driven by the REAL
`automation_core.crm` api backend and the REAL `dispatcher.drain_handoffs`. 25/25 checks passed:
- Producer: targeted (`target_engine="nurturing"`) and broadcast (`target_engine=None`) rows enqueue with
  correct `source_engine`/`metadata`.
- Consumer: a single drain claims BOTH targeted + broadcast rows, tags the CRM contact `nurture:<campaign>`,
  writes one `enrolled` campaign_event per contact (correct `dedupe_key`), and transitions rows to `enrolled`.
- Idempotency: re-running the drain claims nothing and writes no new events.
- Crash-after-claim: with the engine-DB write forced to throw, the row is left `claimed` (not lost);
  the next pass's `_sweep_stale_claims` reverts it to `pending` and re-drains it to `enrolled`.
A second reviewer ("critic") pass returned SHIP-WITH-NITS; the one Medium finding (postgres partial
indexes) was fixed (migrations above), the nits addressed (docstring caveat on `add_contact_tags`).

## Known follow-up (out of scope for Prompt C — flag for the next checkpoint)
Under `CRM_BACKEND=api`, the nurturing **send side** (`dispatcher.run_campaign` → `contacts_db.list_contacts`)
still reads enrolled contacts from the **engine DB**, but enrollment now tags the contact in the **CRM**.
So after this cutover the consumer INTAKE is correct, but the send loop's contact source must also move
onto the CRM (or adopt option (c)) before nurturing actually sends under the api backend. This change
deliberately cuts over only the consumer intake, exactly as Prompt C scoped it.

---

## PROMPT D — staging deploy / ops (operator actions; run on the host/VM, not the agent)
```
GOAL: roll the DenchClaw CRM contract + engine cutovers to staging.

# 1. Apply the CRM-owned migration to the live denchclaw DB (CRM agent never runs DDL on it):
psql "$DENCHCLAW_DATABASE_URL" -f denchclaw-crm/migrations/002_prospect_inbox.sql
#   (creates prospect_inbox + its two partial unique indexes + indexes; idempotent / IF NOT EXISTS).

# 2. Apply the NEW engine-DB migrations to EACH engine's OWN database (separate DBs).
#    These auto-run on engine boot via the FastAPI lifespan migration runner, OR apply manually:
psql "$OUTREACH_DATABASE_URL"   -f outreach-engine/backend/migrations/031-relax-campaign-events-contact-fk.sql
psql "$OUTREACH_DATABASE_URL"   -f outreach-engine/backend/migrations/032-prospect-inbox-partial-unique-indexes.sql
psql "$CONTENT_DATABASE_URL"    -f content-engine/backend/migrations/003-relax-campaign-events-contact-fk.sql
psql "$CONTENT_DATABASE_URL"    -f content-engine/backend/migrations/004-prospect-inbox-partial-unique-indexes.sql
psql "$NURTURING_DATABASE_URL"  -f nurturing-engine/backend/migrations/011-relax-campaign-events-contact-fk.sql
#   (all idempotent: IF EXISTS / IF NOT EXISTS; the partial-index migrations de-dupe broadcast rows first.)

# 3. Auth/isolation — DECIDED 2026-06-19: keep the SINGLE shared key for now (isolation deferred).
#    Leave INTERNAL_API_KEYS UNSET → INTERNAL_API_KEY falls back to "*"; NO engine .env key changes.
pm2 restart denchclaw-crm && curl -s http://127.0.0.1:3100/health

# 4. Restart the engines AFTER their cutover PRs merge + deploy (so the lifespan runner applies migrations):
pm2 restart outreach-engine-py nurturing-engine content-engine-py

# 5. Staging smoke (mirrors the in-sandbox 25/25 run, against the real CRM):
#    CRM_BACKEND=api CRM_API_BASE=http://127.0.0.1:3100 CRM_API_KEY=<shared key>
#    a) create/find a contact via the CRM
#    b) POST /api/crm/prospect-inbox {contact_id, target_engine:"nurturing", source_engine:"outreach"}
#    c) run the nurturing drain (dispatcher.drain_handoffs / the cron one-shot)
#    d) GET /api/crm/prospect-inbox?status=enrolled → the row transitioned pending→claimed→enrolled,
#       the contact carries the nurture:<campaign> tag, and exactly one enrolled campaign_event exists.
#    e) re-run the drain → no change (idempotent).
#    Also confirm a content broadcast: engager path enqueues target_engine=NULL and the nurturing drain
#    claims it (broadcast is claimable by any engine).

CONSTRAINTS: never commit to YOGI; the denchclaw DB is the only DB the CRM touches.
```

## Sequencing
Merge CRM PR #1 + the `automation_core/crm.py` additions first → **D step 1–2** (migrations) →
**A/B/C PRs** merge/deploy → **D step 3–4** (restarts) → **D step 5** (staging smoke). Then schedule the
send-side follow-up (above) as the next checkpoint.

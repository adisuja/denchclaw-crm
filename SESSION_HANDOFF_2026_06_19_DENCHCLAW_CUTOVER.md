# Handoff — DenchClaw CRM cutover (ClaudeCowork session prompts)

Date: 2026-06-19. These are the remaining pieces of the DenchClaw CRM build that are **blocked for the
CRM session** (live engine repos under concurrent edit + staging ops) and should run as their own
ClaudeCowork sessions. Each prompt below is **self-contained** — paste it into a fresh session.

## What is already DONE (do not redo)
- **CRM server** (`denchclaw-crm`, PR [#1](https://github.com/adisuja/denchclaw-crm/pull/1)): key→company auth binding
  (`INTERNAL_API_KEYS`), per-row company scoping (404), CRM-owned `prospect_inbox` (`migrations/002_prospect_inbox.sql`)
  with `POST /api/crm/prospect-inbox`, `POST /api/crm/prospect-inbox/claim`, `GET /api/crm/prospect-inbox`,
  `PATCH /api/crm/prospect-inbox/:id`, and `GET /api/crm/pipeline/transitions`. Contract test `test/contract.mjs` 19/19.
  Authoritative contract: `denchclaw-crm/docs/API_CONTRACT.md`.
- **Client** (`pro-workflows/automation_core/crm.py`, on `main`): unified handoff interface on BOTH backends —
  `enqueue_handoff(company_id, contact_id, *, target_engine=None, source_engine=None, suggested_campaign=None, metadata=None)`,
  `claim_handoffs(company_id, *, target_engine=None, limit=1, claimed_by=None)`,
  `list_handoffs(...)`, `complete_handoff(company_id, inbox_id, *, status="done", claimed_by=None)`.
  Also `advance_stage` now defers to the CRM (raises `CrmStageError` on illegal transitions; no client-side linear guard),
  and `add_contact_activity`/`advance_stage`/`get_activity` take an optional `company_id`.

## Local CRM left running for A/B/C verification (no need to stand up your own)
A throwaway CRM is up on this machine so the engine cutovers can verify end-to-end immediately:
- **Base URL:** `http://127.0.0.1:3100`  ·  **Health:** `GET /health`
- **Key (acts for any company, '*'):** `CRM_API_KEY=cp1-main-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- **DB:** throwaway Postgres `denchclaw` in Docker container `denchclaw-crm-test` on host `:5434`
  (`migrations/002_prospect_inbox.sql` already applied).
- To verify a cutover: `CRM_BACKEND=api CRM_API_BASE=http://127.0.0.1:3100 CRM_API_KEY=<above>` then exercise
  the engine path and `GET /api/crm/prospect-inbox`.
- Teardown when all engine cutovers are verified: `docker rm -f denchclaw-crm-test` + kill the `:3100` node process.

## The ONE architectural decision the cutover must resolve (read before any engine prompt)
Under `CRM_BACKEND=api`, **contacts live in the denchclaw CRM DB**, but each engine's
`campaigns` + `campaign_events` tables live in the **engine's own DB**. The nurturing consumer today
enrolls a contact and writes a `campaign_events` row keyed by `contact_id` **in the engine DB** — that
`contact_id` will no longer exist in the engine DB once contacts are CRM-owned. So moving `prospect_inbox`
to the CRM splits a previously-single-DB workflow. Pick ONE per engine (document the choice):
- **(a) Loose-couple:** drop/relax the engine-DB FK from `campaign_events.contact_id`→`contacts` and treat
  `contact_id` as an opaque CRM id. Smallest change; keeps analytics working; no cross-DB transaction.
- **(b) Mirror:** keep a thin local `contacts` shadow synced from the CRM. More moving parts.
- **(c) Move campaigns/campaign_events to the CRM too.** Cleanest long-term, largest blast radius — likely a
  separate program, not this cutover.
Recommended default: **(a)** for this cutover; revisit (c) later. Whatever you pick, the claim→work→complete
flow is **not** atomic across CRM+engine DB — so use claim (sets `claimed`), do engine-side work, then
`complete_handoff(status="enrolled")`; on failure leave it `claimed` and add a re-drain that reclaims rows
stuck in `claimed` past a timeout (or revert to `pending`).

---

## PROMPT A — Outreach engine: cut the handoff PRODUCER over to the CRM
```
You are working in /Users/adithyamurali/outreach-engine (Python/FastAPI, consumes automation_core).
GOAL: when CRM_BACKEND=api, the outreach→nurturing handoff must go through the CRM-owned prospect_inbox
over HTTP instead of the engine-local DB.

Context: automation_core.crm now exposes enqueue_handoff(company_id, contact_id, *, target_engine,
source_engine, suggested_campaign, metadata). The producer today is backend/app/router.py
:_handoff_to_nurturing, which calls repo.push_prospect(...) (engine DB). repo.push_prospect lives in
backend/app/repo.py.

DO:
1. In _handoff_to_nurturing, replace the repo.push_prospect(...) call with
   crm.enqueue_handoff(company_id, contact_id=str(contact["id"]), target_engine="nurturing",
   source_engine="outreach", suggested_campaign=evt.get("suggested_campaign"),
   metadata={"reason": evt.get("event_type"), "from_campaign": evt.get("campaign_id")}).
   Keep the existing repo.enqueue_nurture(...) call (separate nurture queue) unchanged.
2. Keep it backend-agnostic: under CRM_BACKEND=postgres, enqueue_handoff already writes the engine DB,
   so a single code path works for both. Do NOT dual-write.
3. Read the "ONE architectural decision" in SESSION_HANDOFF_2026_06_19_DENCHCLAW_CUTOVER.md (in the
   denchclaw-crm repo) and confirm campaign_events writes still work; if outreach writes campaign_events
   keyed by contact_id, apply option (a) (relax the FK) in its migrations.
4. Remove now-dead repo.push_prospect if nothing else calls it (grep first).

VERIFY (Karpathy Layer 2 — eval up front + Codex critic + external signal):
- Start the CRM (see denchclaw-crm/docs/API_CONTRACT.md / the verification-runtime memory) and run an
  end-to-end: trigger the outreach event that calls _handoff_to_nurturing with CRM_BACKEND=api, then
  GET /api/crm/prospect-inbox?target_engine=nurturing and assert the row exists.
- Run the existing outreach tests. Have the Codex `critic` subagent review the diff.
CONSTRAINTS: never edit the live DB directly (migration files only); never commit to YOGI; this repo's
working tree may be shared with other sessions — commit only your own files (targeted git add).
```

---

## PROMPT B — Content engine: cut the handoff PRODUCER over to the CRM
```
You are working in /Users/adithyamurali/content-engine (Python/FastAPI, consumes automation_core).
GOAL: route the content→prospect broadcast handoff through the CRM-owned prospect_inbox when
CRM_BACKEND=api.

Context: the producer is backend/app/engager.py (~line 107), which calls
campaigns_db.push_prospect(source_engine="content", target_engine=None, suggested_campaign="content_prospect", ...)
— a BROADCAST handoff (target_engine=None). engager.py already uses crm.find_or_create_contact and
crm.add_contact_activity. automation_core.crm.enqueue_handoff supports target_engine=None (broadcast =
claimable by any engine, first-claim-consumes).

DO:
1. Replace the campaigns_db.push_prospect(...) call with
   crm.enqueue_handoff(company_id, contact_id=str(contact["id"]), target_engine=None,
   source_engine="content", suggested_campaign="content_prospect", metadata=<existing metadata>).
2. Single code path for both backends (enqueue_handoff handles postgres too). No dual-write.
3. Read the "ONE architectural decision" in denchclaw-crm/SESSION_HANDOFF_2026_06_19_DENCHCLAW_CUTOVER.md;
   apply option (a) if content writes campaign_events keyed by contact_id.

VERIFY: with the CRM running and CRM_BACKEND=api, run the engager path and assert a broadcast row appears
via GET /api/crm/prospect-inbox (target_engine null) and is claimable. Run content-engine tests. Codex
critic on the diff.
CONSTRAINTS: never edit the live DB directly; never commit to YOGI; targeted git add (shared checkout).
```

---

## PROMPT C — Nurturing engine: cut the handoff CONSUMER over to the CRM (the hard one)
```
You are working in /Users/adithyamurali/nurturing-engine (Python/FastAPI, consumes automation_core).
GOAL: the consumer must drain handoffs from the CRM-owned prospect_inbox over HTTP when CRM_BACKEND=api,
preserving enroll + campaign_event logging.

Context: backend/app/dispatcher.py:drain_handoffs today does, in ONE engine-DB transaction:
campaigns_db.poll_prospects → for each: find an active campaign → contacts_db.get_contact → tag contact →
campaigns_db.log_event(event_type="enrolled") → campaigns_db.mark_prospect(status="enrolled").
automation_core.crm now exposes claim_handoffs / complete_handoff / list_handoffs.

CRITICAL — read the "ONE architectural decision" section in
denchclaw-crm/SESSION_HANDOFF_2026_06_19_DENCHCLAW_CUTOVER.md FIRST. Under CRM_BACKEND=api, contacts live
in the CRM DB but campaigns/campaign_events live in the engine DB, and claim+enroll is NOT atomic across
the two. Adopt option (a) (treat contact_id as an opaque CRM id; relax the engine-DB campaign_events FK)
unless you have a strong reason otherwise, and document the choice.

DO (rewrite drain_handoffs to be backend-agnostic):
1. Claim instead of poll-then-mark:
   claimed = await crm.claim_handoffs(company_id, target_engine="nurturing", limit=N, claimed_by="nurturing")
   (this also drains broadcast/NULL-target rows). claim atomically sets status='claimed'.
2. For each claimed row: resolve the campaign (suggested_campaign or first active), fetch the contact via
   crm.find_contact_by_email / contacts query as appropriate, tag it, write the enrolled campaign_event,
   then await crm.complete_handoff(company_id, row["id"], status="enrolled", claimed_by="nurturing").
3. Failure handling: if engine-side work throws after claim, leave the row 'claimed' and add a sweep that
   reclaims rows stuck in 'claimed' beyond a timeout (or PATCH them back to 'pending'). Make enrollment
   idempotent (the campaign_events dedupe_key already guards double-enroll).
4. Remove dead campaigns_db.poll_prospects/mark_prospect/push_prospect usage if nothing else calls them;
   coordinate with automation_core (campaigns.py standalone push/poll/mark are slated for removal).

VERIFY: with the CRM running + CRM_BACKEND=api, enqueue a handoff (POST /api/crm/prospect-inbox
target_engine=nurturing), run drain_handoffs, assert: the contact is enrolled, a campaign_event row is
written once (idempotent on re-run), and the prospect row is 'enrolled' (GET /api/crm/prospect-inbox).
Test the crash-after-claim path (row not lost). Run nurturing tests. Codex critic on the diff.
CONSTRAINTS: never edit the live DB directly (migration files only); never commit to YOGI; targeted git add.
```

---

## PROMPT D — Staging deploy / ops (operator actions the agent can't do)
```
GOAL: roll the DenchClaw CRM contract changes to staging.

1. Apply the new migration to the live denchclaw DB (the CRM agent never runs DDL on it):
   psql "$DENCHCLAW_DATABASE_URL" -f denchclaw-crm/migrations/002_prospect_inbox.sql
   (creates prospect_inbox + its two partial unique indexes + indexes; idempotent / IF NOT EXISTS).
2. Auth/isolation — DECIDED 2026-06-19: keep the SINGLE shared key for now (isolation deferred).
   Leave INTERNAL_API_KEYS UNSET → the existing single INTERNAL_API_KEY falls back to "*" (any company),
   i.e. no behavior change and NO engine .env key changes needed. (Row-scoping 404s still apply; only the
   403 key→company binding is deferred.) Restart: pm2 restart denchclaw-crm && curl -s http://127.0.0.1:3100/health
   To turn on real isolation later: set INTERNAL_API_KEYS={"<key>":["<company>"]} per tenant and update
   each engine's CRM_API_KEY to match — that's a separate follow-on.
3. Engine .env (outreach/nurturing/content) already have CRM_BACKEND=api + CRM_API_BASE + CRM_API_KEY
   (per the SESSION_5 addendum). After the engine-cutover PRs (Prompts A/B/C) merge + deploy, restart the
   engines: pm2 restart outreach-engine-py nurturing-engine content-engine-py.
4. Smoke on staging: create a contact via CRM_BACKEND=api, enqueue a handoff, claim it, confirm 200s and
   the row transitions pending→claimed→enrolled.
CONSTRAINTS: never commit to YOGI; the denchclaw DB is the only DB the CRM touches (isolated from YOGI's).
```

---

## Sequencing
Merge the CRM PR (#1) and the `automation_core/crm.py` changes first → run **Prompt D step 1–2** (migration
+ keys) → then **Prompts A, B, C** (engine cutovers, any order; C depends on A/B producing rows to test) →
**Prompt D step 3–4** (engine restart + staging smoke). Each engine cutover closes with its own `/verify`.

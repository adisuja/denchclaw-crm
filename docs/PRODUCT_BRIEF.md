# DenchClaw CRM — Product Brief

> Layer 1 (Karpathy SPEC). The shared backend the three automation engines integrate with,
> part of **Pro Workflows** — separate from YOGI. This brief defines *what the CRM must be
> for the engines* and what "the API contract is done" means. It is the goal-anchor every
> later spec and checkpoint hangs off.
>
> Authored 2026-06-19. Status: **agreed scope** (see "Decisions locked" below).

---

## 1. Why this exists (the goal)

Three automation engines — **outreach-engine**, **nurturing-engine**, **content-engine** — drive
prospects through a sales pipeline. They need one shared system of record for *who the contact is*,
*what's happened to them*, *where they are in the pipeline*, and *which engine should work them next*.

That system of record is the **DenchClaw CRM**: a standalone Node/Express microservice with its own
isolated `denchclaw` Postgres database, reached by the engines over HTTP via
`automation_core/crm.py` when `CRM_BACKEND=api`.

The decision this work drives: **can the engines trust `CRM_BACKEND=api` as the production path
for all CRM operations — including cross-engine handoff — instead of direct Postgres?** Today
`CRM_BACKEND=postgres` works; `api` is the upgrade that lets the CRM evolve independently of the
engines' database. The contract is "done" when an engine operator can flip `CRM_BACKEND=api` and
lose nothing.

**Non-negotiable constraints**
- The CRM owns its own `denchclaw` DB; it is **completely isolated from YOGI's DB**.
- **Never commit to YOGI.** This work lives in `denchclaw-crm` (CRM server) and `pro-workflows`
  (`automation_core/crm.py` client). YOGI is untouched.
- **The agent never edits the live CRM database directly.** Schema changes ship as **migration
  files** in this repo (`migrate.sql` / `migrations/*.sql`) that a human operator applies. The
  agent authors DDL; it does not execute DDL against the running `denchclaw` DB.

---

## 2. What the CRM must be for the engines

### 2.1 The 11-stage pipeline

The pipeline is **a state machine, not a linear ladder.** The CRM is the authoritative owner of
which transitions are legal. The 11 stages:

```
lead · contacted · qualified · no_show · unqualified · proposal ·
proposal_accepted · negotiation · onboarding · won · lost
```

Authoritative transition map (`DEFAULT_STAGE_TRANSITIONS`, server-side; overridable per-company via
`crm_pipeline_configs`):

| From | Allowed → |
|---|---|
| lead | contacted, unqualified, lost |
| contacted | qualified, unqualified, lost |
| qualified | proposal, no_show, unqualified, lost |
| no_show | contacted, qualified, lost |
| unqualified | lead, contacted, lost |
| proposal | proposal_accepted, negotiation, lost |
| proposal_accepted | negotiation, onboarding, lost |
| negotiation | won, lost |
| onboarding | won, lost |
| won | *(terminal)* |
| lost | lead *(reactivation)* |

This deliberately supports moves a strictly-linear model cannot: **reactivation** (`lost→lead`),
**lateral recovery** (`no_show→contacted`), and **disqualification from anywhere** (`*→lost`).
A linear forward-only model would wrongly block these and wrongly permit stage-skipping.

**Authority decision:** the **CRM is authoritative**. `automation_core.advance_stage` drops its
linear `STAGE_ORDER` forward-only guard and trusts the CRM — an illegal transition returns HTTP 400
with `{ error, allowed_transitions, current_stage }`, which the client surfaces rather than
second-guessing. (Forward-only intent, where engines want it, is expressed by *which* target they
request, not by a client-side index comparison that disagrees with the server.)

### 2.2 The contact / activity / deal model

**Contact** — the core record (`contacts` table). Identity + pipeline position + scoring:
`id, company_id, name, email, phone, company_name, title, linkedin_url, source, lead_score
(hot/warm/neutral/cold/negative) + lead_score_numeric, deal_stage, deal_value, tags[], utm_*,
metadata, last_contacted, next_follow_up`. Dedup on email, then linkedin_url, then phone.

**Activity** — the append-only feed per contact (`contact_activity` table): `type, message, agent,
channel, data, engagement_id, created_at`. Activity is how engines report what they did
(email_opened, call_booked, payment, …); recognized types bump `lead_score_numeric` via
`ENGAGEMENT_WEIGHTS`.

**Deal** — optional revenue object (`deals` table), its own stage/value/probability lifecycle,
linkable to a contact. Deal stage changes write a `deal_stage_change` activity onto the linked
contact.

**Pipeline config** — `crm_pipeline_configs` lets a company override stages/transitions; the server
falls back to defaults when absent (60s cache).

### 2.3 The shared `prospect_inbox` handoff contract — **IN SCOPE (build), cutover PHASED**

When one engine finishes with a contact, it hands it to the next engine by enqueuing a
`prospect_inbox` row. **Reality discovered during grounding:** this is *not* one shared table — each
engine has its own `prospect_inbox` (+ `campaigns`, `campaign_events`) in its **own** DB, with
repo-local producer/consumer code (outreach `repo.push_prospect` + `router._handoff_to_nurturing`;
nurturing `dispatcher.drain_handoffs`). The consumer enrolls the contact into a campaign and writes a
`campaign_events` row **in the same engine-DB transaction** — so `prospect_inbox` is locality-coupled
to `campaigns`/`campaign_events`/`contacts`. `automation_core.campaigns.push_prospect` exists but has
no callers (in_degree 0).

Therefore **scope is phased** (agreed):
- **This pass:** `prospect_inbox` becomes a **CRM-owned resource** — table (via migration) + HTTP
  endpoints + **one unified `automation_core.crm` client interface** (api backend → CRM HTTP;
  postgres backend → DB), proven by contract tests. This delivers the contract; nothing in the live
  engines is rewired yet.
- **Follow-on (separate checkpoints, one engine at a time, each its own /verify):** rewire each
  engine's producer/consumer off its repo-local handoff code onto the unified client. Deferred
  because moving only `prospect_inbox` across the DB boundary would split the consumer's
  enroll+log_event transaction; that cross-DB question is resolved per-engine, not here.

Schema (CRM-owned, FK → CRM `contacts.id`), reconciled with the existing engine-side semantics:
```
id, company_id, contact_id, source_engine, target_engine (NULLABLE → broadcast handoff),
suggested_campaign, status (pending|claimed|enrolled|done), claimed_by, metadata,
created_at, claimed_at
UNIQUE(contact_id, target_engine)   ·   INDEX(company_id, target_engine) WHERE status='pending'
```

Contract semantics:
- **Enqueue** — idempotent on `(contact_id, target_engine)`. Re-enqueue of a `pending`/`claimed` row
  refreshes metadata only (never yanks an in-flight row). Re-enqueue of a `done` row **resets it to
  `pending`** (clearing `claimed_by`/`claimed_at`) so a contact can be re-handed-off (e.g. after
  reactivation `lost→lead`). Never a duplicate or 500.
- **Claim** — a target engine atomically claims the oldest pending row(s) for its engine + company
  via `FOR UPDATE SKIP LOCKED` (no double-claim under concurrency). This is a new, stronger API than
  the engine-side poll-then-mark; plain list/poll stays available.
- **List / complete** — inspect by engine + status; transition to `done`.

Schema ships as a migration file applied by the operator (per §1 constraint).

---

## 3. The `CRM_BACKEND=api` HTTP contract

The engines never speak SQL under `api`; they call these endpoints (base `/api/crm`, auth
`X-Internal-Key` + `X-Company-Id`). The client is `automation_core._ApiBackend`.

| Op | Method · Path | Notes |
|---|---|---|
| Find by email | `GET /contacts?search=<email>` | client filters for exact email match |
| Create / upsert | `POST /contacts` | dedup email→linkedin→phone; `company`↔`company_name` mapping |
| Read by id | `GET /contacts/:id` | **must be company-scoped** |
| Update | `PATCH /contacts/:id` | allow-listed fields; **company-scoped** |
| Advance stage | `PATCH /contacts/:id {deal_stage}` | state-machine guard; 400 on illegal transition |
| Add activity | `POST /contacts/:id/activity` | bumps lead score; **company-scoped** |
| List activity | `GET /contacts/:id/activity` | **company-scoped** |
| Enqueue handoff | `POST /prospect-inbox` | idempotent on (contact_id, target_engine) |
| Claim handoff | `POST /prospect-inbox/claim` | atomic, per target_engine + company |
| List handoffs | `GET /prospect-inbox?target_engine=&status=` | |

There is **no** `POST /contacts/:id/stage` endpoint (the old contract doc's stub is fiction);
stage advancement is `PATCH /contacts/:id`.

### Multi-tenant isolation — **IN SCOPE (two layers)**
The Codex critic correctly flagged that row-scoping alone is **not** real isolation: the CRM uses one
shared `INTERNAL_API_KEY` and trusts `X-Company-Id` verbatim ([auth.js:33](server/middleware/auth.js)),
so any keyholder can read company B by setting the header to B. We close this with **two layers**:

1. **Auth binding (the real control):** bind the API key to an allowed company set server-side;
   reject (`403`) any request whose `X-Company-Id` is outside the key's allowed set. A spoofed header
   no longer grants access. Config-driven (`INTERNAL_API_KEYS` mapping key→companies), backward
   compatible with the current single-key/single-company default.
2. **Row-scoping (defense-in-depth):** every by-id read/write (`GET/PATCH/DELETE /contacts/:id`,
   `/contacts/:id/activity`, deals `:id`, prospect_inbox) verifies the row's `company_id` matches the
   caller's company, returning **404** (not 403 — no existence disclosure) on mismatch. Today `:id`
   routes skip this entirely.

Only with both does the brief's "cross-company access is impossible" hold. Layer 2 alone stops
*accidental* leakage between cooperating callers; layer 1 stops a hostile/compromised keyholder.

---

## 4. Definition of done — "the API contract is done"

Full parity. All of:

1. **Spec matches reality.** A single contract doc describes exactly what the server serves; no
   fictional endpoints, no doc/impl drift. The stale `SESSION_5_CRM_API_CONTRACT.md` is corrected
   or superseded.
2. **Stage model reconciled.** CRM is authoritative; `automation_core.advance_stage` no longer
   applies a conflicting client-side guard; illegal transitions surface the CRM's 400.
3. **Multi-tenant isolation enforced.** Cross-company access by UUID is impossible (404). Proven by
   a negative test.
4. **prospect_inbox handoff works over HTTP.** Enqueue (idempotent), claim (atomic), list — proven
   end-to-end through the API.
5. **One real engine proven over HTTP.** With the server running on :3100, an engine path completes
   find/create → activity → advance-stage → handoff against `CRM_BACKEND=api`, losing nothing vs.
   `postgres`.
6. **Repeatable contract tests.** A test script exercises every endpoint (happy path + the negative
   isolation + illegal-transition + idempotent-enqueue cases) and re-runs at each checkpoint as the
   external signal.

Each of the build checkpoints below closes with `/verify`: eval criteria up front → Codex critic →
external signal (run server + exercise endpoints).

---

## 5. Scope boundary

**In scope (this pass):** CRM server (`server/`) — key→company auth binding, multi-tenant row-scoping,
a migration file for `prospect_inbox` + indexes, the prospect_inbox endpoints; `automation_core/crm.py`
client changes (company-threading, stage-guard removal + typed error, unified prospect_inbox client
interface for both backends); contract tests; corrected contract doc.

**Phased (follow-on checkpoints, NOT this pass):** rewiring each live engine
(outreach/nurturing/content) off its repo-local handoff/campaign code onto the unified client —
deferred per §2.3 because of the cross-DB transaction question; one engine per checkpoint, each
with its own /verify.

**Out of scope:** YOGI (never touched); moving `campaigns`/`campaign_events` to the CRM; the engines'
internal logic beyond the CRM client; the dashboard/WebSocket layer (`broadcast` stays a no-op); deal
probability/forecasting; applying DDL to the live DB (operator's job).

**Hard guardrails:** no direct edits to the live `denchclaw` DB; no commits to YOGI; rule files
untouched.

---

## 6. Provisional checkpoint plan (agile, each closed with /verify)

> Detailed spec lives in `.specs/`; this is the shape, not the contract.

- **CP0 — Contract harness.** Stand up the server on :3100, write the contract test script against
  *current* behavior (records the baseline, including known failures). The test must exercise the
  real `_ApiBackend` against a non-`growthclub` company, not just raw curl. External signal from day one.
- **CP1 — Isolation (atomic across both repos).** Server: key→company auth binding (403) + row-scope
  all by-id routes (404). Client: thread `company_id` through `_ApiBackend.find_by_id/update/
  add_activity/get_activity` (and the public signatures) so the api backend doesn't 404 its own
  non-default-company records. Negative test (spoofed + cross-company) goes green; api-backend
  regression stays green.
- **CP2 — Stage authority.** Confirm CRM 400 semantics; make `_ApiBackend.update()` raise a typed
  `CrmStageError` on 4xx (today it swallows to `None`); strip automation_core's linear guard. Illegal
  transition surfaces the CRM verdict through `channels/base.advance_stage`'s try/except; reactivation
  `lost→lead` now succeeds. Audit other `update()` callers for the raise side-effect.
- **CP3 — prospect_inbox (CRM-owned).** Migration (nullable target_engine; statuses
  pending/claimed/enrolled/done; re-handoff resets done→pending) + enqueue/claim/list/complete
  endpoints + unified client interface for both backends. Idempotent-enqueue, re-handoff-reset,
  cross-company-enqueue-404, and N-way atomic-claim tests go green.
- **CP4 — Parity proof + doc.** One engine path end-to-end over `CRM_BACKEND=api`
  (find/create→activity→advance→enqueue→claim); assert backend key-set parity; supersede the stale
  contract doc; final `/verify` against the full done-bar.

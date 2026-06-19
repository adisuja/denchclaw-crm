# Spec 001 — DenchClaw CRM API Contract (CRM_BACKEND=api parity) — v2

> Layer 1 detailed spec, **v2 after Codex critic** (Layer 2). Implements
> [docs/PRODUCT_BRIEF.md](../docs/PRODUCT_BRIEF.md). v1 was issued a FAIL verdict (5 blockers); this
> revision folds them in. §9 maps every critic finding to where it's resolved.
>
> Authored 2026-06-19. Repos: `denchclaw-crm` (server), `pro-workflows` (`automation_core/crm.py`).
> Never YOGI. Agent never runs DDL on the live `denchclaw` DB (migration files only).

---

## 0. Ground truth (verified from code)

- Server: Node/Express, `server/server.js`, mounts `server/routes/crm.js` at `/api/crm`, `PORT||3100`.
- Auth: `requireAuth` ([auth.js:21](../server/middleware/auth.js)) — single `INTERNAL_API_KEY`; loopback
  CIDR gate; `req.auth.companyId` taken **verbatim** from `X-Company-Id` (default `growthclub`). No
  key→company binding today → header is spoofable.
- DAL ([contacts.js](../server/db/models/contacts.js)):
  - `getByEmail(email, companyId)` — **company-scoped** ✅. Linkedin/phone dedup fallbacks scope via
    `list(companyId,…)`. So **contact dedup is already tenant-safe** (do not add a global unique).
  - `getById(id)` — **NOT scoped** ❌ · `update(id,data)` — **NOT scoped** ❌ ·
    `addActivity(contactId,entry)` — derives company from the row, **NOT scoped** ❌ ·
    `getActivity(contactId,limit)` — no company param at all ❌.
- Stage guard: route `PATCH /contacts/:id` via `STAGE_TRANSITIONS` state machine
  ([crm.js:44](../server/routes/crm.js)); 400 `{error, allowed_transitions, current_stage}`.
  Same-stage PATCH is a no-op 200 (verify preserved).
- Client ([crm.py](../../pro-workflows/automation_core/crm.py)):
  - `_ApiBackend.find_by_id/update/add_activity/get_activity` (≈ lines 251/291/311/315) call
    `self._client()` **with no company_id** → always send `X-Company-Id: growthclub`.
  - `_ApiBackend.update()` (≈293): `if r.is_success: return …` else falls to `return None` —
    **swallows 4xx** (unlike `create()` which `raise_for_status()`).
  - public `advance_stage` (≈448→461): linear `STAGE_ORDER` forward-only guard, then `update(deal_stage)`.
  - `advance_stage` is wrapped by `channels/base.advance_stage`
    ([base.py:141-144](../../pro-workflows/automation_core/channels/base.py)) in try/except (logs, swallows).
- Handoff is **engine-local, not shared**: each engine has its own `prospect_inbox`+`campaigns`+
  `campaign_events` in its own DB. Producer: outreach `repo.push_prospect` +
  `router._handoff_to_nurturing`. Consumer: nurturing `dispatcher.drain_handoffs`
  ([dispatcher.py:274](../../nurturing-engine/backend/app/dispatcher.py)) — polls, then **enrolls +
  writes campaign_events + tags contact in the same engine-DB txn**, then `mark_prospect(...,"enrolled")`.
  `automation_core.campaigns.push_prospect/poll_prospects/mark_prospect` exist but have **0 callers**
  (DO NOTHING idempotency; non-atomic poll; statuses pending/claimed/enrolled/done; `target_engine`
  **nullable**; `claimed_by` coerced UUID-or-NULL).
- No `POST /contacts/:id/stage` endpoint exists (contract-doc stub is fiction).

---

## 1. Invariants (hold at every checkpoint)

- **I1 — Tenant isolation (two layers):** (a) the API key is bound to an allowed company set;
  `X-Company-Id` outside it ⇒ **403**. (b) by-id rows are company-scoped; mismatch ⇒ **404**. A
  spoofed header grants nothing.
- **I2 — CRM is stage authority:** transition legality is decided solely by the server map; clients
  neither veto nor force.
- **I3 — Backend parity:** for the public `automation_core.crm` interface, `api` and `postgres`
  return the same dict **key sets** (verified, not asserted) — incl. the new handoff methods.
- **I4 — Idempotent handoff:** enqueue of the same `(contact_id, target_engine)` yields one row.
  Re-enqueue of pending/claimed = metadata refresh; re-enqueue of `done` = reset to pending.
- **I5 — Atomic claim:** concurrent claims never hand one row to two callers (`FOR UPDATE SKIP LOCKED`).
- **I6 — No live-DB DDL by agent:** migration files only.
- **I7 — Compat is explicit, not absolute:** no breaking change to existing *endpoint request bodies*.
  Deliberate, tested behavioral deltas ARE introduced and enumerated: new 403/404s; client public
  signatures gain `company_id`; `update()` raises on 4xx; re-handoff resets done→pending.

---

## 2. CP0 — Contract harness + baseline

**Build:** `test/contract.mjs` (Node, zero deps beyond built-in fetch) that:
- reads `CRM_API_BASE`, `INTERNAL_API_KEY`, a run tag, two companies `co_a`/`co_b` from env;
- runs assertions, prints `PASS/FAIL` per case, exits non-zero on FAIL; re-runnable via run-tagged
  unique emails (CRM dedups on email/linkedin/phone — tag all three);
- **includes a case that drives the real `_ApiBackend`** (via a tiny py shim or by replicating its
  default-`growthclub` header behavior) against a **non-`growthclub`** company, so finding-#1's
  self-404 is visible in the baseline (currently passes only because nothing is scoped yet).
- Operator provisions a disposable `denchclaw_test` DB and applies `migrate.sql` (+ later migrations).
  Agent supplies SQL; never executes it on a live DB.

**Baseline table (record actual = "Now"):**

| Case | Now | Target CP |
|---|---|---|
| health 200 | PASS | — |
| create (co_a) → 201 + `company_name` | PASS | — |
| find by email (co_a) | PASS | — |
| read co_a row as co_b | leak 200 | 404 (CP1) |
| patch co_a row as co_b | mutates | 404 (CP1) |
| `GET /contacts/:id/activity` as co_b | leaks feed | 404 (CP1) |
| spoofed `X-Company-Id` with valid key | accepted | 403 (CP1) |
| api-backend op on non-growthclub contact | works (unscoped) | still works after CP1 |
| illegal transition lead→won | 400 | — |
| legal lead→contacted | 200 | — |
| reactivation lost→lead (CRM PATCH) | 200 | — |
| `advance_stage` lost→lead via client | **blocked (linear)** | 200 (CP2) |
| add activity bumps lead_score_numeric | PASS | — |
| prospect_inbox enqueue | 404 (no route) | 200 (CP3) |

**Eval (verify):** script runs vs live :3100; actual == "Now" column. External signal = script output.
Codex reviews coverage.

---

## 3. CP1 — Isolation (ATOMIC across both repos)

> Critic #1/#9: server-scoping alone self-breaks the api backend; #3: header is spoofable; #11: two
> routes were missed; #10: deals→contact cross-write hole. All folded here.

**Server — auth binding (I1a):**
- New env `INTERNAL_API_KEYS` = JSON/CSV map `key → [company,…]` (or `*` for all). Back-compat:
  if unset, fall back to `INTERNAL_API_KEY` bound to `[default company]` (`growthclub`) ⇒ existing
  single-tenant deployments unchanged.
- `requireAuth`: resolve the presented key → allowed set; if `X-Company-Id` ∉ set ⇒ `403
  {error:'company not permitted for this key'}`. Keep the loopback CIDR gate.

**Server — row-scoping (I1b):** add company-scoped DAL variants and thread `getUserCompanyId(req)`:
- `getById(id, companyId)` → `WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL`. Keep
  `getByIdUnscoped(id)` **private, single internal caller only** (never reachable from a user-id route).
- `update(id, data, companyId)` → `… AND company_id=$N`; null result ⇒ route 404.
- `addActivity(contactId, entry, companyId)` → verify ownership before insert.
- `getActivity(contactId, limit, companyId)` → join/guard on company.
- Routes to scope (complete list, all ⇒ 404 on mismatch):
  `GET /contacts/:id` (310), `PATCH /contacts/:id` (322), **`GET /contacts/:id/activity` (387)**,
  `POST /contacts/:id/activity` (399), `PATCH /contacts/:id/follow-up` (623),
  `DELETE /contacts/:id` (698), `GET/PATCH/DELETE /deals/:id` (502/522/712),
  **`POST /deals/:id/activity` (726)**.
- **Deals→contact cross-write (#10):** `PATCH /deals/:id` (522-565) writes a `deal_stage_change`
  activity onto `deal.contact_id`. Scope the deal lookup by company AND assert
  `deal.company_id === contact.company_id` before the cross-write; otherwise skip it.

**Client — company threading (I1a/#1):**
- `_ApiBackend._client(company_id)` already exists; **pass company_id** in `find_by_id`, `update`,
  `add_activity`, `get_activity`. Public signatures gain a leading/required `company_id`:
  - `find_contact_by_email(company_id, email)` (already has it).
  - `advance_stage(company_id, contact_id, target_stage)` — **was** `(contact_id, target_stage)`.
  - `add_contact_activity(company_id, contact_id, …)` — was `(contact_id, …)`.
  - `get_activity(company_id, contact_id, …)`.
  - Update `channels/base.advance_stage` (and any other callers) to pass `company_id`. Enumerate
    callers first (grep `advance_stage(`, `add_contact_activity(`, `crm.get_activity(`).

**Eval (verify):**
- co_b read/patch/delete/activity-read of a co_a row ⇒ 404 (4 cases).
- valid key + foreign `X-Company-Id` ⇒ 403.
- co_a self-access ⇒ 200 unchanged shape.
- **api-backend op on a non-`growthclub` contact still works** (regression for #1).
- single-tenant default deployment (no `INTERNAL_API_KEYS`) unchanged.
- Codex: confirm no `:id` route missed; 404-not-403 uniform; `getByIdUnscoped` unreachable from routes.

---

## 4. CP2 — Stage authority

> Critic #2: `update()` swallows the 400; the CP2 promise is impossible without fixing it.

**Server:** confirm 400 body `{error, allowed_transitions, current_stage}`; same-stage PATCH = 200
no-op; `crm_pipeline_configs` per-company override reachable (document; no behavior change).

**Client (`crm.py`):**
- Define `class CrmStageError(Exception)` carrying `allowed_transitions`, `current_stage`, `target`.
- `_ApiBackend.update()`: detect non-2xx. On **400 with an `allowed_transitions` body** (stage
  rejection) ⇒ raise `CrmStageError`. Other non-2xx ⇒ keep current tolerant behavior (return None)
  **unless** called from the stage path — to bound blast radius, route stage changes through a
  dedicated `_ApiBackend.set_stage(company_id, contact_id, stage)` that uses `raise_for_status()`,
  rather than overloading the general `update()`. Audit `update()` callers: `advance_stage` and
  `add_contact_activity` (≈443) — the latter must NOT start raising.
- public `advance_stage(company_id, contact_id, target_stage)`:
  - resolve contact; if missing ⇒ return. If `target == current` ⇒ no-op.
  - **remove** the linear `STAGE_ORDER` index comparison.
  - call `_backend().set_stage(company_id, contact_id, target_stage)`. Let `CrmStageError` propagate —
    `channels/base.advance_stage` catches & logs it (verified at base.py:141-144), so no engine crash.
- Add `set_stage(company_id, contact_id, stage)` to **both** backends' method tables (api: dedicated
  `raise_for_status()` call to `PATCH /contacts/:id {deal_stage}`; postgres: validate then write).
- Postgres backend stage legality: define a single `STAGE_TRANSITIONS` dict in `crm.py` mirroring the
  server map; postgres `set_stage` validates against it and raises `CrmStageError` on illegal moves —
  so both backends enforce the same map. The py map is a **drift detector, not a single source** — so
  CP4 runs a **mandatory, fail-loud** test (in the api-reachable lane) asserting the py map ==
  `GET /api/crm/pipeline/transitions` (new tiny read endpoint); if the endpoint is unreachable the
  test FAILS (does not skip). This catches drift without making postgres depend on the network at runtime.
- `STAGE_ORDER`: keep only if still imported elsewhere (grep); else delete.

**Eval (verify):** via client under `api`: illegal lead→won ⇒ `CrmStageError` surfaced+logged, stage
unchanged, engine not crashed; legal lead→contacted ⇒ updated; reactivation lost→lead ⇒ **succeeds**
(was blocked); postgres backend same three; `add_contact_activity` still tolerant. drift test green.
Codex: attack map drift; confirm no residual linear logic; confirm the raise is caught.

---

## 5. CP3 — prospect_inbox (CRM-owned) + unified client interface

> Critic #4 (re-handoff), #5 (existing impl + claimed_by type), #6 (parity), #7 (claim test). Folded.
> Cutover of live engines is PHASED OUT of this pass (brief §2.3).

**Migration `migrations/002_prospect_inbox.sql` (file only):**
```sql
CREATE TABLE IF NOT EXISTS prospect_inbox (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         TEXT NOT NULL,
  contact_id         UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_engine      TEXT,
  target_engine      TEXT,                              -- NULLABLE: NULL = broadcast handoff
  suggested_campaign TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending|claimed|enrolled|done
  claimed_by         TEXT,                              -- free TEXT: engines pass label OR campaign id
  metadata           JSONB DEFAULT '{}',
  created_at         TIMESTAMPTZ DEFAULT now(),
  claimed_at         TIMESTAMPTZ
);
-- Unique on (contact_id, target_engine). NULL target_engine: enforce single broadcast row via a
-- partial unique index on contact_id WHERE target_engine IS NULL (NULLs aren't unique by default).
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_inbox_contact_target
  ON prospect_inbox (contact_id, target_engine) WHERE target_engine IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_inbox_contact_broadcast
  ON prospect_inbox (contact_id) WHERE target_engine IS NULL;
CREATE INDEX IF NOT EXISTS idx_prospect_inbox_pending
  ON prospect_inbox (company_id, target_engine) WHERE status = 'pending';
```
`claimed_by` is **TEXT** (not UUID/FK) — reconciles with engine-side reality where the consumer passes
the label `"nurturing"` (the engine model's UUID FK silently coerced non-UUIDs to NULL; we keep the
label instead of losing it). No FK to `campaigns` (that table isn't in the CRM).

**Endpoints (server, all company-scoped per I1b; enqueue verifies contact∈company):**

| Op | Method · Path | Request | Response |
|---|---|---|---|
| Enqueue | `POST /api/crm/prospect-inbox` | `{contact_id, target_engine?, source_engine?, suggested_campaign?, metadata?}` | 201/200 `{row}` |
| Claim | `POST /api/crm/prospect-inbox/claim` | `{target_engine?, limit?=1, claimed_by?}` | 200 `{claimed:[rows]}` |
| List | `GET /api/crm/prospect-inbox?target_engine=&status=&limit=` | — | 200 `{total, rows}` |
| Complete | `PATCH /api/crm/prospect-inbox/:id` | `{status:'enrolled'|'done', claimed_by?}` | 200 `{row}` |

**Enqueue idempotency + re-handoff reset (I4, #4).** Postgres will NOT infer a *partial* unique
index from a bare `ON CONFLICT (cols)` — the index predicate must be restated, and the two partial
indexes (NOT NULL vs NULL) cannot share one arbiter. So there are **two statements**, routed by
`target_engine` null-ness in the handler. The `DO UPDATE SET` body is identical (factored as
`<RESET_BODY>` below).

`<RESET_BODY>` (re-handoff after completion: a done row re-enters as pending; in-flight rows untouched):
```sql
  source_engine      = COALESCE(EXCLUDED.source_engine, prospect_inbox.source_engine),
  suggested_campaign = COALESCE(EXCLUDED.suggested_campaign, prospect_inbox.suggested_campaign),
  metadata           = prospect_inbox.metadata || EXCLUDED.metadata,
  status     = CASE WHEN prospect_inbox.status = 'done' THEN 'pending' ELSE prospect_inbox.status END,
  claimed_by = CASE WHEN prospect_inbox.status = 'done' THEN NULL     ELSE prospect_inbox.claimed_by END,
  claimed_at = CASE WHEN prospect_inbox.status = 'done' THEN NULL     ELSE prospect_inbox.claimed_at END,
  created_at = CASE WHEN prospect_inbox.status = 'done' THEN now()    ELSE prospect_inbox.created_at END
```
Targeted enqueue (`target_engine` NOT NULL) — arbiter = `uq_prospect_inbox_contact_target`:
```sql
INSERT INTO prospect_inbox (id, company_id, contact_id, source_engine, target_engine, suggested_campaign, metadata)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (contact_id, target_engine) WHERE target_engine IS NOT NULL
DO UPDATE SET <RESET_BODY> RETURNING *;
```
Broadcast enqueue (`target_engine` IS NULL) — arbiter = `uq_prospect_inbox_contact_broadcast`:
```sql
INSERT INTO prospect_inbox (id, company_id, contact_id, source_engine, target_engine, suggested_campaign, metadata)
VALUES ($1,$2,$3,$4,NULL,$5,$6)
ON CONFLICT (contact_id) WHERE target_engine IS NULL
DO UPDATE SET <RESET_BODY> RETURNING *;
```
Race on a done row: `ON CONFLICT DO UPDATE` row-locks the conflicting tuple, so the second updater
sees `pending` and its CASE is a no-op — no double-reset. The route guards `contact_id` belongs to the
caller's company ⇒ else 404.

**Broadcast semantics (decided):** a NULL-`target_engine` row is **claimable by any engine,
first-claim-consumes** (matches the existing engine code: `poll_prospects` filters
`target_engine==X OR IS NULL`, then `mark_prospect` consumes it once). It is NOT fan-out to all
engines — if true fan-out is ever needed it requires per-engine rows, out of scope here.

**Atomic claim (I5):**
```sql
UPDATE prospect_inbox SET status='claimed', claimed_by=$3, claimed_at=now()
WHERE id IN (
  SELECT id FROM prospect_inbox
  WHERE company_id=$1 AND status='pending'
    AND ($2::text IS NULL OR target_engine=$2 OR target_engine IS NULL)  -- engine + broadcast
  ORDER BY created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $4
)
RETURNING *;
```

**Client (`crm.py`) — unified interface, both backends (I3):**
- `enqueue_handoff(company_id, contact_id, *, target_engine=None, source_engine=None, suggested_campaign=None, metadata=None)`
- `claim_handoffs(company_id, *, target_engine=None, limit=1, claimed_by=None) -> list[dict]`
- `list_handoffs(company_id, *, target_engine=None, status=None, limit=50) -> list[dict]`
- `complete_handoff(company_id, inbox_id, *, status='done', claimed_by=None) -> dict|None`
- api backend → endpoints above; postgres backend → **one** implementation (fold the existing
  `campaigns.push_prospect/poll_prospects/mark_prospect` logic into these methods; do NOT add a third
  copy). Document that `campaigns.py`'s standalone handoff functions are superseded by this interface
  and slated for deletion at engine cutover. Keep `_row` snake_case keys so both backends match.

**Eval (verify):**
- enqueue same (contact,target) twice ⇒ one row, 2nd merges metadata, no dup/500.
- enqueue → claim → complete(done) → re-enqueue ⇒ row back to `pending`, claimed_by/at cleared (#4).
- enqueue pending → re-enqueue ⇒ stays pending, not yanked.
- enqueue for a contact in another company ⇒ 404.
- **N-way atomic claim:** ≥4 concurrent claimers (limit 1) vs M<N pending ⇒ union of claimed ids has
  no duplicate, total == M; many iterations (#7).
- broadcast (NULL target) enqueue + claim by a specific engine works.
- **parity:** assert identical dict key sets from `claim_handoffs`/`list_handoffs` across both
  backends (#6).
- Codex: attack ON CONFLICT reset, SKIP LOCKED, NULL-target unique handling, company guard.

---

## 6. CP4 — Parity proof + doc supersede

- Full contract test green vs live :3100 (all "Target" results).
- One engine path via the public `automation_core.crm` interface under
  `CRM_BACKEND=api CRM_API_BASE=http://127.0.0.1:3100`:
  `find_or_create_contact → add_contact_activity → advance_stage → enqueue_handoff → claim_handoffs`,
  asserting each step + key-set parity vs a `postgres` run.
- Supersede `pro-workflows/docs/AUTOMATION_ENGINES_PY/SESSION_5_CRM_API_CONTRACT.md`: fix "Python app",
  remove fictional `/stage`, document real `PATCH {deal_stage}` + state machine + auth binding +
  prospect_inbox endpoints + multi-tenant rule + the phased engine cutover. (Operator: correct in
  place vs add a superseding doc.)
- Commit: `denchclaw-crm` (server + migration + tests + docs) and `pro-workflows` (`crm.py` + doc).
  Branch off main; PRs. Never YOGI.

**Eval (verify):** brief §4 done-bar, all items, shown by command output (server log + test exit 0 +
engine-path output). Final Codex pass on the whole diff.

---

## 7. Deliberate behavioral deltas (the honest I7 list)
New 403 (foreign company) · new 404s (cross-company by-id) · client public signatures gain
`company_id` · stage path raises `CrmStageError` (general `update()` stays tolerant) · re-enqueue of a
`done` handoff resets it to pending · `advance_stage` no longer blocks non-linear moves (reactivation
now works). Each has a test.

## 8. Accepted limitations (documented, not fixed this pass)
- campaigns/campaign_events stay engine-side; handoff consumer's enroll+log_event txn is not yet
  cross-DB-safe — engine cutover (phased) resolves it.
- Loopback CIDR gate unchanged; auth binding assumes keys are distributed per-tenant by the operator.

## 9. Critic findings → resolution map
| # | Sev | Resolved in |
|---|---|---|
| 1 | BLOCKER | CP1 client company-threading; CP0 baseline case exercises real `_ApiBackend` |
| 2 | BLOCKER | CP2 `set_stage` + `CrmStageError`; general `update()` left tolerant |
| 3 | BLOCKER | CP1 auth binding (I1a, 403); brief §3 isolation-truth corrected |
| 4 | BLOCKER | CP3 ON CONFLICT done→pending reset |
| 5 | BLOCKER | CP3 postgres backend reuses one impl; `claimed_by` TEXT; campaigns.py superseded+slated |
| 6 | MAJOR | CP3/CP4 key-set parity assertion |
| 7 | MAJOR | CP3 N-way concurrent claim test |
| 8 | MAJOR | §7 explicit deltas; I7 restated |
| 9 | MAJOR | CP1 made atomic across both repos; CP0 exercises default-company path |
| 10 | MINOR | CP1 deals→contact cross-write company-equality guard |
| 11 | MINOR | CP1 route list incl. `GET /contacts/:id/activity` + `POST /deals/:id/activity` |
| 12 | MINOR | CP1 `getByIdUnscoped` private/unreachable |
| 13 | MINOR | §0 notes dedup already tenant-safe; no global unique |

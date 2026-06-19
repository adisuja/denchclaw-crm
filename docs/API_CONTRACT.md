# DenchClaw CRM — API Contract (authoritative)

> This is the source-of-truth contract for `CRM_BACKEND=api`. It supersedes
> `pro-workflows/docs/AUTOMATION_ENGINES_PY/SESSION_5_CRM_API_CONTRACT.md`, which is stale
> (it described a "Python app", a fictional `POST /contacts/:id/stage` endpoint, and no
> prospect_inbox or multi-tenant rules). Verified against a live server — see [.specs/001-api-contract.md](../.specs/001-api-contract.md).

## What it is
Node/Express microservice, own isolated `denchclaw` Postgres DB, default `:3100`. The three
automation engines reach it over HTTP via `automation_core/crm.py` when `CRM_BACKEND=api`.

## Auth (two layers)
- `X-Internal-Key` — must be a known key. `X-Company-Id` — the acting company.
- **Key→company binding:** `INTERNAL_API_KEYS` (JSON: `{"<key>": ["co_a"], "<key2>": "*"}`) binds each
  key to the companies it may act for. An `X-Company-Id` outside the key's set ⇒ **403**.
  Back-compat: if unset, the single `INTERNAL_API_KEY` is bound to `*` (today's behavior).
- **Row scoping:** every by-id route additionally checks the row's `company_id` matches the caller's;
  mismatch ⇒ **404** (no existence disclosure). Cross-tenant access by UUID is impossible.

## Pipeline = state machine (not linear)
11 stages: `lead, contacted, qualified, no_show, unqualified, proposal, proposal_accepted,
negotiation, onboarding, won, lost`. Legal transitions are a state machine (`GET /pipeline/transitions`),
**not** a linear ladder — it supports reactivation (`lost→lead`), lateral recovery (`no_show→contacted`),
and disqualification from anywhere (`*→lost`). The CRM is authoritative: an illegal transition ⇒ **400**
`{error, allowed_transitions, current_stage}`. `automation_core.advance_stage` surfaces that as
`CrmStageError` and does **not** apply a client-side guard.

## Endpoints (base `/api/crm`)
| Method · Path | Purpose | Notes |
|---|---|---|
| GET `/contacts?search=&score=&source=&stage=&tags=&limit=&offset=` | list/find | search matches name/email/company; `tags` = `a,b` or repeated `tags=a&tags=b` → array-overlap filter (powers the send-side enrolled-contact query under `CRM_BACKEND=api`) |
| POST `/contacts` | create/upsert | dedup email→linkedin→phone; `company`↔`company_name` mapping |
| GET `/contacts/:id` | read | company-scoped (404) |
| PATCH `/contacts/:id` | update / **advance stage** (`{deal_stage}`) | scoped; 400 on illegal transition |
| DELETE `/contacts/:id` | delete | scoped |
| GET `/contacts/:id/activity` | activity feed | scoped |
| POST `/contacts/:id/activity` | append activity | scoped; bumps `lead_score_numeric` |
| PATCH `/contacts/:id/follow-up` | record follow-up | scoped |
| GET `/contacts/follow-ups` · `/contacts/export` · `/activity/recent` · `/stats` · `/pipeline` | reporting | |
| POST `/contacts/bulk-import` | bulk upsert | |
| GET `/pipeline/transitions` | the authoritative stage state machine | |
| GET/POST/GET/PATCH/DELETE `/deals[/:id]` (+ `/deals/:id/activity`) | deals | `:id` routes company-scoped |
| POST `/prospect-inbox` | enqueue handoff | idempotent on `(contact_id, target_engine)`; done→pending reset |
| POST `/prospect-inbox/claim` | atomic claim (`FOR UPDATE SKIP LOCKED`) | `{target_engine?, limit?, claimed_by?}` |
| GET `/prospect-inbox?target_engine=&status=` | list | |
| PATCH `/prospect-inbox/:id` | transition (`enrolled`/`done`) | scoped |

There is **no** `POST /contacts/:id/stage` — stage changes go through `PATCH /contacts/:id {deal_stage}`.

## prospect_inbox handoff
CRM-owned table (migration [migrations/002_prospect_inbox.sql](../migrations/002_prospect_inbox.sql)).
`target_engine` NULLABLE (NULL = broadcast, claimable by any engine, first-claim-consumes); status
`pending|claimed|enrolled|done`; `claimed_by` free TEXT. Enqueue is idempotent; re-enqueuing a `done`
row resets it to `pending` (re-handoff after reactivation). Claim is atomic.

**Phased cutover:** the engines still run their repo-local handoff (engine DB) today. Rewiring each
engine's producer/consumer onto this CRM-owned queue is a follow-on, per-engine checkpoint (the
consumer's enroll+`campaign_events` write is locality-coupled to the engine DB; that cross-DB question
is resolved at cutover). The `automation_core.crm` client already exposes the unified interface
(`enqueue_handoff/claim_handoffs/list_handoffs/complete_handoff`) for both backends.

## Client (`automation_core/crm.py`)
Public functions accept an optional `company_id` (thread it so multi-tenant lookups resolve to the
right company; without it requests fall back to `default_company_id`). The api and postgres backends
return the same dict key sets. `advance_stage` raises `CrmStageError` on illegal transitions.

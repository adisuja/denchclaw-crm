# Handoff — DenchClaw CRM cutover: remaining work (paste into a fresh Claude Code session)
Date: 2026-06-20. This is a **self-contained** continuation prompt. The producer/consumer engine
cutovers (Prompts A/B/C) are code-complete and verified; what remains is (1) commit + PR the changes,
(2) run the staging deploy (Prompt D), (3) the **send-side contact-locality migration** (the real
remaining engineering edit), and (4) a coordinated cleanup. Run this on your **Mac** in Claude Code so
it has the repos, the live CRM on `:3100`, a real Postgres, and the VM/SSH route — none of which the
prior Cowork session could reach.

---
## 0. Repos & remotes (all on github.com/adisuja)
| Repo | Local path | Branch in flight | Remote |
|---|---|---|---|
| CRM (Node/Express) | `/Users/adithyamurali/denchclaw-crm` | (PR #1 merged?) | https://github.com/adisuja/denchclaw-crm |
| Shared client (Python) | `/Users/adithyamurali/pro-workflows` | `outreach/automation-core-fixes` | https://github.com/adisuja/pro-workflows |
| Outreach engine | `/Users/adithyamurali/outreach-engine` | `outreach/cp1-cp4-auth-deploy` | https://github.com/adisuja/outreach-engine |
| Content engine | `/Users/adithyamurali/content-engine` | `main` | https://github.com/adisuja/content-engine |
| Nurturing engine | `/Users/adithyamurali/nurturing-engine` | `main` | https://github.com/adisuja/nurturing-engine |

**Authoritative references (read first):**
- `denchclaw-crm/docs/API_CONTRACT.md` — the source-of-truth `CRM_BACKEND=api` contract.
- `denchclaw-crm/SESSION_HANDOFF_2026_06_19_DENCHCLAW_CUTOVER.md` — original cutover plan + the "ONE
  architectural decision" (option (a), adopted).
- `denchclaw-crm/SESSION_HANDOFF_2026_06_20_DENCHCLAW_CUTOVER_EXECUTION.md` — what was executed/verified
  on 2026-06-20 (read this; it has the Prompt D runbook and the exact file list).
- `denchclaw-crm/migrations/002_prospect_inbox.sql` — the CRM-owned table (note its TWO partial unique
  indexes; the engine DBs needed the same — see below).
- `denchclaw-crm/server/routes/crm.js` — prospect-inbox + contacts routes (the real semantics).
- Shared schema: `outreach-engine/src/db/migrations/001-automation-engines.sql` (defines `campaigns`,
  `campaign_events`, engine `prospect_inbox`).

---
## 1. What is DONE and VERIFIED (do not redo — just commit + ship)
Decision recorded for all engines: **option (a)** — under `CRM_BACKEND=api`, `contact_id` is an opaque
CRM id; each engine-DB `campaign_events.contact_id → contacts` FK is dropped (column + index kept).

- **A — outreach producer**: already committed on `outreach/cp1-cp4-auth-deploy`
  (`backend/app/router.py` `_handoff_to_nurturing` → `crm.enqueue_handoff(target_engine="nurturing")`;
  `backend/app/repo.py` `push_prospect` removed; `backend/migrations/031-relax-campaign-events-contact-fk.sql`).
- **B — content producer** (uncommitted): `content-engine/backend/app/engager.py`
  `campaigns_db.push_prospect(...)` → `crm.enqueue_handoff(target_engine=None, ...)` (broadcast).
- **C — nurturing consumer** (uncommitted): `nurturing-engine/backend/app/dispatcher.py` `drain_handoffs`
  rewritten to claim → fetch/tag CRM contact → `log_event(enrolled)` → `complete_handoff`, plus
  `_sweep_stale_claims` (crash-after-claim recovery). Added `from automation_core import crm` + `import os`.
- **Client helpers** (uncommitted, `pro-workflows/automation_core/crm.py`): new public
  `get_contact(company_id, contact_id)` and `add_contact_tags(company_id, contact_id, tags)`
  (backend-agnostic). `campaigns.py` got a deprecation comment over `push_prospect`.
- **Extra fix found in review** (uncommitted): the postgres backend's `enqueue_handoff` infers PARTIAL
  unique indexes that the engine-DB `prospect_inbox` lacked (it had only a full `UNIQUE`), so under
  `CRM_BACKEND=postgres` enqueue would error and the producer would silently drop the handoff. Added
  idempotent, data-safe migrations:
  `outreach-engine/backend/migrations/032-prospect-inbox-partial-unique-indexes.sql` and
  `content-engine/backend/migrations/004-prospect-inbox-partial-unique-indexes.sql`.
- **Nurturing FK relax** (uncommitted): `nurturing-engine/backend/migrations/011-relax-campaign-events-contact-fk.sql`.
- **Content FK relax** (uncommitted): `content-engine/backend/migrations/003-relax-campaign-events-contact-fk.sql`.

**Verification already done** (in a no-Postgres sandbox): a faithful mock of the CRM prospect-inbox +
contacts contract was driven by the REAL `automation_core.crm` api client + REAL `dispatcher.drain_handoffs`
— 25/25 checks (producer targeted + broadcast; consumer claim/tag/enroll; idempotency; crash-after-claim
sweep). The reusable harness + mock are saved (ask the user for `harness.py` / `mock_crm.py` from the prior
session outputs) if you want to re-run; they point `CRM_API_BASE` at a mock on `:3100`. The LIVE e2e and
`pytest` against real Postgres were NOT run there — do them now (Tasks 2–3).

---
## 2. TASK — commit + PR the changes (targeted; shared trees; NEVER commit to YOGI)
Each repo's working tree may contain OTHER sessions' uncommitted hunks — use `git add -p` / per-file adds.
Stage ONLY the files below.
- **outreach-engine**: `git add backend/migrations/032-prospect-inbox-partial-unique-indexes.sql` (new file).
  (Prompt A files already committed.) PR title: "outreach: engine prospect_inbox partial unique indexes (DenchClaw)".
- **content-engine**: stage `backend/app/engager.py` (the producer hunk only) +
  `backend/migrations/003-relax-campaign-events-contact-fk.sql` + `backend/migrations/004-prospect-inbox-partial-unique-indexes.sql`.
- **nurturing-engine**: stage `backend/app/dispatcher.py` + `backend/migrations/011-relax-campaign-events-contact-fk.sql`.
  **Do NOT stage `.specs/NURTURING_ENGINE_SPEC.md`** — that change pre-existed and belongs to another session.
- **pro-workflows**: stage `automation_core/crm.py` (the two new helpers) + `automation_core/campaigns.py`
  (deprecation comment). If other CP-* hunks are tangled in these files, `git add -p` only the cutover hunks;
  if they can't be cleanly separated, STOP and report.
Open one PR per repo. Verify `python -m py_compile` on each changed `.py` before pushing.

## 3. TASK — Prompt D staging deploy (operator)
Follow the runbook verbatim in `denchclaw-crm/SESSION_HANDOFF_2026_06_20_DENCHCLAW_CUTOVER_EXECUTION.md`
(§"PROMPT D"). In short: apply `denchclaw-crm/migrations/002_prospect_inbox.sql` to the live denchclaw DB;
apply the five new engine migrations to EACH engine's OWN DB (or let the FastAPI lifespan runner apply them
on boot); keep `INTERNAL_API_KEYS` UNSET (single shared key, isolation deferred); `pm2 restart` the CRM +
the three engines; run the staging smoke (create contact → enqueue → drain → assert pending→claimed→enrolled,
one enrolled `campaign_event`, `nurture:<campaign>` tag, idempotent re-run; plus a content broadcast claimed
by nurturing). The nurturing VM/SSH specifics are in `nurturing-engine/docs/CLAUDE_CODE_HANDOFF.md`
(SSH `ssh -i ~/Downloads/yogi-agent-key.pem yogi@staging.usetantra.com`).

## 4. TASK — the REAL remaining edit: send-side contact-locality under CRM_BACKEND=api
**Problem.** Prompt C cut over the consumer INTAKE only. Enrollment now tags the contact in the **CRM**,
but the nurturing **send side** still reads enrolled contacts from the **engine DB** via
`automation_core.contacts` (`contacts_db`). Under `CRM_BACKEND=api` those reads return nothing, so
nurturing would never actually send. This is the documented next checkpoint.

**Engine-DB contact reads to migrate (nurturing):**
- `nurturing-engine/backend/app/dispatcher.py:168` — `contacts_db.list_contacts(company_id, tags=[enrollment_tag(...)])` (run_campaign enrolled list).
- `nurturing-engine/backend/app/events.py:71,76,91` — `get_contact` + tag update on events/webhooks.
- `nurturing-engine/backend/app/router.py:180,192,218,341,391` — list/enroll/get contacts.
(Also audit outreach + content for engine-DB contact reads on their send/automation paths.)

**Key finding (there is a CRM gap to close first).** The CRM data layer
(`denchclaw-crm/server/db/models/contacts.js`) DOES support a `tags` overlap filter (`tags && $n`), but the
HTTP route `GET /api/crm/contacts` (`denchclaw-crm/server/routes/crm.js` ~line 140) only parses
`{ score, source, search, stage, limit, offset }` — it does **not** parse `?tags=`. And the client
`crm.py` `_ApiBackend.list_all` only sends `{limit:500}`. So a tag-based enrolled-contact query is not yet
reachable over HTTP.

**Recommended approach (option (a)-consistent):**
1. CRM: expose `?tags=` on `GET /api/crm/contacts` — parse `req.query.tags` (comma-separated or repeated)
   into `filters.tags` (the model already handles overlap). Add a contract test + update `API_CONTRACT.md`.
2. Client: add `crm.list_contacts(company_id, *, tags=None, deal_stage=None, ...)` to
   `pro-workflows/automation_core/crm.py` mapping to `GET /contacts` with those params, for BOTH backends
   (the postgres backend already has `automation_core.contacts.list_contacts` to delegate to). Keep return
   dict keys identical across backends (the `_norm` company↔company_name mapping already exists).
3. Engines: swap the `contacts_db.list_contacts(... tags=...)` / `get_contact` / `update_contact` send-side
   calls to the backend-agnostic `crm.*` equivalents (reuse `crm.get_contact` / `crm.add_contact_tags` added
   in Prompt C). Make it ONE path — no `if backend==...` branching, no dual-read.
4. Decide on the heavier alternative explicitly: if cross-DB contact reads on every send pass prove too
   chatty, escalate to **option (c)** (move campaigns/campaign_events to the CRM) as a separate program —
   but default to (a) for this checkpoint.

**Verify** (Karpathy Layer 2 — eval up front + critic + external signal): with `CRM_BACKEND=api` against
the live/local CRM, enroll a contact via a handoff, then run `dispatcher.run_campaign` and assert the
enrolled contact is found and the due touch is attempted (use the live allow-list / test-send path in
`nurturing-engine/docs/CLAUDE_CODE_HANDOFF.md` PROMPT E so nothing real is sent to non-allow-listed people).
Run the nurturing + content + outreach pytest suites. Have a critic subagent review the diff.

## 5. TASK — coordinated cleanup (after 2–4 land)
Remove the now-dead standalone handoff primitives `push_prospect` / `poll_prospects` / `mark_prospect`
from `pro-workflows/automation_core/campaigns.py` once a repo-wide grep (all engines + tests) confirms no
callers remain. They are marked deprecated; deleting them is a separate small PR so a bisect is clean.

---
## Constraints (apply to every task)
- **Never** edit a live DB directly — migration files only; the CRM agent never runs DDL on the denchclaw DB.
- **Never** commit to YOGI; the denchclaw DB is the only DB the CRM touches (isolated from YOGI's).
- Shared working trees — **targeted `git add`** (per-file or `git add -p`); never sweep another session's hunks.
- Keep one backend-agnostic code path (no dual-write/dual-read); the `CRM_BACKEND` switch lives in
  `automation_core`, not the engines.
- Keep enrollment idempotent (the `campaign_events` `dedupe_key` partial-unique index guards double-enroll).

## Suggested order
2 (commit/PR) → 3 (deploy + smoke) → 4 (send-side migration: CRM `?tags=` → client wrapper → engine swap →
verify) → 5 (cleanup). Task 4 is the substantive one; 2–3 are mechanical but gated on review.

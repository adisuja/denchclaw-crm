# Spec 002 — DenchClaw CRM cutover: convergence + ship (CRM_BACKEND=api)

> Integration + deploy + REAL end-to-end verification across 5 repos. Not new building.
> Karpathy 3-layer; second critic is ALWAYS Codex. Authored 2026-06-20.
> Source of truth: [docs/API_CONTRACT.md](../docs/API_CONTRACT.md),
> [SESSION_HANDOFF_2026_06_20_..._EXECUTION.md](../SESSION_HANDOFF_2026_06_20_DENCHCLAW_CUTOVER_EXECUTION.md)
> (Prompt D), option (a) in [..._2026_06_19_..._CUTOVER.md](../SESSION_HANDOFF_2026_06_19_DENCHCLAW_CUTOVER.md).

## 0. Goal
The three engines run on `CRM_BACKEND=api` against the DenchClaw CRM, with the cross-engine
handoff (prospect_inbox) CRM-owned, proven by a REAL end-to-end loop on real Postgres — not a mock.
"Done" = all 5 PRs merged, migrations applied, services restarted (sends GATED), the producer→consumer
loop verified against real rows, every repo's `pytest -q` green, and docs updated so no handoff is needed.

## 1. Ground truth (verified 2026-06-20, not assumed)
- Branches (cutover committed): pro-workflows `outreach/automation-core-fixes`; denchclaw-crm
  `feat/contacts-phone-filter`; outreach `outreach/cp1-cp4-auth-deploy`; content
  `content/denchclaw-producer-cutover`; nurturing `nurturing/denchclaw-send-side-cutover`.
- 5 open PRs (denchclaw #3, pro-workflows #1, nurturing #1, content #1, outreach #1). denchclaw #2 (`?tags=`) MERGED.
- **Local runtime is DOWN**: Docker daemon stopped → throwaway Postgres gone; CRM `:3100` not running.
  (Earlier verification was real-Postgres-local; it must be rebuilt, OR verify on the VM.)
- SSH key present: `~/Downloads/yogi-agent-key.pem` → `yogi@staging.usetantra.com` reachable.
- **Send-side migration (the old "known follow-up") is ALREADY DONE** in nurturing #1
  (`dispatcher.run_campaign` + events/router now read via `crm.list_contacts`/`get_contact`/
  `find_contact_by_phone`, unbounded). So new-prompt Phase 5 = record-and-close, not build.
- Stray uncommitted (CLEAN targets): denchclaw 2 handoff .md (untracked); outreach 2 handoff .md
  (untracked); nurturing `.specs/NURTURING_ENGINE_SPEC.md` (M — ANOTHER session's, do NOT commit),
  `CLAUDE.md` + `docs/CLAUDE_CODE_HANDOFF.md` + `nurturing-engine.env.example` (untracked).
  pro-workflows + content: clean.

## 2. Invariants
- Never commit to YOGI. CRM DB is guardrail-protected (no direct agent DDL — migration files only).
- Sends/publishing stay GATED until keys land (verify must not message real people).
- One backend-agnostic path; `CRM_BACKEND` switch lives in automation_core, not engines.
- Single shared key = `*` (isolation deferred, decided 2026-06-19) → no engine `.env` key changes.
- Enrollment idempotent (`campaign_events.dedupe_key`); handoff idempotent (done→pending reset).

## 3. Phase 1 — CLEAN (per repo, targeted; gated)
Commit/clear only stray NON-code files; confirm no cutover code is left uncommitted.
- denchclaw-crm: the 2 handoff `.md` are reference artifacts → commit to main (own repo) OR leave
  untracked. Decision: commit them to main (small docs) so the next session inherits them.
- outreach-engine: 2 handoff `.md` untracked → leave untracked (engine session's reference) OR commit
  to its branch. Decision: leave untracked (not ours to commit into their PR). Confirm migration 032
  IS committed (it is — `b13368f`).
- nurturing-engine: do NOT touch `.specs/NURTURING_ENGINE_SPEC.md` (M, other session). `CLAUDE.md`,
  `docs/CLAUDE_CODE_HANDOFF.md`, `nurturing-engine.env.example` untracked → leave (other session's).
- Verify each repo: no cutover `.py`/`.sql`/`.js` left unstaged.

## 4. Phase 2 — MERGE (dependency order; gated on user confirmation)
1. **pro-workflows #1** (client `crm.*`) — engines import it.
2. **denchclaw-crm #3** (server `?phone=` + list semantics) — nurturing inbound needs `?phone=`.
3. **outreach #1** + **content #1** (producers) — independent of each other.
4. **nurturing #1** (consumer) — depends on 1+2.
Squash-merge each; delete branch. After each engine merge, the FastAPI lifespan runner will apply that
engine's migrations on next boot. (denchclaw migration 002 is applied separately in Phase 3.)

## 5. Phase 3 — DEPLOY (Prompt D; gated) — STAGING-ONLY with hard preflight gates
Critic B1/B2 + M6: local 3a is CUT from the critical path (the local editable `automation_core` install is
broken — `.pth` → nonexistent `YOGI/AUTOMATION_ENGINES_PY` — and the local denchclaw DB ≠ staging DB, so
local proves nothing about staging). Ship + verify on staging (3b). Sequence is GATED, in order:

**Preflights (each a HARD gate; abort if any fails):**
- **PF1 (B1 editable install):** on each engine's staging runtime, BEFORE restart:
  `python -c "from automation_core import crm; print(crm.__file__, hasattr(crm,'get_contact'), hasattr(crm,'list_contacts'), hasattr(crm,'find_contact_by_phone'))"`
  — assert the path is the *pulled* pro-workflows checkout at the merged commit and all three are True.
- **PF2 (B2 foundation schema):** assert the foundation tables already exist on each engine DB
  (`psql -c "select to_regclass('public.campaign_events'), to_regclass('public.prospect_inbox')"` → non-null).
  If null on any engine DB, STOP — the hardcoded foundation-migration path in `automation_core/migrate.py:23`
  won't resolve on staging (`/Users/adithyamurali/...`) and would silently skip; provision/point it first.
- **PF3:** `git pull` lands the merged commit in each repo's staging checkout BEFORE any restart of that service.

**Deploy order (M4 — numbered, do not reorder):**
1. pull pro-workflows on staging (client available to the editable install) → PF1 passes.
2. apply `denchclaw-crm/migrations/002_prospect_inbox.sql` to the live denchclaw DB via SSH `psql`
   (NOT the CRM process; idempotent IF NOT EXISTS); `pm2 restart denchclaw-crm`; `curl :3100/health`.
3. pull + (lifespan-runner or manual `psql`) apply engine migrations on each engine DB; PF2 re-check.
4. `pm2 restart outreach-engine-py content-engine-py` (producers), then `nurturing-engine` (consumer).
5. keep `INTERNAL_API_KEYS` UNSET (single `*`) — no engine `.env` key changes.

**Boot-log gate:** after each engine restart, grep its pm2 logs for `[migrate] Migration file not found`
and for import errors → FAIL the deploy if present (catches B2 silent-skip + B1 stale checkout).

## 6. Phase 4 — VERIFY FOR REAL (the whole point; gated) — acceptance criteria
Against the STAGING real Postgres + live CRM. Record the exact DB + `CRM_API_BASE` used in the output
(M6 — local proves nothing). Mock results do NOT count.

**B3 — sends are FAIL-OPEN; gate them fail-closed for the verify (mandatory):** `live_send_allowed`
returns True on an empty `NURTURE_LIVE_ALLOWLIST`. Before criterion 5: (a) confirm no live channel
credentials are set on the staging engines, AND (b) run with `opts={"dryRun": True}`, AND (c) set
`NURTURE_LIVE_ALLOWLIST` to ONE safe test address. Negative check: a contact NOT in the allowlist must
yield `not_in_live_allowlist` and zero send attempts.
1. **Producers enqueue:** drive the outreach producer path (`_handoff_to_nurturing` → enqueue
   `target_engine="nurturing"`) AND the content producer (`engager` → enqueue `target_engine=None`
   broadcast). Assert real CRM rows via `GET /api/crm/prospect-inbox` (status `pending`).
2. **Consumer drain:** run nurturing `drain_handoffs` → claims BOTH rows (targeted + broadcast),
   tags each CRM contact `nurture:<campaign>`, writes exactly one `enrolled` campaign_event per contact,
   transitions rows `pending→claimed→enrolled` (assert via `GET ?status=enrolled` + real engine-DB event rows).
3. **Idempotency:** re-run drain → no new claims/events.
4. **Crash-after-claim sweep:** force the engine-side write to throw → row left `claimed` (not lost);
   next pass `_sweep_stale_claims` reverts to `pending` and re-drains to `enrolled`.
5. **Send-side read:** under `CRM_BACKEND=api`, `dispatcher.run_campaign` finds the enrolled contact via
   `crm.list_contacts(tags=[...])` (proves the send loop sees CRM-owned contacts). Sends GATED (dryRun/allow-list).
6. **External signal:** hit `:3100` + engine endpoints; inspect real rows. `pytest -q` green in
   pro-workflows + outreach + content + nurturing.
7. **Rollback safety (M5):** one smoke under `CRM_BACKEND=postgres` (enqueue→drain→enrolled against the
   engine DB) so the documented rollback path is proven, not assumed. (Or explicitly declare roll-forward-only.)
8. **Replay/reconciliation (m7/m8):** crash-after-claim replay produces NO duplicate tag / duplicate
   `enrolled` event (dedupe_key holds); the enrolled event's `contact_id` resolves to a real CRM contact row
   (the FK is gone — nothing else catches a stale id).
9. **Codex critic** on the integration as a whole.

## 7. Phase 5 — send-side contact-locality
Already implemented (nurturing #1). Action: VERIFY it under api (Phase 4 criterion 5), then RECORD in
`docs/API_CONTRACT.md` + PROGRESS that it's shipped (not a pending follow-up). No new build unless Phase 4
reveals a gap.

## 8. Phase 6 — close out
Update `denchclaw-crm/PROGRESS.md` (create if absent) + each repo's `docs/PRODUCT_BRIEF.md` status to
"CRM_BACKEND=api cutover SHIPPED + verified (date)". Task 5 (`campaigns.py` push/poll/mark removal): only
after a repo-wide grep shows zero callers post-merge; separate small PR.

## 9. Risks / open decisions (for the critic + user)
- **R1 staging blast radius:** 3b touches the live staging denchclaw DB + restarts prod-ish engines. Mitigation:
  do 3a (local real PG) first; migrations idempotent + additive (FK drop, IF NOT EXISTS indexes); sends gated.
- **R2 merge-before-deploy:** staging `git pull` must only happen AFTER merges; engine lifespan migration
  runner applies DDL on boot — confirm it tolerates already-applied (idempotent) migrations.
- **R3 cross-DB non-atomicity** (option a, accepted): claim→enroll→complete not atomic; covered by the sweep
  (Phase 4 criterion 4).
- **R4 local rebuild cost:** 3a needs Docker up + engine DB schema; if too heavy, fall back to 3b-only with
  extra care. Decision needed: 3a+3b, or 3b-only?
- **R5 nurturing run_campaign full e2e** needs an engine-DB campaign + channel config; Phase 4 criterion 5
  requires seeding one (the engine API `/campaigns` + `/enroll`).

## 10. Codex critic findings — folded in (Spec v2)
| # | Sev | Resolution |
|---|---|---|
| B1 | BLOCKER | PF1 editable-install preflight + restart gate; 3a cut |
| B2 | BLOCKER | PF2 foundation-schema preflight + boot-log fail-on-skip; underlying `migrate.py:23` hardcoded path logged as a separate bug to fix |
| B3 | BLOCKER | Phase 4 fail-closed gate: dryRun=True + single-address allowlist + negative not_in_allowlist check; underlying fail-open `base.py:71` logged as a separate bug |
| M4 | MAJOR | Phase 3 numbered staging deploy/restart order |
| M5 | MAJOR | Phase 4 criterion 7 — postgres rollback smoke |
| M6 | MAJOR | staging-only; record real DB + CRM_API_BASE in output |
| m7/m8 | MINOR | Phase 4 criterion 8 — dedupe replay + contact_id reconciliation |
| m9 | MINOR | 3a optional, cut from critical path |

**Two underlying code bugs surfaced (NOT blockers for already-provisioned staging, but real):**
`automation_core/migrate.py:23` hardcodes `/Users/adithyamurali/outreach-engine/...` for the foundation
schema (silently skips off-box) and `channels/base.py:71` `live_send_allowed` is fail-open. Both are in
pro-workflows; fix as separate small PRs (out of this convergence's critical path; gated around here).

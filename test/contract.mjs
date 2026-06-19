#!/usr/bin/env node
// DenchClaw CRM — contract test harness.
// Spec: ../.specs/001-api-contract.md   Brief: ../docs/PRODUCT_BRIEF.md
//
// Re-runnable: uses a run tag (RUN env, default = epoch) to make emails/linkedin/phone unique,
// since the CRM dedups on all three. Drives the running server on CRM_API_BASE.
//
//   DATABASE-free: this script only speaks HTTP to a server you started separately.
//
// Usage:
//   CRM_API_BASE=http://127.0.0.1:3100 INTERNAL_API_KEY=... node test/contract.mjs
//
// Each case carries a `cp` tag = the checkpoint at which its TARGET behavior lands. At CP0 we assert
// the BASELINE (current) behavior — including the known-bad cases — so later checkpoints flip the
// expectation and the diff is visible. Set PHASE=CP0 (default) to assert baseline.

const BASE = process.env.CRM_API_BASE || 'http://127.0.0.1:3100';
const KEY = process.env.INTERNAL_API_KEY;
// Optional key bound (via server INTERNAL_API_KEYS) to ONLY the company 'co_bound_only',
// used to prove the 403 key→company binding at CP1+.
const LIMITED_KEY = process.env.LIMITED_API_KEY || null;
const RUN = process.env.RUN || String(Date.now());
const PHASE = process.env.PHASE || 'CP0';
const CO_A = 'co_a_' + RUN;
const CO_B = 'co_b_' + RUN;
const DEFAULT_CO = 'growthclub'; // auth.js default when X-Company-Id absent

if (!KEY) { console.error('FATAL: INTERNAL_API_KEY env required'); process.exit(2); }

let pass = 0, fail = 0;
const results = [];

async function req(method, path, { company, key = KEY, body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (key !== null) h['x-internal-key'] = key;
  if (company !== undefined && company !== null) h['x-company-id'] = company;
  const r = await fetch(BASE + path, {
    method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

function check(name, cp, ok, detail) {
  if (ok) { pass++; results.push(`  PASS  [${cp}] ${name}`); }
  else { fail++; results.push(`  FAIL  [${cp}] ${name} — ${detail}`); }
}

const email = (who) => `ct-${who}-${RUN}@example.com`;

async function main() {
  console.log(`\nDenchClaw CRM contract test — PHASE=${PHASE} RUN=${RUN}\nBASE=${BASE}\n`);

  // 1 — health
  {
    const r = await req('GET', '/health', { company: CO_A });
    check('health ok', '—', r.status === 200 && r.json?.ok === true, `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 2 — create contact (co_a) → 201 + company_name echoed
  let aId = null;
  {
    const r = await req('POST', '/api/crm/contacts', {
      company: CO_A,
      body: { name: 'Alice A', email: email('a'), company: 'Acme A', source: 'manual', lead_score: 'warm' },
    });
    aId = r.json?.id || null;
    check('create co_a contact', '—',
      r.status === 201 && !!aId && (r.json?.company_name === 'Acme A'),
      `status=${r.status} id=${aId} company_name=${r.json?.company_name}`);
  }

  // 3 — find by email (co_a)
  {
    const r = await req('GET', `/api/crm/contacts?search=${encodeURIComponent(email('a'))}`, { company: CO_A });
    const found = (r.json?.contacts || []).some(c => (c.email || '').toLowerCase() === email('a'));
    check('find co_a by email', '—', r.status === 200 && found, `status=${r.status} n=${r.json?.contacts?.length}`);
  }

  // 4 — read co_a contact AS co_b  (BASELINE: leaks 200; TARGET CP1: 404)
  {
    const r = await req('GET', `/api/crm/contacts/${aId}`, { company: CO_B });
    const leaks = r.status === 200 && r.json?.id === aId;
    if (PHASE === 'CP0') check('cross-company read leaks (baseline)', 'CP1→404', leaks, `status=${r.status}`);
    else check('cross-company read blocked', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 5 — patch co_a contact AS co_b  (BASELINE: mutates 200; TARGET CP1: 404)
  {
    const r = await req('PATCH', `/api/crm/contacts/${aId}`, { company: CO_B, body: { title: 'pwned-by-b' } });
    if (PHASE === 'CP0') check('cross-company patch mutates (baseline)', 'CP1→404', r.status === 200, `status=${r.status}`);
    else check('cross-company patch blocked', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 6 — read co_a contact activity AS co_b  (BASELINE: leaks feed; TARGET CP1: 404)
  {
    const r = await req('GET', `/api/crm/contacts/${aId}/activity`, { company: CO_B });
    if (PHASE === 'CP0') check('cross-company activity leaks (baseline)', 'CP1→404', r.status === 200, `status=${r.status}`);
    else check('cross-company activity blocked', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 7 — key→company binding (BASELINE: any company accepted; TARGET CP1: 403 for out-of-set)
  {
    if (PHASE === 'CP0') {
      const r = await req('GET', '/api/crm/contacts', { company: 'totally-unbound-company-' + RUN });
      check('foreign company-id accepted (baseline)', 'CP1→403', r.status === 200, `status=${r.status}`);
    } else if (LIMITED_KEY) {
      const denied = await req('GET', '/api/crm/contacts', { key: LIMITED_KEY, company: 'co_other_' + RUN });
      check('out-of-set company rejected (403)', 'CP1', denied.status === 403, `status=${denied.status} (should be 403)`);
      const ok = await req('GET', '/api/crm/contacts', { key: LIMITED_KEY, company: 'co_bound_only' });
      check('in-set company allowed (200)', 'CP1', ok.status === 200, `status=${ok.status} (should be 200)`);
    } else {
      check('binding test', 'CP1', false, 'LIMITED_API_KEY not provided — cannot test 403 binding');
    }
  }

  // 8 — api-backend default-company path: read co_a contact with the DEFAULT company header
  //     (mirrors _ApiBackend.find_by_id sending X-Company-Id=growthclub). BASELINE: 200 (unscoped).
  //     After CP1 + client company-threading, the backend will send the right company; this raw-default
  //     probe should then 404 (proving the scope is real). Kept as a regression sentinel.
  {
    const r = await req('GET', `/api/crm/contacts/${aId}`, { company: DEFAULT_CO });
    if (PHASE === 'CP0') check('default-company read works unscoped (baseline)', 'CP1', r.status === 200, `status=${r.status}`);
    else check('default-company cannot read co_a row', 'CP1', r.status === 404, `status=${r.status} (should be 404)`);
  }

  // 9 — illegal stage transition lead→won → 400 with allowed_transitions
  {
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Stage X', email: email('stage'), source: 'manual' } });
    const sid = c.json?.id;
    const r = await req('PATCH', `/api/crm/contacts/${sid}`, { company: CO_A, body: { deal_stage: 'won' } });
    check('illegal transition lead→won → 400', '—',
      r.status === 400 && Array.isArray(r.json?.allowed_transitions),
      `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // 10 — legal transition lead→contacted → 200, and 11 — reactivation lead→lost→lead → 200
  {
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Stage Y', email: email('stageY'), source: 'manual' } });
    const sid = c.json?.id;
    const r1 = await req('PATCH', `/api/crm/contacts/${sid}`, { company: CO_A, body: { deal_stage: 'contacted' } });
    check('legal transition lead→contacted → 200', '—', r1.status === 200, `status=${r1.status}`);

    const c2 = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'React Z', email: email('react'), source: 'manual' } });
    const rid = c2.json?.id;
    const toLost = await req('PATCH', `/api/crm/contacts/${rid}`, { company: CO_A, body: { deal_stage: 'lost' } });
    const back = await req('PATCH', `/api/crm/contacts/${rid}`, { company: CO_A, body: { deal_stage: 'lead' } });
    check('reactivation lost→lead → 200 (state machine)', '—',
      toLost.status === 200 && back.status === 200, `lost=${toLost.status} back=${back.status}`);
  }

  // 12 — add activity bumps lead_score_numeric
  {
    const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'Score', email: email('score'), source: 'manual' } });
    const sid = c.json?.id;
    const before = (await req('GET', `/api/crm/contacts/${sid}`, { company: CO_A })).json?.lead_score_numeric ?? 0;
    await req('POST', `/api/crm/contacts/${sid}/activity`, { company: CO_A, body: { type: 'email_replied', message: 'replied' } });
    const after = (await req('GET', `/api/crm/contacts/${sid}`, { company: CO_A })).json?.lead_score_numeric ?? 0;
    check('activity bumps lead_score_numeric', '—', after > before, `before=${before} after=${after}`);
  }

  // 13 — prospect_inbox enqueue (BASELINE: 404 no route; TARGET CP3: 201/200)
  {
    const r = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: aId, target_engine: 'nurturing' } });
    if (PHASE === 'CP0') check('prospect-inbox enqueue absent (baseline)', 'CP3→200', r.status === 404, `status=${r.status}`);
    else check('prospect-inbox enqueue works', 'CP3', r.status === 200 || r.status === 201, `status=${r.status}`);
  }

  // ── CP3 deep cases (handoff). Only meaningful once the endpoints + migration exist. ──
  if (PHASE === 'CP3' || PHASE === 'CP4') {
    // 14 — idempotent on (contact_id, target_engine)
    {
      const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'HO', email: email('ho'), source: 'manual' } });
      const cid = c.json?.id;
      const e1 = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: cid, target_engine: 'nurturing', metadata: { a: 1 } } });
      const e2 = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: cid, target_engine: 'nurturing', metadata: { b: 2 } } });
      check('enqueue idempotent (one row, merged meta)', 'CP3',
        e1.json?.id && e2.json?.id === e1.json.id && e2.json?.metadata?.a === 1 && e2.json?.metadata?.b === 2,
        `e1=${e1.json?.id} e2=${e2.json?.id} meta=${JSON.stringify(e2.json?.metadata)}`);

      // 15 — re-handoff after done resets to pending
      await req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: 'nurturing', limit: 50, claimed_by: 'nurturing' } });
      await req('PATCH', `/api/crm/prospect-inbox/${e1.json.id}`, { company: CO_A, body: { status: 'done' } });
      const reEnq = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: cid, target_engine: 'nurturing' } });
      check('re-handoff resets done→pending', 'CP3',
        reEnq.json?.status === 'pending' && reEnq.json?.claimed_by === null,
        `status=${reEnq.json?.status} claimed_by=${reEnq.json?.claimed_by}`);
    }

    // 16 — cross-company enqueue → 404 (contact belongs to CO_A, caller is CO_B)
    {
      const r = await req('POST', '/api/crm/prospect-inbox', { company: CO_B, body: { contact_id: aId, target_engine: 'nurturing' } });
      check('cross-company enqueue blocked (404)', 'CP3', r.status === 404, `status=${r.status}`);
    }

    // 17 — N-way atomic claim: K pending rows, N concurrent claimers (limit 1) → no dup, total==K
    {
      const TE = 'race_' + RUN;
      const K = 6;
      const ids = [];
      for (let i = 0; i < K; i++) {
        const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: `R${i}`, email: email('race' + i), source: 'manual' } });
        await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: c.json.id, target_engine: TE } });
      }
      const N = 10;
      const claims = await Promise.all(
        Array.from({ length: N }, () => req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: TE, limit: 1, claimed_by: 'w' } }))
      );
      const claimedIds = claims.flatMap(c => (c.json?.claimed || []).map(r => r.id));
      const uniq = new Set(claimedIds);
      check('atomic claim: no double-claim', 'CP3',
        claimedIds.length === uniq.size && uniq.size === K,
        `claimed=${claimedIds.length} unique=${uniq.size} expected=${K}`);
    }

    // 18 — broadcast (NULL target) claimable by a specific engine
    {
      const c = await req('POST', '/api/crm/contacts', { company: CO_A, body: { name: 'BC', email: email('bc'), source: 'manual' } });
      const enq = await req('POST', '/api/crm/prospect-inbox', { company: CO_A, body: { contact_id: c.json.id } }); // no target = broadcast
      const claim = await req('POST', '/api/crm/prospect-inbox/claim', { company: CO_A, body: { target_engine: 'some_engine_' + RUN, limit: 10, claimed_by: 'x' } });
      const got = (claim.json?.claimed || []).some(r => r.id === enq.json?.id);
      check('broadcast handoff claimable by any engine', 'CP3', enq.json?.target_engine === null && got, `target=${enq.json?.target_engine} claimed=${got}`);
    }
  }

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed  (PHASE=${PHASE})\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(2); });

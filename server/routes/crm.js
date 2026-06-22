'use strict';
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const contactDb = require('../db/models/contacts');
const { query } = require('../db/index');

const { requireAuth, getUserCompanyId } = require('../middleware/auth');

// All CRM routes require X-Internal-Key
router.use(requireAuth);

// No-op validator — engines send well-formed data; validation at API boundary
const validate = () => (req, res, next) => next();

const LEAD_SCORES = { hot: 90, warm: 60, neutral: 30, cold: 10, negative: 0 };

const DEFAULT_DEAL_STAGES = ['lead', 'contacted', 'qualified', 'no_show', 'unqualified', 'proposal', 'proposal_accepted', 'negotiation', 'onboarding', 'won', 'lost'];
const DEAL_STAGES = DEFAULT_DEAL_STAGES;
const SOURCES = ['expandi', 'instantly', 'linkedin', 'website', 'referral', 'manual', 'webinar', 'whatsapp', 'sms', 'content',
  'cold_email_prospect', 'cold_calendar_prospect', 'linkedin_prospect', 'linkedin_engagement',
  'facebook_engagement', 'twitter_engagement', 'instagram_engagement', 'paid_ads', 'social_engagement'];

const ENGAGEMENT_WEIGHTS = {
  email_opened: 2,
  email_clicked: 5,
  email_replied: 10,
  whatsapp_read: 3,
  whatsapp_replied: 10,
  sms_replied: 8,
  linkedin_connection_accepted: 5,
  linkedin_message_replied: 10,
  video_watched: 15,
  video_completed: 20,
  call_booked: 25,
  call_completed: 30,
  form_submitted: 15,
  registered: 15,
  cta_clicked: 10,
  proposal_viewed: 15,
  payment: 50,
};

const DEFAULT_STAGE_TRANSITIONS = {
  lead: ['contacted', 'unqualified', 'lost'],
  contacted: ['qualified', 'unqualified', 'lost'],
  qualified: ['proposal', 'no_show', 'unqualified', 'lost'],
  no_show: ['contacted', 'qualified', 'lost'],
  unqualified: ['lead', 'contacted', 'lost'],
  proposal: ['proposal_accepted', 'negotiation', 'lost'],
  proposal_accepted: ['negotiation', 'onboarding', 'lost'],
  negotiation: ['won', 'lost'],
  onboarding: ['won', 'lost'],
  won: [],
  lost: ['lead'],
};
const STAGE_TRANSITIONS = DEFAULT_STAGE_TRANSITIONS;

const _pipelineCache = new Map();
const PIPELINE_TTL_MS = 60 * 1000;

async function getPipelineStages(companyId) {
  const cached = _pipelineCache.get(companyId);
  if (cached && Date.now() - cached.fetchedAt < PIPELINE_TTL_MS) return cached;

  let stages = DEFAULT_DEAL_STAGES.slice();
  let transitions = { ...DEFAULT_STAGE_TRANSITIONS };
  try {
    const r = await query(
      `SELECT stages FROM crm_pipeline_configs
        WHERE company_id = $1
        ORDER BY is_default DESC, created_at ASC LIMIT 1`,
      [companyId]
    );
    const rawStages = Array.isArray(r.rows[0]?.stages) ? r.rows[0].stages : null;
    if (rawStages && rawStages.length) {
      const keys = rawStages.map(s => s.key || s.id).filter(Boolean);
      if (keys.length) {
        stages = keys;
        const customTx = {};
        let any = false;
        for (const s of rawStages) {
          const k = s.key || s.id;
          if (k && Array.isArray(s.transitions)) { customTx[k] = s.transitions; any = true; }
        }
        if (any) transitions = { ...DEFAULT_STAGE_TRANSITIONS, ...customTx };
      }
    }
  } catch (_e) { /* fall back to defaults */ }

  const entry = { stages, transitions, fetchedAt: Date.now() };
  _pipelineCache.set(companyId, entry);
  return entry;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadDeals(companyId, { limit = 500 } = {}) {
  if (!companyId) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 500);
  const { rows } = await query(
    `SELECT * FROM deals WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, cap]
  );
  return rows.map(r => {
    const meta = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) || {};
    return {
      id: r.id,
      title: r.title,
      contact_id: r.contact_id,
      contact_name: meta.contact_name || '',
      value: parseFloat(r.value) || 0,
      stage: r.stage,
      notes: meta.notes || '',
      activity: meta.activity || [],
      companyId: r.company_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      closed_at: meta.closed_at || null,
    };
  });
}

function broadcast(req, message) {
  // no-op — no WebSocket in standalone CRM
}

async function triggerStageAutomation(contact, oldStage, newStage) {
  console.log(`[CRM] Stage automation: ${contact.name || contact.email} ${oldStage} → ${newStage}`);
  // Automation hooks (Telegram, task queue, etc.) can be added here later
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

// GET /api/crm/contacts
router.get('/contacts', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const { score, source, search, stage, limit, offset, tags, phone } = req.query;
    const paginated = limit !== undefined || offset !== undefined;

    // tags overlap filter — accepts ?tags=a,b or repeated ?tags=a&tags=b.
    // Powers the send-side enrolled-contact query under CRM_BACKEND=api.
    const tagList = tags === undefined
      ? undefined
      : (Array.isArray(tags) ? tags : String(tags).split(',')).map(s => String(s).trim()).filter(Boolean);

    const contacts = await contactDb.list(companyId, {
      search,
      dealStage: stage,
      leadScore: score,
      source,
      ...(tagList && tagList.length ? { tags: tagList } : {}),
      ...(phone ? { phone } : {}),
      ...(paginated ? { limit, offset } : {}),
    });

    const stats = {
      total: contacts.length,
      hot: contacts.filter(c => (c.lead_score || c.leadScore) === 'hot').length,
      warm: contacts.filter(c => (c.lead_score || c.leadScore) === 'warm').length,
      neutral: contacts.filter(c => (c.lead_score || c.leadScore) === 'neutral').length,
      cold: contacts.filter(c => (c.lead_score || c.leadScore) === 'cold').length,
      by_source: {},
      by_stage: {}
    };
    contacts.forEach(c => {
      const src = c.source || 'unknown';
      const stg = c.deal_stage || c.dealStage || 'lead';
      stats.by_source[src] = (stats.by_source[src] || 0) + 1;
      stats.by_stage[stg] = (stats.by_stage[stg] || 0) + 1;
    });

    if (paginated) {
      const lim = Math.min(parseInt(limit, 10) || 50, 500);
      const off = Math.max(parseInt(offset, 10) || 0, 0);
      const aggregate = await contactDb.getStats(companyId).catch(() => null);
      return res.json({
        data: contacts,
        contacts,
        total: aggregate?.totalContacts ?? contacts.length,
        limit: lim,
        offset: off,
        stats,
      });
    }
    res.json({ total: contacts.length, contacts, stats });
  } catch (err) {
    console.error('[CRM] GET /contacts error:', err.message);
    res.status(500).json({ error: 'failed to load contacts' });
  }
});

// POST /api/crm/contacts
router.post('/contacts', validate(), async (req, res) => {
  try {
    const { name, email, phone, company, title, linkedin_url, source, lead_score, notes, metadata, tags,
      utmSource, utmMedium, utmCampaign, utmContent,
      whatsappOptIn, smsOptIn,
      website, location, position } = req.body;
    if (!name && !email) return res.status(400).json({ error: 'name or email required' });

    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });

    let existing = null;
    if (email) {
      existing = await contactDb.getByEmail(email, companyId);
    }
    if (!existing && linkedin_url) {
      const allContacts = await contactDb.list(companyId, { search: linkedin_url });
      existing = allContacts.find(c => c.linkedin_url && c.linkedin_url.toLowerCase() === linkedin_url.toLowerCase()) || null;
    }

    if (existing) {
      const updateData = {
        ...(name && { name }),
        ...(phone && { phone }),
        ...(company && { company_name: company }),
        ...(title && { title }),
        ...(linkedin_url && { linkedin_url }),
        ...(lead_score && { lead_score }),
      };
      const updated = await contactDb.update(existing.id, updateData);
      if (notes) {
        await contactDb.addActivity(existing.id, { type: 'note', message: notes });
      }
      broadcast(req, { type: 'contact_updated', contact: updated || existing });
      return res.json(updated || existing);
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid email format' });
    }

    const nameParts = (name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const contactData = {
      id: uuidv4(),
      name: name || '',
      firstName,
      lastName,
      email: email || '',
      phone: phone || '',
      company: company || '',
      company_id: companyId,
      title: title || position || '',
      position: position || title || '',
      linkedin_url: linkedin_url || '',
      website: website || '',
      location: location || '',
      source: SOURCES.includes(source) ? source : 'manual',
      lead_score: Object.keys(LEAD_SCORES).includes(lead_score) ? lead_score : 'neutral',
      lead_score_numeric: LEAD_SCORES[lead_score] || 30,
      deal_stage: 'lead',
      deal_value: 0,
      engagementScore: 0,
      engagement_score: 0,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      whatsappOptIn: whatsappOptIn === true,
      smsOptIn: smsOptIn === true,
      isUnsubscribed: false,
      tags: Array.isArray(tags) ? tags : [],
      metadata: metadata || {},
      activity: [
        { type: 'created', message: `Contact created from ${source || 'manual'}`, timestamp: new Date().toISOString() }
      ],
      last_contacted: null,
      next_follow_up: null
    };

    const contact = await contactDb.create(contactData);
    broadcast(req, { type: 'contact_created', contact });

    res.status(201).json(contact);
  } catch (err) {
    console.error('[CRM] POST /contacts error:', err.message);
    res.status(500).json({ error: 'failed to create contact' });
  }
});

// GET /api/crm/contacts/follow-ups — MUST be before :id route
router.get('/contacts/follow-ups', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contacts = await contactDb.list(companyId, {});
    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 86400000);
    const needsFollowUp = contacts.filter(c => {
      if (c.deal_stage === 'won' || c.deal_stage === 'lost') return false;
      if (c.next_follow_up && new Date(c.next_follow_up) <= now) return true;
      if ((c.lead_score === 'hot' || c.lead_score === 'warm') && c.last_contacted) {
        const daysSince = (now - new Date(c.last_contacted)) / 86400000;
        if (c.lead_score === 'hot' && daysSince >= 2) return true;
        if (c.lead_score === 'warm' && daysSince >= 5) return true;
      }
      if (!c.last_contacted || new Date(c.last_contacted) < sevenDaysAgo) return true;
      return false;
    }).sort((a, b) => {
      const scoreOrder = { hot: 0, warm: 1, neutral: 2, cold: 3 };
      return (scoreOrder[a.lead_score] || 3) - (scoreOrder[b.lead_score] || 3);
    });
    res.json({ total: needsFollowUp.length, contacts: needsFollowUp });
  } catch (err) {
    console.error('[CRM] GET /contacts/follow-ups error:', err.message);
    res.status(500).json({ error: 'failed to load follow-ups' });
  }
});

// GET /api/crm/contacts/:id
router.get('/contacts/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    res.json(contact);
  } catch (err) {
    console.error('[CRM] GET /contacts/:id error:', err.message);
    res.status(500).json({ error: 'failed to load contact' });
  }
});

// PATCH /api/crm/contacts/:id
router.patch('/contacts/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const existing = await contactDb.getById(req.params.id, companyId);
    if (!existing) return res.status(404).json({ error: 'contact not found' });

    const updates = req.body;

    const allowed = ['name', 'email', 'phone', 'company', 'title', 'linkedin_url', 'source',
                      'lead_score', 'deal_stage', 'deal_value', 'tags', 'next_follow_up', 'last_contacted',
                      'company_name'];
    const updateData = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) updateData[key] = updates[key];
    }
    // Map 'company' → 'company_name' (automation_core sends 'company', DB column is 'company_name')
    if (updateData.company !== undefined && updateData.company_name === undefined) {
      updateData.company_name = updateData.company;
    }
    delete updateData.company;

    if (updates.lead_score) {
      updateData.lead_score_numeric = LEAD_SCORES[updates.lead_score] || 30;
    }

    if (updates.activity_message) {
      await contactDb.addActivity(req.params.id, {
        type: updates.activity_type || 'update',
        message: updates.activity_message,
        agent: updates.agent || 'system',
        data: updates.activity_data || null
      }, companyId);
    }

    if (updates.deal_stage && updates.deal_stage !== existing.deal_stage) {
      const oldStage = existing.deal_stage || 'lead';
      const newStage = updates.deal_stage;

      const allowedTransitions = STAGE_TRANSITIONS[oldStage];
      if (allowedTransitions && !allowedTransitions.includes(newStage)) {
        return res.status(400).json({
          error: `Invalid stage transition: ${oldStage} → ${newStage}`,
          allowed_transitions: allowedTransitions,
          current_stage: oldStage,
        });
      }

      await contactDb.addActivity(req.params.id, {
        type: 'stage_change',
        message: `Stage: ${oldStage} → ${newStage}`,
      }, companyId);

      triggerStageAutomation({ ...existing, ...updateData }, oldStage, newStage).catch(() => {});
    }

    const contact = await contactDb.update(req.params.id, updateData, companyId);
    broadcast(req, { type: 'contact_updated', contact: contact || existing });

    res.json(contact || existing);
  } catch (err) {
    console.error('[CRM] PATCH /contacts/:id error:', err.message);
    res.status(500).json({ error: 'failed to update contact' });
  }
});

// GET /api/crm/contacts/:id/activity
router.get('/contacts/:id/activity', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const limit = parseInt(req.query.limit) || 50;
    const activity = await contactDb.getActivity(req.params.id, limit, companyId);
    res.json({ activity });
  } catch (err) {
    console.error('[CRM] GET /contacts/:id/activity error:', err.message);
    res.status(500).json({ error: 'failed to load activity' });
  }
});

// POST /api/crm/contacts/:id/activity
router.post('/contacts/:id/activity', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const { type, message, agent, data, channel } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const entry = {
      type: type || 'note',
      message,
      agent: agent || 'system',
      channel: channel || null,
      timestamp: new Date().toISOString(),
      data: data || null
    };

    await contactDb.addActivity(req.params.id, entry, companyId);

    const SCORE_WEIGHTS = { email_opened: 2, email_clicked: 5, email_replied: 10, call_booked: 25, call_completed: 30, form_submitted: 15, payment: 50 };
    const weight = SCORE_WEIGHTS[entry.type] || 1;
    await query(`UPDATE contacts SET lead_score_numeric = LEAST(COALESCE(lead_score_numeric, 0) + $1, 100) WHERE id = $2 AND company_id = $3`, [weight, req.params.id, companyId]);

    broadcast(req, { type: 'contact_activity', contact_id: req.params.id, entry });
    res.json(entry);
  } catch (err) {
    console.error('[CRM] POST /contacts/:id/activity error:', err.message);
    res.status(500).json({ error: 'failed to add activity' });
  }
});

// ─── DEALS / PIPELINE ────────────────────────────────────────────────────────

// GET /api/crm/deals
router.get('/deals', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req) || null;
    const deals = await loadDeals(companyId);
    const { stage, search } = req.query;

    let filtered = deals;
    if (stage) filtered = filtered.filter(d => d.stage === stage);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(d =>
        (d.title || '').toLowerCase().includes(q) ||
        (d.contact_name || '').toLowerCase().includes(q)
      );
    }

    const pipeline = {};
    DEAL_STAGES.forEach(s => { pipeline[s] = deals.filter(d => d.stage === s); });

    const totalValue = deals.filter(d => d.stage !== 'lost').reduce((s, d) => s + (d.value || 0), 0);
    const wonValue = deals.filter(d => d.stage === 'won').reduce((s, d) => s + (d.value || 0), 0);

    res.json({ total: filtered.length, deals: filtered, pipeline, stats: { totalValue, wonValue } });
  } catch (err) {
    console.error('[CRM] GET /deals error:', err.message);
    res.status(500).json({ error: 'failed to load deals' });
  }
});

// POST /api/crm/deals
router.post('/deals', validate(), async (req, res) => {
  try {
    const { title, contact_id, contact_name, value, stage, notes } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const deal = {
      id: uuidv4(),
      title,
      contact_id: contact_id || null,
      contact_name: contact_name || '',
      value: value || 0,
      stage: DEAL_STAGES.includes(stage) ? stage : 'lead',
      notes: notes || '',
      activity: [
        { type: 'created', message: 'Deal created', timestamp: new Date().toISOString() }
      ],
      companyId: getUserCompanyId(req) || 'growthclub',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: null
    };

    await query(
      `INSERT INTO deals (id, company_id, contact_id, title, value, stage, source, metadata, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
       ON CONFLICT (id) DO UPDATE SET stage=$6, value=$5, updated_at=NOW()`,
      [deal.id, deal.companyId, deal.contact_id, deal.title, deal.value, deal.stage, 'crm',
       JSON.stringify({ contact_name: deal.contact_name, notes: deal.notes, activity: deal.activity })]
    );

    broadcast(req, { type: 'deal_created', deal });
    res.status(201).json(deal);
  } catch (err) {
    console.error('[CRM] POST /deals error:', err.message);
    res.status(500).json({ error: 'failed to create deal' });
  }
});

// GET /api/crm/deals/:id
router.get('/deals/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });
    const row = rows[0];
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
    res.json({
      id: row.id, title: row.title, contact_id: row.contact_id,
      contact_name: meta.contact_name || '', value: parseFloat(row.value) || 0,
      stage: row.stage, notes: meta.notes || '', activity: meta.activity || [],
      companyId: row.company_id, created_at: row.created_at, updated_at: row.updated_at,
      closed_at: meta.closed_at || null,
    });
  } catch (err) {
    console.error('[CRM] GET /deals/:id error:', err.message);
    res.status(500).json({ error: 'failed to load deal' });
  }
});

// PATCH /api/crm/deals/:id
router.patch('/deals/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });

    const row = rows[0];
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
    const deal = {
      id: row.id, title: row.title, contact_id: row.contact_id,
      contact_name: meta.contact_name || '', value: parseFloat(row.value) || 0,
      stage: row.stage, notes: meta.notes || '', activity: meta.activity || [],
      companyId: row.company_id, created_at: row.created_at, updated_at: row.updated_at,
      closed_at: meta.closed_at || null,
    };

    const updates = req.body;

    if (updates.title) deal.title = updates.title;
    if (updates.value !== undefined) deal.value = updates.value;
    if (updates.notes) deal.notes = updates.notes;
    if (updates.contact_id) deal.contact_id = updates.contact_id;
    if (updates.contact_name) deal.contact_name = updates.contact_name;

    if (updates.stage && updates.stage !== deal.stage) {
      const oldStage = deal.stage;
      const newStage = updates.stage;
      deal.activity.push({
        type: 'stage_change',
        message: `Stage: ${oldStage} → ${newStage}`,
        timestamp: new Date().toISOString()
      });
      deal.stage = newStage;
      if (newStage === 'won' || newStage === 'lost') {
        deal.closed_at = new Date().toISOString();
      }
      if (deal.contact_id) {
        // Cross-write is company-scoped: addActivity only writes if the contact
        // belongs to this deal's company (no-op otherwise), so a deal cannot
        // annotate a contact in another tenant.
        await contactDb.addActivity(deal.contact_id, {
          type: 'deal_stage_change',
          message: `Deal "${deal.title}" moved from ${oldStage} to ${newStage}`,
          channel: 'crm',
          data: { deal_id: deal.id, old_stage: oldStage, new_stage: newStage, value: deal.value }
        }, companyId);
      }
    }

    deal.updated_at = new Date().toISOString();

    await query(
      `UPDATE deals SET title=$1, value=$2, stage=$3, contact_id=$4, metadata=$5, updated_at=NOW() WHERE id=$6 AND company_id=$7`,
      [deal.title, deal.value, deal.stage, deal.contact_id,
       JSON.stringify({ contact_name: deal.contact_name, notes: deal.notes, activity: deal.activity, closed_at: deal.closed_at }),
       deal.id, companyId]
    );

    broadcast(req, { type: 'deal_updated', deal });
    res.json(deal);
  } catch (err) {
    console.error('[CRM] PATCH /deals/:id error:', err.message);
    res.status(500).json({ error: 'failed to update deal' });
  }
});

// GET /api/crm/stats
router.get('/stats', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contacts = await contactDb.list(companyId, {});
    const deals = await loadDeals(companyId);

    const now = new Date();
    const dayAgo = new Date(now - 86400000);
    const weekAgo = new Date(now - 604800000);

    res.json({
      contacts: {
        total: contacts.length,
        hot: contacts.filter(c => (c.lead_score || c.leadScore) === 'hot').length,
        warm: contacts.filter(c => (c.lead_score || c.leadScore) === 'warm').length,
        new_today: contacts.filter(c => new Date(c.created_at) > dayAgo).length,
        new_this_week: contacts.filter(c => new Date(c.created_at) > weekAgo).length,
        by_source: contacts.reduce((acc, c) => { acc[c.source] = (acc[c.source] || 0) + 1; return acc; }, {}),
        by_stage: contacts.reduce((acc, c) => { const stg = c.deal_stage || c.dealStage || 'lead'; acc[stg] = (acc[stg] || 0) + 1; return acc; }, {})
      },
      deals: {
        total: deals.length,
        open: deals.filter(d => !['won', 'lost'].includes(d.stage)).length,
        won: deals.filter(d => d.stage === 'won').length,
        lost: deals.filter(d => d.stage === 'lost').length,
        pipeline_value: deals.filter(d => !['won', 'lost'].includes(d.stage)).reduce((s, d) => s + (d.value || 0), 0),
        won_value: deals.filter(d => d.stage === 'won').reduce((s, d) => s + (d.value || 0), 0),
        by_stage: DEAL_STAGES.reduce((acc, s) => { acc[s] = deals.filter(d => d.stage === s).length; return acc; }, {})
      }
    });
  } catch (err) {
    console.error('[CRM] GET /stats error:', err.message);
    res.status(500).json({ error: 'failed to load stats' });
  }
});

// PATCH /api/crm/contacts/:id/follow-up
router.patch('/contacts/:id/follow-up', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const existing = await contactDb.getById(req.params.id, companyId);
    if (!existing) return res.status(404).json({ error: 'contact not found' });

    const { next_follow_up, action_taken, notes } = req.body;

    const updateData = { last_contacted: new Date().toISOString() };
    if (next_follow_up) updateData.next_follow_up = next_follow_up;

    await contactDb.addActivity(req.params.id, {
      type: 'follow_up',
      message: action_taken || 'Follow-up completed',
      agent: req.body.agent || 'human',
      data: { notes, next_follow_up }
    }, companyId);

    const contact = await contactDb.update(req.params.id, updateData, companyId);
    broadcast(req, { type: 'contact_updated', contact: contact || existing });
    res.json(contact || existing);
  } catch (err) {
    console.error('[CRM] PATCH /contacts/:id/follow-up error:', err.message);
    res.status(500).json({ error: 'failed to update follow-up' });
  }
});

// GET /api/crm/activity/recent
router.get('/activity/recent', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const limit = parseInt(req.query.limit) || 20;

    const { rows } = await query(
      `SELECT ca.*, c.name AS contact_name, c.company_name AS contact_company, c.lead_score
       FROM contact_activity ca
       JOIN contacts c ON c.id = ca.contact_id
       WHERE ca.company_id = $1
       ORDER BY ca.created_at DESC LIMIT $2`,
      [companyId, limit]
    );
    res.json({ activities: rows });
  } catch (err) {
    console.error('[CRM] GET /activity/recent error:', err.message);
    res.status(500).json({ error: 'failed to load recent activity' });
  }
});

// GET /api/crm/pipeline
router.get('/pipeline', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contacts = await contactDb.list(companyId, {});
    const pipeline = {};
    DEAL_STAGES.forEach(stage => {
      const stageContacts = contacts.filter(c => (c.deal_stage || c.dealStage) === stage);
      pipeline[stage] = {
        count: stageContacts.length,
        value: stageContacts.reduce((s, c) => s + (c.deal_value || c.dealValue || 0), 0),
        contacts: stageContacts.map(c => ({
          id: c.id, name: c.name, company: c.company_name, lead_score: c.lead_score || c.leadScore,
          deal_value: c.deal_value || c.dealValue, last_contacted: c.last_contacted,
          linkedin_url: c.linkedin_url, source: c.source
        }))
      };
    });
    res.json({ pipeline });
  } catch (err) {
    console.error('[CRM] GET /pipeline error:', err.message);
    res.status(500).json({ error: 'failed to load pipeline' });
  }
});

// GET /api/crm/pipeline/transitions — the authoritative stage state machine.
// automation_core mirrors this map for its postgres backend and asserts equality
// against this endpoint in CI (drift detector). CRM is the single source of truth.
router.get('/pipeline/transitions', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { stages, transitions } = await getPipelineStages(companyId);
    res.json({ stages, transitions });
  } catch (err) {
    console.error('[CRM] GET /pipeline/transitions error:', err.message);
    res.status(500).json({ error: 'failed to load transitions' });
  }
});

// ───────── PROSPECT INBOX (cross-engine handoff) ──────────────────────────────
const HANDOFF_STATUSES = ['pending', 'claimed', 'enrolled', 'done'];

// POST /api/crm/prospect-inbox — enqueue a handoff (idempotent on contact+target;
// re-enqueue of a 'done' row resets it to pending so a contact can be re-handed-off).
router.post('/prospect-inbox', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { contact_id, target_engine = null, source_engine = null, suggested_campaign = null, metadata = {} } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

    // Tenant guard: the contact must belong to the caller's company.
    const contact = await contactDb.getById(contact_id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const resetBody = `
      source_engine      = COALESCE(EXCLUDED.source_engine, prospect_inbox.source_engine),
      suggested_campaign = COALESCE(EXCLUDED.suggested_campaign, prospect_inbox.suggested_campaign),
      metadata           = prospect_inbox.metadata || EXCLUDED.metadata,
      status     = CASE WHEN prospect_inbox.status = 'done' THEN 'pending' ELSE prospect_inbox.status END,
      claimed_by = CASE WHEN prospect_inbox.status = 'done' THEN NULL      ELSE prospect_inbox.claimed_by END,
      claimed_at = CASE WHEN prospect_inbox.status = 'done' THEN NULL      ELSE prospect_inbox.claimed_at END,
      created_at = CASE WHEN prospect_inbox.status = 'done' THEN now()     ELSE prospect_inbox.created_at END`;

    let row;
    if (target_engine === null) {
      // Broadcast: arbiter is the partial unique index on (contact_id) WHERE target_engine IS NULL.
      const r = await query(
        `INSERT INTO prospect_inbox (company_id, contact_id, source_engine, target_engine, suggested_campaign, metadata)
         VALUES ($1,$2,$3,NULL,$4,$5)
         ON CONFLICT (contact_id) WHERE target_engine IS NULL
         DO UPDATE SET ${resetBody} RETURNING *`,
        [companyId, contact_id, source_engine, suggested_campaign, JSON.stringify(metadata || {})]
      );
      row = r.rows[0];
    } else {
      const r = await query(
        `INSERT INTO prospect_inbox (company_id, contact_id, source_engine, target_engine, suggested_campaign, metadata)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (contact_id, target_engine) WHERE target_engine IS NOT NULL
         DO UPDATE SET ${resetBody} RETURNING *`,
        [companyId, contact_id, source_engine, target_engine, suggested_campaign, JSON.stringify(metadata || {})]
      );
      row = r.rows[0];
    }
    broadcast(req, { type: 'prospect_enqueued', row });
    res.status(201).json(row);
  } catch (err) {
    console.error('[CRM] POST /prospect-inbox error:', err.message);
    res.status(500).json({ error: 'failed to enqueue prospect' });
  }
});

// POST /api/crm/prospect-inbox/claim — atomically claim pending rows for an engine
// (+ broadcast rows). FOR UPDATE SKIP LOCKED prevents double-claim under concurrency.
router.post('/prospect-inbox/claim', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { target_engine = null, limit = 1, claimed_by = null } = req.body;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 1, 1), 100);
    const r = await query(
      `UPDATE prospect_inbox SET status='claimed', claimed_by=$3, claimed_at=now()
       WHERE id IN (
         SELECT id FROM prospect_inbox
         WHERE company_id=$1 AND status='pending'
           AND ($2::text IS NULL OR target_engine=$2 OR target_engine IS NULL)
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $4
       )
       RETURNING *`,
      [companyId, target_engine, claimed_by, lim]
    );
    res.json({ claimed: r.rows });
  } catch (err) {
    console.error('[CRM] POST /prospect-inbox/claim error:', err.message);
    res.status(500).json({ error: 'failed to claim prospects' });
  }
});

// GET /api/crm/prospect-inbox?target_engine=&status=&limit=
router.get('/prospect-inbox', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { target_engine, status } = req.query;
    const lim = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const conditions = ['company_id = $1'];
    const params = [companyId];
    let idx = 2;
    if (target_engine !== undefined) { conditions.push(`(target_engine = $${idx++} OR target_engine IS NULL)`); params.push(target_engine); }
    if (status !== undefined) {
      if (!HANDOFF_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
      conditions.push(`status = $${idx++}`); params.push(status);
    }
    params.push(lim);
    const r = await query(
      `SELECT * FROM prospect_inbox WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT $${idx}`,
      params
    );
    res.json({ total: r.rows.length, rows: r.rows });
  } catch (err) {
    console.error('[CRM] GET /prospect-inbox error:', err.message);
    res.status(500).json({ error: 'failed to list prospects' });
  }
});

// PATCH /api/crm/prospect-inbox/:id — transition a handoff (e.g. → enrolled | done)
router.patch('/prospect-inbox/:id', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { status, claimed_by } = req.body;
    if (status && !HANDOFF_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    const sets = [];
    const params = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); params.push(status); }
    if (claimed_by !== undefined) { sets.push(`claimed_by = $${idx++}`); params.push(claimed_by); }
    if (status === 'claimed' || status === 'enrolled') { sets.push(`claimed_at = now()`); }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.id, companyId);
    const r = await query(
      `UPDATE prospect_inbox SET ${sets.join(', ')} WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'prospect not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[CRM] PATCH /prospect-inbox/:id error:', err.message);
    res.status(500).json({ error: 'failed to update prospect' });
  }
});

// DELETE /api/crm/contacts/:id
router.delete('/contacts/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const contact = await contactDb.getById(req.params.id, companyId);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    await query('DELETE FROM contacts WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    broadcast(req, { type: 'contact_deleted', id: req.params.id });
    res.json({ ok: true, deleted: contact });
  } catch (err) {
    console.error('[CRM] DELETE /contacts/:id error:', err.message);
    res.status(500).json({ error: 'failed to delete contact' });
  }
});

// DELETE /api/crm/deals/:id
router.delete('/deals/:id', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });
    await query('DELETE FROM deals WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    broadcast(req, { type: 'deal_deleted', id: req.params.id });
    res.json({ ok: true, deleted: rows[0] });
  } catch (err) {
    console.error('[CRM] DELETE /deals/:id error:', err.message);
    res.status(500).json({ error: 'failed to delete deal' });
  }
});

// POST /api/crm/deals/:id/activity
router.post('/deals/:id/activity', validate(), async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    const { type, message, agent, data } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const entry = { type: type || 'note', message, agent: agent || 'system', timestamp: new Date().toISOString(), data: data || null };

    const { rows } = await query(`SELECT * FROM deals WHERE id = $1 AND company_id = $2 LIMIT 1`, [req.params.id, companyId]);
    if (rows.length === 0) return res.status(404).json({ error: 'deal not found' });

    const row = rows[0];
    const meta = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) || {};
    const activity = meta.activity || [];
    activity.push(entry);

    await query(
      `UPDATE deals SET metadata = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3`,
      [JSON.stringify({ ...meta, activity }), row.id, companyId]
    );

    broadcast(req, { type: 'deal_activity', deal_id: row.id, entry });
    res.json(entry);
  } catch (err) {
    console.error('[CRM] POST /deals/:id/activity error:', err.message);
    res.status(500).json({ error: 'failed to add deal activity' });
  }
});

// POST /api/crm/contacts/bulk-import
router.post('/contacts/bulk-import', async (req, res) => {
  const { contacts: inputContacts } = req.body;
  if (!Array.isArray(inputContacts) || inputContacts.length === 0) {
    return res.status(400).json({ error: 'contacts array required' });
  }

  let created = 0, updated = 0, errors = 0;
  for (const input of inputContacts) {
    try {
      if (!input.email && !input.name) { errors++; continue; }
      const { contact, created: isNew } = await findOrCreateContact(input.email, {
        name: input.name,
        phone: input.phone,
        company: input.company,
        title: input.title || input.position,
        linkedin_url: input.linkedin_url || input.linkedin,
        source: input.source || 'bulk_import',
        lead_score: input.lead_score || 'cold',
        tags: input.tags || ['bulk_import'],
        utmSource: input.utmSource,
        utmMedium: input.utmMedium,
        utmCampaign: input.utmCampaign,
        metadata: input.metadata,
      });
      if (isNew) {
        await addContactActivity(contact.id, { type: 'prospect_loaded', message: `Loaded from bulk import (${input.source || 'list'})` });
        created++;
      } else {
        updated++;
      }
    } catch { errors++; }
  }

  res.json({ ok: true, created, updated, errors, total: inputContacts.length });
});

// GET /api/crm/contacts/export
router.get('/contacts/export', async (req, res) => {
  try {
    const companyId = getUserCompanyId(req);
    if (!companyId) return res.status(401).json({ error: 'Authentication required' });
    const contacts = await contactDb.list(companyId, {});
    const { format } = req.query;
    if (format === 'csv') {
      const csvSafe = (val) => {
        const s = String(val || '').replace(/"/g, '""');
        if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
        return s;
      };
      const headers = 'name,email,phone,company,source,lead_score,deal_stage,engagementScore,utmSource,tags,created_at';
      const rows = contacts.map(c =>
        `"${csvSafe(c.name)}","${csvSafe(c.email)}","${csvSafe(c.phone)}","${csvSafe(c.company_name)}","${csvSafe(c.source)}","${csvSafe(c.lead_score)}","${csvSafe(c.deal_stage)}",${c.lead_score_numeric || 0},"${csvSafe(c.utm_source)}","${csvSafe((c.tags || []).join(';'))}","${csvSafe(c.created_at)}"`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.send([headers, ...rows].join('\n'));
    } else {
      res.json({ total: contacts.length, contacts });
    }
  } catch (err) {
    console.error('[CRM] GET /contacts/export error:', err.message);
    res.status(500).json({ error: 'failed to export contacts' });
  }
});

// ─── Exported helpers ─────────────────────────────────────────────────────────

async function findContactByEmail(email, companyId) {
  if (!email) return null;
  return await contactDb.getByEmail(email, companyId || null);
}

async function findOrCreateContact(email, defaults = {}) {
  const companyId = defaults.company_id || defaults.companyId || null;

  let contact = email ? await contactDb.getByEmail(email, companyId) : null;

  if (!contact && (defaults.phone || defaults.linkedin_url)) {
    const allContacts = await contactDb.list(companyId, {});
    if (!contact && defaults.phone) {
      const normalized = defaults.phone.replace(/\D/g, '');
      contact = allContacts.find(c => c.phone && c.phone.replace(/\D/g, '') === normalized) || null;
    }
    if (!contact && defaults.linkedin_url) {
      contact = allContacts.find(c => c.linkedin_url && c.linkedin_url.toLowerCase() === defaults.linkedin_url.toLowerCase()) || null;
    }
  }

  if (contact) return { contact, created: false };

  const name = defaults.name || (email ? email.split('@')[0] : 'Unknown');
  const nameParts = name.trim().split(/\s+/);

  const contactData = {
    id: uuidv4(),
    name,
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '',
    email: email ? email.toLowerCase() : '',
    phone: defaults.phone || null,
    company: defaults.company || null,
    company_id: companyId,
    title: defaults.title || defaults.position || null,
    position: defaults.position || defaults.title || null,
    linkedin_url: defaults.linkedin_url || null,
    website: defaults.website || null,
    location: defaults.location || null,
    source: defaults.source || 'webhook',
    lead_score: defaults.lead_score || 'neutral',
    lead_score_numeric: LEAD_SCORES[defaults.lead_score || 'neutral'] || 30,
    deal_stage: defaults.deal_stage || 'lead',
    deal_value: defaults.deal_value || 0,
    engagementScore: 0,
    engagement_score: 0,
    utmSource: defaults.utmSource || null,
    utmMedium: defaults.utmMedium || null,
    utmCampaign: defaults.utmCampaign || null,
    utmContent: defaults.utmContent || null,
    whatsappOptIn: defaults.whatsappOptIn === true,
    smsOptIn: defaults.smsOptIn === true,
    isUnsubscribed: false,
    tags: defaults.tags || [],
    metadata: defaults.metadata || {},
    activity: [],
    last_contacted: null,
    next_follow_up: null,
  };

  contact = await contactDb.create(contactData);
  return { contact, created: true };
}

async function findContactByPhone(phone) {
  if (!phone) return null;
  const normalized = phone.replace(/\D/g, '');
  const allContacts = await contactDb.list(null, {});
  return allContacts.find(c => c.phone && c.phone.replace(/\D/g, '') === normalized) || null;
}

function calculateEngagementScore(contact) {
  if (!contact.activity || contact.activity.length === 0) return 0;
  let score = 0;
  for (const act of contact.activity) {
    score += ENGAGEMENT_WEIGHTS[act.type] || 0;
  }
  return Math.min(score, 100);
}

async function addContactActivity(contactId, entry) {
  const contact = await contactDb.getById(contactId);
  if (!contact) return false;

  const timestampedEntry = { ...entry, timestamp: new Date().toISOString() };
  await contactDb.addActivity(contactId, timestampedEntry);

  const updated = await contactDb.getById(contactId);
  const es = calculateEngagementScore(updated || contact);

  const updateData = { lead_score_numeric: es };

  if (es >= 80 && (contact.lead_score || contact.leadScore) !== 'hot') {
    updateData.lead_score = 'hot';
    updateData.lead_score_numeric = 90;
  } else if (es >= 50 && (contact.lead_score || contact.leadScore) === 'cold') {
    updateData.lead_score = 'warm';
    updateData.lead_score_numeric = 60;
  }

  await contactDb.update(contactId, updateData);
  return true;
}

router.findContactByEmail = findContactByEmail;
router.findContactByPhone = findContactByPhone;
router.findOrCreateContact = findOrCreateContact;
router.addContactActivity = addContactActivity;
router.calculateEngagementScore = calculateEngagementScore;

module.exports = router;

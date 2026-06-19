// ─── DAL: Contacts ──────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const { query } = require('../index');

// ─── Public API ─────────────────────────────────────────────────────────────

async function list(companyId, filters = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (companyId) {
    conditions.push(`company_id = $${idx++}`);
    params.push(companyId);
  }
  if (filters.dealStage) {
    conditions.push(`deal_stage = $${idx++}`);
    params.push(filters.dealStage);
  }
  if (filters.leadScore) {
    if (typeof filters.leadScore === 'number' || /^\d+$/.test(filters.leadScore)) {
      conditions.push(`lead_score_numeric >= $${idx++}`);
      params.push(parseInt(filters.leadScore, 10));
    } else {
      conditions.push(`lead_score = $${idx++}`);
      params.push(filters.leadScore);
    }
  }
  if (filters.source) {
    conditions.push(`source = $${idx++}`);
    params.push(filters.source);
  }
  if (filters.tags) {
    conditions.push(`tags && $${idx++}`);
    params.push(Array.isArray(filters.tags) ? filters.tags : [filters.tags]);
  }
  if (filters.search) {
    conditions.push(`(name ILIKE $${idx} OR email ILIKE $${idx} OR company_name ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }

  conditions.push('deleted_at IS NULL');
  const where = `WHERE ${conditions.join(' AND ')}`;

  if (filters.limit !== undefined || filters.offset !== undefined) {
    const limit = Math.min(parseInt(filters.limit, 10) || 50, 500);
    const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);
    const result = await query(
      `SELECT * FROM contacts ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    );
    return result.rows;
  }

  const result = await query(
    `SELECT * FROM contacts ${where} ORDER BY updated_at DESC`,
    params
  );
  return result.rows;
}

async function listPaginated(companyId, filters = {}) {
  const limit = Math.min(parseInt(filters.limit, 10) || 50, 500);
  const offset = Math.max(parseInt(filters.offset, 10) || 0, 0);

  const conditions = [];
  const params = [];
  let idx = 1;
  if (companyId) { conditions.push(`company_id = $${idx++}`); params.push(companyId); }
  if (filters.dealStage) { conditions.push(`deal_stage = $${idx++}`); params.push(filters.dealStage); }
  if (filters.source) { conditions.push(`source = $${idx++}`); params.push(filters.source); }
  if (filters.search) {
    conditions.push(`(name ILIKE $${idx} OR email ILIKE $${idx} OR company_name ILIKE $${idx})`);
    params.push(`%${filters.search}%`);
    idx++;
  }
  conditions.push('deleted_at IS NULL');
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [dataRes, countRes] = await Promise.all([
    query(`SELECT * FROM contacts ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`, [...params, limit, offset]),
    query(`SELECT COUNT(*)::int AS total FROM contacts ${where}`, params),
  ]);
  return { data: dataRes.rows, total: countRes.rows[0]?.total || 0, limit, offset };
}

// Company-scoped read. Pass companyId from a route handler so a caller can only
// see its own tenant's row (mismatch ⇒ null ⇒ route 404). Internal callers that
// legitimately need any row use getByIdUnscoped (kept private to this module).
async function getById(id, companyId) {
  if (companyId === undefined || companyId === null) return getByIdUnscoped(id);
  const result = await query(
    `SELECT * FROM contacts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [id, companyId]
  );
  return result.rows[0] || null;
}

async function getByIdUnscoped(id) {
  const result = await query(`SELECT * FROM contacts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]);
  return result.rows[0] || null;
}

async function getByEmail(email, companyId) {
  const result = await query(
    `SELECT * FROM contacts WHERE LOWER(email) = LOWER($1) AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [email, companyId]
  );
  return result.rows[0] || null;
}

async function create(data) {
  const now = new Date().toISOString();
  const contact = {
    id: data.id || uuidv4(),
    name: data.name || '',
    email: data.email || '',
    company_name: data.company_name || data.companyName || data.company || '',
    company_id: data.company_id || data.companyId || null,
    title: data.title || '',
    deal_stage: data.deal_stage || data.dealStage || 'lead',
    lead_score: data.lead_score || data.leadScore || 'neutral',
    lead_score_numeric: parseInt(data.lead_score_numeric || data.leadScoreNumeric || 0, 10),
    source: data.source || 'manual',
    tags: Array.isArray(data.tags) ? data.tags : [],
    phone: data.phone || '',
    linkedin_url: data.linkedin_url || data.linkedinUrl || '',
    deal_value: parseFloat(data.deal_value || data.dealValue || 0),
    utm_source: data.utm_source || data.utmSource || null,
    utm_medium: data.utm_medium || data.utmMedium || null,
    utm_campaign: data.utm_campaign || data.utmCampaign || null,
    utm_content: data.utm_content || data.utmContent || null,
    metadata: data.metadata || {},
    created_at: data.created_at || now,
    updated_at: now,
  };

  const result = await query(
    `INSERT INTO contacts (id, company_id, name, email, phone, company_name, title, linkedin_url,
      source, lead_score, lead_score_numeric, deal_stage, deal_value, tags, utm_source, utm_medium,
      utm_campaign, utm_content, metadata, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    [
      contact.id, contact.company_id, contact.name, contact.email, contact.phone,
      contact.company_name, contact.title, contact.linkedin_url,
      contact.source, contact.lead_score, contact.lead_score_numeric,
      contact.deal_stage, contact.deal_value, contact.tags,
      contact.utm_source, contact.utm_medium, contact.utm_campaign, contact.utm_content,
      JSON.stringify(contact.metadata), contact.created_at, contact.updated_at,
    ]
  );

  return result.rows[0] || contact;
}

// Company-scoped update. When companyId is passed, the WHERE clause restricts to
// that tenant — a cross-tenant id returns no row ⇒ null ⇒ route 404.
async function update(id, data, companyId) {
  const now = new Date().toISOString();
  data.updated_at = now;

  const ALLOWED_CONTACT_COLUMNS = ['name','email','phone','company_name','title','linkedin_url','source','lead_score','lead_score_numeric','deal_stage','deal_value','tags','utm_source','utm_medium','utm_campaign','utm_content','metadata','last_contacted','next_follow_up','updated_at'];
  const fields = Object.keys(data).filter(k => ALLOWED_CONTACT_COLUMNS.includes(k));
  if (fields.length === 0) return getById(id, companyId);

  const setClauses = [];
  const params = [];
  let pIdx = 1;

  for (const field of fields) {
    const val = data[field];
    if (field === 'metadata') {
      setClauses.push(`${field} = $${pIdx++}`);
      params.push(JSON.stringify(val));
    } else if (field === 'tags') {
      setClauses.push(`${field} = $${pIdx++}`);
      params.push(Array.isArray(val) ? val : [val]);
    } else {
      setClauses.push(`${field} = $${pIdx++}`);
      params.push(val);
    }
  }

  params.push(id);
  let where = `id = $${pIdx}`;
  if (companyId !== undefined && companyId !== null) {
    params.push(companyId);
    where += ` AND company_id = $${pIdx + 1}`;
  }
  const sql = `UPDATE contacts SET ${setClauses.join(', ')} WHERE ${where} RETURNING *`;
  const result = await query(sql, params);
  return result.rows[0] || null;
}

// When companyId is passed, the activity is only written if the contact belongs
// to that tenant (returns false on mismatch — route maps to 404).
async function addActivity(contactId, entry, companyId) {
  const timestamped = { ...entry, timestamp: entry.timestamp || new Date().toISOString() };

  const r = await query(`SELECT company_id FROM contacts WHERE id = $1 AND deleted_at IS NULL`, [contactId]);
  const rowCompany = r.rows[0]?.company_id || null;
  if (companyId !== undefined && companyId !== null) {
    if (!rowCompany || rowCompany !== companyId) return false; // cross-tenant or missing
  }
  const effectiveCompany = timestamped.company_id || rowCompany;

  await query(
    `INSERT INTO contact_activity (contact_id, company_id, type, message, channel, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      contactId, effectiveCompany, timestamped.type, timestamped.message,
      timestamped.channel || null, JSON.stringify(timestamped),
      timestamped.timestamp,
    ]
  );
  return true;
}

async function getActivity(contactId, limit = 50, companyId) {
  if (companyId !== undefined && companyId !== null) {
    const result = await query(
      `SELECT ca.* FROM contact_activity ca
        WHERE ca.contact_id = $1
          AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ca.contact_id AND c.company_id = $3)
        ORDER BY ca.created_at DESC LIMIT $2`,
      [contactId, limit, companyId]
    );
    return result.rows;
  }
  const result = await query(
    `SELECT * FROM contact_activity WHERE contact_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [contactId, limit]
  );
  return result.rows;
}

async function getStats(companyId) {
  const stageResult = await query(
    `SELECT deal_stage, COUNT(*)::int AS count, SUM(deal_value)::numeric AS value
     FROM contacts WHERE company_id = $1 GROUP BY deal_stage`,
    [companyId]
  );

  const totalResult = await query(
    `SELECT COUNT(*)::int AS total, COALESCE(SUM(deal_value), 0)::numeric AS total_value,
            COALESCE(AVG(NULLIF(lead_score_numeric, 0)), 0)::numeric AS avg_score
     FROM contacts WHERE company_id = $1`,
    [companyId]
  );

  const byStage = {};
  for (const row of stageResult.rows) {
    byStage[row.deal_stage] = { count: row.count, value: parseFloat(row.value) || 0 };
  }

  const totals = totalResult.rows[0] || {};
  return {
    totalContacts: totals.total || 0,
    byStage,
    totalDealValue: parseFloat(totals.total_value) || 0,
    avgLeadScore: Math.round(parseFloat(totals.avg_score) || 0),
  };
}

module.exports = {
  list,
  listPaginated,
  getById,
  getByEmail,
  create,
  update,
  addActivity,
  getActivity,
  getStats,
};

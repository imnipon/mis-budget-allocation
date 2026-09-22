/**
 * Audit.gs
 * บันทึก log กลางของทุกการเปลี่ยนแปลง (append-only)
 * ทุกฟังก์ชันที่เขียนข้อมูลต้องเรียก writeAudit_() เสมอ
 */

function writeAudit_(o) {
  const rec = {
    log_id: newId_('LOG'),
    timestamp: nowIso_(),
    actor_email: normEmail_(o.actor),
    action: str_(o.action),
    entity_type: str_(o.entityType),
    entity_id: str_(o.entityId),
    budget_id: str_(o.budgetId),
    summary: str_(o.summary),
    reason: str_(o.reason),
    before_json: o.before ? JSON.stringify(serialize_(o.before)) : '',
    after_json: o.after ? JSON.stringify(serialize_(o.after)) : '',
    attachment_ids: Array.isArray(o.attachmentIds) ? o.attachmentIds.join(',') : str_(o.attachmentIds)
  };
  insertRow_(SH.AUDIT, rec);
  return rec.log_id;
}

/**
 * อ่าน audit log แบบกรองได้
 * filter: { budgetId, entityType, entityId, action, actor, from, to, limit }
 */
function listAudit_(user, filter) {
  filter = filter || {};
  requireAuditView_(user, filter.budgetId || '');

  const allowed = {};
  if (user.isSuperAdmin || user.isExecutive) {
    // เห็นทั้งหมด
  } else {
    const map = getRoleMap_(user.email);
    Object.keys(map).forEach(function (k) {
      if (ROLE_RANK[map[k]] >= ROLE_RANK[ROLE.TXN_MANAGER]) allowed[k] = true;
    });
  }
  const limit = Math.min(Number(filter.limit) || CFG.AUDIT_PAGE_SIZE, 1000);
  const from = str_(filter.from);
  const to = str_(filter.to);

  const rows = readTable_(SH.AUDIT).filter(function (r) {
    const bid = str_(r.budget_id);
    if (!user.isSuperAdmin && !user.isExecutive) {
      if (bid) { if (!allowed[bid]) return false; }
      else if (normEmail_(r.actor_email) !== user.email) return false;
    }
    if (filter.budgetId && bid !== str_(filter.budgetId)) return false;
    if (filter.entityType && str_(r.entity_type) !== str_(filter.entityType)) return false;
    if (filter.entityId && str_(r.entity_id) !== str_(filter.entityId)) return false;
    if (filter.action && str_(r.action) !== str_(filter.action)) return false;
    if (filter.actor && normEmail_(r.actor_email).indexOf(normEmail_(filter.actor)) < 0) return false;
    const ts = dateOnly_(r.timestamp);
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return true;
  });

  // ใหม่→เก่า; เวลาเท่ากันใช้ลำดับแถว (ลำดับการบันทึกจริง) เป็นตัวตัดสิน
  rows.sort(function (a, b) {
    const ta = String(serialize_(a.timestamp)), tb = String(serialize_(b.timestamp));
    return ta === tb ? b._row - a._row : tb.localeCompare(ta);
  });

  const budgetNames = {};
  readTable_(SH.BUDGETS).forEach(function (b) { budgetNames[str_(b.budget_id)] = str_(b.code) + ' – ' + str_(b.name); });

  return {
    total: rows.length,
    rows: rows.slice(0, limit).map(function (r) {
      return {
        logId: str_(r.log_id),
        timestamp: serialize_(r.timestamp),
        actor: str_(r.actor_email),
        action: str_(r.action),
        actionLabel: LABELS.action[str_(r.action)] || str_(r.action),
        entityType: str_(r.entity_type),
        entityId: str_(r.entity_id),
        budgetId: str_(r.budget_id),
        budgetName: budgetNames[str_(r.budget_id)] || '',
        summary: str_(r.summary),
        reason: str_(r.reason),
        before: safeParse_(r.before_json),
        after: safeParse_(r.after_json),
        attachments: attachmentsByIds_(idListToArray_(r.attachment_ids))
      };
    })
  };
}

function safeParse_(s) {
  const t = str_(s);
  if (!t) return null;
  try { return JSON.parse(t); } catch (e) { return { raw: t }; }
}

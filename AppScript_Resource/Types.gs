/**
 * Types.gs
 * จัดการประเภท/หมวดงบประมาณ (A–Z) พร้อมชื่อและคำอธิบาย
 * ใช้เป็นตัวเลือกตอนสร้างงบ และตัวกรองภาพรวม
 */

function toTypeDto_(t) {
  return {
    typeId: str_(t.type_id),
    code: str_(t.code).toUpperCase(),
    name: str_(t.name),
    description: str_(t.description),
    status: str_(t.status) || STATUS.ACTIVE,
    createdAt: serialize_(t.created_at),
    createdBy: str_(t.created_by),
    updatedAt: serialize_(t.updated_at),
    updatedBy: str_(t.updated_by)
  };
}

function getTypeMap_() {
  const map = {};
  readTable_(SH.BUDGET_TYPES).forEach(function (t) {
    if (str_(t.status) !== STATUS.ACTIVE) return;
    const c = str_(t.code).toUpperCase();
    if (c) map[c] = toTypeDto_(t);
  });
  return map;
}

/** รายการประเภท — ผู้ใช้ที่ล็อกอินแล้วอ่านได้ (สำหรับฟอร์ม/ตัวกรอง) */
function listBudgetTypes_(user, opt) {
  opt = opt || {};
  if (!user || user.systemRole === ROLE.NONE) return [];
  const includeInactive = !!opt.includeInactive && user.isSuperAdmin;
  return readTable_(SH.BUDGET_TYPES)
    .filter(function (t) {
      return includeInactive || str_(t.status) === STATUS.ACTIVE;
    })
    .map(toTypeDto_)
    .sort(function (a, b) { return a.code.localeCompare(b.code); });
}

function findTypeByCode_(code) {
  const c = str_(code).toUpperCase();
  const rows = readTable_(SH.BUDGET_TYPES);
  for (let i = 0; i < rows.length; i++) {
    if (str_(rows[i].code).toUpperCase() === c) return rows[i];
  }
  return null;
}

/**
 * สร้าง/แก้ไขประเภท — เฉพาะผู้ดูแลระบบ
 * payload: { code, name, description, status }
 */
function upsertBudgetType_(user, payload) {
  requireSuperAdmin_(user);
  const code = str_(payload.code).toUpperCase();
  if (!/^[A-Z]$/.test(code)) throw new Error('รหัสประเภทต้องเป็นตัวอักษร A–Z ตัวเดียว');
  const name = str_(payload.name);
  if (!name) throw new Error('กรุณาระบุชื่อประเภท');
  const status = payload.status === STATUS.INACTIVE ? STATUS.INACTIVE : STATUS.ACTIVE;

  return withLock_(function () {
    const existing = findTypeByCode_(code);
    if (existing) {
      const before = toTypeDto_(existing);
      updateRow_(SH.BUDGET_TYPES, existing._row, {
        name: name,
        description: str_(payload.description),
        status: status,
        updated_at: nowIso_(),
        updated_by: user.email
      });
      writeAudit_({
        actor: user.email, action: ACTION.TYPE_UPSERT, entityType: ENTITY.BUDGET_TYPE, entityId: code,
        summary: 'แก้ไขประเภท ' + code + ' – ' + name,
        reason: str_(payload.reason), before: before,
        after: { code: code, name: name, description: str_(payload.description), status: status }
      });
      return { code: code, mode: 'update' };
    }
    const id = newId_('TYP');
    insertRow_(SH.BUDGET_TYPES, {
      type_id: id, code: code, name: name, description: str_(payload.description),
      status: status,
      created_at: nowIso_(), created_by: user.email,
      updated_at: nowIso_(), updated_by: user.email
    });
    writeAudit_({
      actor: user.email, action: ACTION.TYPE_UPSERT, entityType: ENTITY.BUDGET_TYPE, entityId: code,
      summary: 'เพิ่มประเภท ' + code + ' – ' + name,
      reason: str_(payload.reason),
      after: { code: code, name: name, description: str_(payload.description), status: status }
    });
    return { code: code, mode: 'create', typeId: id };
  });
}

/** นับจำนวนโครงการต่อประเภท */
function countBudgetsByType_() {
  const map = {};
  readTable_(SH.BUDGETS).forEach(function (b) {
    const c = str_(b.code).toUpperCase();
    if (!c) return;
    map[c] = (map[c] || 0) + 1;
  });
  return map;
}

function listBudgetTypesAdmin_(user) {
  requireSuperAdmin_(user);
  const counts = countBudgetsByType_();
  return listBudgetTypes_(user, { includeInactive: true }).map(function (t) {
    t.budgetCount = counts[t.code] || 0;
    return t;
  });
}

/** seed ประเภทเริ่มต้น A–D ถ้ายังไม่มี */
function seedDefaultTypes_(actorEmail) {
  const defaults = [
    { code: 'A', name: 'พัฒนาระบบ / ดิจิทัล', description: 'โครงการพัฒนาซอฟต์แวร์ ระบบสารสนเทศ และงานดิจิทัล' },
    { code: 'B', name: 'บำรุงรักษา', description: 'งานบำรุงรักษาฮาร์ดแวร์ ซอฟต์แวร์ และสัญญาบริการต่อเนื่อง' },
    { code: 'C', name: 'ฝึกอบรม / พัฒนาบุคลากร', description: 'การอบรม สัมมนา และพัฒนาทักษะบุคลากร' },
    { code: 'D', name: 'สำรอง / ค่าใช้จ่ายทั่วไป', description: 'งบสำรองและรายจ่ายทั่วไปที่ไม่เข้าประเภทอื่น' }
  ];
  defaults.forEach(function (d) {
    if (findTypeByCode_(d.code)) return;
    insertRow_(SH.BUDGET_TYPES, {
      type_id: newId_('TYP'), code: d.code, name: d.name, description: d.description,
      status: STATUS.ACTIVE,
      created_at: nowIso_(), created_by: actorEmail || 'system',
      updated_at: nowIso_(), updated_by: actorEmail || 'system'
    });
  });
}

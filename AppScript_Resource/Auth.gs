/**
 * Auth.gs
 * ระบุตัวตนผู้ใช้ + ตรวจสอบสิทธิ์
 *
 * ระดับระบบ
 *   SUPER_ADMIN → ทุกอย่าง
 *   EXECUTIVE   → ดูทุกโครงการ + ภาพรวม (อ่านอย่างเดียว) ไม่ต้องมีสิทธิ์รายงบ
 *   USER        → ตามสิทธิ์รายงบเท่านั้น
 *
 * ระดับรายงบ (Permissions.role)
 *   OWNER       → แก้ข้อมูลงบ / ปรับวงเงิน / รายการใช้งบ / ดูประวัติ
 *   TXN_MANAGER → เพิ่ม-แก้รายการใช้งบ / ดูประวัติ
 *   VIEWER      → ดู dashboard/รายการเท่านั้น (ไม่เห็นประวัติ)
 */

var __currentUser = null;

/** รวมอีเมลผู้ดูแลระบบจาก Script Properties + รายชื่อคงที่ในโค้ด */
function getSuperAdminEmails_() {
  const props = PropertiesService.getScriptProperties();
  const fromProps = str_(props.getProperty(CFG.PROP_SUPER_ADMINS))
    .split(',').map(normEmail_).filter(Boolean);
  const fromCode = (CFG.DEFAULT_SUPER_ADMINS || []).map(normEmail_).filter(Boolean);
  const all = fromProps.concat(fromCode);
  return all.filter(function (e, i, a) { return a.indexOf(e) === i; });
}

/** หาผู้ใช้จากอีเมลแบบไม่สนตัวพิมพ์เล็ก/ใหญ่ */
function findUserByEmail_(email) {
  const target = normEmail_(email);
  if (!target) return null;
  const rows = readTable_(SH.USERS);
  for (let i = 0; i < rows.length; i++) {
    if (normEmail_(rows[i].email) === target) return rows[i];
  }
  return null;
}

function getCurrentUser_() {
  if (__currentUser) return __currentUser;

  const props = PropertiesService.getScriptProperties();
  let email = normEmail_(Session.getActiveUser().getEmail());
  if (!email) email = normEmail_(props.getProperty(CFG.PROP_DEV_EMAIL));
  if (!email) {
    throw new Error('ไม่สามารถระบุตัวตนผู้ใช้ได้ — เว็บแอปนี้ต้องเปิดด้วยบัญชีในองค์กรเดียวกับเจ้าของสคริปต์ (Google Workspace) กรุณาติดต่อผู้ดูแลระบบ');
  }

  const bootstrapSupers = getSuperAdminEmails_();

  let row = findUserByEmail_(email);
  if (!row) {
    const cfg = getConfigMap_();
    const isSuper = bootstrapSupers.indexOf(email) >= 0;
    if (!isSuper && str_(cfg.allow_self_register).toUpperCase() !== 'TRUE') {
      __currentUser = {
        email: email,
        displayName: email.split('@')[0],
        systemRole: ROLE.NONE,
        isSuperAdmin: false,
        isExecutive: false,
        status: 'UNREGISTERED'
      };
      return __currentUser;
    }
    row = {
      user_id: newId_('USR'),
      email: email,
      display_name: email.split('@')[0],
      system_role: isSuper ? ROLE.SUPER_ADMIN : ROLE.USER,
      status: STATUS.ACTIVE,
      note: isSuper ? 'bootstrap super admin' : 'ลงทะเบียนอัตโนมัติเมื่อเข้าใช้งานครั้งแรก',
      created_at: nowIso_(), created_by: email, updated_at: nowIso_(), updated_by: email
    };
    insertRow_(SH.USERS, row);
  }

  const rawRole = str_(row.system_role);
  const isSuper = rawRole === ROLE.SUPER_ADMIN || bootstrapSupers.indexOf(email) >= 0;
  // ถ้าอยู่ในรายชื่อผู้ดูแลระบบคงที่ แต่ชีตยังเป็น role อื่น → ยกเป็น SUPER_ADMIN ในหน่วยความจำ + แก้ชีตให้ตรง
  if (isSuper && rawRole !== ROLE.SUPER_ADMIN) {
    try {
      updateRow_(SH.USERS, row._row, {
        system_role: ROLE.SUPER_ADMIN, status: STATUS.ACTIVE, updated_at: nowIso_()
      });
    } catch (e) { /* อ่านได้อย่างเดียวก็ยังถือเป็น super ใน session นี้ */ }
  }
  const isExecutive = !isSuper && rawRole === ROLE.EXECUTIVE;
  const systemRole = isSuper ? ROLE.SUPER_ADMIN : (isExecutive ? ROLE.EXECUTIVE : (rawRole || ROLE.USER));

  __currentUser = {
    email: email,
    displayName: str_(row.display_name) || email.split('@')[0],
    systemRole: systemRole,
    isSuperAdmin: isSuper,
    isExecutive: isExecutive,
    status: str_(row.status) || STATUS.ACTIVE
  };
  if (__currentUser.status === STATUS.INACTIVE) {
    // ผู้ดูแลระบบในรายชื่อคงที่ห้ามถูกระงับด้วยสถานะชีต (กันล็อกตัวเอง)
    if (isSuper) {
      __currentUser.status = STATUS.ACTIVE;
    } else {
      throw new Error('บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
    }
  }
  return __currentUser;
}

function getRoleMap_(email) {
  const target = normEmail_(email);
  const map = {};
  readTable_(SH.PERMISSIONS).forEach(function (p) {
    if (normEmail_(p.email) !== target) return;
    if (str_(p.status) !== STATUS.ACTIVE) return;
    const bid = str_(p.budget_id);
    const role = normalizeBudgetRole_(p.role);
    if (!bid || !role) return;
    if (!map[bid] || ROLE_RANK[role] > ROLE_RANK[map[bid]]) map[bid] = role;
  });
  return map;
}

function roleForBudget_(user, budgetId) {
  if (user.isSuperAdmin) return ROLE.SUPER_ADMIN;
  if (user.isExecutive) return ROLE.VIEWER; // อ่านอย่างเดียวทุกงบ
  const map = getRoleMap_(user.email);
  return map[str_(budgetId)] || ROLE.NONE;
}

function canView_(user, budgetId) {
  if (user.isSuperAdmin || user.isExecutive) return true;
  return ROLE_RANK[roleForBudget_(user, budgetId)] >= ROLE_RANK[ROLE.VIEWER];
}

/** แก้ข้อมูลงบ / ปรับวงเงิน */
function canManageBudget_(user, budgetId) {
  if (user.isSuperAdmin) return true;
  if (user.isExecutive) return false;
  const role = roleForBudget_(user, budgetId);
  return ROLE_RANK[role] >= ROLE_RANK[ROLE.OWNER];
}

/** เพิ่ม/แก้ไขรายการใช้งบ */
function canManageTxn_(user, budgetId) {
  if (user.isSuperAdmin) return true;
  if (user.isExecutive) return false;
  const role = roleForBudget_(user, budgetId);
  return ROLE_RANK[role] >= ROLE_RANK[ROLE.TXN_MANAGER];
}

/** ดูประวัติการเปลี่ยนแปลง / audit ของงบ */
function canViewAudit_(user, budgetId) {
  if (user.isSuperAdmin) return true;
  if (user.isExecutive) return true; // ดูได้อย่างเดียวทุกโครงการ
  const role = roleForBudget_(user, budgetId);
  return ROLE_RANK[role] >= ROLE_RANK[ROLE.TXN_MANAGER];
}

function canViewOverview_(user) {
  return !!(user.isSuperAdmin || user.isExecutive);
}

function requireView_(user, budgetId) {
  if (!canView_(user, budgetId)) throw new Error('คุณไม่มีสิทธิ์ดูงบประมาณนี้');
}

function requireManageBudget_(user, budgetId) {
  if (!canManageBudget_(user, budgetId)) {
    throw new Error('คุณไม่มีสิทธิ์แก้ไขข้อมูลงบ/ปรับวงเงิน (ต้องเป็นผู้รับผิดชอบ)');
  }
}

function requireManageTxn_(user, budgetId) {
  if (!canManageTxn_(user, budgetId)) {
    throw new Error('คุณไม่มีสิทธิ์บันทึก/แก้ไขรายการใช้งบ');
  }
}

/** ชื่อเดิม — ใช้กับโค้ดเก่าที่ยังเรียก requireManage_ (= แก้รายการ) */
function requireManage_(user, budgetId) {
  requireManageTxn_(user, budgetId);
}

function requireSuperAdmin_(user) {
  if (!user.isSuperAdmin) throw new Error('เฉพาะผู้ดูแลระบบเท่านั้น');
}

function requireOverview_(user) {
  if (!canViewOverview_(user)) throw new Error('เฉพาะผู้ดูแลระบบและผู้บริหารเท่านั้นที่ดูภาพรวมได้');
}

function requireAuditView_(user, budgetId) {
  if (budgetId) {
    if (!canViewAudit_(user, budgetId)) throw new Error('คุณไม่มีสิทธิ์ดูประวัติการเปลี่ยนแปลงของงบนี้');
  } else if (!user.isSuperAdmin && !user.isExecutive) {
    // รายการ audit รวม: ต้องมีอย่างน้อยหนึ่งงบที่เป็น OWNER/TXN_MANAGER
    const map = getRoleMap_(user.email);
    const ok = Object.keys(map).some(function (k) {
      return ROLE_RANK[map[k]] >= ROLE_RANK[ROLE.TXN_MANAGER];
    });
    if (!ok) throw new Error('คุณไม่มีสิทธิ์ดูประวัติการเปลี่ยนแปลง');
  }
}

function accessibleBudgets_(user) {
  if (user.isSuperAdmin || user.isExecutive) {
    return readTable_(SH.BUDGETS).map(function (b) {
      b._role = user.isSuperAdmin ? ROLE.SUPER_ADMIN : ROLE.VIEWER;
      return b;
    });
  }
  const map = getRoleMap_(user.email);
  return readTable_(SH.BUDGETS).filter(function (b) {
    return !!map[str_(b.budget_id)];
  }).map(function (b) {
    b._role = map[str_(b.budget_id)];
    return b;
  });
}

/* ───────────── การจัดการผู้ใช้ / สิทธิ์ ───────────── */

function upsertUser_(user, payload) {
  requireSuperAdmin_(user);
  const email = normEmail_(payload.email);
  if (!email || email.indexOf('@') < 0) throw new Error('อีเมลไม่ถูกต้อง');

  let role = str_(payload.systemRole);
  if (role !== ROLE.SUPER_ADMIN && role !== ROLE.EXECUTIVE) role = ROLE.USER;
  const status = payload.status === STATUS.INACTIVE ? STATUS.INACTIVE : STATUS.ACTIVE;

  if (email === user.email && (status === STATUS.INACTIVE || role !== ROLE.SUPER_ADMIN)) {
    throw new Error('ไม่สามารถลดสิทธิ์หรือระงับบัญชีของตัวเองได้ — ให้ผู้ดูแลระบบคนอื่นดำเนินการ');
  }

  return withLock_(function () {
    const existing = findRow_(SH.USERS, 'email', email);
    if (existing) {
      const before = { email: email, system_role: existing.system_role, status: existing.status, display_name: existing.display_name };
      updateRow_(SH.USERS, existing._row, {
        display_name: str_(payload.displayName) || existing.display_name,
        system_role: role, status: status, note: str_(payload.note),
        updated_at: nowIso_(), updated_by: user.email
      });
      writeAudit_({
        actor: user.email, action: ACTION.USER_UPSERT, entityType: ENTITY.USER, entityId: email,
        summary: 'แก้ไขผู้ใช้ ' + email + ' → ' + role + '/' + status,
        reason: str_(payload.note), before: before,
        after: { email: email, system_role: role, status: status, display_name: str_(payload.displayName) }
      });
      return { email: email, mode: 'update' };
    }
    insertRow_(SH.USERS, {
      user_id: newId_('USR'), email: email,
      display_name: str_(payload.displayName) || email.split('@')[0],
      system_role: role, status: status, note: str_(payload.note),
      created_at: nowIso_(), created_by: user.email, updated_at: nowIso_(), updated_by: user.email
    });
    writeAudit_({
      actor: user.email, action: ACTION.USER_UPSERT, entityType: ENTITY.USER, entityId: email,
      summary: 'เพิ่มผู้ใช้ ' + email + ' (' + role + ')', reason: str_(payload.note),
      after: { email: email, system_role: role, status: status }
    });
    return { email: email, mode: 'create' };
  });
}

/**
 * ตั้งสิทธิ์รายงบจากรายชื่ออีเมล 3 กลุ่ม (ใช้ตอนสร้าง/แก้ไขงบ)
 * owners[], txnManagers[], viewers[]
 */
function syncBudgetPermissions_(actorEmail, budgetId, owners, txnManagers, viewers) {
  const groups = [
    { role: ROLE.OWNER, emails: owners || [] },
    { role: ROLE.TXN_MANAGER, emails: txnManagers || [] },
    { role: ROLE.VIEWER, emails: viewers || [] }
  ];
  const desired = {}; // email → highest role
  groups.forEach(function (g) {
    g.emails.forEach(function (raw) {
      const e = normEmail_(raw);
      if (!e || e.indexOf('@') < 0) return;
      if (!desired[e] || ROLE_RANK[g.role] > ROLE_RANK[desired[e]]) desired[e] = g.role;
    });
  });

  const existing = readTable_(SH.PERMISSIONS).filter(function (p) {
    return str_(p.budget_id) === str_(budgetId) && str_(p.status) === STATUS.ACTIVE;
  });

  const seen = {};
  existing.forEach(function (p) {
    const e = normEmail_(p.email);
    const want = desired[e];
    if (!want) {
      updateRow_(SH.PERMISSIONS, p._row, {
        status: STATUS.REVOKED, revoked_by: actorEmail, revoked_at: nowIso_()
      });
      return;
    }
    seen[e] = true;
    const cur = normalizeBudgetRole_(p.role);
    if (cur !== want) {
      updateRow_(SH.PERMISSIONS, p._row, {
        role: want, granted_by: actorEmail, granted_at: nowIso_()
      });
    }
  });

  Object.keys(desired).forEach(function (e) {
    if (seen[e]) return;
    insertRow_(SH.PERMISSIONS, {
      permission_id: newId_('PRM'), budget_id: budgetId, email: e, role: desired[e],
      status: STATUS.ACTIVE, note: 'กำหนดจากฟอร์มงบประมาณ',
      granted_by: actorEmail, granted_at: nowIso_(), revoked_by: '', revoked_at: ''
    });
    if (!findRow_(SH.USERS, 'email', e)) {
      insertRow_(SH.USERS, {
        user_id: newId_('USR'), email: e, display_name: e.split('@')[0],
        system_role: ROLE.USER, status: STATUS.ACTIVE,
        note: 'สร้างจากการกำหนดสิทธิ์งบ',
        created_at: nowIso_(), created_by: actorEmail, updated_at: nowIso_(), updated_by: actorEmail
      });
    }
  });

  return desired;
}

function grantPermission_(user, payload) {
  const budgetId = str_(payload.budgetId);
  requireManageBudget_(user, budgetId);
  const email = normEmail_(payload.email);
  if (!email || email.indexOf('@') < 0) throw new Error('อีเมลไม่ถูกต้อง');
  let role = str_(payload.role);
  if (role === ROLE.ADMIN) role = ROLE.OWNER;
  if (role !== ROLE.OWNER && role !== ROLE.TXN_MANAGER && role !== ROLE.VIEWER) {
    role = ROLE.VIEWER;
  }
  const budget = findRow_(SH.BUDGETS, 'budget_id', budgetId);
  if (!budget) throw new Error('ไม่พบงบประมาณ');

  return withLock_(function () {
    const rows = readTable_(SH.PERMISSIONS).filter(function (p) {
      return str_(p.budget_id) === budgetId && normEmail_(p.email) === email && str_(p.status) === STATUS.ACTIVE;
    });
    if (rows.length) {
      const p = rows[0];
      const before = { email: email, role: p.role };
      updateRow_(SH.PERMISSIONS, p._row, { role: role, note: str_(payload.note), granted_by: user.email, granted_at: nowIso_() });
      writeAudit_({
        actor: user.email, action: ACTION.PERM_UPDATE, entityType: ENTITY.PERMISSION, entityId: str_(p.permission_id),
        budgetId: budgetId, summary: 'เปลี่ยนสิทธิ์ ' + email + ' เป็น ' + LABELS.role[role] + ' ในงบ ' + str_(budget.code),
        reason: str_(payload.note), before: before, after: { email: email, role: role }
      });
      return { permissionId: str_(p.permission_id), mode: 'update' };
    }
    const id = newId_('PRM');
    insertRow_(SH.PERMISSIONS, {
      permission_id: id, budget_id: budgetId, email: email, role: role,
      status: STATUS.ACTIVE, note: str_(payload.note),
      granted_by: user.email, granted_at: nowIso_(), revoked_by: '', revoked_at: ''
    });
    if (!findRow_(SH.USERS, 'email', email)) {
      insertRow_(SH.USERS, {
        user_id: newId_('USR'), email: email, display_name: email.split('@')[0],
        system_role: ROLE.USER, status: STATUS.ACTIVE, note: 'สร้างจากการให้สิทธิ์งบ ' + str_(budget.code),
        created_at: nowIso_(), created_by: user.email, updated_at: nowIso_(), updated_by: user.email
      });
    }
    writeAudit_({
      actor: user.email, action: ACTION.PERM_GRANT, entityType: ENTITY.PERMISSION, entityId: id,
      budgetId: budgetId, summary: 'ให้สิทธิ์ ' + LABELS.role[role] + ' แก่ ' + email + ' ในงบ ' + str_(budget.code),
      reason: str_(payload.note), after: { email: email, role: role }
    });
    return { permissionId: id, mode: 'create' };
  });
}

function revokePermission_(user, payload) {
  const p = findRow_(SH.PERMISSIONS, 'permission_id', str_(payload.permissionId));
  if (!p) throw new Error('ไม่พบรายการสิทธิ์');
  const budgetId = str_(p.budget_id);
  requireManageBudget_(user, budgetId);
  if (normEmail_(p.email) === user.email && !user.isSuperAdmin) {
    throw new Error('ไม่สามารถเพิกถอนสิทธิ์ของตัวเองได้');
  }
  return withLock_(function () {
    updateRow_(SH.PERMISSIONS, p._row, {
      status: STATUS.REVOKED, revoked_by: user.email, revoked_at: nowIso_(),
      note: str_(payload.reason) || str_(p.note)
    });
    writeAudit_({
      actor: user.email, action: ACTION.PERM_REVOKE, entityType: ENTITY.PERMISSION,
      entityId: str_(p.permission_id), budgetId: budgetId,
      summary: 'เพิกถอนสิทธิ์ของ ' + str_(p.email), reason: str_(payload.reason),
      before: { email: p.email, role: p.role, status: STATUS.ACTIVE },
      after: { email: p.email, role: p.role, status: STATUS.REVOKED }
    });
    return { permissionId: str_(p.permission_id) };
  });
}

function listPermissions_(user, budgetId) {
  requireView_(user, budgetId);
  return readTable_(SH.PERMISSIONS)
    .filter(function (p) { return str_(p.budget_id) === str_(budgetId); })
    .map(function (p) {
      const role = normalizeBudgetRole_(p.role);
      return {
        permissionId: str_(p.permission_id), budgetId: str_(p.budget_id), email: str_(p.email),
        role: role, status: str_(p.status), note: str_(p.note),
        grantedBy: str_(p.granted_by), grantedAt: serialize_(p.granted_at),
        revokedBy: str_(p.revoked_by), revokedAt: serialize_(p.revoked_at)
      };
    })
    .sort(function (a, b) {
      if (a.status !== b.status) return a.status === STATUS.ACTIVE ? -1 : 1;
      const ra = ROLE_RANK[a.role] || 0, rb = ROLE_RANK[b.role] || 0;
      if (ra !== rb) return rb - ra;
      return a.email.localeCompare(b.email);
    });
}

/** รายชื่อผู้ใช้ที่ active สำหรับเลือกในฟอร์ม (ไม่ต้องเป็น super admin) */
function listActiveUserEmails_(user) {
  if (!user.isSuperAdmin && !user.isExecutive) {
    // ผู้รับผิดชอบต้องเลือกอีเมลจาก Users ได้เมื่อแก้สิทธิ์งบ
    const map = getRoleMap_(user.email);
    const isOwnerSomewhere = Object.keys(map).some(function (k) {
      return ROLE_RANK[map[k]] >= ROLE_RANK[ROLE.OWNER];
    });
    if (!isOwnerSomewhere) throw new Error('ไม่มีสิทธิ์ดูรายชื่อผู้ใช้');
  }
  return readTable_(SH.USERS)
    .filter(function (u) { return str_(u.status) === STATUS.ACTIVE; })
    .map(function (u) {
      return {
        email: normEmail_(u.email),
        displayName: str_(u.display_name),
        systemRole: str_(u.system_role)
      };
    })
    .sort(function (a, b) { return a.email.localeCompare(b.email); });
}

function listUsers_(user) {
  requireSuperAdmin_(user);
  const roleCount = {};
  readTable_(SH.PERMISSIONS).forEach(function (p) {
    if (str_(p.status) !== STATUS.ACTIVE) return;
    const e = normEmail_(p.email);
    const role = normalizeBudgetRole_(p.role);
    roleCount[e] = roleCount[e] || { owner: 0, txnManager: 0, viewer: 0 };
    if (role === ROLE.OWNER) roleCount[e].owner++;
    else if (role === ROLE.TXN_MANAGER) roleCount[e].txnManager++;
    else roleCount[e].viewer++;
  });
  return readTable_(SH.USERS).map(function (u) {
    const e = normEmail_(u.email);
    const c = roleCount[e] || {};
    return {
      userId: str_(u.user_id), email: e, displayName: str_(u.display_name),
      systemRole: str_(u.system_role), status: str_(u.status), note: str_(u.note),
      ownerOf: c.owner || 0,
      txnManagerOf: c.txnManager || 0,
      viewerOf: c.viewer || 0,
      adminOf: c.owner || 0, // legacy field สำหรับ UI เก่า
      viewerOfLegacy: c.viewer || 0,
      createdAt: serialize_(u.created_at)
    };
  }).sort(function (a, b) { return a.email.localeCompare(b.email); });
}

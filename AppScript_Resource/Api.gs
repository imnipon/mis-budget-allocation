/**
 * Api.gs
 * ฟังก์ชันเดียวที่ฝั่ง client เรียกใช้ (rpc) — จัดการ error/permission ที่จุดเดียว
 *
 * ฝั่ง client:  google.script.run.withSuccessHandler(cb).rpc('budget.detail', { budgetId })
 * ผลลัพธ์:      { ok: true, data: ... }  หรือ  { ok: false, error: 'ข้อความ' }
 */

function rpc(action, payload) {
  payload = payload || {};
  const started = new Date().getTime();
  try {
    const user = getCurrentUser_();
    const data = dispatch_(action, user, payload);
    return serialize_({ ok: true, action: action, data: data, ms: new Date().getTime() - started });
  } catch (err) {
    const message = (err && err.message) ? err.message : String(err);
    console.error('rpc %s failed: %s', action, message);
    return { ok: false, action: action, error: message };
  }
}

function dispatch_(action, user, p) {
  switch (action) {
    case 'app.bootstrap':      return bootstrap_(user);
    case 'budget.list':        return listBudgetsWithSummary_(user);
    case 'budget.detail':      return getBudgetDetail_(user, p.budgetId);
    case 'budget.changes':     return listChanges_(user, p.budgetId);
    case 'txn.list':           return listTransactions_(user, p);
    case 'txn.openReserves':   return openReservations_(user, p.budgetId);
    case 'txn.history':        return txnHistory_(user, p.txnId);
    case 'audit.list':         return listAudit_(user, p);
    case 'perm.list':          return listPermissions_(user, p.budgetId);
    case 'file.get':           return getAttachmentData_(user, p.attachmentId);
    case 'report.overview':    return overviewReport_(user, p);
    case 'type.list':          return listBudgetTypes_(user, p);
    case 'type.adminList':     return listBudgetTypesAdmin_(user);
    case 'user.emails':        return listActiveUserEmails_(user);

    case 'budget.create':      return createBudget_(user, p);
    case 'budget.update':      return updateBudgetInfo_(user, p);
    case 'budget.setAmount':   return setAmount_(user, p);
    case 'budget.setAmounts':  return setAmounts_(user, p);
    case 'txn.create':         return createTransaction_(user, p);
    case 'txn.update':         return updateTransaction_(user, p);
    case 'txn.cancel':         return cancelTransaction_(user, p);
    case 'txn.move':           return moveTransactionSet_(user, p);
    case 'perm.grant':         return grantPermission_(user, p);
    case 'perm.revoke':        return revokePermission_(user, p);
    case 'type.upsert':        return upsertBudgetType_(user, p);

    case 'user.list':          return listUsers_(user);
    case 'user.upsert':        return upsertUser_(user, p);
    case 'config.get':         return getConfigMap_();

    default:
      throw new Error('ไม่รู้จักคำสั่ง: ' + action);
  }
}

function bootstrap_(user) {
  const cfg = getConfigMap_();
  const budgets = (user.systemRole === ROLE.NONE) ? [] : listBudgetsWithSummary_(user);
  let recent = [];
  try {
    recent = listAudit_(user, { limit: 12 }).rows;
  } catch (e) {
    recent = [];
  }
  const roleLabel = user.isSuperAdmin ? LABELS.role[ROLE.SUPER_ADMIN]
    : user.isExecutive ? LABELS.role[ROLE.EXECUTIVE]
    : (budgets.length ? LABELS.role[ROLE.USER] : LABELS.role[ROLE.NONE]);

  return {
    user: {
      email: user.email,
      displayName: user.displayName,
      systemRole: user.systemRole,
      isSuperAdmin: user.isSuperAdmin,
      isExecutive: !!user.isExecutive,
      canViewOverview: canViewOverview_(user),
      canViewAudit: user.isSuperAdmin || user.isExecutive || budgets.some(function (b) { return b.canViewAudit; }),
      status: user.status,
      roleLabel: roleLabel
    },
    app: {
      name: cfg.app_name || CFG.APP_NAME,
      org: cfg.org_name || '',
      version: CFG.VERSION,
      currency: cfg.currency || 'THB',
      warnPct: Number(cfg.warn_threshold_pct || 80),
      dangerPct: Number(cfg.danger_threshold_pct || 95)
    },
    labels: LABELS,
    enums: { ROLE: ROLE, STATUS: STATUS, TXN_TYPE: TXN_TYPE, CHANGE_TYPE: CHANGE_TYPE, ENTITY: ENTITY, ACTION: ACTION },
    budgets: budgets,
    categories: distinctCategories_(),
    budgetTypes: listBudgetTypes_(user),
    recent: recent
  };
}

function distinctCategories_() {
  const set = {};
  readTable_(SH.TXNS).forEach(function (t) {
    const c = str_(t.category);
    if (c) set[c] = true;
  });
  return Object.keys(set).sort();
}

function overviewReport_(user, filter) {
  requireOverview_(user);
  filter = filter || {};
  let budgets = listBudgetsWithSummary_(user);

  // ตัวกรองสถานะ (multi) — ค่าว่าง = ทุกสถานะ
  const statuses = [];
  (filter.statuses || filter.status || []).forEach(function (s) {
    const v = str_(s).toUpperCase();
    if (v === STATUS.ACTIVE) statuses.push(STATUS.PROCESS);
    else if (v === STATUS.NEW || v === STATUS.PROCESS || v === STATUS.CLOSED) statuses.push(v);
  });
  // ตัวกรองประเภท/หมวด A–Z (multi)
  // - ไม่ส่ง codes มาเลย → ไม่กรอง (ทุกประเภท)
  // - ส่ง [] → ไม่มีประเภทถูกเลือก → ว่าง
  // - ส่งค่า → กรองตามนั้น
  const codesRaw = filter.codes;
  const codesFilterActive = Array.isArray(codesRaw);
  const codes = [];
  if (codesFilterActive) {
    codesRaw.forEach(function (c) {
      const v = str_(c).toUpperCase();
      if (/^[A-Z]$/.test(v)) codes.push(v);
    });
  }

  if (statuses.length) {
    budgets = budgets.filter(function (b) {
      return statuses.indexOf(normalizeBudgetStatus_(b.status)) >= 0;
    });
  } else if (Array.isArray(filter.statuses) || Array.isArray(filter.status)) {
    budgets = []; // เลือกสถานะว่าง = ไม่แสดง
  }
  if (codesFilterActive) {
    if (!codes.length) budgets = [];
    else {
      budgets = budgets.filter(function (b) {
        return codes.indexOf(str_(b.code).toUpperCase()) >= 0;
      });
    }
  }

  const total = {
    budgetAmount: 0, usableAmount: 0, reservedOutstanding: 0,
    disbursed: 0, committed: 0, availableToSpend: 0, unreleased: 0
  };
  budgets.forEach(function (b) {
    Object.keys(total).forEach(function (k) { total[k] = round2_(total[k] + num_(b.summary[k])); });
  });
  total.usagePctOfUsable = total.usableAmount > 0 ? round2_(total.committed / total.usableAmount * 100) : 0;

  const txns = readTable_(SH.TXNS);
  const allowed = {};
  budgets.forEach(function (b) { allowed[b.budgetId] = true; });
  const mine = txns.filter(function (t) { return allowed[str_(t.budget_id)]; });

  // ตัวเลือกตัวกรองจากประเภทที่ลงทะเบียน + รหัสที่มีในงบ
  const typeMap = getTypeMap_();
  const allAccessible = listBudgetsWithSummary_(user);
  const codeSet = {};
  Object.keys(typeMap).forEach(function (c) { codeSet[c] = true; });
  allAccessible.forEach(function (b) {
    const c = str_(b.code).toUpperCase();
    if (c) codeSet[c] = true;
  });

  return {
    total: total,
    budgets: budgets,
    monthly: monthlySeries_(mine),
    byCategory: categorySeries_(mine).slice(0, 8),
    filterOptions: {
      statuses: [
        { value: STATUS.NEW, label: 'New' },
        { value: STATUS.PROCESS, label: 'Process' },
        { value: STATUS.CLOSED, label: 'Close' }
      ],
      codes: Object.keys(codeSet).sort().map(function (c) {
        const t = typeMap[c];
        return { value: c, label: t ? (c + ' – ' + t.name) : c };
      })
    },
    applied: { statuses: statuses, codes: codes }
  };
}

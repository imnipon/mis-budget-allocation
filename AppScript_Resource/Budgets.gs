/**
 * Budgets.gs
 * งบประมาณ: สร้าง/แก้ไข, กำหนดสิทธิ์รายงบ, ปรับวงเงิน (หน้าเดียว), คำนวณยอด
 *
 * code (A–Z) = หมวด/ประเภท ซ้ำได้หลายโครงการ
 * สถานะ: NEW → PROCESS (อัตโนมัติเมื่อมีรายการแรก) → CLOSED
 */

function toBudgetDto_(b, role) {
  const r = role || ROLE.NONE;
  const status = normalizeBudgetStatus_(b.status);
  return {
    budgetId: str_(b.budget_id),
    code: str_(b.code),
    name: str_(b.name),
    fiscalYear: str_(b.fiscal_year),
    ownerEmail: str_(b.owner_email),
    description: str_(b.description),
    currency: str_(b.currency) || 'THB',
    budgetAmount: num_(b.budget_amount),
    usableAmount: num_(b.usable_amount),
    status: status,
    statusLabel: LABELS.budgetStatus[status] || status,
    createdAt: serialize_(b.created_at),
    createdBy: str_(b.created_by),
    updatedAt: serialize_(b.updated_at),
    updatedBy: str_(b.updated_by),
    role: r === ROLE.SUPER_ADMIN ? ROLE.OWNER : normalizeBudgetRole_(r),
    canManage: r === ROLE.SUPER_ADMIN || ROLE_RANK[normalizeBudgetRole_(r)] >= ROLE_RANK[ROLE.OWNER],
    canManageTxn: r === ROLE.SUPER_ADMIN || ROLE_RANK[normalizeBudgetRole_(r)] >= ROLE_RANK[ROLE.TXN_MANAGER],
    canViewAudit: r === ROLE.SUPER_ADMIN || ROLE_RANK[normalizeBudgetRole_(r)] >= ROLE_RANK[ROLE.TXN_MANAGER]
  };
}

/** แนบ flags สิทธิ์จาก user จริง (แม่นยำกว่าคำนวณจาก role อย่างเดียว) */
function attachCaps_(dto, user, budgetId) {
  dto.canManage = canManageBudget_(user, budgetId);
  dto.canManageTxn = canManageTxn_(user, budgetId);
  dto.canViewAudit = canViewAudit_(user, budgetId);
  return dto;
}

function computeSummary_(budget, txns) {
  const bid = str_(budget.budget_id);
  const rows = (txns || readTable_(SH.TXNS)).filter(function (t) { return str_(t.budget_id) === bid; });

  let reservedTotal = 0, reservedOutstanding = 0, disbursed = 0;
  let countReserve = 0, countDisburse = 0, countCancelled = 0;

  rows.forEach(function (t) {
    const status = str_(t.status);
    const amount = num_(t.amount);
    if (status === STATUS.CANCELLED) { countCancelled++; return; }
    if (str_(t.txn_type) === TXN_TYPE.RESERVE) {
      countReserve++;
      reservedTotal += amount;
      reservedOutstanding += Math.max(amount - num_(t.settled_amount), 0);
    } else if (str_(t.txn_type) === TXN_TYPE.DISBURSE) {
      countDisburse++;
      disbursed += amount;
    }
  });

  const budgetAmount = num_(budget.budget_amount);
  const usableAmount = num_(budget.usable_amount);
  const committed = round2_(reservedOutstanding + disbursed);

  return {
    budgetAmount: budgetAmount,
    usableAmount: usableAmount,
    unreleased: round2_(budgetAmount - usableAmount),
    reservedTotal: round2_(reservedTotal),
    reservedOutstanding: round2_(reservedOutstanding),
    disbursed: round2_(disbursed),
    committed: committed,
    availableToSpend: round2_(usableAmount - committed),
    remainingOfBudget: round2_(budgetAmount - committed),
    usagePctOfUsable: usableAmount > 0 ? round2_(committed / usableAmount * 100) : 0,
    usagePctOfBudget: budgetAmount > 0 ? round2_(committed / budgetAmount * 100) : 0,
    disbursePctOfUsable: usableAmount > 0 ? round2_(disbursed / usableAmount * 100) : 0,
    txnCount: countReserve + countDisburse,
    reserveCount: countReserve,
    disburseCount: countDisburse,
    cancelledCount: countCancelled
  };
}

function round2_(n) {
  return Math.round(num_(n) * 100) / 100;
}

function validateBudgetCode_(code) {
  const c = str_(code).toUpperCase();
  if (!/^[A-Z]$/.test(c)) throw new Error('รหัสหมวดงบประมาณต้องเป็นตัวอักษร A–Z ตัวเดียว');
  const t = findTypeByCode_(c);
  if (!t || str_(t.status) !== STATUS.ACTIVE) {
    throw new Error('ยังไม่มีประเภท "' + c + '" ในระบบ หรือถูกระงับแล้ว — ไปที่ หลังบ้าน › จัดการประเภท เพื่อเพิ่มก่อน');
  }
  return c;
}

function normalizeEmailList_(arr) {
  if (!arr) return [];
  if (typeof arr === 'string') {
    arr = arr.split(/[,;\s]+/);
  }
  const out = [];
  const seen = {};
  (arr || []).forEach(function (raw) {
    const e = normEmail_(raw);
    if (!e || e.indexOf('@') < 0 || seen[e]) return;
    seen[e] = true;
    out.push(e);
  });
  return out;
}

function listBudgetsWithSummary_(user) {
  const budgets = accessibleBudgets_(user);
  const allTxns = readTable_(SH.TXNS);
  return budgets.map(function (b) {
    const dto = attachCaps_(toBudgetDto_(b, b._role), user, str_(b.budget_id));
    dto.summary = computeSummary_(b, allTxns);
    return dto;
  }).sort(function (a, b) {
    const c = a.code.localeCompare(b.code);
    return c !== 0 ? c : a.name.localeCompare(b.name);
  });
}

function getBudgetOr404_(budgetId) {
  const b = findRow_(SH.BUDGETS, 'budget_id', str_(budgetId));
  if (!b) throw new Error('ไม่พบงบประมาณที่ระบุ');
  return b;
}

function getBudgetDetail_(user, budgetId) {
  requireView_(user, budgetId);
  const b = getBudgetOr404_(budgetId);
  const role = roleForBudget_(user, budgetId);
  const dto = attachCaps_(toBudgetDto_(b, role), user, budgetId);
  const txns = readTable_(SH.TXNS);

  dto.summary = computeSummary_(b, txns);
  dto.transactions = listTransactions_(user, { budgetId: budgetId }).rows;
  dto.permissions = listPermissions_(user, budgetId);
  dto.owners = dto.permissions.filter(function (p) { return p.status === STATUS.ACTIVE && p.role === ROLE.OWNER; }).map(function (p) { return p.email; });
  dto.txnManagers = dto.permissions.filter(function (p) { return p.status === STATUS.ACTIVE && p.role === ROLE.TXN_MANAGER; }).map(function (p) { return p.email; });
  dto.viewers = dto.permissions.filter(function (p) { return p.status === STATUS.ACTIVE && p.role === ROLE.VIEWER; }).map(function (p) { return p.email; });
  dto.changes = dto.canViewAudit ? listChanges_(user, budgetId) : [];
  dto.monthly = monthlySeries_(txns.filter(function (t) { return str_(t.budget_id) === str_(budgetId); }));
  dto.byCategory = categorySeries_(txns.filter(function (t) { return str_(t.budget_id) === str_(budgetId); }));
  return dto;
}

function listChanges_(user, budgetId) {
  requireAuditView_(user, budgetId);
  return readTable_(SH.CHANGES)
    .filter(function (c) { return str_(c.budget_id) === str_(budgetId); })
    .sort(function (a, b) {
      const ta = String(serialize_(a.created_at)), tb = String(serialize_(b.created_at));
      return ta === tb ? b._row - a._row : tb.localeCompare(ta);
    })
    .map(function (c) {
      return {
        changeId: str_(c.change_id),
        budgetId: str_(c.budget_id),
        changeType: str_(c.change_type),
        changeTypeLabel: LABELS.changeType[str_(c.change_type)] || str_(c.change_type),
        oldAmount: num_(c.old_amount),
        newAmount: num_(c.new_amount),
        delta: num_(c.delta),
        effectiveDate: dateOnly_(c.effective_date),
        reason: str_(c.reason),
        refNo: str_(c.ref_no),
        createdAt: serialize_(c.created_at),
        createdBy: str_(c.created_by),
        attachments: attachmentsByIds_(idListToArray_(c.attachment_ids))
      };
    });
}

/** เปลี่ยน NEW → PROCESS เมื่อมีรายการใช้งบครั้งแรก */
function promoteBudgetToProcess_(budget) {
  if (normalizeBudgetStatus_(budget.status) !== STATUS.NEW) return;
  updateRow_(SH.BUDGETS, budget._row, {
    status: STATUS.PROCESS, updated_at: nowIso_()
  });
  budget.status = STATUS.PROCESS;
}

function createBudget_(user, payload) {
  requireSuperAdmin_(user);
  const code = validateBudgetCode_(payload.code);
  const name = str_(payload.name);
  if (!name) throw new Error('กรุณาระบุชื่องบประมาณ / ชื่อโครงการ');

  const owners = normalizeEmailList_(payload.owners);
  if (payload.ownerEmail) {
    const primary = normEmail_(payload.ownerEmail);
    if (primary && owners.indexOf(primary) < 0) owners.unshift(primary);
  }
  if (!owners.length) owners.push(user.email);
  const txnManagers = normalizeEmailList_(payload.txnManagers);
  const viewers = normalizeEmailList_(payload.viewers);

  return withLock_(function () {
    const id = newId_('BUD');
    const budgetAmount = num_(payload.budgetAmount);
    const usableAmount = payload.usableAmount === '' || payload.usableAmount === undefined
      ? 0 : num_(payload.usableAmount);
    if (usableAmount > budgetAmount) throw new Error('จำนวนที่ใช้ได้ต้องไม่เกินวงเงินงบประมาณ');

    const row = {
      budget_id: id, code: code, name: name,
      fiscal_year: str_(payload.fiscalYear),
      owner_email: owners[0],
      description: str_(payload.description),
      currency: str_(payload.currency) || 'THB',
      budget_amount: budgetAmount,
      usable_amount: usableAmount,
      status: STATUS.NEW,
      created_at: nowIso_(), created_by: user.email, updated_at: nowIso_(), updated_by: user.email
    };
    insertRow_(SH.BUDGETS, row);

    const fileIds = saveAttachments_(user, row, ENTITY.BUDGET, id, payload.files);
    syncBudgetPermissions_(user.email, id, owners, txnManagers, viewers);

    if (budgetAmount > 0) {
      logChange_(user, row, CHANGE_TYPE.BUDGET_AMOUNT, 0, budgetAmount,
        str_(payload.reason) || 'ตั้งวงเงินงบประมาณครั้งแรก', str_(payload.refNo), payload.effectiveDate, fileIds);
    }
    if (usableAmount > 0) {
      logChange_(user, row, CHANGE_TYPE.USABLE_AMOUNT, 0, usableAmount,
        str_(payload.reason) || 'กำหนดจำนวนที่ใช้ได้ครั้งแรก', str_(payload.refNo), payload.effectiveDate, fileIds);
    }

    writeAudit_({
      actor: user.email, action: ACTION.BUDGET_CREATE, entityType: ENTITY.BUDGET, entityId: id,
      budgetId: id, summary: 'สร้างงบประมาณ ' + code + ' – ' + name,
      reason: str_(payload.reason), after: row, attachmentIds: fileIds
    });
    return { budgetId: id };
  });
}

function updateBudgetInfo_(user, payload) {
  const budgetId = str_(payload.budgetId);
  requireManageBudget_(user, budgetId);
  const b = getBudgetOr404_(budgetId);

  return withLock_(function () {
    const before = {
      code: str_(b.code), name: str_(b.name), fiscal_year: str_(b.fiscal_year),
      owner_email: str_(b.owner_email), description: str_(b.description), status: str_(b.status)
    };
    const patch = {
      name: str_(payload.name) || str_(b.name),
      fiscal_year: payload.fiscalYear === undefined ? str_(b.fiscal_year) : str_(payload.fiscalYear),
      description: payload.description === undefined ? str_(b.description) : str_(payload.description),
      updated_at: nowIso_(), updated_by: user.email
    };

    if (payload.code) {
      patch.code = validateBudgetCode_(payload.code);
    }

    if (payload.status) {
      const st = str_(payload.status);
      if (st === STATUS.NEW || st === STATUS.PROCESS || st === STATUS.CLOSED || st === STATUS.ACTIVE) {
        patch.status = st === STATUS.ACTIVE ? STATUS.PROCESS : st;
      }
    }

    // อัปเดตสิทธิ์ถ้าส่งมา
    if (payload.owners || payload.txnManagers || payload.viewers) {
      const owners = normalizeEmailList_(payload.owners);
      const txnManagers = normalizeEmailList_(payload.txnManagers);
      const viewers = normalizeEmailList_(payload.viewers);
      if (!owners.length) throw new Error('ต้องมีผู้รับผิดชอบอย่างน้อย 1 คน');
      patch.owner_email = owners[0];
      syncBudgetPermissions_(user.email, budgetId, owners, txnManagers, viewers);
    } else if (payload.ownerEmail !== undefined) {
      patch.owner_email = normEmail_(payload.ownerEmail) || str_(b.owner_email);
    }

    updateRow_(SH.BUDGETS, b._row, patch);
    const fileIds = saveAttachments_(user, b, ENTITY.BUDGET, budgetId, payload.files);
    writeAudit_({
      actor: user.email,
      action: patch.status && patch.status !== before.status ? ACTION.BUDGET_CLOSE : ACTION.BUDGET_UPDATE,
      entityType: ENTITY.BUDGET, entityId: budgetId, budgetId: budgetId,
      summary: 'แก้ไขข้อมูลงบ ' + str_(patch.code || b.code),
      reason: str_(payload.reason), before: before, after: patch, attachmentIds: fileIds
    });
    return { budgetId: budgetId };
  });
}

/**
 * ปรับวงเงินและ/หรือจำนวนที่ใช้ได้ในครั้งเดียว
 * payload: { budgetId, budgetAmount?, usableAmount?, reason, refNo, effectiveDate, files[] }
 * อย่างน้อยหนึ่งค่าต้องเปลี่ยน
 */
function setAmounts_(user, payload) {
  const budgetId = str_(payload.budgetId);
  requireManageBudget_(user, budgetId);
  const reason = str_(payload.reason);
  if (reason.length < 5) throw new Error('กรุณาระบุรายละเอียด/เหตุผลการเปลี่ยนแปลง (อย่างน้อย 5 ตัวอักษร)');

  return withLock_(function () {
    const b = getBudgetOr404_(budgetId);
    if (normalizeBudgetStatus_(b.status) === STATUS.CLOSED) {
      throw new Error('งบประมาณนี้ปิดแล้ว ไม่สามารถแก้ไขได้');
    }

    const summary = computeSummary_(b);
    const oldBudget = num_(b.budget_amount);
    const oldUsable = num_(b.usable_amount);

    const hasBudget = payload.budgetAmount !== undefined && payload.budgetAmount !== '';
    const hasUsable = payload.usableAmount !== undefined && payload.usableAmount !== '';
    if (!hasBudget && !hasUsable) throw new Error('กรุณาระบุจำนวนเงินที่ต้องการปรับ');

    const newBudget = hasBudget ? num_(payload.budgetAmount) : oldBudget;
    const newUsable = hasUsable ? num_(payload.usableAmount) : oldUsable;
    if (newBudget < 0 || newUsable < 0) throw new Error('จำนวนเงินต้องไม่ติดลบ');
    if (newUsable > newBudget) {
      throw new Error('จำนวนที่ใช้ได้ (' + fmtMoneySrv_(newUsable) + ') ต้องไม่เกินวงเงินงบประมาณ (' +
        fmtMoneySrv_(newBudget) + ')');
    }
    if (newUsable < summary.committed) {
      throw new Error('จำนวนที่ใช้ได้ใหม่ (' + fmtMoneySrv_(newUsable) + ') ต่ำกว่ายอดที่ผูกพันแล้ว (' +
        fmtMoneySrv_(summary.committed) + ')');
    }
    if (newBudget === oldBudget && newUsable === oldUsable) {
      throw new Error('จำนวนเงินไม่เปลี่ยนแปลง');
    }

    const patch = { updated_at: nowIso_(), updated_by: user.email };
    if (newBudget !== oldBudget) patch.budget_amount = newBudget;
    if (newUsable !== oldUsable) patch.usable_amount = newUsable;
    updateRow_(SH.BUDGETS, b._row, patch);

    const fileIds = saveAttachments_(user, b, ENTITY.CHANGE, budgetId, payload.files);
    const changeIds = [];
    if (newBudget !== oldBudget) {
      changeIds.push(logChange_(user, b, CHANGE_TYPE.BUDGET_AMOUNT, oldBudget, newBudget, reason,
        str_(payload.refNo), payload.effectiveDate, fileIds));
    }
    if (newUsable !== oldUsable) {
      changeIds.push(logChange_(user, b, CHANGE_TYPE.USABLE_AMOUNT, oldUsable, newUsable, reason,
        str_(payload.refNo), payload.effectiveDate, fileIds));
    }

    writeAudit_({
      actor: user.email, action: ACTION.AMOUNT_SET, entityType: ENTITY.CHANGE,
      entityId: changeIds.join(','), budgetId: budgetId,
      summary: 'ปรับวงเงินงบ ' + str_(b.code) +
        (newBudget !== oldBudget ? ' วงเงิน ' + fmtMoneySrv_(oldBudget) + '→' + fmtMoneySrv_(newBudget) : '') +
        (newUsable !== oldUsable ? ' ใช้ได้ ' + fmtMoneySrv_(oldUsable) + '→' + fmtMoneySrv_(newUsable) : ''),
      reason: reason,
      before: { budgetAmount: oldBudget, usableAmount: oldUsable },
      after: { budgetAmount: newBudget, usableAmount: newUsable, refNo: str_(payload.refNo) },
      attachmentIds: fileIds
    });
    return { changeIds: changeIds, budgetId: budgetId, budgetAmount: newBudget, usableAmount: newUsable };
  });
}

/** รองรับ API เก่า setAmount แบบทีละประเภท */
function setAmount_(user, payload) {
  const changeType = str_(payload.changeType);
  const p = {
    budgetId: payload.budgetId,
    reason: payload.reason,
    refNo: payload.refNo,
    effectiveDate: payload.effectiveDate,
    files: payload.files
  };
  if (changeType === CHANGE_TYPE.BUDGET_AMOUNT) p.budgetAmount = payload.newAmount;
  else if (changeType === CHANGE_TYPE.USABLE_AMOUNT) p.usableAmount = payload.newAmount;
  else throw new Error('ประเภทการเปลี่ยนแปลงไม่ถูกต้อง');
  return setAmounts_(user, p);
}

function logChange_(user, budget, changeType, oldAmount, newAmount, reason, refNo, effectiveDate, fileIds) {
  const id = newId_('CHG');
  insertRow_(SH.CHANGES, {
    change_id: id,
    budget_id: str_(budget.budget_id),
    change_type: changeType,
    old_amount: num_(oldAmount),
    new_amount: num_(newAmount),
    delta: round2_(num_(newAmount) - num_(oldAmount)),
    effective_date: dateOnly_(effectiveDate) || todayIso_(),
    reason: str_(reason),
    ref_no: str_(refNo),
    attachment_ids: (fileIds || []).join(','),
    created_at: nowIso_(),
    created_by: user.email
  });
  return id;
}

function fmtMoneySrv_(n) {
  const v = num_(n);
  const parts = Math.abs(v).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-' : '') + parts.join('.') + ' บาท';
}

function monthlySeries_(txns) {
  const map = {};
  txns.forEach(function (t) {
    if (str_(t.status) === STATUS.CANCELLED) return;
    const d = dateOnly_(t.txn_date) || dateOnly_(t.created_at);
    const month = d ? d.substring(0, 7) : 'ไม่ระบุ';
    map[month] = map[month] || { month: month, reserve: 0, disburse: 0 };
    if (str_(t.txn_type) === TXN_TYPE.RESERVE) map[month].reserve += num_(t.amount);
    else map[month].disburse += num_(t.amount);
  });
  return Object.keys(map).sort().map(function (k) {
    map[k].reserve = round2_(map[k].reserve);
    map[k].disburse = round2_(map[k].disburse);
    return map[k];
  });
}

function categorySeries_(txns) {
  const map = {};
  txns.forEach(function (t) {
    if (str_(t.status) === STATUS.CANCELLED) return;
    const c = str_(t.category) || 'ไม่ระบุหมวด';
    map[c] = map[c] || { category: c, amount: 0, count: 0 };
    map[c].amount += num_(t.amount);
    map[c].count++;
  });
  return Object.keys(map).map(function (k) {
    map[k].amount = round2_(map[k].amount);
    return map[k];
  }).sort(function (a, b) { return b.amount - a.amount; });
}

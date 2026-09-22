/**
 * Transactions.gs
 * รายการใช้งบประมาณ 2 ประเภท
 *   RESERVE  = การจอง (กันวงเงินไว้)
 *   DISBURSE = เบิกใช้แล้ว (อ้างอิงรายการจองได้ เพื่อไม่ให้นับซ้ำ)
 *
 * ทุกการเพิ่ม/แก้ไข/ยกเลิก บันทึก AuditLog พร้อมเหตุผลและไฟล์แนบได้
 */

function toTxnDto_(t, reserveMap, canManage) {
  const amount = num_(t.amount);
  const settled = num_(t.settled_amount);
  const type = str_(t.txn_type);
  const reserveId = str_(t.reserve_txn_id);
  return {
    txnId: str_(t.txn_id),
    budgetId: str_(t.budget_id),
    txnType: type,
    txnTypeLabel: LABELS.txnType[type] || type,
    txnNo: str_(t.txn_no),
    txnDate: dateOnly_(t.txn_date),
    title: str_(t.title),
    description: str_(t.description),
    category: str_(t.category),
    vendor: str_(t.vendor),
    amount: amount,
    settledAmount: settled,
    outstanding: type === TXN_TYPE.RESERVE ? round2_(Math.max(amount - settled, 0)) : 0,
    status: str_(t.status),
    statusLabel: LABELS.txnStatus[str_(t.status)] || str_(t.status),
    reserveTxnId: reserveId,
    reserveTxnNo: reserveId && reserveMap && reserveMap[reserveId] ? str_(reserveMap[reserveId].txn_no) : '',
    attachments: attachmentsByIds_(idListToArray_(t.attachment_ids)),
    createdAt: serialize_(t.created_at),
    createdBy: str_(t.created_by),
    updatedAt: serialize_(t.updated_at),
    updatedBy: str_(t.updated_by),
    canManage: !!canManage
  };
}

/**
 * filter: { budgetId, txnType, status, category, keyword, from, to, limit }
 * ถ้าไม่ระบุ budgetId → ดึงทุกงบที่ผู้ใช้มีสิทธิ์
 */
function listTransactions_(user, filter) {
  filter = filter || {};
  const budgets = accessibleBudgets_(user);
  const allowed = {};
  budgets.forEach(function (b) { allowed[str_(b.budget_id)] = b; });

  if (filter.budgetId && !allowed[str_(filter.budgetId)]) throw new Error('คุณไม่มีสิทธิ์ดูงบประมาณนี้');

  const all = readTable_(SH.TXNS);
  const reserveMap = {};
  all.forEach(function (t) { if (str_(t.txn_type) === TXN_TYPE.RESERVE) reserveMap[str_(t.txn_id)] = t; });

  const kw = str_(filter.keyword).toLowerCase();
  const from = str_(filter.from), to = str_(filter.to);

  const rows = all.filter(function (t) {
    const bid = str_(t.budget_id);
    if (!allowed[bid]) return false;
    if (filter.budgetId && bid !== str_(filter.budgetId)) return false;
    if (filter.txnType && str_(t.txn_type) !== str_(filter.txnType)) return false;
    if (filter.status && str_(t.status) !== str_(filter.status)) return false;
    if (filter.category && str_(t.category) !== str_(filter.category)) return false;
    const d = dateOnly_(t.txn_date);
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    if (kw) {
      const hay = [t.txn_no, t.title, t.description, t.vendor, t.category, t.created_by]
        .map(str_).join(' ').toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });

  rows.sort(function (a, b) {
    const da = dateOnly_(a.txn_date), db = dateOnly_(b.txn_date);
    if (da !== db) return db.localeCompare(da);
    const ca = String(serialize_(a.created_at)), cb = String(serialize_(b.created_at));
    return ca === cb ? b._row - a._row : cb.localeCompare(ca);
  });

  const limit = Math.min(Number(filter.limit) || 500, 2000);
  const budgetInfo = {};
  budgets.forEach(function (b) {
    budgetInfo[str_(b.budget_id)] = { code: str_(b.code), name: str_(b.name), role: b._role };
  });

  return {
    total: rows.length,
    rows: rows.slice(0, limit).map(function (t) {
      const bid = str_(t.budget_id);
      const info = budgetInfo[bid] || {};
      const canManage = canManageTxn_(user, bid);
      const dto = toTxnDto_(t, reserveMap, canManage);
      dto.budgetCode = info.code || '';
      dto.budgetName = info.name || '';
      return dto;
    })
  };
}

/** รายการจองที่ยังมียอดค้าง — ใช้เป็นตัวเลือกตอนบันทึกการเบิก */
function openReservations_(user, budgetId) {
  requireView_(user, budgetId);
  return readTable_(SH.TXNS)
    .filter(function (t) {
      return str_(t.budget_id) === str_(budgetId)
        && str_(t.txn_type) === TXN_TYPE.RESERVE
        && str_(t.status) === STATUS.ACTIVE
        && num_(t.amount) - num_(t.settled_amount) > 0.009;
    })
    .map(function (t) {
      return {
        txnId: str_(t.txn_id), txnNo: str_(t.txn_no), title: str_(t.title),
        txnDate: dateOnly_(t.txn_date),
        amount: num_(t.amount), settledAmount: num_(t.settled_amount),
        outstanding: round2_(num_(t.amount) - num_(t.settled_amount))
      };
    })
    .sort(function (a, b) { return a.txnDate.localeCompare(b.txnDate); });
}

/**
 * สร้างรายการใช้งบ
 * payload: { budgetId, txnType, txnNo, txnDate, title, description, category, vendor,
 *            amount, reserveTxnId, reason, files[] }
 */
function createTransaction_(user, payload) {
  const budgetId = str_(payload.budgetId);
  requireManageTxn_(user, budgetId);
  const txnType = str_(payload.txnType);
  if (txnType !== TXN_TYPE.RESERVE && txnType !== TXN_TYPE.DISBURSE) {
    throw new Error('ประเภทรายการไม่ถูกต้อง (ต้องเป็นการจอง หรือ เบิกใช้แล้ว)');
  }
  const amount = num_(payload.amount);
  if (amount <= 0) throw new Error('จำนวนเงินต้องมากกว่า 0');
  if (!str_(payload.title)) throw new Error('กรุณาระบุรายละเอียด/ชื่อรายการ');

  return withLock_(function () {
    const b = getBudgetOr404_(budgetId);
    if (normalizeBudgetStatus_(b.status) === STATUS.CLOSED) {
      throw new Error('งบประมาณนี้ปิดแล้ว ไม่สามารถเพิ่มรายการได้');
    }

    const txns = readTable_(SH.TXNS);
    const summary = computeSummary_(b, txns);
    const reserveId = str_(payload.reserveTxnId);

    if (txnType === TXN_TYPE.DISBURSE && reserveId) {
      // เบิกจากรายการจอง → ไม่กินวงเงินเพิ่ม แต่ต้องไม่เกินยอดจองที่ค้าง
      const r = txns.filter(function (t) { return str_(t.txn_id) === reserveId; })[0];
      if (!r) throw new Error('ไม่พบรายการจองที่อ้างอิง');
      if (str_(r.budget_id) !== budgetId) throw new Error('รายการจองที่อ้างอิงอยู่ต่างงบประมาณ');
      if (str_(r.status) !== STATUS.ACTIVE) throw new Error('รายการจองนี้ถูกยกเลิก/ปิดแล้ว');
      const outstanding = round2_(num_(r.amount) - num_(r.settled_amount));
      if (amount > outstanding + 0.009) {
        throw new Error('ยอดเบิก ' + fmtMoneySrv_(amount) + ' เกินยอดจองที่ค้างไว้ (' + fmtMoneySrv_(outstanding) + ')');
      }
    } else {
      assertWithinAvailable_(amount, summary);
    }

    const id = newId_('TXN');
    const row = {
      txn_id: id, budget_id: budgetId, txn_type: txnType,
      txn_no: str_(payload.txnNo) || autoTxnNo_(b, txnType, txns),
      txn_date: dateOnly_(payload.txnDate) || todayIso_(),
      title: str_(payload.title),
      description: str_(payload.description),
      category: str_(payload.category),
      vendor: str_(payload.vendor),
      amount: amount,
      settled_amount: 0,
      status: STATUS.ACTIVE,
      reserve_txn_id: txnType === TXN_TYPE.DISBURSE ? reserveId : '',
      attachment_ids: '',
      created_at: nowIso_(), created_by: user.email, updated_at: nowIso_(), updated_by: user.email
    };
    insertRow_(SH.TXNS, row);

    const fileIds = saveAttachments_(user, b, ENTITY.TRANSACTION, id, payload.files);
    if (fileIds.length) {
      const saved = findRow_(SH.TXNS, 'txn_id', id);
      updateRow_(SH.TXNS, saved._row, { attachment_ids: fileIds.join(',') });
    }

    if (txnType === TXN_TYPE.DISBURSE && reserveId) applySettlement_(reserveId, amount);

    promoteBudgetToProcess_(b);

    writeAudit_({
      actor: user.email, action: ACTION.TXN_CREATE, entityType: ENTITY.TRANSACTION, entityId: id,
      budgetId: budgetId,
      summary: LABELS.txnType[txnType] + ' ' + fmtMoneySrv_(amount) + ' – ' + str_(payload.title) +
        ' (งบ ' + str_(b.code) + ')',
      reason: str_(payload.reason), after: row, attachmentIds: fileIds
    });
    return { txnId: id, txnNo: row.txn_no };
  });
}

/**
 * แก้ไขรายการใช้งบ — ต้องระบุเหตุผล, แนบไฟล์ได้, เก็บ before/after ใน AuditLog
 */
function updateTransaction_(user, payload) {
  const txnId = str_(payload.txnId);
  const reason = str_(payload.reason);
  if (reason.length < 5) throw new Error('กรุณาระบุเหตุผลการแก้ไข (อย่างน้อย 5 ตัวอักษร)');

  return withLock_(function () {
    const t = findRow_(SH.TXNS, 'txn_id', txnId);
    if (!t) throw new Error('ไม่พบรายการที่ต้องการแก้ไข');
    const budgetId = str_(t.budget_id);
    requireManageTxn_(user, budgetId);
    if (str_(t.status) === STATUS.CANCELLED) throw new Error('รายการนี้ถูกยกเลิกแล้ว ไม่สามารถแก้ไขได้');

    const b = getBudgetOr404_(budgetId);
    if (normalizeBudgetStatus_(b.status) === STATUS.CLOSED) {
      throw new Error('งบประมาณนี้ปิดแล้ว ไม่สามารถแก้ไขรายการได้');
    }

    const txns = readTable_(SH.TXNS);
    const oldAmount = num_(t.amount);
    const newAmount = payload.amount === undefined || payload.amount === '' ? oldAmount : num_(payload.amount);
    if (newAmount <= 0) throw new Error('จำนวนเงินต้องมากกว่า 0');

    const type = str_(t.txn_type);
    const reserveId = str_(t.reserve_txn_id);

    if (newAmount !== oldAmount) {
      if (type === TXN_TYPE.RESERVE) {
        const settled = num_(t.settled_amount);
        if (newAmount < settled) {
          throw new Error('ยอดจองใหม่ (' + fmtMoneySrv_(newAmount) + ') ต่ำกว่ายอดที่ถูกเบิกไปแล้ว (' +
            fmtMoneySrv_(settled) + ')');
        }
      }
      if (type === TXN_TYPE.DISBURSE && reserveId) {
        const r = txns.filter(function (x) { return str_(x.txn_id) === reserveId; })[0];
        if (r) {
          const outstandingExcl = round2_(num_(r.amount) - num_(r.settled_amount) + oldAmount);
          if (newAmount > outstandingExcl + 0.009) {
            throw new Error('ยอดเบิกใหม่เกินยอดจองที่ค้างไว้ (' + fmtMoneySrv_(outstandingExcl) + ')');
          }
        }
      } else {
        // คำนวณวงเงินคงเหลือโดยไม่รวมรายการนี้
        const others = txns.filter(function (x) { return str_(x.txn_id) !== txnId; });
        const summaryExcl = computeSummary_(b, others);
        assertWithinAvailable_(newAmount, summaryExcl);
      }
    }

    const before = {
      txn_no: str_(t.txn_no), txn_date: dateOnly_(t.txn_date), title: str_(t.title),
      description: str_(t.description), category: str_(t.category), vendor: str_(t.vendor),
      amount: oldAmount, status: str_(t.status)
    };
    const patch = {
      txn_no: payload.txnNo === undefined ? str_(t.txn_no) : str_(payload.txnNo),
      txn_date: dateOnly_(payload.txnDate) || dateOnly_(t.txn_date),
      title: payload.title === undefined ? str_(t.title) : str_(payload.title),
      description: payload.description === undefined ? str_(t.description) : str_(payload.description),
      category: payload.category === undefined ? str_(t.category) : str_(payload.category),
      vendor: payload.vendor === undefined ? str_(t.vendor) : str_(payload.vendor),
      amount: newAmount,
      updated_at: nowIso_(), updated_by: user.email
    };

    const fileIds = saveAttachments_(user, b, ENTITY.TRANSACTION, txnId, payload.files);
    if (fileIds.length) {
      patch.attachment_ids = idListToArray_(t.attachment_ids).concat(fileIds).join(',');
    }
    updateRow_(SH.TXNS, t._row, patch);

    // ปรับ settled ของรายการจองที่อ้างถึง เมื่อยอดเบิกเปลี่ยน
    if (type === TXN_TYPE.DISBURSE && reserveId && newAmount !== oldAmount) {
      applySettlement_(reserveId, round2_(newAmount - oldAmount));
    }

    writeAudit_({
      actor: user.email, action: ACTION.TXN_UPDATE, entityType: ENTITY.TRANSACTION, entityId: txnId,
      budgetId: budgetId,
      summary: 'แก้ไข' + LABELS.txnType[type] + ' ' + str_(patch.txn_no) +
        (newAmount !== oldAmount ? ' (' + fmtMoneySrv_(oldAmount) + ' → ' + fmtMoneySrv_(newAmount) + ')' : ''),
      reason: reason, before: before, after: patch, attachmentIds: fileIds
    });
    return { txnId: txnId };
  });
}

/** ยกเลิกรายการ (ไม่ลบข้อมูล เพื่อคงร่องรอยการตรวจสอบ) */
function cancelTransaction_(user, payload) {
  const txnId = str_(payload.txnId);
  const reason = str_(payload.reason);
  if (reason.length < 5) throw new Error('กรุณาระบุเหตุผลการยกเลิก (อย่างน้อย 5 ตัวอักษร)');

  return withLock_(function () {
    const t = findRow_(SH.TXNS, 'txn_id', txnId);
    if (!t) throw new Error('ไม่พบรายการ');
    const budgetId = str_(t.budget_id);
    requireManageTxn_(user, budgetId);
    if (str_(t.status) === STATUS.CANCELLED) throw new Error('รายการนี้ถูกยกเลิกไปแล้ว');

    const b = getBudgetOr404_(budgetId);
    const type = str_(t.txn_type);

    if (type === TXN_TYPE.RESERVE && num_(t.settled_amount) > 0.009) {
      throw new Error('ไม่สามารถยกเลิกรายการจองที่มีการเบิกแล้ว — กรุณายกเลิกรายการเบิกที่อ้างอิงก่อน');
    }

    const fileIds = saveAttachments_(user, b, ENTITY.TRANSACTION, txnId, payload.files);
    const patch = {
      status: STATUS.CANCELLED, updated_at: nowIso_(), updated_by: user.email
    };
    if (fileIds.length) patch.attachment_ids = idListToArray_(t.attachment_ids).concat(fileIds).join(',');
    updateRow_(SH.TXNS, t._row, patch);

    // คืนยอดให้รายการจอง ถ้าเป็นการเบิกที่อ้างอิงการจอง
    if (type === TXN_TYPE.DISBURSE && str_(t.reserve_txn_id)) {
      applySettlement_(str_(t.reserve_txn_id), -num_(t.amount));
    }

    writeAudit_({
      actor: user.email, action: ACTION.TXN_CANCEL, entityType: ENTITY.TRANSACTION, entityId: txnId,
      budgetId: budgetId,
      summary: 'ยกเลิก' + LABELS.txnType[type] + ' ' + str_(t.txn_no) + ' ' + fmtMoneySrv_(t.amount),
      reason: reason,
      before: { status: str_(t.status), amount: num_(t.amount) },
      after: { status: STATUS.CANCELLED }, attachmentIds: fileIds
    });
    return { txnId: txnId };
  });
}

/** บวก/ลบยอดที่ถูกเบิกออกจากรายการจอง แล้วอัปเดตสถานะ ACTIVE/SETTLED */
function applySettlement_(reserveTxnId, delta) {
  const r = findRow_(SH.TXNS, 'txn_id', str_(reserveTxnId));
  if (!r) return;
  const settled = round2_(Math.max(num_(r.settled_amount) + num_(delta), 0));
  const amount = num_(r.amount);
  const patch = { settled_amount: settled, updated_at: nowIso_() };
  if (str_(r.status) !== STATUS.CANCELLED) {
    patch.status = settled >= amount - 0.009 ? STATUS.SETTLED : STATUS.ACTIVE;
  }
  updateRow_(SH.TXNS, r._row, patch);
}

function assertWithinAvailable_(amount, summary) {
  if (summary.usableAmount <= 0) {
    throw new Error('งบประมาณนี้ยังไม่ได้กำหนด "จำนวนที่ใช้ได้" — กรุณากำหนดก่อนบันทึกรายการ');
  }
  if (num_(amount) > summary.availableToSpend + 0.009) {
    throw new Error('จำนวนเงิน ' + fmtMoneySrv_(amount) + ' เกินวงเงินที่ใช้ได้คงเหลือ (' +
      fmtMoneySrv_(summary.availableToSpend) + ')\n' +
      'จำนวนที่ใช้ได้ ' + fmtMoneySrv_(summary.usableAmount) +
      ' – จองค้าง ' + fmtMoneySrv_(summary.reservedOutstanding) +
      ' – เบิกแล้ว ' + fmtMoneySrv_(summary.disbursed));
  }
}

/** เลขที่รายการอัตโนมัติ เช่น A-RSV-0007 */
function autoTxnNo_(budget, txnType, txns) {
  const prefix = str_(budget.code) + '-' + (txnType === TXN_TYPE.RESERVE ? 'RSV' : 'DSB') + '-';
  let max = 0;
  (txns || readTable_(SH.TXNS)).forEach(function (t) {
    const no = str_(t.txn_no);
    if (no.indexOf(prefix) === 0) {
      const n = parseInt(no.substring(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + ('0000' + (max + 1)).slice(-4);
}

/** ประวัติการแก้ไขของรายการเดียว (ดึงจาก AuditLog) */
function txnHistory_(user, txnId) {
  const t = findRow_(SH.TXNS, 'txn_id', str_(txnId));
  if (!t) throw new Error('ไม่พบรายการ');
  requireAuditView_(user, str_(t.budget_id));
  return listAudit_(user, { entityType: ENTITY.TRANSACTION, entityId: str_(txnId), limit: 100 }).rows;
}

/**
 * ย้ายรายการใช้งบทั้งชุด (จอง + เบิกที่ผูกกัน) ไปงบอื่น — เฉพาะผู้ดูแลระบบ
 * payload: { txnId, toBudgetId, reason }
 * ถ้า txnId เป็นเบิกที่ผูกจอง → ย้ายทั้งชุดจากรายการจอง
 * ถ้าเป็นจอง → ย้ายจอง + ทุกรายการเบิกที่อ้างอิง
 */
function moveTransactionSet_(user, payload) {
  requireSuperAdmin_(user);
  const reason = str_(payload.reason);
  if (reason.length < 5) throw new Error('กรุณาระบุเหตุผลการย้าย (อย่างน้อย 5 ตัวอักษร)');
  const toBudgetId = str_(payload.toBudgetId);
  if (!toBudgetId) throw new Error('กรุณาเลือกงบปลายทาง');

  return withLock_(function () {
    const seed = findRow_(SH.TXNS, 'txn_id', str_(payload.txnId));
    if (!seed) throw new Error('ไม่พบรายการ');
    if (str_(seed.status) === STATUS.CANCELLED) throw new Error('ไม่สามารถย้ายรายการที่ยกเลิกแล้ว');

    const fromBudgetId = str_(seed.budget_id);
    if (fromBudgetId === toBudgetId) throw new Error('งบปลายทางต้องต่างจากงบต้นทาง');

    const fromB = getBudgetOr404_(fromBudgetId);
    const toB = getBudgetOr404_(toBudgetId);
    if (normalizeBudgetStatus_(fromB.status) === STATUS.CLOSED) {
      throw new Error('งบต้นทางปิดแล้ว ไม่สามารถย้ายออกได้');
    }
    if (normalizeBudgetStatus_(toB.status) === STATUS.CLOSED) {
      throw new Error('งบปลายทางปิดแล้ว ไม่สามารถย้ายเข้าได้');
    }

    // หา root จองของชุด
    let reserve = seed;
    if (str_(seed.txn_type) === TXN_TYPE.DISBURSE && str_(seed.reserve_txn_id)) {
      reserve = findRow_(SH.TXNS, 'txn_id', str_(seed.reserve_txn_id));
      if (!reserve) throw new Error('ไม่พบรายการจองที่ผูกกับรายการเบิกนี้');
    } else if (str_(seed.txn_type) === TXN_TYPE.DISBURSE) {
      // เบิกตรงไม่มีจอง — ย้ายรายการเดียว
      reserve = null;
    } else if (str_(seed.txn_type) !== TXN_TYPE.RESERVE) {
      throw new Error('ประเภทรายการไม่รองรับการย้าย');
    }

    const all = readTable_(SH.TXNS);
    const set = [];
    if (reserve) {
      set.push(reserve);
      all.forEach(function (t) {
        if (str_(t.reserve_txn_id) === str_(reserve.txn_id) && str_(t.status) !== STATUS.CANCELLED) {
          set.push(t);
        }
      });
    } else {
      set.push(seed);
    }

    // คำนวณยอดที่จะกินวงเงินปลายทาง (จองค้าง + เบิกตรง; เบิกจากจองไม่กินเพิ่ม)
    let impact = 0;
    set.forEach(function (t) {
      if (str_(t.status) === STATUS.CANCELLED) return;
      if (str_(t.txn_type) === TXN_TYPE.RESERVE) {
        impact += Math.max(num_(t.amount) - num_(t.settled_amount), 0);
      } else if (str_(t.txn_type) === TXN_TYPE.DISBURSE && !str_(t.reserve_txn_id)) {
        impact += num_(t.amount);
      }
    });
    impact = round2_(impact);

    const destTxns = all.filter(function (t) { return str_(t.budget_id) === toBudgetId; });
    const destSummary = computeSummary_(toB, destTxns);
    assertWithinAvailable_(impact, destSummary);

    const movedIds = [];
    set.forEach(function (t) {
      updateRow_(SH.TXNS, t._row, {
        budget_id: toBudgetId,
        updated_at: nowIso_(),
        updated_by: user.email
      });
      movedIds.push(str_(t.txn_id));
    });

    promoteBudgetToProcess_(toB);

    writeAudit_({
      actor: user.email, action: ACTION.TXN_MOVE, entityType: ENTITY.TRANSACTION,
      entityId: movedIds[0], budgetId: toBudgetId,
      summary: 'ย้ายรายการ ' + movedIds.length + ' รายการ จากงบ ' + str_(fromB.code) +
        ' → ' + str_(toB.code) + ' (ผลกระทบวงเงิน ' + fmtMoneySrv_(impact) + ')',
      reason: reason,
      before: { fromBudgetId: fromBudgetId, txnIds: movedIds },
      after: { toBudgetId: toBudgetId, txnIds: movedIds, impact: impact }
    });
    // log อีกครั้งที่งบต้นทางเพื่อให้เห็นในประวัติทั้งสองฝั่ง
    writeAudit_({
      actor: user.email, action: ACTION.TXN_MOVE, entityType: ENTITY.TRANSACTION,
      entityId: movedIds[0], budgetId: fromBudgetId,
      summary: 'ย้ายรายการออกไปงบ ' + str_(toB.code) + ' (' + movedIds.length + ' รายการ)',
      reason: reason,
      before: { fromBudgetId: fromBudgetId, txnIds: movedIds },
      after: { toBudgetId: toBudgetId, txnIds: movedIds }
    });

    return { movedTxnIds: movedIds, fromBudgetId: fromBudgetId, toBudgetId: toBudgetId, impact: impact };
  });
}

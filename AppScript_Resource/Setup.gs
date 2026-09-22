/**
 * Setup.gs
 * ติดตั้งระบบครั้งแรก + seed ข้อมูลตัวอย่างครบประวัติ
 */

function setup() {
  const props = PropertiesService.getScriptProperties();

  let ssId = props.getProperty(CFG.PROP_SPREADSHEET_ID);
  if (!ssId) {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    const ss = active || SpreadsheetApp.create(CFG.APP_NAME + ' – Database');
    ssId = ss.getId();
    props.setProperty(CFG.PROP_SPREADSHEET_ID, ssId);
  }

  Object.keys(HEADERS).forEach(function (name) { getSheet_(name); });
  formatSheets_();
  ensureRootFolder_();

  const me = normEmail_(Session.getEffectiveUser().getEmail());
  // ผู้ดูแลระบบเริ่มต้น (รายชื่อคงที่ใน Schema + คนที่รัน setup)
  const designated = (CFG.DEFAULT_SUPER_ADMINS || []).slice();
  const supers = designated.concat(me ? [me] : [])
    .map(normEmail_)
    .filter(Boolean)
    .filter(function (e, i, a) { return a.indexOf(e) === i; });
  props.setProperty(CFG.PROP_SUPER_ADMINS, supers.join(','));

  supers.forEach(function (email) {
    const existing = findUserByEmail_(email);
    if (!existing) {
      insertRow_(SH.USERS, {
        user_id: newId_('USR'),
        email: email,
        display_name: email.split('@')[0],
        system_role: ROLE.SUPER_ADMIN,
        status: STATUS.ACTIVE,
        note: 'ผู้ดูแลระบบ',
        created_at: nowIso_(), created_by: me || email,
        updated_at: nowIso_(), updated_by: me || email
      });
    } else if (str_(existing.system_role) !== ROLE.SUPER_ADMIN || str_(existing.status) !== STATUS.ACTIVE) {
      updateRow_(SH.USERS, existing._row, {
        system_role: ROLE.SUPER_ADMIN, status: STATUS.ACTIVE, updated_at: nowIso_()
      });
    }
  });

  seedConfig_();
  seedDefaultTypes_(me);

  const url = SpreadsheetApp.openById(ssId).getUrl();
  Logger.log('ติดตั้งเสร็จแล้ว\nSpreadsheet: %s\nSuper admins: %s', url, supers.join(', '));
  return { spreadsheetUrl: url, superAdmins: supers };
}

/**
 * สร้างข้อมูลตัวอย่างครบ: ผู้ใช้หลายบทบาท, หลายโครงการภายใต้รหัสซ้ำ,
 * ประวัติปรับวงเงิน, จอง, เบิก, รายงานหมวด, งบปิด
 */
function seedDemoData() {
  const actor = normEmail_(Session.getEffectiveUser().getEmail()) || 'chiraporn.r@ku.th';
  const SUPERS = (CFG.DEFAULT_SUPER_ADMINS || []).slice();
  const EXEC = 'forregistertest@gmail.com';
  const OWNER = 'forregistertest2@gmail.com';
  const TXN_MGR = 'forregistertest3@gmail.com';
  const VIEWER = 'forregistertest4@gmail.com';

  // ผู้ใช้
  const users = SUPERS.map(function (e) {
    return { email: e, name: e.split('@')[0], role: ROLE.SUPER_ADMIN, note: 'ผู้ดูแลระบบ (seed)' };
  }).concat([
    { email: EXEC, name: 'ผู้บริหารทดสอบ', role: ROLE.EXECUTIVE, note: 'ดูทุกโครงการ อ่านอย่างเดียว' },
    { email: OWNER, name: 'ผู้รับผิดชอบทดสอบ', role: ROLE.USER, note: 'ผู้รับผิดชอบรายโครงการ' },
    { email: TXN_MGR, name: 'ผู้จัดการรายการทดสอบ', role: ROLE.USER, note: 'บันทึกรายการจอง/เบิก' },
    { email: VIEWER, name: 'ผู้ดูทดสอบ', role: ROLE.USER, note: 'ดู dashboard เท่านั้น' }
  ]);
  users.forEach(function (u) {
    const existing = findUserByEmail_(u.email);
    if (existing) {
      updateRow_(SH.USERS, existing._row, {
        display_name: u.name, system_role: u.role, status: STATUS.ACTIVE, note: u.note,
        updated_at: nowIso_(), updated_by: actor
      });
    } else {
      insertRow_(SH.USERS, {
        user_id: newId_('USR'), email: normEmail_(u.email), display_name: u.name,
        system_role: u.role, status: STATUS.ACTIVE, note: u.note,
        created_at: nowIso_(), created_by: actor, updated_at: nowIso_(), updated_by: actor
      });
    }
  });

  const props = PropertiesService.getScriptProperties();
  const supers = getSuperAdminEmails_().concat([actor]).map(normEmail_).filter(Boolean)
    .filter(function (e, i, a) { return a.indexOf(e) === i; });
  props.setProperty(CFG.PROP_SUPER_ADMINS, supers.join(','));

  seedDefaultTypes_(actor);

  // ถ้ามีงบจาก seed เก่าอยู่แล้ว ข้ามการสร้างซ้ำ (ตรวจจากชื่อ)
  if (findRow_(SH.BUDGETS, 'name', 'โครงการพัฒนาระบบสารสนเทศ')) {
    return 'มีข้อมูลตัวอย่างอยู่แล้ว — ข้ามการสร้างซ้ำ';
  }

  const fy = 'หลังปี ' + new Date().getFullYear();
  const fakeUser = { email: actor, isSuperAdmin: true, isExecutive: false };
  const SUPER = SUPERS[0] || actor;

  // ── งบ A: Process — มีประวัติครบ ──
  const a1 = seedBudget_(fakeUser, {
    code: 'A', name: 'โครงการพัฒนาระบบสารสนเทศ', fiscalYear: fy,
    description: 'พัฒนาระบบงานภายใน ปีงบปัจจุบัน รวมจัดซื้อซอฟต์แวร์และจ้างพัฒนาระบบ',
    budgetAmount: 5000000, usableAmount: 2000000,
    owners: [OWNER, SUPER], txnManagers: [TXN_MGR], viewers: [VIEWER],
    reason: 'อนุมัติตั้งต้นตามบันทึก กค 101/2569'
  });
  // ปรับวงเงินเพิ่ม + ปล่อยใช้ได้ (history)
  setAmounts_(fakeUser, {
    budgetId: a1.budgetId, budgetAmount: 5500000, usableAmount: 3500000,
    reason: 'โอนเพิ่มงบและปล่อยวงเงินงวดที่ 2 ตามบันทึก กค 150/2569', refNo: 'กค 150/2569'
  });

  const r1 = createTransaction_(fakeUser, {
    budgetId: a1.budgetId, txnType: TXN_TYPE.RESERVE, title: 'จ้างพัฒนาระบบ CRM',
    category: 'จ้างเหมาบริการ', vendor: 'บริษัท ซอฟต์เทค จำกัด', amount: 800000,
    description: 'สัญญาจ้างพัฒนาระยะที่ 1', reason: 'seed'
  });
  createTransaction_(fakeUser, {
    budgetId: a1.budgetId, txnType: TXN_TYPE.DISBURSE, title: 'เบิกงวดที่ 1 – CRM',
    category: 'จ้างเหมาบริการ', vendor: 'บริษัท ซอฟต์เทค จำกัด', amount: 300000,
    reserveTxnId: r1.txnId, reason: 'seed เบิกจากจอง'
  });
  createTransaction_(fakeUser, {
    budgetId: a1.budgetId, txnType: TXN_TYPE.DISBURSE, title: 'ซื้อใบอนุญาตซอฟต์แวร์',
    category: 'วัสดุ/ซอฟต์แวร์', vendor: 'Microsoft', amount: 120000, reason: 'seed เบิกตรง'
  });
  createTransaction_(fakeUser, {
    budgetId: a1.budgetId, txnType: TXN_TYPE.RESERVE, title: 'จัดซื้อเซิร์ฟเวอร์',
    category: 'ครุภัณฑ์', vendor: 'IT Supply Co.', amount: 450000, reason: 'seed'
  });

  // ── งบ A อีกโครงการ (รหัสซ้ำ) — New ──
  seedBudget_(fakeUser, {
    code: 'A', name: 'โครงการอบรมบุคลากรด้านดิจิทัล', fiscalYear: fy,
    description: 'อบรมทักษะดิจิทัลให้เจ้าหน้าที่ ยังไม่เริ่มใช้งบ',
    budgetAmount: 800000, usableAmount: 0,
    owners: [OWNER], txnManagers: [], viewers: [VIEWER],
    reason: 'อนุมัติหลักการ รอจัดสรรงบใช้ได้'
  });

  // ── งบ B: Process ──
  const b1 = seedBudget_(fakeUser, {
    code: 'B', name: 'งานบำรุงรักษาระบบประจำปี', fiscalYear: fy,
    description: 'สัญญาบำรุงรักษาฮาร์ดแวร์และซอฟต์แวร์',
    budgetAmount: 2400000, usableAmount: 2400000,
    owners: [OWNER], txnManagers: [TXN_MGR], viewers: [VIEWER],
    reason: 'ตั้งวงเงินงานบำรุงรักษา'
  });
  createTransaction_(fakeUser, {
    budgetId: b1.budgetId, txnType: TXN_TYPE.DISBURSE, title: 'ค่าบำรุงรักษางวด Q1',
    category: 'บำรุงรักษา', vendor: 'Maintenance Plus', amount: 500000, reason: 'seed'
  });
  createTransaction_(fakeUser, {
    budgetId: b1.budgetId, txnType: TXN_TYPE.RESERVE, title: 'จองค่าบำรุงรักษางวด Q2–Q4',
    category: 'บำรุงรักษา', vendor: 'Maintenance Plus', amount: 1500000, reason: 'seed'
  });

  // ── งบ C: Close — มีประวัติแล้วปิด ──
  const c1 = seedBudget_(fakeUser, {
    code: 'C', name: 'งานฝึกอบรมประจำปี (ปิดแล้ว)', fiscalYear: 'ปีงบ 2568',
    description: 'โครงการฝึกอบรมที่ดำเนินการครบและปิดงบแล้ว',
    budgetAmount: 1200000, usableAmount: 1200000,
    owners: [OWNER], txnManagers: [TXN_MGR], viewers: [VIEWER],
    reason: 'ตั้งวงเงินงานฝึกอบรม'
  });
  const cr = createTransaction_(fakeUser, {
    budgetId: c1.budgetId, txnType: TXN_TYPE.RESERVE, title: 'จองค่าวิทยากรและสถานที่',
    category: 'อบรม', vendor: 'Training Hub', amount: 900000, reason: 'seed'
  });
  createTransaction_(fakeUser, {
    budgetId: c1.budgetId, txnType: TXN_TYPE.DISBURSE, title: 'เบิกค่าวิทยากรครบ',
    category: 'อบรม', vendor: 'Training Hub', amount: 900000,
    reserveTxnId: cr.txnId, reason: 'seed'
  });
  createTransaction_(fakeUser, {
    budgetId: c1.budgetId, txnType: TXN_TYPE.DISBURSE, title: 'ค่าเอกสารประกอบการอบรม',
    category: 'วัสดุ', vendor: 'PrintShop', amount: 85000, reason: 'seed'
  });
  updateBudgetInfo_(fakeUser, {
    budgetId: c1.budgetId, status: STATUS.CLOSED,
    reason: 'ปิดงบหลังสรุปผลการอบรมครบถ้วน'
  });

  // ── งบ D: Process สำหรับรายงานหมวด ──
  const d1 = seedBudget_(fakeUser, {
    code: 'D', name: 'งบสำรองและค่าใช้จ่ายทั่วไป', fiscalYear: fy,
    description: 'ใช้โชว์รายงานแยกหมวดหลายประเภท',
    budgetAmount: 1000000, usableAmount: 700000,
    owners: [OWNER, SUPER], txnManagers: [TXN_MGR], viewers: [],
    reason: 'ตั้งงบสำรอง'
  });
  ['ค่าเดินทาง', 'ค่าประชุม', 'วัสดุสำนักงาน', 'สาธารณูปโภค'].forEach(function (cat, i) {
    createTransaction_(fakeUser, {
      budgetId: d1.budgetId, txnType: TXN_TYPE.DISBURSE,
      title: 'รายจ่ายหมวด ' + cat, category: cat, amount: 50000 + i * 25000, reason: 'seed รายงาน'
    });
  });

  return 'สร้างข้อมูลตัวอย่างครบแล้ว (งบ A×2, B, C ปิด, D + ผู้ใช้ 5 คน + ประวัติ)';
}

/** สร้างงบโดยตรงใน seed โดยไม่ผ่าน createBudget_ RPC ซ้ำซ้อน — เรียก createBudget_ */
function seedBudget_(user, o) {
  return createBudget_(user, {
    code: o.code, name: o.name, fiscalYear: o.fiscalYear, description: o.description,
    budgetAmount: o.budgetAmount, usableAmount: o.usableAmount,
    owners: o.owners, txnManagers: o.txnManagers, viewers: o.viewers,
    reason: o.reason || 'seed', refNo: o.refNo || ''
  });
}

function ensureRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folderId = props.getProperty(CFG.PROP_FOLDER_ID);
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (e) { /* recreate */ }
  }
  const folder = DriveApp.createFolder(CFG.APP_NAME + ' – ไฟล์แนบ');
  props.setProperty(CFG.PROP_FOLDER_ID, folder.getId());
  return folder;
}

function seedConfig_() {
  const existing = {};
  readTable_(SH.CONFIG).forEach(function (r) { existing[str_(r.key)] = true; });
  const defaults = [
    ['app_name', CFG.APP_NAME, 'ชื่อที่แสดงบนหัวเว็บ'],
    ['org_name', 'หน่วยงานของคุณ', 'ชื่อหน่วยงาน แสดงใต้ชื่อระบบ'],
    ['currency', 'THB', 'สกุลเงินเริ่มต้น'],
    ['allow_self_register', 'FALSE', 'TRUE = ผู้ใช้ใหม่ถูกบันทึกอัตโนมัติ (ยังไม่มีสิทธิ์ดูงบใด ๆ)'],
    ['warn_threshold_pct', '80', 'เปอร์เซ็นต์การใช้งบที่เริ่มเตือนสีเหลือง'],
    ['danger_threshold_pct', '95', 'เปอร์เซ็นต์การใช้งบที่เตือนสีแดง']
  ];
  const toAdd = defaults
    .filter(function (d) { return !existing[d[0]]; })
    .map(function (d) { return { key: d[0], value: d[1], note: d[2] }; });
  insertRows_(SH.CONFIG, toAdd);
}

function getConfigMap_() {
  const map = {};
  readTable_(SH.CONFIG).forEach(function (r) {
    const k = str_(r.key);
    if (k) map[k] = str_(r.value);
  });
  return map;
}

function formatSheets_() {
  const ss = getSpreadsheet_();
  const moneyCols = {
    Budgets: ['budget_amount', 'usable_amount'],
    BudgetChanges: ['old_amount', 'new_amount', 'delta'],
    Transactions: ['amount', 'settled_amount']
  };
  Object.keys(HEADERS).forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const headers = HEADERS[name];
    sh.autoResizeColumns(1, headers.length);
    (moneyCols[name] || []).forEach(function (col) {
      const idx = headers.indexOf(col) + 1;
      if (idx > 0) sh.getRange(2, idx, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('#,##0.00');
    });
    if (sh.getMaxColumns() > headers.length) {
      sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
    }
  });
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('⚙️ ' + CFG.APP_SHORT)
      .addItem('ติดตั้ง / ซ่อมแซมโครงสร้างชีต', 'setup')
      .addItem('สร้างข้อมูลตัวอย่าง (ครบประวัติ)', 'seedDemoData')
      .addSeparator()
      .addItem('เปิดเว็บแอป (ดู URL)', 'showWebAppUrl')
      .addToUi();
  } catch (e) { /* not from spreadsheet */ }
}

function showWebAppUrl() {
  const url = ScriptApp.getService().getUrl();
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;padding:12px 4px">' +
    (url
      ? '<p>URL เว็บแอป:</p><p><a href="' + url + '" target="_blank">' + url + '</a></p>'
      : '<p>ยังไม่ได้ Deploy เว็บแอป — ไปที่ Apps Script → Deploy → New deployment → Web app</p>') +
    '</div>'
  ).setWidth(460).setHeight(160);
  SpreadsheetApp.getUi().showModalDialog(html, 'เว็บแอปบริหารงบประมาณ');
}

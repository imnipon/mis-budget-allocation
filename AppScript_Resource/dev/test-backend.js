/* ───────────────────────────────────────────────────────────────
   dev/test-backend.js
   ตัวจำลอง Google Apps Script (Sheets / Drive / Session / Lock) เพื่อทดสอบ
   logic หลังบ้านทั้งหมดบนเครื่อง โดยไม่ต้อง deploy

   รัน:  node dev/test-backend.js
   ไฟล์นี้ใช้ตอนพัฒนาเท่านั้น และถูกกันไม่ให้ push ขึ้น Apps Script ด้วย .claspignore
   ─────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** โฟลเดอร์ที่เก็บไฟล์ .gs (โปรเจกต์อยู่ระดับบน 1 ชั้น) */
const SRC_DIR = path.join(__dirname, '..');

/* ── mock: Utilities ── */
function pad(n, w) { return String(n).padStart(w, '0'); }
function formatDate(d, tz, fmt) {
  const map = {
    yyyy: d.getFullYear(), yy: pad(d.getFullYear() % 100, 2),
    MM: pad(d.getMonth() + 1, 2), dd: pad(d.getDate(), 2),
    HH: pad(d.getHours(), 2), mm: pad(d.getMinutes(), 2), ss: pad(d.getSeconds(), 2)
  };
  return fmt.replace(/'([^']*)'|yyyy|yy|MM|dd|HH|mm|ss/g,
    (m, lit) => (lit !== undefined ? lit : map[m]));
}
const Utilities = {
  formatDate,
  getUuid: () => require('crypto').randomUUID(),
  base64Decode: s => Array.from(Buffer.from(s, 'base64')),
  base64Encode: b => Buffer.from(b).toString('base64'),
  newBlob: (bytes, mime, name) => ({
    _bytes: bytes, _mime: mime, _name: name,
    setName(n) { this._name = n; return this; }, getBytes() { return this._bytes; }
  }),
  formatString: (f, ...a) => { let i = 0; return f.replace(/%s/g, () => a[i++]); }
};

/* ── mock: Spreadsheet ── */
class MockRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.data[this.r - 1 + i] || [];
      const line = [];
      for (let j = 0; j < this.nc; j++) {
        const v = row[this.c - 1 + j];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    this.sheet._ensure(this.r + vals.length - 1, this.c + (vals[0] || []).length - 1);
    vals.forEach((row, i) => row.forEach((v, j) => {
      this.sheet.data[this.r - 1 + i][this.c - 1 + j] = v;
    }));
    return this;
  }
  setFontWeight() { return this; } setBackground() { return this; }
  setFontColor() { return this; } setNumberFormat() { return this; }
}
class MockSheet {
  constructor(name) { this.name = name; this.data = []; }
  _ensure(r, c) {
    while (this.data.length < r) this.data.push([]);
    for (const row of this.data) while (row.length < c) row.push('');
  }
  getName() { return this.name; }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => { if (row.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.data.forEach(row => row.forEach((v, j) => { if (v !== '' && v !== null && v !== undefined) last = Math.max(last, j + 1); }));
    return last;
  }
  getMaxRows() { return Math.max(this.data.length, 1000); }
  getMaxColumns() { return 26; }
  deleteColumns() { return this; }
  autoResizeColumns() { return this; }
  setFrozenRows() { return this; }
  getRange(r, c, nr = 1, nc = 1) { return new MockRange(this, r, c, nr, nc); }
  appendRow(vals) {
    const r = this.getLastRow() + 1;
    this._ensure(r, vals.length);
    vals.forEach((v, j) => { this.data[r - 1][j] = v; });
  }
}
class MockSpreadsheet {
  constructor(id) { this.id = id; this.sheets = {}; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { this.sheets[n] = new MockSheet(n); return this.sheets[n]; }
}
const theSpreadsheet = new MockSpreadsheet('SHEET_TEST_ID');
const SpreadsheetApp = {
  openById: () => theSpreadsheet,
  getActiveSpreadsheet: () => theSpreadsheet,
  create: () => theSpreadsheet,
  getUi: () => { throw new Error('no ui'); }
};

/* ── mock: Properties / Session / Lock / Drive ── */
const propStore = {};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: k => (k in propStore ? propStore[k] : null),
    setProperty: (k, v) => { propStore[k] = v; }
  })
};
let CURRENT_EMAIL = 'owner@example.com';
const Session = {
  getActiveUser: () => ({ getEmail: () => CURRENT_EMAIL }),
  getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' })
};
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
let fileSeq = 0;
const fileRegistry = {};
function mockFolder(name) {
  const children = {};
  return {
    _name: name, getId: () => 'folder_' + name,
    getFoldersByName: n => { const f = children[n]; let used = false; return { hasNext: () => !!f && !used, next: () => { used = true; return f; } }; },
    createFolder: n => (children[n] = mockFolder(n)),
    createFile: blob => {
      const id = 'file_' + (++fileSeq);
      const file = {
        getId: () => id, getUrl: () => 'https://drive.google.com/file/d/' + id,
        getMimeType: () => blob._mime, getSize: () => blob._bytes.length,
        getBlob: () => blob, getName: () => blob._name
      };
      fileRegistry[id] = file;
      return file;
    }
  };
}
const rootFolder = mockFolder('root');
const DriveApp = {
  createFolder: n => rootFolder,
  getFolderById: () => rootFolder,
  getFileById: id => {
    if (!fileRegistry[id]) throw new Error('ไม่พบไฟล์ ' + id);
    return fileRegistry[id];
  }
};
const Logger = { log: (...a) => {} };
const ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/webapp' }) };
const HtmlService = {};

/* ── โหลดไฟล์ .gs ทั้งหมดเข้า context เดียวกัน ── */
const ctx = vm.createContext({
  Utilities, SpreadsheetApp, PropertiesService, Session, LockService,
  DriveApp, Logger, ScriptApp, HtmlService, console, JSON, Math, Date,
  Number, String, Object, Array, isNaN, parseInt, parseFloat, Error
});
fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.gs')).sort().forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'), ctx, { filename: f });
});
const run = expr => vm.runInContext(expr, ctx);
const call = (fn, ...args) => {
  ctx.__args = args;
  return vm.runInContext(fn + '.apply(null, __args)', ctx);
};

/* ── ตัวช่วยทดสอบ ── */
let pass = 0, fail = 0;
function t(label, fn) {
  try { fn(); console.log('  ✓ ' + label); pass++; }
  catch (e) { console.log('  ✗ ' + label + '\n      → ' + e.message); fail++; }
}
function eq(actual, expected, what) {
  const a = typeof actual === 'number' ? Math.round(actual * 100) / 100 : actual;
  if (a !== expected) throw new Error((what || 'value') + ': ได้ ' + JSON.stringify(a) + ' คาดว่า ' + JSON.stringify(expected));
}
function rpc(action, payload) {
  ctx.__args = [action, payload || {}];
  const res = vm.runInContext('rpc(__args[0], __args[1])', ctx);
  return res;
}
function ok(action, payload) {
  const r = rpc(action, payload);
  if (!r.ok) throw new Error('rpc ' + action + ' ล้มเหลว: ' + r.error);
  return r.data;
}
function mustFail(action, payload, contains) {
  const r = rpc(action, payload);
  if (r.ok) throw new Error('rpc ' + action + ' ควรล้มเหลวแต่สำเร็จ');
  if (contains && String(r.error).indexOf(contains) < 0) {
    throw new Error('ข้อความ error ไม่ตรง: ' + r.error);
  }
  return r.error;
}
/** ทุก rpc ต้องล้าง cache ของ request เหมือน Apps Script ที่สร้าง context ใหม่ */
function newRequest(email) {
  if (email) CURRENT_EMAIL = email;
  run('__currentUser = null; invalidateCache_(); __attIndex = null;');
}
const B64 = Buffer.from('เอกสารทดสอบ').toString('base64');
const file1 = { name: 'approval.pdf', mimeType: 'application/pdf', dataBase64: B64 };

console.log('\n═══ 1. ติดตั้งระบบ ═══');
t('setup() สร้างชีตครบ 9 ตาราง', () => {
  call('setup');
  const names = Object.keys(theSpreadsheet.sheets).sort();
  eq(names.length, 9, 'จำนวนชีต');
});
t('ผู้ติดตั้งเป็นผู้ดูแลระบบ', () => {
  newRequest('owner@example.com');
  const b = ok('app.bootstrap');
  eq(b.user.isSuperAdmin, true, 'isSuperAdmin');
});

console.log('\n═══ 2. สร้างงบประมาณ A/B/C ═══');
const ids = {};
t('สร้างงบ A วงเงิน 5,000,000 / ใช้ได้ 3,500,000', () => {
  newRequest();
  const r = ok('budget.create', {
    code: 'A', name: 'งบประมาณงาน A', fiscalYear: 'FY69', budgetAmount: 5000000,
    usableAmount: 3500000, reason: 'อนุมัติตามบันทึกที่ กค 1/2569', refNo: 'กค 1/2569', files: [file1]
  });
  ids.A = r.budgetId;
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.A });
  eq(d.summary.budgetAmount, 5000000, 'วงเงิน');
  eq(d.summary.usableAmount, 3500000, 'จำนวนที่ใช้ได้');
  eq(d.summary.unreleased, 1500000, 'ยังไม่ปล่อยให้ใช้');
  eq(d.summary.availableToSpend, 3500000, 'คงเหลือใช้ได้');
  eq(d.changes.length, 2, 'log การกำหนดวงเงิน (วงเงิน + จำนวนที่ใช้ได้)');
  eq(d.changes[0].attachments.length >= 1, true, 'ไฟล์แนบใน log');
});
t('สร้างงบ B และ C', () => {
  newRequest();
  ids.B = ok('budget.create', { code: 'B', name: 'งบประมาณงาน B', budgetAmount: 2400000, usableAmount: 2400000, reason: 'ตั้งงบบำรุงรักษา' }).budgetId;
  newRequest();
  ids.C = ok('budget.create', { code: 'C', name: 'งบประมาณงาน C', budgetAmount: 1200000, usableAmount: 800000, reason: 'ตั้งงบฝึกอบรม' }).budgetId;
  newRequest();
  eq(ok('budget.list').length, 3, 'จำนวนงบ');
});
t('สร้างงบ A และ A อีกโครงการ (รหัสหมวดซ้ำได้)', () => {
  newRequest();
  const r2 = ok('budget.create', {
    code: 'A', name: 'โครงการ A ชุดที่ 2', budgetAmount: 100000, usableAmount: 50000, reason: 'ทดสอบรหัสหมวดซ้ำ'
  });
  ids.A2 = r2.budgetId;
  newRequest();
  eq(ok('budget.list').length, 4, 'จำนวนงบหลังเพิ่ม A2');
});

console.log('\n═══ 3. กฎการปรับวงเงิน ═══');
t('จำนวนที่ใช้ได้ห้ามเกินวงเงิน', () => {
  newRequest();
  mustFail('budget.setAmount', { budgetId: ids.A, changeType: 'USABLE_AMOUNT', newAmount: 9000000, reason: 'ทดสอบเกินวงเงิน' }, 'ต้องไม่เกินวงเงิน');
});
t('บังคับใส่เหตุผลอย่างน้อย 5 ตัวอักษร', () => {
  newRequest();
  mustFail('budget.setAmount', { budgetId: ids.A, changeType: 'USABLE_AMOUNT', newAmount: 1000, reason: 'ok' }, 'รายละเอียด');
});
t('ปล่อยวงเงินเพิ่มเป็น 4,000,000 พร้อมแนบไฟล์', () => {
  newRequest();
  ok('budget.setAmount', {
    budgetId: ids.A, changeType: 'USABLE_AMOUNT', newAmount: 4000000,
    reason: 'ปล่อยวงเงินงวดที่ 2', refNo: 'กค 7/2569', effectiveDate: '2026-04-01', files: [file1]
  });
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.A });
  eq(d.summary.usableAmount, 4000000, 'จำนวนที่ใช้ได้ใหม่');
  eq(d.summary.unreleased, 1000000, 'ยังไม่ปล่อยให้ใช้');
  eq(d.changes.length, 3, 'จำนวน log');
  eq(d.changes[0].delta, 500000, 'ส่วนต่างที่บันทึก');
});
t('ลดวงเงินต่ำกว่าจำนวนที่ใช้ได้ถูกปฏิเสธ', () => {
  newRequest();
  mustFail('budget.setAmount', { budgetId: ids.A, changeType: 'BUDGET_AMOUNT', newAmount: 1000000, reason: 'ทดสอบลดวงเงิน' }, 'ต้องไม่เกินวงเงิน');
});
t('ปรับวงเงินและใช้ได้พร้อมกันในครั้งเดียว', () => {
  newRequest();
  ok('budget.setAmounts', {
    budgetId: ids.B, budgetAmount: 2500000, usableAmount: 2500000,
    reason: 'ปรับวงเงินและใช้ได้พร้อมกัน'
  });
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.B });
  eq(d.summary.budgetAmount, 2500000, 'วงเงิน B');
  eq(d.summary.usableAmount, 2500000, 'ใช้ได้ B');
});

console.log('\n═══ 4. การจอง และการเบิก ═══');
const txn = {};
t('บันทึกการจอง 1,200,000 → เลขที่อัตโนมัติ A-RSV-0001 + สถานะ Process', () => {
  newRequest();
  const r = ok('txn.create', {
    budgetId: ids.A, txnType: 'RESERVE', amount: 1200000, title: 'จัดซื้อเครื่องคอมพิวเตอร์',
    category: 'ครุภัณฑ์', vendor: 'บจก. ทดสอบ', txnDate: '2026-05-10', files: [file1]
  });
  txn.r1 = r.txnId;
  eq(r.txnNo, 'A-RSV-0001', 'เลขที่รายการ');
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.A });
  eq(d.status, 'PROCESS', 'สถานะเปลี่ยนเป็น Process อัตโนมัติ');
  eq(d.summary.reservedOutstanding, 1200000, 'จองคงค้าง');
  eq(d.summary.availableToSpend, 2800000, 'คงเหลือใช้ได้');
});
t('เบิกจากรายการจอง 500,000 → ไม่นับวงเงินซ้ำ', () => {
  newRequest();
  txn.d1 = ok('txn.create', {
    budgetId: ids.A, txnType: 'DISBURSE', amount: 500000, title: 'เบิกงวดที่ 1',
    reserveTxnId: txn.r1, txnDate: '2026-06-01'
  }).txnId;
  newRequest();
  const s = ok('budget.detail', { budgetId: ids.A }).summary;
  eq(s.disbursed, 500000, 'เบิกแล้ว');
  eq(s.reservedOutstanding, 700000, 'จองคงค้างหลังตัดยอด');
  eq(s.committed, 1200000, 'ผูกพันรวม (ไม่นับซ้ำ)');
  eq(s.availableToSpend, 2800000, 'คงเหลือใช้ได้ไม่เปลี่ยน');
});
t('เบิกเกินยอดจองคงค้างถูกปฏิเสธ', () => {
  newRequest();
  mustFail('txn.create', { budgetId: ids.A, txnType: 'DISBURSE', amount: 900000, title: 'เบิกเกินจอง', reserveTxnId: txn.r1 }, 'เกินยอดจอง');
});
t('เบิกครบ → รายการจองเปลี่ยนสถานะเป็น SETTLED', () => {
  newRequest();
  ok('txn.create', { budgetId: ids.A, txnType: 'DISBURSE', amount: 700000, title: 'เบิกงวดสุดท้าย', reserveTxnId: txn.r1 });
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.A });
  const r1 = d.transactions.filter(x => x.txnId === txn.r1)[0];
  eq(r1.status, 'SETTLED', 'สถานะรายการจอง');
  eq(d.summary.disbursed, 1200000, 'เบิกแล้วรวม');
  eq(d.summary.reservedOutstanding, 0, 'จองคงค้าง');
  eq(d.summary.availableToSpend, 2800000, 'คงเหลือใช้ได้');
});
t('เบิกตรงเกินวงเงินคงเหลือถูกปฏิเสธ', () => {
  newRequest();
  const msg = mustFail('txn.create', { budgetId: ids.A, txnType: 'DISBURSE', amount: 3000000, title: 'เบิกเกินวงเงิน' }, 'เกินวงเงินที่ใช้ได้คงเหลือ');
  if (msg.indexOf('2,800,000.00') < 0) throw new Error('error ควรบอกยอดคงเหลือ: ' + msg);
});
t('ลดจำนวนที่ใช้ได้ต่ำกว่ายอดผูกพันถูกปฏิเสธ', () => {
  newRequest();
  mustFail('budget.setAmount', { budgetId: ids.A, changeType: 'USABLE_AMOUNT', newAmount: 500000, reason: 'ทดสอบลดต่ำกว่าผูกพัน' }, 'ต่ำกว่ายอดที่ผูกพันแล้ว');
});

console.log('\n═══ 5. แก้ไข / ยกเลิก + log ═══');
t('แก้ไขยอดเบิกต้องมีเหตุผล', () => {
  newRequest();
  mustFail('txn.update', { txnId: txn.d1, amount: 400000, reason: 'สั้น' }, 'เหตุผล');
});
t('แก้ไขยอดเบิก → คืนยอดให้รายการจองและกลับเป็น ACTIVE', () => {
  newRequest();
  ok('txn.update', { txnId: txn.d1, amount: 300000, reason: 'แก้ยอดตามใบเสร็จจริง', files: [file1] });
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.A });
  const r1 = d.transactions.filter(x => x.txnId === txn.r1)[0];
  eq(d.summary.disbursed, 1000000, 'เบิกแล้วรวมหลังแก้');
  eq(r1.settledAmount, 1000000, 'ยอดจองที่ถูกเบิก');
  eq(r1.status, 'ACTIVE', 'สถานะกลับเป็น ACTIVE');
  eq(d.summary.reservedOutstanding, 200000, 'จองคงค้าง');
});
t('audit log เก็บค่าก่อน–หลัง พร้อมไฟล์แนบ', () => {
  newRequest();
  const rows = ok('txn.history', { txnId: txn.d1 });
  const upd = rows.filter(r => r.action === 'TXN_UPDATE')[0];
  if (!upd) throw new Error('ไม่พบ log TXN_UPDATE');
  eq(upd.before.amount, 500000, 'ค่าก่อนแก้');
  eq(upd.after.amount, 300000, 'ค่าหลังแก้');
  eq(upd.reason, 'แก้ยอดตามใบเสร็จจริง', 'เหตุผล');
  eq(upd.attachments.length, 1, 'ไฟล์แนบใน log');
});
t('ยกเลิกรายการจองที่มีการเบิกแล้วถูกปฏิเสธ', () => {
  newRequest();
  mustFail('txn.cancel', { txnId: txn.r1, reason: 'ทดสอบยกเลิกจองที่เบิกแล้ว' }, 'มีการเบิกแล้ว');
});
t('ยกเลิกรายการเบิก → คืนวงเงินและคงข้อมูลไว้', () => {
  newRequest();
  ok('txn.cancel', { txnId: txn.d1, reason: 'บันทึกผิดงบประมาณ' });
  newRequest();
  const d = ok('budget.detail', { budgetId: ids.A });
  const dd = d.transactions.filter(x => x.txnId === txn.d1)[0];
  eq(dd.status, 'CANCELLED', 'สถานะ');
  eq(d.summary.disbursed, 700000, 'เบิกแล้วรวมหลังยกเลิก');
  eq(d.summary.reservedOutstanding, 500000, 'จองคงค้างหลังคืนยอด');
  eq(d.summary.committed, 1200000, 'ผูกพันรวม');
});

console.log('\n═══ 6. สิทธิ์ผู้ดูแล / ผู้ดู ═══');
t('ให้สิทธิ์ผู้ดู (VIEWER) กับงบ A', () => {
  newRequest('owner@example.com');
  ok('perm.grant', { budgetId: ids.A, email: 'Viewer@Example.com', role: 'VIEWER', note: 'ผู้ตรวจสอบภายใน' });
  newRequest();
  const perms = ok('perm.list', { budgetId: ids.A });
  const v = perms.filter(p => p.email === 'viewer@example.com')[0];
  eq(!!v, true, 'พบรายการสิทธิ์');
  eq(v.role, 'VIEWER', 'บทบาท');
});
t('ผู้ดูเห็นเฉพาะงบ A และห้ามแก้ไข', () => {
  newRequest('viewer@example.com');
  const b = ok('app.bootstrap');
  eq(b.budgets.length, 1, 'จำนวนงบที่เห็น');
  eq(b.budgets[0].code, 'A', 'รหัสงบ');
  eq(b.budgets[0].canManage, false, 'สิทธิ์แก้ไขงบ');
  eq(b.budgets[0].canManageTxn, false, 'สิทธิ์รายการ');
  eq(b.user.canViewOverview, false, 'ห้ามภาพรวม');
  newRequest('viewer@example.com');
  mustFail('txn.create', { budgetId: ids.A, txnType: 'RESERVE', amount: 100, title: 'ลองแอบบันทึก' }, 'ไม่มีสิทธิ์');
  newRequest('viewer@example.com');
  mustFail('budget.setAmount', { budgetId: ids.A, changeType: 'USABLE_AMOUNT', newAmount: 10, reason: 'ลองแอบแก้วงเงิน' }, 'ไม่มีสิทธิ์');
  newRequest('viewer@example.com');
  mustFail('budget.detail', { budgetId: ids.B }, 'ไม่มีสิทธิ์ดู');
  newRequest('viewer@example.com');
  mustFail('budget.create', { code: 'Z', name: 'ลองสร้างงบ', budgetAmount: 1, reason: 'ทดสอบสิทธิ์' }, 'ผู้ดูแลระบบ');
  newRequest('viewer@example.com');
  mustFail('audit.list', {}, 'ไม่มีสิทธิ์ดูประวัติ');
});
t('ผู้รับผิดชอบ (OWNER/ADMIN) ทำรายการได้เฉพาะงบของตน', () => {
  newRequest('owner@example.com');
  ok('perm.grant', { budgetId: ids.B, email: 'admin.b@example.com', role: 'OWNER', note: 'ผู้รับผิดชอบงบ B' });
  newRequest('admin.b@example.com');
  const r = ok('txn.create', { budgetId: ids.B, txnType: 'RESERVE', amount: 250000, title: 'จองงานบำรุงรักษา' });
  eq(r.txnNo, 'B-RSV-0001', 'เลขที่รายการงบ B');
  newRequest('admin.b@example.com');
  mustFail('txn.create', { budgetId: ids.A, txnType: 'RESERVE', amount: 100, title: 'ข้ามงบ' }, 'ไม่มีสิทธิ์');
  newRequest('admin.b@example.com');
  const b = ok('app.bootstrap');
  eq(b.budgets.length, 1, 'เห็นเฉพาะงบ B');
});
t('เพิกถอนสิทธิ์ → ผู้ดูไม่เห็นงบอีก', () => {
  newRequest('owner@example.com');
  const perms = ok('perm.list', { budgetId: ids.A });
  const pid = perms.filter(p => p.email === 'viewer@example.com')[0].permissionId;
  newRequest('owner@example.com');
  ok('perm.revoke', { permissionId: pid, reason: 'ย้ายหน่วยงาน' });
  newRequest('viewer@example.com');
  eq(ok('app.bootstrap').budgets.length, 0, 'จำนวนงบที่เห็นหลังเพิกถอน');
});
t('ผู้จัดการรายการเห็น audit ของงบตน / ผู้ดูห้ามดู', () => {
  newRequest('owner@example.com');
  ok('perm.grant', { budgetId: ids.C, email: 'txn.mgr@example.com', role: 'TXN_MANAGER' });
  ok('perm.grant', { budgetId: ids.C, email: 'viewer2@example.com', role: 'VIEWER' });
  newRequest('txn.mgr@example.com');
  const a = ok('audit.list', { limit: 500 });
  const leaked = a.rows.filter(r => r.budgetId && r.budgetId !== ids.C);
  eq(leaked.length, 0, 'จำนวน log ของงบอื่นที่รั่ว');
  newRequest('viewer2@example.com');
  mustFail('audit.list', {}, 'ไม่มีสิทธิ์ดูประวัติ');
});
t('ย้ายรายการทั้งชุดไปงบอื่น (ผู้ดูแลระบบ)', () => {
  newRequest('owner@example.com');
  const rsv = ok('txn.create', {
    budgetId: ids.A2, txnType: 'RESERVE', amount: 20000, title: 'จองเพื่อทดสอบย้าย'
  });
  ok('txn.create', {
    budgetId: ids.A2, txnType: 'DISBURSE', amount: 5000, title: 'เบิกบางส่วน', reserveTxnId: rsv.txnId
  });
  newRequest('owner@example.com');
  const moved = ok('txn.move', { txnId: rsv.txnId, toBudgetId: ids.B, reason: 'ย้ายไปงบ B เพื่อทดสอบ' });
  eq(moved.movedTxnIds.length, 2, 'ย้ายทั้งชุดจอง+เบิก');
  newRequest('owner@example.com');
  const dB = ok('budget.detail', { budgetId: ids.B });
  eq(dB.transactions.some(t => t.txnId === rsv.txnId), true, 'พบรายการจองในงบ B');
});

console.log('\n═══ 7. งบปิด และรายงานภาพรวม ═══');
t('ปิดงบ C → ห้ามบันทึกรายการ', () => {
  newRequest('owner@example.com');
  ok('budget.update', { budgetId: ids.C, status: 'CLOSED', reason: 'สิ้นสุดปีงบประมาณ',
    owners: ['owner@example.com'], txnManagers: ['txn.mgr@example.com'], viewers: ['viewer2@example.com'] });
  newRequest('owner@example.com');
  mustFail('txn.create', { budgetId: ids.C, txnType: 'RESERVE', amount: 1000, title: 'หลังปิดงบ' }, 'ปิดแล้ว');
});
t('report.overview รวมยอดทุกงบถูกต้อง', () => {
  newRequest('owner@example.com');
  const r = ok('report.overview');
  // A + A2 + B + C
  eq(r.total.budgetAmount, 5000000 + 100000 + 2500000 + 1200000, 'วงเงินรวม');
  eq(r.budgets.length, 4, 'จำนวนงบในภาพรวม');
});
t('ผู้บริหารเห็นภาพรวมทุกงบ อ่านอย่างเดียว', () => {
  newRequest('owner@example.com');
  ok('user.upsert', { email: 'exec@example.com', displayName: 'ผู้บริหาร', systemRole: 'EXECUTIVE' });
  newRequest('exec@example.com');
  const b = ok('app.bootstrap');
  eq(b.user.isExecutive, true, 'isExecutive');
  eq(b.user.canViewOverview, true, 'canViewOverview');
  eq(b.budgets.length, 4, 'เห็นทุกงบ');
  newRequest('exec@example.com');
  mustFail('txn.create', { budgetId: ids.A, txnType: 'RESERVE', amount: 100, title: 'ผู้บริหารลองแก้' }, 'ไม่มีสิทธิ์');
});
t('ผู้ใช้ที่ไม่มีสิทธิ์เข้าได้แต่ไม่เห็นข้อมูล', () => {
  newRequest('stranger@example.com');
  const b = ok('app.bootstrap');
  eq(b.budgets.length, 0, 'จำนวนงบ');
  eq(b.user.isSuperAdmin, false, 'isSuperAdmin');
});
t('ดาวน์โหลดไฟล์แนบต้องมีสิทธิ์ดูงบ', () => {
  newRequest('owner@example.com');
  const d = ok('budget.detail', { budgetId: ids.A });
  const att = d.changes[0].attachments[0] || d.transactions.map(t => t.attachments[0]).filter(Boolean)[0];
  if (!att) throw new Error('ไม่พบไฟล์แนบสำหรับทดสอบ');
  newRequest('owner@example.com');
  const f = ok('file.get', { attachmentId: att.attachmentId });
  eq(f.fileName, 'approval.pdf', 'ชื่อไฟล์');
  newRequest('stranger@example.com');
  mustFail('file.get', { attachmentId: att.attachmentId }, 'ไม่มีสิทธิ์');
});

console.log('\n═══ 8. ความถูกต้องของ audit log ═══');
t('ทุก action สำคัญถูกบันทึกลง AuditLog', () => {
  newRequest('owner@example.com');
  const rows = run('readTable_(SH.AUDIT)');
  const actions = {};
  rows.forEach(r => { actions[r.action] = (actions[r.action] || 0) + 1; });
  ['BUDGET_CREATE', 'AMOUNT_SET', 'TXN_CREATE', 'TXN_UPDATE', 'TXN_CANCEL', 'TXN_MOVE', 'PERM_GRANT', 'PERM_REVOKE', 'BUDGET_CLOSE']
    .forEach(a => { if (!actions[a]) throw new Error('ไม่พบ action ' + a + ' ใน AuditLog'); });
});
t('BudgetChanges เป็น append-only และผูกไฟล์แนบได้', () => {
  const rows = run('readTable_(SH.CHANGES)');
  eq(rows.length >= 7, true, 'จำนวน log การเปลี่ยนวงเงิน');
  eq(rows.some(r => String(r.attachment_ids).length > 0), true, 'มี log ที่แนบไฟล์');
});

console.log('\n───────────────────────────────');
console.log('ผลทดสอบ: ผ่าน ' + pass + ' / ล้มเหลว ' + fail);
process.exit(fail ? 1 : 0);

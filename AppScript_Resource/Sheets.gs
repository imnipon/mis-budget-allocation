/**
 * Sheets.gs
 * ชั้น Data Access (repository) สำหรับอ่าน/เขียน Google Sheets
 * ใช้ header row เป็นชื่อฟิลด์ เพื่อให้เพิ่มคอลัมน์ใหม่ได้โดยไม่ต้องแก้โค้ดทุกจุด
 */

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(CFG.PROP_SPREADSHEET_ID);
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('ยังไม่ได้ตั้งค่า SPREADSHEET_ID ใน Script Properties (เรียก setup() ก่อน)');
}

function getSheet_(name) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  const headers = HEADERS[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers) writeHeaders_(sh, headers);
    return sh;
  }
  if (headers && sh.getLastRow() === 0) writeHeaders_(sh, headers);
  return sh;
}

function writeHeaders_(sh, headers) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#1f2937')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

/**
 * แคชตารางต่อ 1 request (Apps Script สร้าง context ใหม่ทุกครั้งที่เรียก rpc)
 * ช่วยลดจำนวนครั้งที่อ่าน Sheet ซึ่งเป็นส่วนที่ช้าที่สุด
 */
var __tableCache = {};

function invalidateCache_(name) {
  if (name) delete __tableCache[name];
  else __tableCache = {};
}

/** อ่านทั้งตารางเป็น array ของ object (แนบ _row = เลขแถวจริงใน sheet) */
function readTable_(name) {
  if (__tableCache[name]) return __tableCache[name];
  const sh = getSheet_(name);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    __tableCache[name] = [];
    return __tableCache[name];
  }
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values.shift();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    if (raw.join('') === '') continue;
    const obj = { _row: i + 2 };
    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];
      if (h) obj[h] = raw[c];
    }
    out.push(obj);
  }
  __tableCache[name] = out;
  return out;
}

function findRow_(name, field, value) {
  const rows = readTable_(name);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][field]) === String(value)) return rows[i];
  }
  return null;
}

function insertRow_(name, obj) {
  const sh = getSheet_(name);
  const headers = HEADERS[name];
  const row = headers.map(function (h) {
    const v = obj[h];
    return (v === undefined || v === null) ? '' : v;
  });
  sh.appendRow(row);
  invalidateCache_(name);
  return obj;
}

function insertRows_(name, objs) {
  if (!objs || !objs.length) return 0;
  const sh = getSheet_(name);
  const headers = HEADERS[name];
  const rows = objs.map(function (obj) {
    return headers.map(function (h) {
      const v = obj[h];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  invalidateCache_(name);
  return rows.length;
}

/** อัปเดตบางฟิลด์ของแถวที่ระบุ */
function updateRow_(name, rowIndex, patch) {
  const sh = getSheet_(name);
  const headers = HEADERS[name];
  const range = sh.getRange(rowIndex, 1, 1, headers.length);
  const current = range.getValues()[0];
  headers.forEach(function (h, i) {
    if (Object.prototype.hasOwnProperty.call(patch, h)) {
      const v = patch[h];
      current[i] = (v === undefined || v === null) ? '' : v;
    }
  });
  range.setValues([current]);
  invalidateCache_(name);
}

/* ───────────────────────── utils ───────────────────────── */

function newId_(prefix) {
  const stamp = Utilities.formatDate(new Date(), CFG.TZ, 'yyMMddHHmmss');
  const rand = Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase();
  return prefix + '-' + stamp + '-' + rand;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), CFG.TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

function todayIso_() {
  return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
}

function num_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function str_(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function normEmail_(v) {
  return str_(v).toLowerCase();
}

/** แปลงค่าที่อ่านจาก sheet ให้ส่งผ่าน google.script.run ได้อย่างปลอดภัย */
function serialize_(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return Utilities.formatDate(value, CFG.TZ, "yyyy-MM-dd'T'HH:mm:ss");
  if (Array.isArray(value)) return value.map(serialize_);
  if (typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function (k) { out[k] = serialize_(value[k]); });
    return out;
  }
  return value;
}

/** แปลงวันที่จาก sheet (Date หรือ string) → 'yyyy-MM-dd' */
function dateOnly_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, CFG.TZ, 'yyyy-MM-dd');
  const s = str_(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : s;
}

/** ล็อกการเขียนเพื่อกันข้อมูลชนกันเมื่อมีผู้ใช้หลายคน */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('ระบบกำลังประมวลผลคำขออื่น กรุณาลองอีกครั้ง');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function idListToArray_(v) {
  return str_(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

/**
 * Schema.gs
 * ค่าคงที่ของระบบ + โครงสร้างตาราง (sheet schema) ทั้งหมด
 *
 * หลักการออกแบบ
 *  - ทุกตารางเป็น "append-only" สำหรับ log (BudgetChanges / AuditLog) แก้ไขไม่ได้จาก UI
 *  - ตารางข้อมูลหลัก (Budgets / Transactions / Permissions) แก้ไขได้ แต่ทุกครั้งต้องบันทึก AuditLog
 *  - ยอดเงินคงเหลือไม่เก็บซ้ำ แต่คำนวณสด (derived) จาก Transactions เพื่อไม่ให้ข้อมูลเพี้ยน
 *  - code (A–Z) = หมวด/ประเภท ซ้ำได้หลายโครงการ · budget_id = ตัวระบุโครงการจริง
 */

const CFG = {
  APP_NAME: 'ระบบบริหารงบประมาณ',
  APP_SHORT: 'Budget Allocation',
  VERSION: '2.1.2',
  TZ: 'Asia/Bangkok',

  PROP_SPREADSHEET_ID: 'SPREADSHEET_ID',
  PROP_FOLDER_ID: 'ATTACHMENT_FOLDER_ID',
  PROP_SUPER_ADMINS: 'SUPER_ADMINS',
  PROP_DEV_EMAIL: 'DEV_IMPERSONATE_EMAIL',

  /** ผู้ดูแลระบบคงที่ — รวมกับ Script Properties เสมอ (กันลืมรัน setup ซ้ำ) */
  DEFAULT_SUPER_ADMINS: [
    'nipon.w@ku.th',
    'kaitisak.t@ku.th',
    'chiraporn.r@ku.th'
  ],

  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  MAX_FILES_PER_ACTION: 5,
  AUDIT_PAGE_SIZE: 200
};

const SH = {
  CONFIG: 'Config',
  USERS: 'Users',
  BUDGETS: 'Budgets',
  BUDGET_TYPES: 'BudgetTypes',
  PERMISSIONS: 'Permissions',
  CHANGES: 'BudgetChanges',
  TXNS: 'Transactions',
  FILES: 'Attachments',
  AUDIT: 'AuditLog'
};

const HEADERS = {
  Config: ['key', 'value', 'note'],

  Users: [
    'user_id', 'email', 'display_name', 'system_role', 'status', 'note',
    'created_at', 'created_by', 'updated_at', 'updated_by'
  ],

  BudgetTypes: [
    'type_id', 'code', 'name', 'description', 'status',
    'created_at', 'created_by', 'updated_at', 'updated_by'
  ],

  Budgets: [
    'budget_id', 'code', 'name', 'fiscal_year', 'owner_email', 'description', 'currency',
    'budget_amount',
    'usable_amount',
    'status',
    'created_at', 'created_by', 'updated_at', 'updated_by'
  ],

  Permissions: [
    'permission_id', 'budget_id', 'email', 'role', 'status', 'note',
    'granted_by', 'granted_at', 'revoked_by', 'revoked_at'
  ],

  BudgetChanges: [
    'change_id', 'budget_id', 'change_type', 'old_amount', 'new_amount', 'delta',
    'effective_date', 'reason', 'ref_no', 'attachment_ids', 'created_at', 'created_by'
  ],

  Transactions: [
    'txn_id', 'budget_id', 'txn_type', 'txn_no', 'txn_date',
    'title', 'description', 'category', 'vendor',
    'amount',
    'settled_amount',
    'status',
    'reserve_txn_id',
    'attachment_ids',
    'created_at', 'created_by', 'updated_at', 'updated_by'
  ],

  Attachments: [
    'attachment_id', 'entity_type', 'entity_id', 'budget_id',
    'file_id', 'file_name', 'mime_type', 'size_bytes', 'drive_url',
    'uploaded_by', 'uploaded_at'
  ],

  AuditLog: [
    'log_id', 'timestamp', 'actor_email', 'action', 'entity_type', 'entity_id',
    'budget_id', 'summary', 'reason', 'before_json', 'after_json', 'attachment_ids'
  ]
};

/** สิทธิ์ระดับระบบ + รายงบ */
const ROLE = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  EXECUTIVE: 'EXECUTIVE',
  USER: 'USER',
  OWNER: 'OWNER',
  TXN_MANAGER: 'TXN_MANAGER',
  VIEWER: 'VIEWER',
  ADMIN: 'ADMIN', // legacy → ถือเป็น OWNER
  NONE: 'NONE'
};

/** อันดับสิทธิ์รายงบ (สำหรับเปรียบเทียบ) */
const ROLE_RANK = {
  NONE: 0,
  VIEWER: 1,
  TXN_MANAGER: 2,
  OWNER: 3,
  ADMIN: 3, // legacy
  SUPER_ADMIN: 4
};

const STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  REVOKED: 'REVOKED',
  NEW: 'NEW',
  PROCESS: 'PROCESS',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
  SETTLED: 'SETTLED'
};

const TXN_TYPE = {
  RESERVE: 'RESERVE',
  DISBURSE: 'DISBURSE'
};

const CHANGE_TYPE = {
  BUDGET_AMOUNT: 'BUDGET_AMOUNT',
  USABLE_AMOUNT: 'USABLE_AMOUNT'
};

const ENTITY = {
  BUDGET: 'BUDGET',
  BUDGET_TYPE: 'BUDGET_TYPE',
  TRANSACTION: 'TRANSACTION',
  PERMISSION: 'PERMISSION',
  USER: 'USER',
  CHANGE: 'CHANGE'
};

const ACTION = {
  BUDGET_CREATE: 'BUDGET_CREATE',
  BUDGET_UPDATE: 'BUDGET_UPDATE',
  BUDGET_CLOSE: 'BUDGET_CLOSE',
  TYPE_UPSERT: 'TYPE_UPSERT',
  AMOUNT_SET: 'AMOUNT_SET',
  TXN_CREATE: 'TXN_CREATE',
  TXN_UPDATE: 'TXN_UPDATE',
  TXN_CANCEL: 'TXN_CANCEL',
  TXN_MOVE: 'TXN_MOVE',
  PERM_GRANT: 'PERM_GRANT',
  PERM_UPDATE: 'PERM_UPDATE',
  PERM_REVOKE: 'PERM_REVOKE',
  USER_UPSERT: 'USER_UPSERT',
  LOGIN: 'LOGIN'
};

const LABELS = {
  role: {
    SUPER_ADMIN: 'ผู้ดูแลระบบ',
    EXECUTIVE: 'ผู้บริหาร',
    USER: 'ผู้ใช้งาน',
    OWNER: 'ผู้รับผิดชอบ',
    TXN_MANAGER: 'ผู้จัดการรายการ',
    VIEWER: 'ผู้ดู',
    ADMIN: 'ผู้รับผิดชอบ',
    NONE: 'ไม่มีสิทธิ์'
  },
  txnType: { RESERVE: 'การจอง', DISBURSE: 'เบิกใช้แล้ว' },
  txnStatus: { ACTIVE: 'ใช้งาน', SETTLED: 'เบิกครบแล้ว', CANCELLED: 'ยกเลิก' },
  changeType: { BUDGET_AMOUNT: 'ปรับวงเงินงบประมาณ', USABLE_AMOUNT: 'ปรับจำนวนที่ใช้ได้' },
  budgetStatus: { NEW: 'New', PROCESS: 'Process', CLOSED: 'Close', ACTIVE: 'Process' },
  action: {
    BUDGET_CREATE: 'สร้างงบประมาณ',
    BUDGET_UPDATE: 'แก้ไขข้อมูลงบประมาณ',
    BUDGET_CLOSE: 'ปิด/เปิดงบประมาณ',
    TYPE_UPSERT: 'จัดการประเภทงบ',
    AMOUNT_SET: 'กำหนดจำนวนเงิน',
    TXN_CREATE: 'เพิ่มรายการใช้งบ',
    TXN_UPDATE: 'แก้ไขรายการใช้งบ',
    TXN_CANCEL: 'ยกเลิกรายการใช้งบ',
    TXN_MOVE: 'ย้ายรายการใช้งบ',
    PERM_GRANT: 'ให้สิทธิ์',
    PERM_UPDATE: 'แก้ไขสิทธิ์',
    PERM_REVOKE: 'เพิกถอนสิทธิ์',
    USER_UPSERT: 'จัดการผู้ใช้',
    LOGIN: 'เข้าใช้งาน'
  }
};

/** ปรับสถานะงบเก่า ACTIVE → PROCESS */
function normalizeBudgetStatus_(s) {
  const v = str_(s);
  if (v === STATUS.ACTIVE || !v) return STATUS.PROCESS;
  if (v === STATUS.NEW || v === STATUS.PROCESS || v === STATUS.CLOSED) return v;
  return STATUS.PROCESS;
}

/** ปรับ role รายงบเก่า ADMIN → OWNER */
function normalizeBudgetRole_(role) {
  const v = str_(role);
  if (v === ROLE.ADMIN) return ROLE.OWNER;
  return v;
}

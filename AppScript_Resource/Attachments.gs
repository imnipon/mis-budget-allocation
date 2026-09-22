/**
 * Attachments.gs
 * อัปโหลดไฟล์แนบเข้า Google Drive (แยกโฟลเดอร์ตามงบประมาณ) และผูกกับ entity ที่เกี่ยวข้อง
 *
 * ความปลอดภัย: ไฟล์ไม่ได้แชร์ public — การดาวน์โหลดทำผ่านฟังก์ชัน getAttachmentData_()
 * ซึ่งจะเช็คสิทธิ์งบประมาณของผู้ใช้ก่อนส่ง base64 กลับไปให้เบราว์เซอร์
 */

function getBudgetFolder_(budget) {
  const root = ensureRootFolder_();
  const name = str_(budget.code) + ' – ' + str_(budget.name);
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

/**
 * files: [{ name, mimeType, dataBase64 }]
 * คืน array ของ attachment_id
 */
function saveAttachments_(user, budget, entityType, entityId, files) {
  if (!files || !files.length) return [];
  if (files.length > CFG.MAX_FILES_PER_ACTION) {
    throw new Error('แนบไฟล์ได้ไม่เกิน ' + CFG.MAX_FILES_PER_ACTION + ' ไฟล์ต่อครั้ง');
  }
  const folder = getBudgetFolder_(budget);
  const ids = [];
  const rows = [];

  files.forEach(function (f) {
    const name = str_(f.name) || 'attachment';
    const b64 = str_(f.dataBase64);
    if (!b64) return;
    const bytes = Utilities.base64Decode(b64);
    if (bytes.length > CFG.MAX_UPLOAD_BYTES) {
      throw new Error('ไฟล์ "' + name + '" ใหญ่เกิน ' + Math.round(CFG.MAX_UPLOAD_BYTES / 1048576) + ' MB');
    }
    const blob = Utilities.newBlob(bytes, str_(f.mimeType) || 'application/octet-stream', name);
    const stamped = Utilities.formatDate(new Date(), CFG.TZ, 'yyyyMMdd-HHmmss') + '_' + name;
    const file = folder.createFile(blob.setName(stamped));
    const id = newId_('ATT');
    ids.push(id);
    rows.push({
      attachment_id: id,
      entity_type: entityType,
      entity_id: str_(entityId),
      budget_id: str_(budget.budget_id),
      file_id: file.getId(),
      file_name: name,
      mime_type: file.getMimeType(),
      size_bytes: file.getSize(),
      drive_url: file.getUrl(),
      uploaded_by: user.email,
      uploaded_at: nowIso_()
    });
  });

  insertRows_(SH.FILES, rows);
  __attIndex = null;
  return ids;
}

/** index: attachment_id → dto (สร้างครั้งเดียวต่อ request) */
var __attIndex = null;

function attachmentIndex_() {
  if (__attIndex) return __attIndex;
  __attIndex = {};
  readTable_(SH.FILES).forEach(function (r) {
    __attIndex[str_(r.attachment_id)] = toAttachmentDto_(r);
  });
  return __attIndex;
}

function attachmentsByIds_(ids) {
  if (!ids || !ids.length) return [];
  const idx = attachmentIndex_();
  return ids.map(function (i) { return idx[str_(i)]; }).filter(Boolean);
}

function attachmentsForEntity_(entityType, entityId) {
  return readTable_(SH.FILES)
    .filter(function (r) { return str_(r.entity_type) === entityType && str_(r.entity_id) === str_(entityId); })
    .map(toAttachmentDto_);
}

function toAttachmentDto_(r) {
  return {
    attachmentId: str_(r.attachment_id),
    fileName: str_(r.file_name),
    mimeType: str_(r.mime_type),
    sizeBytes: num_(r.size_bytes),
    driveUrl: str_(r.drive_url),
    uploadedBy: str_(r.uploaded_by),
    uploadedAt: serialize_(r.uploaded_at),
    entityType: str_(r.entity_type),
    entityId: str_(r.entity_id),
    budgetId: str_(r.budget_id)
  };
}

/** ดาวน์โหลดไฟล์แนบ (เช็คสิทธิ์ก่อน) → ส่ง base64 ให้ client สร้าง blob download */
function getAttachmentData_(user, attachmentId) {
  const r = findRow_(SH.FILES, 'attachment_id', str_(attachmentId));
  if (!r) throw new Error('ไม่พบไฟล์แนบ');
  const bid = str_(r.budget_id);
  if (bid) requireView_(user, bid);
  else if (normEmail_(r.uploaded_by) !== user.email && !user.isSuperAdmin) {
    throw new Error('คุณไม่มีสิทธิ์เข้าถึงไฟล์นี้');
  }
  const file = DriveApp.getFileById(str_(r.file_id));
  return {
    fileName: str_(r.file_name),
    mimeType: file.getMimeType(),
    dataBase64: Utilities.base64Encode(file.getBlob().getBytes())
  };
}

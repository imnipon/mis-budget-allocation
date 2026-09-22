/**
 * Code.gs
 * จุดเข้าใช้งานเว็บแอป (HtmlService) + ตัวช่วย include ไฟล์ HTML ย่อย
 */

function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'app';
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.initialPage = page;
  tpl.appName = CFG.APP_NAME;
  tpl.version = CFG.VERSION;
  return tpl.evaluate()
    .setTitle(CFG.APP_NAME)
    .setFaviconUrl('https://ssl.gstatic.com/docs/spreadsheets/forms/favicon_jfk2.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** เปิดเว็บแอปใน sidebar ของ Google Sheets */
function openSidebar() {
  const html = HtmlService.createTemplateFromFile('Index');
  html.initialPage = 'app';
  html.appName = CFG.APP_NAME;
  html.version = CFG.VERSION;
  SpreadsheetApp.getUi().showSidebar(html.evaluate().setTitle(CFG.APP_NAME));
}

// ============================================================
//  RT経費精算 — Google Apps Script バックエンド v2
//  スプレッドシートID: 1r7LYfEaxanCcEPIMYzxnaGIu7iT4dJeXXKd1XnYmkUo
//
//  【デプロイ手順】
//  1. Apps Script エディタで「デプロイ」→「新しいデプロイ」（または既存を更新）
//  2. 種類: ウェブアプリ
//  3. 次のユーザーとして実行: 自分
//  4. アクセスできるユーザー: 全員
//  5. デプロイ後に表示される URL をアプリの設定画面に貼り付ける
//
//  【GET エンドポイント】
//  ?action=listYears              → 年シート名一覧
//  ?action=getData&year=2026      → 指定年の全取引
//  ?action=getSettings            → 設定CSV文字列
//  ?action=getDeleted             → 削除済みID一覧
//
//  【POST エンドポイント（ボディはJSON文字列）】
//  { action:"saveData",     year, rows, lastModified } → 指定年データ全上書き
//  { action:"saveSettings", content }                  → 設定CSV保存
//  { action:"saveDeleted",  ids }                      → 削除済みID保存
// ============================================================

const SPREADSHEET_ID  = '1r7LYfEaxanCcEPIMYzxnaGIu7iT4dJeXXKd1XnYmkUo';
const TX_HEADERS      = ['id', 'type', 'payer', 'amount', 'category', 'note', 'date', 'transferTo', 'beneficiary'];
const SETTINGS_SHEET  = 'settings';
const DELETED_SHEET   = 'deleted';

const lastWriteKey = year => `lastWrite_${year}`;

// ============================================================
//  GET
// ============================================================
function doGet(e) {
  try {
    const action = (e.parameter && e.parameter.action) ? e.parameter.action : 'getData';
    switch (action) {
      case 'listYears':   return handleListYears();
      case 'getData':     return handleGetData(e.parameter.year);
      case 'getSettings': return handleGetSettings();
      case 'getDeleted':  return handleGetDeleted();
      default:            return jsonError('不明なアクション: ' + action);
    }
  } catch (err) {
    return jsonError(err.message);
  }
}

// ============================================================
//  POST
// ============================================================
function doPost(e) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); }
  catch (_) { return jsonError('サーバーがビジーです。しばらくしてから再試行してください。'); }

  try {
    let body;
    try { body = JSON.parse(e.postData.contents); }
    catch (_) { return jsonError('リクエストボディが不正な JSON です'); }

    switch (body.action) {
      case 'saveData':     return handleSaveData(body);
      case 'saveSettings': return handleSaveSettings(body);
      case 'saveDeleted':  return handleSaveDeleted(body);
      default:             return jsonError('不明なアクション: ' + body.action);
    }
  } catch (err) {
    return jsonError(err.message);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  GET ハンドラ
// ============================================================

// 数字4桁のシート名（年）一覧を返す
function handleListYears() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const years = ss.getSheets()
    .map(s => s.getName())
    .filter(n => /^\d{4}$/.test(n))
    .sort((a, b) => b.localeCompare(a)); // 新しい年が先
  return jsonOk({ years });
}

// 指定年の全取引行を返す
function handleGetData(year) {
  if (!year) return jsonError('year パラメータが必要です');
  const sheet        = getOrCreateYearSheet(year);
  const rows         = sheetToObjects(sheet);
  const props        = PropertiesService.getScriptProperties();
  const lastModified = parseInt(props.getProperty(lastWriteKey(year)) || '0', 10);
  return jsonOk({ rows, lastModified });
}

// 設定CSV文字列を返す
function handleGetSettings() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet || sheet.getLastRow() === 0) return jsonOk({ content: null });
  const content = sheet.getRange(1, 1).getValue();
  return jsonOk({ content: content || null });
}

// 削除済みIDリストを返す
function handleGetDeleted() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(DELETED_SHEET);
  if (!sheet || sheet.getLastRow() === 0) return jsonOk({ ids: [] });
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  const ids    = values.map(r => String(r[0])).filter(Boolean);
  return jsonOk({ ids });
}

// ============================================================
//  POST ハンドラ
// ============================================================

// 指定年の全データを上書き保存（競合チェック付き）
function handleSaveData(body) {
  const { year, rows, lastModified } = body;
  if (!year) return jsonError('year が必要です');

  // 競合チェック：クライアントの lastModified より新しい書き込みが直近10秒以内にある場合
  const props           = PropertiesService.getScriptProperties();
  const serverLastWrite = parseInt(props.getProperty(lastWriteKey(year)) || '0', 10);
  const now             = Date.now();
  const clientTs        = (lastModified !== undefined && lastModified !== null)
    ? parseInt(lastModified, 10) : 0;

  if (serverLastWrite > clientTs && now - serverLastWrite < 10000) {
    return jsonConflict(serverLastWrite);
  }

  const sheet = getOrCreateYearSheet(year);

  // ヘッダー行(1行目)を残して全データ行を削除し、新しいデータを書き込む
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  if (rows && rows.length > 0) {
    const values = rows.map(row =>
      TX_HEADERS.map(h => {
        const v = row[h];
        return (v !== undefined && v !== null) ? v : '';
      })
    );
    sheet.getRange(2, 1, values.length, TX_HEADERS.length).setValues(values);
  }

  props.setProperty(lastWriteKey(year), String(now));
  return jsonOk({ success: true, lastModified: now });
}

// 設定CSVを保存
function handleSaveSettings(body) {
  const { content } = body;
  if (content === undefined) return jsonError('content が必要です');
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
  } else {
    sheet.clearContents();
  }
  sheet.getRange(1, 1).setValue(content);
  return jsonOk({ success: true });
}

// 削除済みIDリストを保存
function handleSaveDeleted(body) {
  const { ids } = body;
  if (!Array.isArray(ids)) return jsonError('ids が必要です');
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(DELETED_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(DELETED_SHEET);
  } else {
    sheet.clearContents();
  }
  if (ids.length > 0) {
    const values = ids.map(id => [String(id)]);
    sheet.getRange(1, 1, values.length, 1).setValues(values);
  }
  return jsonOk({ success: true });
}

// ============================================================
//  ユーティリティ
// ============================================================

function getOrCreateYearSheet(year) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(String(year));
  if (!sheet) {
    sheet = ss.insertSheet(String(year));
    sheet.appendRow(TX_HEADERS);
    const headerRange = sheet.getRange(1, 1, 1, TX_HEADERS.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#e8eaf6');
  }
  return sheet;
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0].map(String);
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonConflict(serverLastWrite) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: 'conflict', serverLastWrite }))
    .setMimeType(ContentService.MimeType.JSON);
}

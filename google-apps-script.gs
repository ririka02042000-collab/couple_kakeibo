// ============================================================
//  RT経費精算 — Google Apps Script バックエンド v3
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
//  ?action=getSettings            → 設定オブジェクト { gfName, bfName, ratioHistory }
//
//  【POST エンドポイント（ボディはJSON文字列）】
//  { action:"saveData",     year, rows, lastModified } → 指定年データ全上書き
//  { action:"deleteRow",    year, id }                 → 指定IDの行を直接削除
//  { action:"saveSettings", gfName, bfName, ratioHistory } → 設定保存（キー・値形式）
// ============================================================

const SPREADSHEET_ID  = '1r7LYfEaxanCcEPIMYzxnaGIu7iT4dJeXXKd1XnYmkUo';
const TX_HEADERS      = ['id', 'type', 'payer', 'amount', 'category', 'note', 'date', 'transferTo', 'beneficiary'];
const SETTINGS_SHEET  = 'settings';

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
      case 'deleteRow':    return handleDeleteRow(body);
      case 'saveSettings': return handleSaveSettings(body);
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
    .sort((a, b) => b.localeCompare(a));
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

// 設定をキー・値オブジェクトとして返す
// シート構造: A列=キー名、B列=値（ratioHistory は JSON 文字列）
function handleGetSettings() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet || sheet.getLastRow() === 0) return jsonOk({ settings: null });

  const values = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  const obj    = {};
  values.forEach(([key, val]) => {
    if (!key) return;
    const k = String(key);
    const v = String(val);
    if (k === 'ratioHistory') {
      try { obj[k] = JSON.parse(v); } catch(_) { obj[k] = []; }
    } else {
      obj[k] = v;
    }
  });
  return jsonOk({ settings: obj });
}

// ============================================================
//  POST ハンドラ
// ============================================================

// 指定年の全データを上書き保存（競合チェック付き）
function handleSaveData(body) {
  const { year, rows, lastModified } = body;
  if (!year) return jsonError('year が必要です');

  const props           = PropertiesService.getScriptProperties();
  const serverLastWrite = parseInt(props.getProperty(lastWriteKey(year)) || '0', 10);
  const now             = Date.now();
  const clientTs        = (lastModified !== undefined && lastModified !== null)
    ? parseInt(lastModified, 10) : 0;

  if (serverLastWrite > clientTs && now - serverLastWrite < 10000) {
    return jsonConflict(serverLastWrite);
  }

  const sheet   = getOrCreateYearSheet(year);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  if (rows && rows.length > 0) {
    const values = rows.map(row =>
      TX_HEADERS.map(h => {
        const v = row[h];
        return (v !== undefined && v !== null) ? v : '';
      })
    );
    const dataRange = sheet.getRange(2, 1, values.length, TX_HEADERS.length);
    // date列（7列目）をテキスト形式に固定してから書き込む（Sheetsの日付自動変換を防ぐ）
    const dateColIndex = TX_HEADERS.indexOf('date') + 1;
    sheet.getRange(2, dateColIndex, values.length, 1).setNumberFormat('@');
    dataRange.setValues(values);
  }

  props.setProperty(lastWriteKey(year), String(now));
  return jsonOk({ success: true, lastModified: now });
}

// 指定IDの行を年シートから直接削除する
function handleDeleteRow(body) {
  const { year, id } = body;
  if (!year || id === undefined) return jsonError('year と id が必要です');

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(String(year));
  if (!sheet) return jsonOk({ success: true }); // シートがなければ削除済み扱い

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1); // シートの行番号は1始まり
      return jsonOk({ success: true });
    }
  }
  return jsonOk({ success: true }); // 見つからない = 削除済み
}

// 設定をキー・値形式でシートに保存する
// 受け取るフィールド: gfName, bfName, ratioHistory (配列)
function handleSaveSettings(body) {
  const { gfName, bfName, ratioHistory } = body;
  if (gfName === undefined && bfName === undefined && ratioHistory === undefined) {
    return jsonError('設定フィールドが必要です');
  }

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(SETTINGS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET);
  } else {
    sheet.clearContents();
  }

  const rows = [];
  if (gfName       !== undefined) rows.push(['gfName',       String(gfName)]);
  if (bfName       !== undefined) rows.push(['bfName',       String(bfName)]);
  if (ratioHistory !== undefined) rows.push(['ratioHistory', JSON.stringify(ratioHistory)]);

  if (rows.length > 0) {
    sheet.getRange(1, 1, rows.length, 2).setValues(rows);
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
    headers.forEach((h, i) => {
      const v = row[i];
      // スプレッドシートが日付型に変換したセルを YYYY-MM-DD 文字列に戻す
      obj[h] = v instanceof Date
        ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : v;
    });
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

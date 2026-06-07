// ============================================================
//  RT経費精算 — Google Apps Script バックエンド
//  スプレッドシートID: 1r7LYfEaxanCcEPIMYzxnaGIu7iT4dJeXXKd1XnYmkUo
//
//  【デプロイ手順】
//  1. Apps Script エディタで「デプロイ」→「新しいデプロイ」
//  2. 種類: ウェブアプリ
//  3. 次のユーザーとして実行: 自分
//  4. アクセスできるユーザー: 全員
//  5. デプロイ後に表示される URL をアプリの設定画面に貼り付ける
// ============================================================

const SPREADSHEET_ID = '1r7LYfEaxanCcEPIMYzxnaGIu7iT4dJeXXKd1XnYmkUo';

// 取引シートのヘッダー（app.js の CSV と同じ列順）
const TX_HEADERS = ['id', 'type', 'payer', 'amount', 'category', 'note', 'date', 'transferTo', 'beneficiary'];

// PropertiesService のキー（年ごとの最終書き込みタイムスタンプ）
const lastWriteKey = year => `lastWrite_${year}`;

// ============================================================
//  GET /?year=2026
//  指定年シートの全取引を JSON で返す
// ============================================================
function doGet(e) {
  try {
    const year = (e.parameter && e.parameter.year) ? e.parameter.year.trim() : null;
    if (!year) return jsonError('year パラメータが必要です');

    const sheet = getOrCreateSheet(year);
    const rows  = sheetToObjects(sheet);

    return jsonOk({ rows });

  } catch (err) {
    return jsonError(err.message);
  }
}

// ============================================================
//  POST — リクエストボディ（JSON 文字列）
//  {
//    year:         "2026",            // 追加先の年
//    row:          { id, type, ... }, // 取引データ
//    lastModified: 1700000000000      // クライアントが最後に書き込んだタイムスタンプ（ms）
//  }
//  成功時: { success: true, lastModified: <新タイムスタンプ> }
//  競合時: { error: "conflict", serverLastWrite: <タイムスタンプ> }
// ============================================================
function doPost(e) {
  // ── スクリプトロック取得（最大10秒待機）──────────────────
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (_) {
    return jsonError('サーバーがビジーです。しばらくしてから再試行してください。');
  }

  try {
    // ── リクエストボディのパース ──────────────────────────
    let body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (_) {
      return jsonError('リクエストボディが不正な JSON です');
    }

    const { year, row, lastModified } = body;
    if (!year)      return jsonError('year が必要です');
    if (!row)       return jsonError('row が必要です');

    // ── 競合チェック ──────────────────────────────────────
    // PropertiesService から最終書き込みタイムスタンプを取得
    const props          = PropertiesService.getScriptProperties();
    const serverLastWrite = parseInt(props.getProperty(lastWriteKey(year)) || '0', 10);
    const now             = Date.now();

    // 「クライアントの lastModified よりも新しい書き込みが直近10秒以内に存在する」
    // → 別端末が先に書き込んでいる可能性があるため競合エラーを返す
    const clientTs = (lastModified !== undefined && lastModified !== null)
      ? parseInt(lastModified, 10)
      : 0;

    if (serverLastWrite > clientTs && now - serverLastWrite < 10000) {
      return jsonConflict(serverLastWrite);
    }

    // ── シートへの書き込み ────────────────────────────────
    const sheet  = getOrCreateSheet(year);
    const newRow = TX_HEADERS.map(h => {
      const v = row[h];
      return (v !== undefined && v !== null) ? v : '';
    });
    sheet.appendRow(newRow);

    // 最終書き込みタイムスタンプを更新
    props.setProperty(lastWriteKey(year), String(now));

    return jsonOk({ success: true, lastModified: now });

  } catch (err) {
    return jsonError(err.message);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  内部ユーティリティ
// ============================================================

/**
 * 指定年のシートを返す。存在しない場合は新規作成してヘッダーを挿入する。
 */
function getOrCreateSheet(year) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(String(year));

  if (!sheet) {
    sheet = ss.insertSheet(String(year));
    sheet.appendRow(TX_HEADERS);

    // ヘッダー行を太字・背景色で見やすくする
    const headerRange = sheet.getRange(1, 1, 1, TX_HEADERS.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#e8eaf6');
  }

  return sheet;
}

/**
 * シートの全データを {ヘッダー名: 値} のオブジェクト配列に変換する。
 * ヘッダー行（1行目）は除外する。
 */
function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return []; // ヘッダーのみ or 空

  const headers = data[0].map(String);
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * 成功レスポンス（JSON）
 */
function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * エラーレスポンス（JSON）
 */
function jsonError(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 競合エラーレスポンス（JSON）
 */
function jsonConflict(serverLastWrite) {
  return ContentService
    .createTextOutput(JSON.stringify({
      error:           'conflict',
      serverLastWrite: serverLastWrite,
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

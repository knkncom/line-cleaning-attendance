/**
 * ==============================================================================
 * LINE朝清掃 出欠自動集計システム - 既存スプレッドシート完全対応 GAS スクリプト
 * 
 * 【既存スプレッドシートの構造】
 * - 入力シート（マトリクス型）:
 *     1行目: [空, 空, 西村, 乾, 銭花, 光本, 吉田, 菱沼, ...]
 *     A列: 日付 (9/29, 10/1, 10/28...)
 *     B列: 曜日 (月, 火, 水, 木, 金...)
 *     C列〜: 各社員の出欠記号 (◯, ✕, 出張, 遅刻)
 * - 集計シート: 「掃除出欠 集計ダッシュボード」（シート1の記号と連動）
 * 
 * 【自動化・手動ゼロ機能】
 * 1. 日付の自動追加:
 *    - 申告された日付がA列に存在しない場合、自動で行を追加し、日付(M/D)と曜日を自動計算・入力します。
 * 2. 社員の自動判定:
 *    - LINEの表示名やUser IDから該当社員列（西村、乾...）を自動特定。
 *    - 「LINE紐付け」シートでニックネームと社員名の紐付けも可能。
 * 3. 記号の自動記入 & メモ付与:
 *    - 出席予定 → 「◯」
 *    - 欠席 → 「✕」
 *    - 出張 → 「出張」
 *    - 遅刻 → 「遅刻」
 *    - セルのメモに「投稿日時」と「申告本文」を自動付与（マウスホバーで確認可能）。
 * 4. 監査ログ自動保存:
 *    - 「取込ログ」タブに更新履歴を自動保存。
 * ==============================================================================
 */

/**
 * HTTP POST リクエストの受信ハンドラー (Cloudflare Workerから呼び出し)
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, message: 'Empty body' }, 400);
    }

    const payload = JSON.parse(e.postData.contents);

    // 1. APIシークレットの検証
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (expectedSecret && expectedSecret.trim() !== '') {
      const providedSecret = payload.apiKey;
      if (providedSecret !== expectedSecret) {
        return jsonResponse({ success: false, message: 'Unauthorized: Invalid API secret' }, 401);
      }
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 2. 出欠入力シートの検出（1行目に社員名が並んでいるシートを自動探索）
    const mainSheet = findAttendanceMatrixSheet(ss);
    if (!mainSheet) {
      return jsonResponse({ success: false, message: '出欠入力シートが見つかりませんでした' }, 500);
    }

    // 3. 社員名・LINE紐付けシートの準備
    const mappingSheet = getOrCreateMappingSheet(ss, mainSheet);

    // 4. 投稿者（LINE表示名 / User ID）からスプレッドシート上の社員名（苗字）を解決
    const employeeName = resolveEmployee(
      mappingSheet,
      mainSheet,
      payload.userId,
      payload.displayName
    );

    if (!employeeName) {
      logImport(ss, payload, '未対応メンバー', '社員名を特定できませんでした');
      return jsonResponse({
        success: false,
        message: `社員名を特定できませんでした (表示名: ${payload.displayName}, userId: ${payload.userId})`
      }, 422);
    }

    // 5. 対象日（YYYY-MM-DD）の行を特定（存在しなければ自動追加！）
    const targetDateObj = parseDateString(payload.targetDate);
    const rowIndex = findOrAppendDateRow(mainSheet, targetDateObj);

    // 6. 社員名に該当する列番号を特定
    const colIndex = findEmployeeColumn(mainSheet, employeeName);
    if (colIndex === -1) {
      logImport(ss, payload, employeeName, `社員列「${employeeName}」が見つかりません`);
      return jsonResponse({ success: false, message: `社員列「${employeeName}」が見つかりません` }, 422);
    }

    // 7. 出欠ステータスを記号に変換
    const symbol = convertStatusToSymbol(payload.status, payload.rawText);

    // 8. セルに記号とメモ（申告内容・日時）を書き込み
    const cell = mainSheet.getRange(rowIndex, colIndex);
    const previousValue = cell.getValue();
    cell.setValue(symbol);
    
    // セルの配置（中央揃え）
    cell.setHorizontalAlignment('center');

    // マウスホバーで確認できるメモを付与
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
    cell.setNote(`【自動取込】${nowStr}\n申告者: ${payload.displayName}\n本文: ${payload.rawText}`);

    // 9. 監査ログに追記
    logImport(ss, payload, employeeName, `行${rowIndex} 列${colIndex} を「${previousValue}」から「${symbol}」へ更新`);

    return jsonResponse({
      success: true,
      action: previousValue ? 'updated' : 'inserted',
      employeeName: employeeName,
      targetDate: payload.targetDate,
      symbol: symbol,
      row: rowIndex,
      col: colIndex
    });

  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * 1行目に社員名が並んでいるメインの出欠表シートを自動探索
 */
function findAttendanceMatrixSheet(ss) {
  const sheets = ss.getSheets();
  for (const sheet of sheets) {
    const sheetName = sheet.getName();
    if (sheetName.includes('集計') || sheetName.includes('ダッシュボード') || sheetName.includes('ログ') || sheetName.includes('紐付け')) {
      continue;
    }
    const firstRow = sheet.getRange(1, 1, 1, Math.min(sheet.getLastColumn(), 20)).getValues()[0];
    // 3列目以降に文字列（社員名）があるかチェック
    if (firstRow.length >= 3 && firstRow[2] && String(firstRow[2]).trim() !== '') {
      return sheet;
    }
  }
  // 見つからなければ1番目のシートを返す
  return sheets[0];
}

/**
 * 日付文字列 (YYYY-MM-DD) を JST の Date オブジェクトに変換
 */
function parseDateString(dateStr) {
  if (!dateStr) return new Date();
  const parts = dateStr.split('-');
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

/**
 * 対象日の行を検索。見つからなければ「日付を自動追加」して行番号を返す
 */
function findOrAppendDateRow(sheet, targetDate) {
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const targetMonth = targetDate.getMonth() + 1;
  const targetDay = targetDate.getDate();
  const targetFormatted = `${targetMonth}/${targetDay}`; // 例: "10/28"

  const dateValues = sheet.getRange(1, 1, lastRow, 1).getValues();

  for (let i = 1; i < dateValues.length; i++) {
    const val = dateValues[i][0];
    if (!val) continue;

    // Date型の場合
    if (val instanceof Date) {
      if (val.getMonth() + 1 === targetMonth && val.getDate() === targetDay) {
        return i + 1; // 1-indexed
      }
    }

    // 文字列 "10/28" などの場合
    const strVal = String(val).trim();
    if (strVal === targetFormatted || strVal.endsWith(`/${targetDay}`)) {
      return i + 1;
    }
  }

  // --- 見つからない場合は自動追加（手作業ゼロ） ---
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const dayOfWeek = dayNames[targetDate.getDay()];
  const newRowIndex = lastRow + 1;

  // A列: "M/D", B列: "曜日"
  sheet.getRange(newRowIndex, 1).setValue(targetFormatted).setHorizontalAlignment('center');
  sheet.getRange(newRowIndex, 2).setValue(dayOfWeek).setHorizontalAlignment('center');

  return newRowIndex;
}

/**
 * 社員名に該当する列番号 (1-indexed) を検索
 */
function findEmployeeColumn(sheet, employeeName) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return -1;
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  for (let col = 0; col < header.length; col++) {
    const name = String(header[col]).trim();
    if (name === employeeName || (employeeName.length >= 2 && name.includes(employeeName))) {
      return col + 1; // 1-indexed
    }
  }
  return -1;
}

/**
 * 出欠状態をスプレッドシートの記号に変換
 */
function convertStatusToSymbol(status, rawText) {
  const text = rawText || '';
  if (text.includes('出張')) {
    return '出張';
  }
  switch (status) {
    case '出席予定':
      return '◯';
    case '欠席':
      return '✕';
    case '遅刻':
      return '遅刻';
    case '要確認':
      return '要確認';
    default:
      return '◯';
  }
}

/**
 * LINE紐付けシートを取得（なければ自動作成し、表の社員名を初期投入）
 */
function getOrCreateMappingSheet(ss, mainSheet) {
  const SHEET_NAME = 'LINE紐付け';
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['社員名(表のヘッダー)', 'LINE表示名(ニックネーム)', 'LINEユーザーID', '備考']);
    sheet.getRange('A1:D1').setBackground('#0b5394').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);

    // メインシートの1行目にある社員名を初期行として登録
    const lastCol = mainSheet.getLastColumn();
    if (lastCol >= 3) {
      const headers = mainSheet.getRange(1, 3, 1, lastCol - 2).getValues()[0];
      for (const name of headers) {
        const trimmed = String(name).trim();
        if (trimmed) {
          sheet.appendRow([trimmed, trimmed, '', '']);
        }
      }
    }
  }
  return sheet;
}

/**
 * 投稿者（LINE表示名 / User ID）から社員名（苗字）を解決
 */
function resolveEmployee(mappingSheet, mainSheet, userId, displayName) {
  const mapData = mappingSheet.getDataRange().getValues();

  // 1. LINE紐付けシートから検索 (User ID優先、次に表示名一致)
  for (let i = 1; i < mapData.length; i++) {
    const empName = String(mapData[i][0]).trim();
    const lineName = String(mapData[i][1]).trim();
    const mapUserId = String(mapData[i][2]).trim();

    if (userId && mapUserId && mapUserId === userId) {
      return empName;
    }
    if (displayName && lineName && lineName === displayName) {
      return empName;
    }
  }

  // 2. メインシートの1行目にある社員名（苗字）が、LINE表示名に含まれているか部分一致検索
  // 例: LINE名が「西村 健介」や「にしむら」で、シートヘッダーが「西村」の場合
  const lastCol = mainSheet.getLastColumn();
  if (lastCol >= 3) {
    const headers = mainSheet.getRange(1, 3, 1, lastCol - 2).getValues()[0];
    for (const name of headers) {
      const empName = String(name).trim();
      if (!empName) continue;

      if (displayName && displayName.includes(empName)) {
        // 次回以降のためにマスタへ自動学習追記
        mappingSheet.appendRow([empName, displayName, userId || '', '自動学習紐付け']);
        return empName;
      }
    }
  }

  return null;
}

/**
 * 取込ログシートへ記録
 */
function logImport(ss, payload, employee, details) {
  try {
    const SHEET_NAME = '取込ログ';
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['実行日時', '対象日', '社員名', '判定状態', 'LINE表示名', '申告本文', '処理詳細']);
      sheet.getRange('A1:G1').setBackground('#434343').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([
      nowStr,
      payload.targetDate,
      employee,
      payload.status,
      payload.displayName,
      payload.rawText,
      details
    ]);
  } catch (_e) {
    // ログ記録の失敗はメイン処理を止めない
  }
}

/**
 * JSON レスポンス生成補助
 */
function jsonResponse(obj, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

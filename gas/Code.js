/**
 * ==============================================================================
 * LINE朝清掃 出欠自動集計システム - Google Apps Script (GAS) スクリプト
 * 
 * 【設定手順】
 * 1. 反映先のGoogleスプレッドシートを開きます。
 * 2. メニューバーの「拡張機能」>「Apps Script」を開きます。
 * 3. エディタ内の既存コードを削除し、このファイルの内容をすべて貼り付けて保存します。
 * 4. （任意・セキュリティ推奨）APIシークレットの設定:
 *    - 左メニュー「プロジェクトの設定（歯車アイコン）」>「スクリプト プロパティ」を開きます。
 *    - プロパティ名: `API_SECRET`
 *    - 値: 任意のランダムな文字列（例: `my_secure_secret_token_123`）
 *    - ※ Cloudflare Worker 側の `SHEETS_API_SECRET` にも同じ値を設定します。
 * 5. デプロイ:
 *    - 右上の「デプロイ」>「新しいデプロイ」をクリックします。
 *    - 種類の選択（歯車）で「ウェブアプリ」を選択します。
 *    - 説明: `LINE出欠Webhook`
 *    - 次のユーザーとして実行: **「自分」**
 *    - アクセスできるユーザー: **「全員」**（※外部のCloudflare Workerから受信するため）
 *    - 「デプロイ」をクリックし、発行された **ウェブアプリURL** をコピーします。
 *    - ※ Cloudflare Worker 側の `SHEETS_WEBHOOK_URL` にこのURLを設定します。
 * ==============================================================================
 */

// シート名の定義
const SHEET_ATTENDANCE = '出欠一覧';
const SHEET_MEMBERS = '社員名簿';

/**
 * HTTP POST リクエストの受信ハンドラー
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, message: 'Empty body' }, 400);
    }

    const payload = JSON.parse(e.postData.contents);

    // 1. APIシークレットの検証（設定されている場合）
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (expectedSecret && expectedSecret.trim() !== '') {
      const providedSecret = payload.apiKey;
      if (providedSecret !== expectedSecret) {
        return jsonResponse({ success: false, message: 'Unauthorized: Invalid API secret' }, 401);
      }
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // 2. シートの初期化・準備
    const attendanceSheet = getOrCreateAttendanceSheet(ss);
    const membersSheet = getOrCreateMembersSheet(ss);

    // 3. 社員マスタから正規の社員名を解決
    const employeeName = resolveEmployeeName(
      membersSheet,
      payload.userId,
      payload.displayName
    );

    // 4. 出欠一覧シートへUPSERT（同じ日付+同じ社員/ユーザーIDなら上書き）
    const action = upsertAttendanceRow(attendanceSheet, {
      targetDate: payload.targetDate,
      employeeName: employeeName,
      status: payload.status,
      displayName: payload.displayName || '',
      userId: payload.userId || '',
      rawText: payload.rawText || '',
      eventId: payload.eventId || '',
      updatedAt: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss')
    });

    return jsonResponse({ success: true, action: action, employeeName: employeeName });
  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * 出欠一覧シートを取得（存在しない場合は初期作成）
 */
function getOrCreateAttendanceSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_ATTENDANCE);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_ATTENDANCE);
    const headers = ['対象日', '社員名', '出欠状態', 'LINE表示名', '申告本文', '最終更新日時', 'LINEユーザーID', 'イベントID'];
    sheet.appendRow(headers);
    sheet.getRange('A1:H1').setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 社員名簿シートを取得（存在しない場合は初期作成）
 */
function getOrCreateMembersSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_MEMBERS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_MEMBERS);
    const headers = ['社員名', 'LINE表示名', 'LINEユーザーID'];
    sheet.appendRow(headers);
    sheet.getRange('A1:C1').setBackground('#6aa84f').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * 社員名簿シートを参照し、社員名を解決します。
 * マスタに未登録の場合はLINE表示名（または仮名）を返します。
 */
function resolveEmployeeName(membersSheet, userId, displayName) {
  const data = membersSheet.getDataRange().getValues();
  if (data.length <= 1) {
    return displayName || userId;
  }

  // 1行目はヘッダーなので2行目以降を探索
  for (let i = 1; i < data.length; i++) {
    const rowName = data[i][0];
    const rowLineName = data[i][1];
    const rowUserId = data[i][2];

    // LINE User ID の完全一致を最優先
    if (userId && rowUserId && String(rowUserId).trim() === String(userId).trim()) {
      return rowName;
    }

    // LINE 表示名の一致
    if (displayName && rowLineName && String(rowLineName).trim() === String(displayName).trim()) {
      return rowName;
    }
  }

  // マスタにない場合はLINE表示名を採用
  return displayName || userId;
}

/**
 * 出欠レコードを上書き（UPSERT）
 */
function upsertAttendanceRow(sheet, record) {
  const data = sheet.getDataRange().getValues();
  let targetRowIndex = -1;

  // 既存レコードを検索 (同じ対象日 かつ (同じLINEユーザーID または 同じ社員名))
  for (let i = 1; i < data.length; i++) {
    const rowDate = Utilities.formatDate(new Date(data[i][0]), 'Asia/Tokyo', 'yyyy-MM-dd');
    const rowEmployee = String(data[i][1]).trim();
    const rowUserId = String(data[i][6]).trim();

    if (rowDate === record.targetDate) {
      if ((record.userId && rowUserId === record.userId) || (rowEmployee === record.employeeName)) {
        targetRowIndex = i + 1; // 1-indexed
        break;
      }
    }
  }

  const rowValues = [
    record.targetDate,
    record.employeeName,
    record.status,
    record.displayName,
    record.rawText,
    record.updatedAt,
    record.userId,
    record.eventId
  ];

  if (targetRowIndex > 0) {
    // 既存行を上書き更新
    sheet.getRange(targetRowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    return 'updated';
  } else {
    // 新規行を追加
    sheet.appendRow(rowValues);
    return 'inserted';
  }
}

/**
 * JSONレスポンスの生成
 */
function jsonResponse(obj, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

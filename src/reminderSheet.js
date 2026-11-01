/**
 * 記録用シートの読み書き（1行 = 1件のリマインダー。列の並びは config.js の COL）
 */

/**
 * 記録用シートを、ほかの処理と順番に使う（設定・停止と送信が同時に書き換えないため）
 * @param {function(): *} fn 順番が来たら行う処理
 * @return {*} fn の戻り値
 */
function withSheetLock(fn) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) throw new Error('帳面が塞がっておる故、しばし待たれよ。');
    try {
        return fn();
    } finally {
        lock.releaseLock();
    }
}

/**
 * 記録用シートを開く
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getReminderSheet() {
    const spreadsheetId = getProp('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('SPREADSHEET_ID が設定されておらぬぞ。');
    const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error(`「${SHEET_NAME}」というシートが見当たらぬぞ。`);
    return sheet;
}

/**
 * シートの全行を、行番号付きで読む（見出しの1行目は除く）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @return {Array<{rowNumber: number, values: Array}>} rowNumber はシート上の行番号（1始まり）
 */
function readReminderRows(sheet) {
    return sheet.getDataRange().getValues()
        .map((values, i) => ({ rowNumber: i + 1, values: values }))
        .slice(1);
}

/**
 * スレッドで動いているリマインダーの行を探す
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {string} threadTs スレッドのタイムスタンプ
 * @return {{rowNumber: number, values: Array}|null} 無ければnull
 */
function findActiveReminder(sheet, threadTs) {
    return readReminderRows(sheet).find(row =>
        String(row.values[COL.THREAD_TS]) === String(threadTs) && row.values[COL.STATUS] === STATUS.ACTIVE
    ) || null;
}

/**
 * リマインダーを1行書き足す
 * タイムスタンプは数として読まれると桁が落ちるので、先頭に「'」を付けて文字として書く。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {object} reminder COL と同じ名前（小文字）の項目を持つリマインダー
 */
function appendReminder(sheet, reminder) {
    const row = [];
    row[COL.TS] = "'" + reminder.ts;
    row[COL.POSTED_AT] = reminder.postedAt;
    row[COL.STATUS] = STATUS.ACTIVE;
    row[COL.USER_ID] = reminder.userId;
    row[COL.USER_NAME] = reminder.userName;
    row[COL.CC_IDS] = reminder.ccIds;
    row[COL.CC_NAMES] = reminder.ccNames;
    row[COL.TEXT] = reminder.text;
    row[COL.CHANNEL_ID] = reminder.channelId;
    row[COL.CHANNEL_NAME] = reminder.channelName;
    row[COL.THREAD_TS] = "'" + reminder.threadTs;
    row[COL.PERMALINK] = reminder.permalink;
    row[COL.INTERVAL_HOURS] = reminder.intervalHours;
    row[COL.NEXT_TIME] = "'" + reminder.nextTime;
    row[COL.COUNT] = 0;
    row[COL.CONTENT] = reminder.content;
    sheet.appendRow(row);
}

/**
 * リマインダーの状態を書き換える
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {number} rowNumber シート上の行番号
 * @param {string} status 状態（STATUS）
 */
function setReminderStatus(sheet, rowNumber, status) {
    sheet.getRange(rowNumber, COL.STATUS + 1).setValue(status);
}

/**
 * リマインドを送った後、次の時刻と回数を書き換える（隣り合う2列なので1度に書く）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {number} rowNumber シート上の行番号
 * @param {number} nextTime 次にリマインドする時刻（UNIX秒）
 * @param {number} count これまでにリマインドした回数
 */
function updateReminderSchedule(sheet, rowNumber, nextTime, count) {
    sheet.getRange(rowNumber, COL.NEXT_TIME + 1, 1, 2).setValues([["'" + nextTime, count]]);
}

/**
 * 対応済みの行を消す（下の行から消し、上の行の行番号がずれないようにする）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {Array<{rowNumber: number, values: Array}>} rows readReminderRows で読んだ行
 */
function deleteDoneReminders(sheet, rows) {
    rows
        .filter(row => row.values[COL.STATUS] === STATUS.DONE)
        .reverse()
        .forEach(row => sheet.deleteRow(row.rowNumber));
}

// ---------------------------------------------------------------------------
// 次に確かめる時刻（NEXT_CHECK_PROP）
// ---------------------------------------------------------------------------

/**
 * 次にシートを確かめる時刻を読む
 * @return {number} UNIX秒。控えが無ければ0（すぐに確かめる）
 */
function getNextCheckTime() {
    return Number(PropertiesService.getScriptProperties().getProperty(NEXT_CHECK_PROP)) || 0;
}

/**
 * 次にシートを確かめる時刻を控える
 * @param {number} time UNIX秒
 */
function setNextCheckTime(time) {
    PropertiesService.getScriptProperties().setProperty(NEXT_CHECK_PROP, String(time));
}

/**
 * 新しいリマインダーの時刻が、控えている時刻より早ければ、控えを早める
 * @param {number} time 新しいリマインダーの最初の時刻（UNIX秒）
 */
function advanceNextCheckTime(time) {
    const nextCheckTime = getNextCheckTime();
    if (nextCheckTime && time < nextCheckTime) setNextCheckTime(time);
}

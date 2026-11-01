/**
 * 時刻が来たリマインダーを送る
 * GASのトリガーで、sendScheduledReminders を1分おきに動かす。
 */

/**
 * 時刻が来たリマインダーを送り、次の時刻と回数を書き換える（トリガーから呼ばれる）
 * 送る時刻が来るまでは、シートを開かずに休む（NEXT_CHECK_PROP）。
 */
function sendScheduledReminders() {
    const now = Math.floor(Date.now() / 1000);
    if (now < getNextCheckTime()) return;

    // 前回の実行や、設定・停止の処理が動いていれば、今回は休む（同じリマインドを二重に送らないため）
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(0)) return;

    try {
        const sheet = getReminderSheet();
        const rows = readReminderRows(sheet);

        // 時刻が来たものを送り、いちばん早い次の時刻を調べる
        let earliest = now + MAX_CHECK_INTERVAL_SEC;
        rows.forEach(row => {
            if (row.values[COL.STATUS] !== STATUS.ACTIVE) return;
            let nextTime = Number(row.values[COL.NEXT_TIME]);
            if (nextTime > 0 && nextTime <= now) nextTime = sendReminder(sheet, row, now);
            if (nextTime > 0) earliest = Math.min(earliest, nextTime);
        });

        // 対応済みの行を消し、次に確かめる時刻を控える
        deleteDoneReminders(sheet, rows);
        setNextCheckTime(earliest);
    } finally {
        lock.releaseLock();
    }
}

/**
 * 1件のリマインダーを送る
 * 失敗したら、そのスレッドに理由を知らせて次の時刻へ進める（毎分失敗し続けないため）。
 * 何度試しても送れないもの（アーカイブ済み・チャンネルに入れない・設定の誤り）は止める。
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {{rowNumber: number, values: Array}} row リマインダーの行
 * @param {number} now 現在時刻（UNIX秒）
 * @return {number|null} 次の時刻（UNIX秒）。止めたらnull
 */
function sendReminder(sheet, row, now) {
    const values = row.values;
    const channelId = values[COL.CHANNEL_ID];
    const threadTs = String(values[COL.THREAD_TS]);
    const count = Number(values[COL.COUNT]) || 0;
    const intervalHours = Number(values[COL.INTERVAL_HOURS]);

    // 間隔が壊れていれば、次の時刻を決められないので止める
    if (!(intervalHours > 0)) {
        setReminderStatus(sheet, row.rowNumber, STATUS.BROKEN);
        tryPostToThread(channelId, threadTs, `:x: 報せる間隔（${values[COL.INTERVAL_HOURS]}）が読めぬ故、務めを取り止め申す。`);
        return null;
    }
    const nextTime = calcNextTime(Number(values[COL.NEXT_TIME]), intervalHours, now);

    try {
        const reminder = buildReminderMessage(count, values[COL.CONTENT]);

        // 依頼した人と、依頼文でメンションされた人に宛てる
        const ccIds = String(values[COL.CC_IDS] || '').split(',').map(id => id.trim()).filter(Boolean);
        let message = `<@${values[COL.USER_ID]}> \n`;
        if (ccIds.length > 0) message += `CC: ${toMentions(ccIds)}\n`;
        message += reminder.text;

        postToThread(channelId, threadTs, message, { angry: reminder.angry });
        updateReminderSchedule(sheet, row.rowNumber, nextTime, count + 1);
        return nextTime;
    } catch (e) {
        console.error(e.stack || e.message);

        // もう送れないチャンネルなら止める
        if (e.message.includes('is_archived')) {
            setReminderStatus(sheet, row.rowNumber, STATUS.ARCHIVED);
            return null;
        }
        if (/not_in_channel|channel_not_found/.test(e.message)) {
            setReminderStatus(sheet, row.rowNumber, STATUS.NO_ACCESS);
            return null;
        }

        // それ以外は、理由を知らせて次の時刻へ進める（回数は増やさない）
        updateReminderSchedule(sheet, row.rowNumber, nextTime, count);
        tryPostToThread(channelId, threadTs, ':x: 由々しき事態が起きておる。\n' + e.message);
        return nextTime;
    }
}

/**
 * スレッドに投稿する（失敗してもログに残すだけで、処理は止めない）
 * @param {string} channelId チャンネルID
 * @param {string} threadTs スレッドのタイムスタンプ
 * @param {string} message 投稿する文
 */
function tryPostToThread(channelId, threadTs, message) {
    try {
        postToThread(channelId, threadTs, message);
    } catch (e) {
        console.error('失敗の通知にも失敗しました: ' + e.message);
    }
}

/**
 * 次にリマインドする時刻を決める
 * 送った時刻ではなく、予定していた時刻に間隔を足す（トリガーの遅れが積み重なって、8:00 が 8:08 にずれていかないため）。
 * 止まっていた間などで足しても過去になるなら、未来になるまで間隔を足す（溜まった分をまとめて送らないため）。
 * @param {number} scheduledTime 予定していた時刻（UNIX秒）
 * @param {number} intervalHours 間隔（時間）
 * @param {number} now 現在時刻（UNIX秒）
 * @return {number} 次の時刻（UNIX秒）
 */
function calcNextTime(scheduledTime, intervalHours, now) {
    const intervalSec = Math.max(Math.round(intervalHours * 60 * 60), 60);
    let nextTime = scheduledTime + intervalSec;
    if (nextTime <= now) {
        nextTime += Math.ceil((now - nextTime + 1) / intervalSec) * intervalSec;
    }
    return nextTime;
}

/**
 * これまでの回数に合わせて、リマインドの文面を選ぶ
 * @param {number} count これまでにリマインドした回数
 * @param {string} content リマインドの内容（空なら「例の件」のまま）
 * @return {{text: string, angry: boolean}} angry: 怒りのアイコンで送るか
 */
function buildReminderMessage(count, content) {
    if (count > GIVE_UP_COUNT) return { text: GIVE_UP_MESSAGE, angry: true };

    const angryMessage = ANGRY_MESSAGES[count];
    const template = angryMessage || REMINDER_MESSAGE;
    const text = content ? template.replace('例の件', `${content}件`) : template;
    return { text: text, angry: Boolean(angryMessage) };
}

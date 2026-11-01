/**
 * 時刻が来たリマインダーを送る
 * GASのトリガーで、sendScheduledReminders を1分おきに動かす。
 */

/**
 * 時刻が来たリマインダーを送り、次の時刻と回数を書き換える（トリガーから呼ばれる）
 */
function sendScheduledReminders() {
    // 前回の実行がまだ終わっていなければ、今回は休む（同じリマインドを二重に送らないため）
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(0)) return;

    try {
        const sheet = getReminderSheet();
        const now = Math.floor(Date.now() / 1000);
        readReminderRows(sheet)
            .filter(row => {
                const nextTime = Number(row.values[COL.NEXT_TIME]);
                return row.values[COL.STATUS] === STATUS.ACTIVE && nextTime > 0 && nextTime <= now;
            })
            .forEach(row => sendReminder(sheet, row, now));
    } finally {
        lock.releaseLock();
    }
}

/**
 * 1件のリマインダーを送る（失敗したら、そのスレッドに理由を知らせて次へ進む）
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet 記録用シート
 * @param {{rowNumber: number, values: Array}} row リマインダーの行
 * @param {number} now 現在時刻（UNIX秒）
 */
function sendReminder(sheet, row, now) {
    const values = row.values;
    const channelId = values[COL.CHANNEL_ID];
    const threadTs = String(values[COL.THREAD_TS]);
    const count = Number(values[COL.COUNT]) || 0;

    try {
        const reminder = buildReminderMessage(count, values[COL.CONTENT]);

        // 依頼した人と、依頼文でメンションされた人に宛てる
        const ccIds = String(values[COL.CC_IDS] || '').split(',').map(id => id.trim()).filter(Boolean);
        let message = `<@${values[COL.USER_ID]}> \n`;
        if (ccIds.length > 0) message += `CC: ${toMentions(ccIds)}\n`;
        message += reminder.text;

        postToThread(channelId, threadTs, message, { angry: reminder.angry });

        // 次の時刻と回数を書き換える
        const nextTime = calcNextTime(Number(values[COL.NEXT_TIME]), Number(values[COL.INTERVAL_HOURS]), now);
        updateReminderSchedule(sheet, row.rowNumber, nextTime, count + 1);
    } catch (e) {
        console.error(e.stack || e.message);

        // チャンネルがアーカイブ済みなら、もう送れないので止める（毎分失敗し続けないため）
        if (e.message.includes('is_archived')) {
            setReminderStatus(sheet, row.rowNumber, STATUS.ARCHIVED);
            return;
        }
        try {
            postToThread(channelId, threadTs, ':x: 由々しき事態が起きておる。\n' + e.message);
        } catch (err) {
            console.error('失敗の通知にも失敗しました: ' + err.message);
        }
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

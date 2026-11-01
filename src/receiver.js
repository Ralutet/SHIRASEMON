/**
 * Slackからのメンションを受け取り、リマインダーを設定・停止する
 *
 * 流れ（doPost → handleMention）:
 *   1. 「erase」「end」だけの本文なら、Gemini に頼まずそのまま扱う
 *   2. それ以外は Gemini に意図とリマインダーの中身を読み取らせる（gemini.js）
 *   3. 意図に合わせて、設定（registerReminder）・停止（stopReminder）・聞き返しをする
 */

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * SlackからのPOSTリクエストを受け取る
 * （Slack App の Event Subscriptions に登録したウェブアプリのURLに、メンションのたびに送られてくる）
 * @param {object} e HTTP POSTイベントオブジェクト
 * @return {GoogleAppsScript.Content.TextOutput} Slackへの応答
 */
function doPost(e) {
    // 送られてきた本文（JSON）を読む
    let contents;
    try {
        contents = JSON.parse(e.postData.contents);
    } catch (err) {
        console.error('POST本文の解析に失敗しました: ' + err.message);
        return ContentService.createTextOutput();
    }

    // 初回の認証（URL Verification）なら、送られてきた challenge をそのまま返す
    if (contents.type === 'url_verification') {
        return ContentService.createTextOutput(contents.challenge).setMimeType(ContentService.MimeType.TEXT);
    }

    // 扱うべきメンションなら扱う（同じイベントの再送は1回だけ扱う）
    const event = contents.event;
    if (contents.type === 'event_callback' && event && shouldHandleEvent(event)) {
        try {
            if (!isProcessed(event.event_ts || event.ts)) {
                // 投稿から受け取るまでと、扱い終えるまでの時間をログに残す（反応の遅さを調べるため）
                console.log(`投稿から受け取るまで: ${Date.now() - parseFloat(event.ts) * 1000}ms`);
                handleMention(event);
                console.log(`投稿から扱い終えるまで: ${Date.now() - parseFloat(event.ts) * 1000}ms`);
            }
        } catch (err) {
            notifyFailure(event, err);
        }
    }

    // 常に空の応答を返し、Slackに正常受信を伝える
    return ContentService.createTextOutput();
}

/**
 * 扱うべきイベントかどうか
 * @param {object} event Slackのイベントオブジェクト
 * @return {boolean}
 */
function shouldHandleEvent(event) {
    // 人が書いた、ボットへのメンションだけを見る
    if (event.type !== 'app_mention' || event.bot_id || !event.text) return false;

    // 投稿から一定時間を過ぎたものは除く（Slackの再送や処理遅延で、古い依頼を今さら扱わないため）
    const postedAt = parseFloat(event.event_ts || event.ts) * 1000;
    return Boolean(postedAt) && Date.now() - postedAt <= EVENT_FRESHNESS_MS;
}

/**
 * 既に扱ったイベントかどうか（Slackは応答が遅いと同じイベントを再送するため）
 * 初めてなら「扱った」と控える。処理中に失敗しても控えは残す（再送で二重に扱わないため）。
 * @param {string} eventTs イベントのタイムスタンプ
 * @return {boolean} 既に扱っていればtrue
 */
function isProcessed(eventTs) {
    const cache = CacheService.getScriptCache();
    const cacheKey = CACHE_PREFIX.EVENT + eventTs;
    if (cache.get(cacheKey)) return true;
    cache.put(cacheKey, 'processed', CACHE_TTL_SEC.EVENT);
    return false;
}

// ---------------------------------------------------------------------------
// メンションの処理
// ---------------------------------------------------------------------------

/**
 * メンションを読み、リマインダーを設定・停止する
 * @param {object} event Slackのイベントオブジェクト
 */
function handleMention(event) {
    const text = removeBotMention(event.text);

    // 1. 命令の言葉だけなら、そのまま扱う
    // （メンションを全て除いて比べる。SLACK_BOT_ID が食い違っていても、Gemini に回して遅くならないように）
    const command = text.replace(/<@[A-Z0-9]+>/g, '').trim().toLowerCase();
    if (COMMANDS.ERASE.indexOf(command) !== -1) {
        cleanUpThread(event);
        return;
    }
    if (COMMANDS.END.indexOf(command) !== -1) {
        stopReminder(event);
        return;
    }

    // 2. Gemini に意図とリマインダーの中身を読み取らせる
    const interpreted = interpretMention(text, new Date());

    // 3. 意図に合わせて扱う
    switch (interpreted.intent) {
        case 'SET_REMINDER':
            registerReminder(event, text, interpreted);
            break;
        case 'STOP_REMINDER':
            stopReminder(event);
            break;
        default:
            postReply(event, 'ご下命の意図を測りかねます。');
            break;
    }
}

/**
 * 新しいリマインダーをシートに書き込み、引き受けたことを返信する
 * @param {object} event Slackのイベントオブジェクト
 * @param {string} text メンションの本文（ボットへのメンションは除いたもの）
 * @param {{interval_hours: number|null, content: string|null, start_time: string|null}} interpreted 読み取った中身
 */
function registerReminder(event, text, interpreted) {
    // 間隔が読み取れなければ、聞き返す
    const intervalHours = Number(interpreted.interval_hours);
    if (!(intervalHours > 0)) {
        postReply(event, '報せる間隔を認識できませぬ。『一時間』や『三時間おき』のように、お示しくだされ。');
        return;
    }

    // 最初にリマインドする時刻を決める（開始日時の指定が無いか過去なら、今から1間隔後）
    const now = Math.floor(Date.now() / 1000);
    const startTime = parseStartTime(interpreted.start_time);
    const hasStartTime = startTime !== null && startTime > now;
    const nextTime = hasStartTime ? startTime : Math.floor(now + intervalHours * 60 * 60);

    // シートに書き込む（同じスレッドで既にリマインド中なら、重ねて設定しない）
    // 名前を調べるのは Slack を呼んで時間がかかるので、シートの順番待ちの前に済ませる
    const record = buildReminderRecord(event, text, interpreted, intervalHours, nextTime);
    const registered = withSheetLock(() => {
        const sheet = getReminderSheet();
        if (findActiveReminder(sheet, record.threadTs)) return false;
        appendReminder(sheet, record);
        advanceNextCheckTime(nextTime);
        return true;
    });
    if (!registered) {
        postReply(event, 'この場においては、既に報せの務めが設定されております。');
        return;
    }

    // 引き受けたことを返信する（例: 資料を作成する件、11月02日 09時00分 より、 1 日おきに、必ずや報せに参ります。）
    let message = interpreted.content ? `${interpreted.content}件、` : '';
    message += hasStartTime ? `${formatUnixTime(startTime, 'MM月dd日 HH時mm分')} より、` : 'これより';
    message += ` ${describeInterval(intervalHours)}おきに、必ずや報せに参ります。`;
    postReply(event, message);
}

/**
 * シートに書き込むリマインダーを組み立てる
 * @param {object} event Slackのイベントオブジェクト
 * @param {string} text メンションの本文
 * @param {{content: string|null}} interpreted 読み取った中身
 * @param {number} intervalHours 間隔（時間）
 * @param {number} nextTime 最初にリマインドする時刻（UNIX秒）
 * @return {object} appendReminder に渡すリマインダー
 */
function buildReminderRecord(event, text, interpreted, intervalHours, nextTime) {
    // 依頼文でメンションされた人を CC にする（依頼した本人は宛先に入るので除く）
    const ccIds = unique(extractUserIds(text)).filter(id => id !== event.user);
    return {
        ts: event.ts,
        postedAt: formatUnixTime(event.ts, 'yyyy/MM/dd HH:mm:ss'),
        userId: event.user,
        userName: getUserRealName(event.user),
        ccIds: ccIds.join(','),
        ccNames: ccIds.map(id => getUserRealName(id) || '不明なユーザー').join(','),
        text: text,
        channelId: event.channel,
        channelName: getChannelName(event.channel),
        threadTs: event.thread_ts || event.ts,
        permalink: slackPermalink(event),
        intervalHours: intervalHours,
        nextTime: nextTime,
        content: interpreted.content,
    };
}

/**
 * スレッドのリマインダーを止め、リマインドの投稿を消す
 * 送信のトリガーと順番にシートを使う（止めた直後に、リマインドが1通届かないため）。
 * 止めた行は、次に送信のトリガーがシートを読んだときに消える。
 * @param {object} event Slackのイベントオブジェクト
 */
function stopReminder(event) {
    const stopped = withSheetLock(() => {
        const sheet = getReminderSheet();
        const reminder = findActiveReminder(sheet, event.thread_ts || event.ts);
        if (!reminder) return false;
        setReminderStatus(sheet, reminder.rowNumber, STATUS.DONE);
        return true;
    });
    if (stopped) {
        postReply(event, '報せの務め、完了いたしました。');
    } else {
        postReply(event, 'この場にて、拙者がお預かりしている報せの務めは見当たりませぬ。');
    }
    cleanUpThread(event);
}

/**
 * スレッド内の、ボットが送ったリマインドの投稿を消す（引き受けたときの返信は残す）
 * @param {object} event Slackのイベントオブジェクト
 */
function cleanUpThread(event) {
    const botId = getProp('SLACK_BOT_ID');
    const messages = getThreadMessages(event.channel, event.thread_ts || event.ts);
    messages
        .filter(msg => {
            const isMine = msg.user === botId || msg.bot_id === botId || msg.username === BOT_NAME;
            const text = msg.text || '';
            const isReminder = text.includes('件') || text.includes(GIVE_UP_MESSAGE);
            const isAcceptance = text.includes('必ずや報せに参ります。');
            return isMine && isReminder && !isAcceptance;
        })
        .forEach(msg => deleteMessage(event.channel, msg.ts));
}

// ---------------------------------------------------------------------------
// 道具
// ---------------------------------------------------------------------------

/**
 * Gemini の読み取った開始日時を UNIX秒 にする（時差が書かれていなければ日本時間とみなす）
 * @param {string|null} startTime ISO 8601 形式の日時
 * @return {number|null} 読めなければnull
 */
function parseStartTime(startTime) {
    if (!startTime) return null;
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(startTime);
    const date = new Date(hasOffset ? startTime : startTime + '+09:00');
    return isNaN(date.getTime()) ? null : Math.floor(date.getTime() / 1000);
}

/**
 * 間隔を言葉にする（例: 48 → "2 日"、36 → "36 時間"、3 → "3 時間"、0.5 → "30 分"）
 * 日で割り切れるときだけ日で表す（36時間を「2 日」と丸めないため）。
 * @param {number} intervalHours 間隔（時間）
 * @return {string}
 */
function describeInterval(intervalHours) {
    if (intervalHours >= 24 && intervalHours % 24 === 0) return `${intervalHours / 24} 日`;
    if (intervalHours >= 1) return `${Math.round(intervalHours * 100) / 100} 時間`;
    return `${Math.round(intervalHours * 60)} 分`;
}

/**
 * 重複を除いた配列を返す（並び順は最初に出てきた順）
 * @param {Array} list
 * @return {Array}
 */
function unique(list) {
    return list.filter((item, i) => list.indexOf(item) === i);
}

/**
 * UNIX秒（Slackのタイムスタンプも可）を日本時間の文字列にする
 * @param {string|number} unixTime UNIX秒（例: "1757922551.438709"）
 * @param {string} format 書式（例: 'yyyy/MM/dd HH:mm:ss'）
 * @return {string}
 */
function formatUnixTime(unixTime, format) {
    return Utilities.formatDate(new Date(parseFloat(unixTime) * 1000), 'Asia/Tokyo', format);
}

/**
 * 処理の失敗を、ログに残してスレッドに知らせる（知らせること自体の失敗で処理を止めない）
 * @param {object} event Slackのイベントオブジェクト
 * @param {Error} error 起きたエラー
 */
function notifyFailure(event, error) {
    console.error(error.stack || error.message);
    try {
        postReply(event, ':x: 由々しき事態が起きておる。\n' + error.message);
    } catch (err) {
        console.error('失敗の通知にも失敗しました: ' + err.message);
    }
}

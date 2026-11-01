/**
 *   SlackからのPOSTリクエ ストを受け取り、イベントの種類に応じて処理を行います。
 * @param {object} e HTTP POSTイベントオブジェクト
 * @return {object} Slackへの応答（TextOutput）
 */
function doPost(e) {
  const contents = JSON.parse(e.postData.contents);

  // 初回認証（URL Verification）の場合
  if (contents.type === 'url_verification') {
    return ContentService.createTextOutput(contents.challenge);
  }

  // イベント（Event Callback）の場合
  if (contents.type === 'event_callback') {
    const event = contents.event;

    try {
      // 重複実行防止（10分間キャッシュ）
      if (isProcessed(event.event_ts)) {
        return ContentService.createTextOutput();
      }

      // BOTへのメンションの場合
      if (event.type === 'app_mention') {

        // テキストに含まれる直接のコマンドを優先処理
        if (event.text.includes('erase')) {
          cleanUpThread(event);
          return ContentService.createTextOutput();
        } else if (event.text.includes('end')) {
          checkForCompletion(event);
          cleanUpThread(event);
          return ContentService.createTextOutput();

        }

        // Geminiでユーザーの意図を分類
        const intentResult = classifyIntent(event);

        switch (intentResult.intent) {
          case 'SET_REMINDER':
            registerNewReminder(event);
            break;
          case 'STOP_REMINDER':
            checkForCompletion(event);
            cleanUpThread(event);
            break;
          case 'OTHER':
          default:
            postConfirmationReply(event, 'ご下命の意図を測りかねます。');
            break;
        }
      }
    } catch (e) {
      try {
        postConfirmationReplyRetry(event, ':x: 由々しき事態が起きておる。' + e.message);
      } catch (e) {
        // エラー通知も失敗した場合は無視
      }
    }
    return ContentService.createTextOutput();
  }

  return ContentService.createTextOutput();
}


/**
 * 新規リマインダーを登録する
 * @param {object} event Slackのイベントオブジェクト
 */
function registerNewReminder(event) {
  const threadTs = event.thread_ts || event.ts;
  const properties = PropertiesService.getScriptProperties();
  const botId = properties.getProperty('SLACK_BOT_ID');
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();

  // 同じスレッドで既にリマインド中かチェック
  for (let i = 1; i < data.length; i++) {
    if (data[i][10] == threadTs && data[i][2] === 'リマインド中') {
      postConfirmationReply(event, 'この場においては、既に報せの務めが設定されております。');
      return;
    }
  }

  // Geminiでリマインダー情報を抽出
  const reminderInfo = extractReminderInfo(event);
  // リマインダーの間隔が読み取れない場合
  if (!reminderInfo || !reminderInfo.interval_hours) {
    postConfirmationReply(event, '報せる間隔を認識できませぬ。『一時間』や『三時間おき』のように、お示しくだされ。');
    return;
  }

  const intervalHours = reminderInfo.interval_hours;
  const content = reminderInfo.content;
  const startTimeISO = reminderInfo.start_time; // ISO 8601形式 (YYYY-MM-DDThh:mm:ss)
  const text = event.text.replace(new RegExp(`<@${botId}>\\s*`), '');
  const now = Math.floor(new Date().getTime() / 1000);

  let message = '';
  if (content) {
    message += `${content}件、`;
  }

  // 開始時刻の決定
  let nextReminderTime;
  let startTimeUnix = null;

  if (startTimeISO) {
    const parsedDate = new Date(startTimeISO);
    if (!isNaN(parsedDate.getTime())) {
      startTimeUnix = Math.floor(parsedDate.getTime() / 1000);
    }
  }

  if (startTimeUnix && startTimeUnix > now) {
    nextReminderTime = startTimeUnix;
    const startDate = new Date(startTimeUnix * 1000);
    const formattedStart = Utilities.formatDate(startDate, 'Asia/Tokyo', 'MM月dd日 HH時mm分');
    message += `${formattedStart} より、`;
  } else {
    nextReminderTime = now + (intervalHours * 60 * 60);
    message += 'これより';
  }
  const permalink = getPermalink(event);

  // スプレッドシートに書き込む
  sheet.appendRow([
    "'" + event.ts,
    formatUnixTimestamp(event.ts),
    'リマインド中',
    event.user,
    getUserRealName(event.user),
    extractUserIds(text),
    getRealNamesFromIds(extractUserIds(text)),
    text,
    event.channel,
    getChannelName(event.channel),
    "'" + threadTs,
    permalink,
    intervalHours,
    "'" + nextReminderTime,
    0,
    content
  ]);


  if (intervalHours >= 24) {
    const intervalDays = Math.round(intervalHours / 24);
    message += ` ${intervalDays} 日おきに`;
  } else if (intervalHours >= 1) {
    message += ` ${intervalHours} 時間おきに`;
  } else {
    const intervalMinutes = Math.round(intervalHours * 60);
    message += ` ${intervalMinutes} 分おきに`;
  }

  message += '、必ずや報せに参ります。';

  postConfirmationReply(event, message);

}


/**
 * リマインダーを完了済みにする
 * @param {object} event Slackのイベントオブジェクト
 */
function checkForCompletion(event) {
  const threadTs = event.thread_ts || event.ts;
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  let reminderFound = false;

  // そのスレッドのリマインダーを探す
  for (let i = 1; i < data.length; i++) {
    if (data[i][10] == threadTs && data[i][2] === 'リマインド中') {
      sheet.getRange(i + 1, 3).setValue('対応済み');
      postConfirmationReply(event, '報せの務め、完了いたしました。');
      reminderFound = true;
      break;
    }
  }
  if (!reminderFound) {
    postConfirmationReply(event, 'この場にて、拙者がお預かりしている報せの務めは見当たりませぬ。');
  }
}

/**
 * Slackイベントを受け取り、そのスレッド内の掃除（リマインド等の削除）を行います。
 * @param {object} event Slackのイベントオブジェクト
 */
function cleanUpThread(event) {
  const threadTs = event.thread_ts || event.ts;
  const channelId = event.channel;

  const properties = PropertiesService.getScriptProperties();
  const botId = properties.getProperty('SLACK_BOT_ID');

  const messages = getThreadMessages(channelId, threadTs);
  if (!messages || messages.length === 0) return;

  messages.forEach(msg => {
    const isMyMessage = (msg.user === botId || msg.bot_id === botId || msg.username === '報衛門');
    const hasKeywords = (msg.text.includes('件') || msg.text.includes('......'));
    const isNotIntroduction = !msg.text.includes('必ずや報せに参ります。');

    if (isMyMessage && hasKeywords && isNotIntroduction) {
      deleteMessage(channelId, msg.ts);
    }
  });
}

/**
 * Unixタイムスタンプ（秒）を 'yyyy/MM/dd HH:mm:ss' 形式の文字列に変換します。
 * @param {string | number} unixTimestamp Unixタイムスタンプ（例: "1757922551.438709"）
 * @returns {string} フォーマットされた日時文字列
 */
function formatUnixTimestamp(unixTimestamp) {
  const date = new Date(parseFloat(unixTimestamp) * 1000);
  return Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
}


/**
 * イベントが既に処理済みかどうかを判定し、未処理ならキャッシュに登録します。
 * @param {string} event_ts イベントのタイムスタンプ
 * @return {boolean} 処理済みの場合はtrue、未処理の場合はfalse
 */
function isProcessed(event_ts) {
  const cache = CacheService.getScriptCache();
  if (cache.get(event_ts)) return true;
  cache.put(event_ts, 'processed', 600);
  return false;
}

/**
 * 文字列から全てのSlackユーザーIDを抽出し、カンマ区切りの文字列として返します。
 * 例: 「<@ID1>と<@ID2>に…」→ "ID1,ID2"
 * @param {string} text 解析対象の文字列
 * @returns {string} 抽出したユーザーIDをカンマで連結した文字列
 */
function extractUserIds(text) {
  if (!text) return '';
  const ids = [];
  const regex = /<@([A-Z0-9]+)>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids.join(',');
}


/**
 * カンマ区切りのユーザーID文字列を受け取り、それぞれの本名をカンマ区切りの文字列で返します。
 * @param {string} idString カンマ区切りのユーザーID文字列 (例: "UP3ELBY05,U07N0UJ62VD")
 * @returns {string} ユーザーの本名をカンマで連結した文字列
 */
function getRealNamesFromIds(idString) {
  if (!idString) return '';
  const ids = idString.split(',');
  const names = ids.map(id => {
    return getUserRealName(id.trim()) || '不明なユーザー';
  });
  return names.join(',');
}



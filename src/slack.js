/**
 * Slack とのやりとり（Web API の呼び出し・投稿・削除・ユーザー名・チャンネル名）
 */

// ---------------------------------------------------------------------------
// Web API の呼び出し
// ---------------------------------------------------------------------------

/**
 * Slack Web API を呼び出す
 * @param {string} method APIメソッド名（例: 'chat.postMessage'）
 * @param {object} params 送るパラメータ
 * @param {{get?: boolean, ignorableErrors?: Array<string>}} [options]
 *        get: GETで呼ぶ（conversations.replies など、読み取り系のAPIはJSONの本文を受け付けないため）
 *        ignorableErrors: 成功とみなすエラーコード（例: 既に消えている投稿）
 * @return {object} APIの応答
 */
function callSlackApi(method, params, options) {
    const opts = options || {};

    // 連続で呼びすぎないよう少し待つ
    Utilities.sleep(API_CALL_INTERVAL_MS);

    // ボットのトークンで呼ぶ
    const token = getProp('SLACK_BOT_TOKEN');
    if (!token) throw new Error('SLACK_BOT_TOKEN が設定されておらぬぞ。');
    const headers = { 'Authorization': 'Bearer ' + token };
    let response;
    try {
        if (opts.get) {
            const query = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
            response = UrlFetchApp.fetch(`https://slack.com/api/${method}?${query}`, {
                method: 'get',
                muteHttpExceptions: true,
                headers: headers,
            });
        } else {
            response = UrlFetchApp.fetch('https://slack.com/api/' + method, {
                method: 'post',
                contentType: 'application/json; charset=utf-8',
                muteHttpExceptions: true,
                headers: headers,
                payload: JSON.stringify(params),
            });
        }
    } catch (e) {
        throw new Error(`Slack ${method} Network Error: ${e.message}`);
    }

    // 応答をJSONとして読む
    const body = response.getContentText();
    let json;
    try {
        json = JSON.parse(body);
    } catch (e) {
        throw new Error(`Slack ${method} Error: 応答がJSONではありません (HTTP ${response.getResponseCode()})\n${body.slice(0, 300)}`);
    }

    // 失敗していればエラーにする（成功とみなしてよいエラーは除く）
    if (!json.ok && (opts.ignorableErrors || []).indexOf(json.error) === -1) {
        throw new Error(`Slack ${method} API Error: ${json.error}`);
    }
    return json;
}

// ---------------------------------------------------------------------------
// 投稿・削除
// ---------------------------------------------------------------------------

/**
 * スレッドに投稿する（失敗したら、待ち時間を倍にしながら再試行する）
 * @param {string} channelId チャンネルID
 * @param {string} threadTs 投稿先スレッドのタイムスタンプ
 * @param {string} message 投稿する文
 * @param {{angry?: boolean}} [options] angry: 怒りのアイコンで投稿する
 */
function postToThread(channelId, threadTs, message, options) {
    const params = {
        channel: channelId,
        thread_ts: String(threadTs),
        text: message,
        username: BOT_NAME,
    };
    if (options && options.angry) params.icon_url = ANGER_ICON_URL;

    let errorMessage = '';
    for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
        try {
            callSlackApi('chat.postMessage', params);
            return;
        } catch (e) {
            errorMessage += e.message + '\n';
            // チャンネルがアーカイブ済みなど、何度試しても同じ結果になるものは諦める
            if (/is_archived|channel_not_found|not_in_channel/.test(e.message)) break;
            // 最後の試行でなければ、1秒・2秒…と待ってから再試行する
            if (tries < MAX_ATTEMPTS - 1) Utilities.sleep(Math.pow(2, tries) * 1000 + Math.random() * 1000);
        }
    }
    throw new Error('幾度すらつくに伝えんと試みれども、叶わぬ。\n```' + errorMessage + '```');
}

/**
 * メンションのあったスレッドに返信する
 * @param {object} event Slackのイベントオブジェクト（channel, ts, thread_ts）
 * @param {string} message 返信する文
 */
function postReply(event, message) {
    postToThread(event.channel, event.thread_ts || event.ts, message);
}

/**
 * 投稿を削除する（既に無ければ何もしない）
 * @param {string} channelId チャンネルID
 * @param {string} ts 投稿のタイムスタンプ
 */
function deleteMessage(channelId, ts) {
    callSlackApi('chat.delete', { channel: channelId, ts: ts }, { ignorableErrors: ['message_not_found'] });
}

/**
 * スレッド内の投稿を全て取得する
 * @param {string} channelId チャンネルID
 * @param {string} threadTs スレッドのタイムスタンプ
 * @return {Array<object>} 投稿
 */
function getThreadMessages(channelId, threadTs) {
    const messages = [];
    let cursor = '';
    do {
        const params = { channel: channelId, ts: threadTs, limit: 200 };
        if (cursor) params.cursor = cursor;
        const json = callSlackApi('conversations.replies', params, { get: true });
        Array.prototype.push.apply(messages, json.messages || []);
        cursor = json.response_metadata && json.response_metadata.next_cursor;
    } while (cursor);
    return messages;
}

// ---------------------------------------------------------------------------
// 名前・URL
// ---------------------------------------------------------------------------

/**
 * ユーザーIDから本名（real_name）を調べる（一度調べた名前はキャッシュから返す）
 * @param {string} userId ユーザーID（例: U01234567）
 * @return {string|null} 本名。調べられなければnull
 */
function getUserRealName(userId) {
    return getCachedName(CACHE_PREFIX.USER + userId, CACHE_TTL_SEC.USER, () => {
        const json = callSlackApi('users.info', { user: userId }, { get: true });
        return json.user && json.user.real_name;
    });
}

/**
 * チャンネルIDからチャンネル名を調べる（一度調べた名前はキャッシュから返す）
 * @param {string} channelId チャンネルID（例: C12345678）
 * @return {string|null} チャンネル名。調べられなければnull
 */
function getChannelName(channelId) {
    return getCachedName(CACHE_PREFIX.CHANNEL + channelId, CACHE_TTL_SEC.CHANNEL, () => {
        const json = callSlackApi('conversations.info', { channel: channelId }, { get: true });
        return json.channel && json.channel.name;
    });
}

/**
 * 名前をキャッシュから返し、無ければ調べてキャッシュに入れる（調べられなくても処理は止めない）
 * @param {string} cacheKey キャッシュのキー
 * @param {number} ttlSec キャッシュを持っておく秒数
 * @param {function(): string|null} lookup 名前を調べる関数
 * @return {string|null}
 */
function getCachedName(cacheKey, ttlSec, lookup) {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    try {
        const name = lookup();
        if (name) {
            cache.put(cacheKey, name, ttlSec);
            return name;
        }
    } catch (e) {
        console.error(`名前の取得に失敗しました（${cacheKey}）: ${e.message}`);
    }
    return null;
}

/**
 * 投稿のURL（パーマリンク）を、APIを使わずに組み立てる
 * @param {object} event Slackのイベントオブジェクト
 * @return {string} 投稿のURL
 */
function slackPermalink(event) {
    // タイムスタンプの「.」を除いたものが、投稿のIDになる
    const url = `https://${getProp('SLACK_DOMAIN')}.slack.com/archives/${event.channel}/p${event.ts.replace('.', '')}`;

    // スレッド内の返信なら、スレッドも指定する
    const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
    return isThreadReply ? `${url}?thread_ts=${event.thread_ts}&cid=${event.channel}` : url;
}

// ---------------------------------------------------------------------------
// メンション
// ---------------------------------------------------------------------------

/**
 * 文中のユーザーメンション（<@U0123>）のIDを全て取り出す
 * @param {string} text 文
 * @return {Array<string>} ユーザーID
 */
function extractUserIds(text) {
    const ids = [];
    const regex = /<@([A-Z0-9]+)>/g;
    let match;
    while ((match = regex.exec(text || '')) !== null) {
        ids.push(match[1]);
    }
    return ids;
}

/**
 * ユーザーIDをメンションの形にする（例: ['U01', 'U02'] → "<@U01>, <@U02>"）
 * @param {Array<string>} ids ユーザーID
 * @return {string}
 */
function toMentions(ids) {
    return ids.map(id => `<@${id}>`).join(', ');
}

/**
 * 本文からボットへのメンションを除く
 * @param {string} text 本文
 * @return {string}
 */
function removeBotMention(text) {
    const botId = getProp('SLACK_BOT_ID');
    return String(text || '').split(`<@${botId}>`).join('').trim();
}

/**
 * Slackにメッセージを投稿する
 * @param {object} event Slackのイベントオブジェクト
 * @param {string} message 送信するメッセージ内容
 */
function postConfirmationReply(event, message) {
    Utilities.sleep(500);
    const threadTs = event.thread_ts || event.ts;
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('SLACK_BOT_TOKEN');
    const url = 'https://slack.com/api/chat.postMessage';

    const payload = {
        channel: event.channel,
        text: message,
        thread_ts: threadTs,
        username: '報衛門',
    };
    const options = {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { 'Authorization': 'Bearer ' + token },
        payload: JSON.stringify(payload)
    };

    try {
        const response = UrlFetchApp.fetch(url, options);
        const jsonResponse = JSON.parse(response.getContentText());

        if (!jsonResponse.ok) {
            throw new Error(jsonResponse.error);
        }
    } catch (e) {
        throw new Error("postConfirmationReply Error:" + e.message);
    }
}

/**
 * postConfirmationReply関数からAPIを呼び出し、メッセージの送信を行う。失敗した場合、5回再試行する。
 * @param {object} event Slackのイベントオブジェクト
 * @param {string} message 送信するメッセージ内容
 */
function postConfirmationReplyRetry(event, message) {
    let tries = 0;
    let errorMessage = "";
    while (tries < 3) {
        try {
            return postConfirmationReply(event, message);
        } catch (e) {
            errorMessage += e.message + "\n";
            const waitTime = Math.pow(2, tries) * 1000 + (Math.random() * 1000);
            Utilities.sleep(waitTime);
            tries++;
        }
    }
    // 3回試行しても成功しなかった場合、エラーを投げる
    throw new Error("参度すらつくに伝えんとすれども、叶わぬ。 ```" + errorMessage + "```");
}

/**
 * SlackのユーザーIDから本名（real_name）を取得する
 * @param {string} userId ユーザーID (例: U01234567)
 * @return {string | null} ユーザーの本名。取得失敗時はnull。
 */
function getUserRealName(userId) {
    if (!userId) return null;

    const cache = CacheService.getScriptCache();
    const cachedName = cache.get('userId_' + userId);
    if (cachedName) {
        return cachedName;
    }

    Utilities.sleep(500);
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('SLACK_BOT_TOKEN');
    const url = `https://slack.com/api/users.info?user=${userId}`;

    const options = {
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + token }
    };

    try {
        const response = UrlFetchApp.fetch(url, options);
        const json = JSON.parse(response.getContentText());

        if (json.ok && json.user) {
            const realName = json.user.real_name;
            cache.put('userId_' + userId, realName, 21600);
            return realName;
        } else {
            console.error('Slack API error (users.info):', json.error || 'Unknown error');
            return null;
        }
    } catch (e) {
        console.error('Error in getUserRealName:', e.message);
        return null;
    }
}

/**
 * SlackのチャンネルIDからチャンネル名を取得します。
 * @param {string} channelId チャンネルID (例: C12345678)
 * @return {string | null} チャンネル名。取得失敗時はnullを返す。
 */
function getChannelName(channelId) {
    if (!channelId) return null;

    const cache = CacheService.getScriptCache();
    const cachedName = cache.get('channelId_' + channelId);
    if (cachedName) {
        return cachedName;
    }

    Utilities.sleep(500);
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('SLACK_BOT_TOKEN');
    const url = `https://slack.com/api/conversations.info?channel=${channelId}`;

    const options = {
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + token }
    };

    try {
        const response = UrlFetchApp.fetch(url, options);
        const json = JSON.parse(response.getContentText());

        if (json.ok && json.channel) {
            const channelName = json.channel.name;
            cache.put('channelId_' + channelId, channelName, 21600);
            return channelName;
        } else {
            console.error('Slack API error (conversations.info):', json.error || 'Unknown error');
            return null;
        }
    } catch (e) {
        console.error('Error in getChannelName:', e.message);
        return null;
    }
}


/**
 * APIを使わず、Slack投稿のパーマリンク（個別URL）を生成する
 * @param {object} event Slackのイベントオブジェクト
 * @return {string} 投稿のURL
 */
function getPermalink(event) {
    const properties = PropertiesService.getScriptProperties();
    const domain = properties.getProperty('SLACK_DOMAIN');
    const channelId = event.channel;
    const ts = event.ts;
    const threadTs = event.thread_ts;

    const tsId = ts.replace('.', '');
    let url = `https://${domain}.slack.com/archives/${channelId}/p${tsId}`;

    // スレッド返信の場合、thread_ts パラメータを付与
    if (threadTs && threadTs !== ts) {
        url += `?thread_ts=${threadTs}&cid=${channelId}`;
    }

    return url;
}

/**
 * スレッド内の全メッセージを取得します。
 * @param {string} channelId チャンネルID
 * @param {string} threadTs スレッドのタイムスタンプ
 * @return {Array} メッセージオブジェクトの配列
 */
function getThreadMessages(channelId, threadTs) {
    Utilities.sleep(500);
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('SLACK_BOT_TOKEN');
    const url = `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}`;

    const options = {
        method: 'get',
        headers: { 'Authorization': 'Bearer ' + token }
    };

    try {
        const response = UrlFetchApp.fetch(url, options);
        const json = JSON.parse(response.getContentText());
        if (json.ok) {
            return json.messages;
        } else {
            console.error('Slack API error (conversations.replies):', json.error);
            return [];
        }
    } catch (e) {
        console.error('Error in getThreadMessages:', e.message);
        return [];
    }
}

/**
 * Slackの指定したメッセージを削除します。
 * @param {string} channelId チャンネルID
 * @param {string} ts メッセージのタイムスタンプ
 */
function deleteMessage(channelId, ts) {
    if (!channelId || !ts) return null;

    Utilities.sleep(500);
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('SLACK_BOT_TOKEN');
    const url = 'https://slack.com/api/chat.delete';
    const options = {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: { 'Authorization': 'Bearer ' + token },
        payload: JSON.stringify({ channel: channelId, ts: ts })
    };
    try {
        UrlFetchApp.fetch(url, options);
    } catch (e) {
        console.error('Error deleting message:', e.message);
    }
}


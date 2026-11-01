/**
 * Slackの指定したチャンネル・スレッドにメッセージを投稿する
 * @param {string} channelId チャンネルID
 * @param {string} message 送信するメッセージ
 * @param {string} threadTs 返信先スレッドのタイムスタンプ
 * @param {boolean} useAngerIcon アイコンを変更するかどうか
 * @return {boolean} 送信に成功したらtrue
 */
function postRemindReply(channelId, message, threadTs, useAngerIcon) {
    Utilities.sleep(500);
    const properties = PropertiesService.getScriptProperties();
    const token = properties.getProperty('SLACK_BOT_TOKEN');
    const url = 'https://slack.com/api/chat.postMessage';
    const angerIconUrl = 'https://pbs.twimg.com/media/GwxiWlJawAEfxCW?format=jpg&name=medium';

    const payload = {
        channel: channelId,
        text: message,
        thread_ts: threadTs,
        username: '報衛門',
    };

    // アイコンを変更する
    if (useAngerIcon) {
        payload.icon_url = angerIconUrl;
    }

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
        throw new Error("postRemindReply Error:" + e.message);
    }
    return true;
}

/**
 * postRemindReply関数からAPIを呼び出し、メッセージの送信を行う。失敗した場合、5回再試行する。
 * @param {string} channelId チャンネルID
 * @param {string} message 送信するメッセージ
 * @param {string} threadTs 返信先スレッドのタイムスタンプ
 * @param {boolean} useAngerIcon アイコンを変更するかどうか
 * @return {boolean} 送信に成功したらtrue
 */
function postRemindReplyRetry(channelId, message, threadTs, useAngerIcon) {
    let tries = 0;
    let errorMessage = "";
    while (tries < 3) {
        try {
            return postRemindReply(channelId, message, threadTs, useAngerIcon);
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

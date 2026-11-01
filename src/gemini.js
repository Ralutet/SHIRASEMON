/**
 * Gemini（GEMINI_MODEL）によるメンションの読み取り
 * 1回の呼び出しで、意図（設定・停止・その他）と、リマインダーの間隔・内容・開始日時をまとめて読み取る。
 */

/** Gemini に返させるJSONの形 */
const INTERPRET_SCHEMA = {
    type: 'object',
    properties: {
        intent: { type: 'string', enum: ['SET_REMINDER', 'STOP_REMINDER', 'OTHER'] },
        interval_hours: { type: ['number', 'null'] },
        content: { type: ['string', 'null'] },
        start_time: { type: ['string', 'null'] },
    },
    required: ['intent', 'interval_hours', 'content', 'start_time'],
};

/**
 * メンションの本文から、意図とリマインダーの中身を読み取る（失敗したら何度か試す）
 * @param {string} text メンションの本文（ボットへのメンションは除いたもの）
 * @param {Date} now 現在時刻（「明日から」などの基準）
 * @return {{intent: string, interval_hours: number|null, content: string|null, start_time: string|null}}
 */
function interpretMention(text, now) {
    const prompt = buildInterpretPrompt(text, now);
    let errorMessage = '';
    for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
        try {
            return callGemini(prompt, INTERPRET_SCHEMA);
        } catch (e) {
            errorMessage += e.message + '\n';
            // 最後の試行でなければ、2秒・4秒…と待ってから再試行する
            if (tries < MAX_ATTEMPTS - 1) Utilities.sleep(Math.pow(2, tries) * 2000 + Math.random() * 1000);
        }
    }
    throw new Error('幾度じゑみにを伺えども、返答を得られぬ。\n```' + errorMessage + '```');
}

/**
 * 読み取りを頼むプロンプトを組み立てる
 * @param {string} text メンションの本文
 * @param {Date} now 現在時刻
 * @return {string}
 */
function buildInterpretPrompt(text, now) {
    const formattedNow = Utilities.formatDate(now, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
    const trimmedText = String(text).slice(0, MAX_PROMPT_TEXT_LENGTH);

    return `Slackでリマインダーのボットに届いたメッセージを読み、intent・interval_hours・content・start_time を返せ。

# 現在時刻
${formattedNow}（日本標準時）

# intent（意図）
- "SET_REMINDER": 新しいリマインダーの設定を頼んでいる、または時間について言及している。
- "STOP_REMINDER": リマインダーの停止・完了を伝えている、または感謝している。
    例: stop, erase, kill, キル, 消して, やめて, 終了, 完了, えんど, エンド, おわり, ありがとう, サンキュー, サンクス, ストップ
- "OTHER": 上記以外。

# interval_hours（リマインドの間隔）
- 時間単位の数にする（1分は0.016666、30分は0.5、2日は48）。
- intent が SET_REMINDER でないとき、または読み取れないときは null。

# content（リマインドの内容）
- 簡潔な動詞の終止形で要約する（例: 資料を作成する、メールを送る）。
- 名詞だけになるときは、末尾に「についての」を付ける（例: メールについての）。
- 「リマインド」「通知」「ストップ」などの命令の言葉は含めない。
- 読み取れないときは null。

# start_time（リマインドを始める日時）
- 「明日から」「今日の21時から」「6日の12時から」のような指定があれば、現在時刻を基準に日時を決める。
- ISO 8601 形式で、日本標準時の「+09:00」を必ず付ける（例: 2026-08-02T09:00:00+09:00）。
- 指定が無いとき、過去の日時になるときは null。

# 例（現在時刻が 2026-08-01T12:00:00+09:00 のとき）
- 「3時間ごとに通知して」 → {"intent": "SET_REMINDER", "interval_hours": 3, "content": null, "start_time": null}
- 「1時間おきに、家でろと言って」 → {"intent": "SET_REMINDER", "interval_hours": 1, "content": "家を出る", "start_time": null}
- 「明日の9時から1日ごとに教えて」 → {"intent": "SET_REMINDER", "interval_hours": 24, "content": null, "start_time": "2026-08-02T09:00:00+09:00"}
- 「30分毎にメールのリマインド」 → {"intent": "SET_REMINDER", "interval_hours": 0.5, "content": "メールについての", "start_time": null}
- 「この件、もう大丈夫です」 → {"intent": "STOP_REMINDER", "interval_hours": null, "content": null, "start_time": null}
- 「ありがとう！」 → {"intent": "STOP_REMINDER", "interval_hours": null, "content": null, "start_time": null}
- 「こんにちは」 → {"intent": "OTHER", "interval_hours": null, "content": null, "start_time": null}

# メッセージ
${trimmedText}`;
}

/**
 * Gemini API を呼び出し、生成された内容をJSONとして返す
 * @param {string} prompt プロンプト
 * @param {object} schema 返させるJSONの形
 * @return {object}
 */
function callGemini(prompt, schema) {
    // APIキーを読む
    const apiKey = getProp('GEMINI_API_KEY');
    if (!apiKey) throw new Error('GEMINI_API_KEY が設定されておらぬぞ。');

    // 決まった形のJSONで返させる（思考は最小にすると、速く出来も変わらない）
    Utilities.sleep(API_CALL_INTERVAL_MS);
    const response = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseJsonSchema: schema,
                thinkingConfig: { thinkingLevel: 'minimal' },
            },
        }),
    });

    // エラーが返っていれば、その内容を伝える
    const statusCode = response.getResponseCode();
    const body = response.getContentText();
    let json;
    try {
        json = JSON.parse(body);
    } catch (e) {
        throw new Error(`Gemini API Error: 応答がJSONではありません (HTTP ${statusCode})\n${body.slice(0, 300)}`);
    }
    if (json.error || statusCode < 200 || statusCode >= 300) {
        throw new Error(`Gemini API Error (HTTP ${statusCode}): ${json.error ? json.error.message : body.slice(0, 300)}`);
    }

    // 本文を取り出す（思考の部分は除く）
    const candidate = json.candidates && json.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    if (!parts || parts.length === 0) {
        throw new Error(`Gemini API Error: 本文が空でした。finishReason=${candidate ? candidate.finishReason : null}`);
    }
    return parseJsonText(parts.filter(part => !part.thought).map(part => part.text || '').join(''));
}

/**
 * モデルの出力をJSONとして読む
 * ```json の囲みは外す。それでも読めなければ、文中のJSONオブジェクトを末尾側から探す
 * （思考の文章が本文に混ざって返ってくることがあったため）。
 * @param {string} text モデルの出力
 * @return {object}
 */
function parseJsonText(text) {
    const cleaned = text
        .trim()
        .replace(/^```(json)?/i, '')
        .replace(/```$/, '')
        .trim();
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        const objects = cleaned.match(/\{[^{}]*\}/g) || [];
        for (let i = objects.length - 1; i >= 0; i--) {
            try {
                return JSON.parse(objects[i]);
            } catch (ignored) {
                // 読めない断片は飛ばして、次を試す
            }
        }
        throw new Error(`JSONとして読めぬ: ${e.message}\n出力: ${cleaned.slice(0, 300)}`);
    }
}

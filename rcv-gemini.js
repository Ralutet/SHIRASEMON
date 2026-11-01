/**
 * Gemini APIを呼び出し、生成されたテキストを取得します。
 * @param {string} prompt プロンプト
 * @param {object} schema 出力JSONスキーマ
 * @return {string} 解析結果（JSON形式）
 */
function callGemini(prompt, schema) {
    Utilities.sleep(500);
    const properties = PropertiesService.getScriptProperties();
    const apiKey = properties.getProperty('GEMINI_API_KEY');
    const model = 'gemma-4-31b-it';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
        "contents": [{
            "parts": [{
                "text": prompt
            }]
        }],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": schema
        }
    };

    const options = {
        'method': 'post',
        'contentType': 'application/json',
        'muteHttpExceptions': true,
        'payload': JSON.stringify(payload)
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseJson = JSON.parse(response.getContentText());

    if (responseJson.error) {
        throw new Error(`Gemini API Error: ${responseJson.error.message}`);
    }

    const candidate = responseJson.candidates && responseJson.candidates[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
        throw new Error(`Gemini Empty Response: ${response.getContentText()}`);
    }

    // 思考過程（thought）のパートを除外し、回答本文のみを連結する
    const resultText = candidate.content.parts
        .filter(part => !part.thought && part.text)
        .map(part => part.text)
        .join('');

    let cleanedText = resultText.trim();
    cleanedText = cleanedText.replace(/^```json/gi, '');
    cleanedText = cleanedText.replace(/^```/gi, '');
    cleanedText = cleanedText.replace(/```$/g, '');
    cleanedText = cleanedText.trim();

    try {
        return JSON.parse(cleanedText);
    } catch (e) {
        // 思考過程などが混入した場合、末尾側から解析可能なJSONオブジェクトを探す
        const extracted = extractLastJsonObject(cleanedText);
        if (extracted) return extracted;
        throw new Error(`Extraction Parse Error: ${e.message}\n Gemini Output Text: ${cleanedText}`);
    }
}

/**
 * テキスト中に含まれるJSONオブジェクトのうち、最後に解析できたものを返します。
 * @param {string} text 解析対象のテキスト
 * @return {object | null} 解析結果。見つからない場合はnull
 */
function extractLastJsonObject(text) {
    const matches = text.match(/\{[^{}]*\}/g);
    if (!matches) return null;
    for (let i = matches.length - 1; i >= 0; i--) {
        try {
            return JSON.parse(matches[i]);
        } catch (e) {
            // 解析できない断片は無視して次を試す
        }
    }
    return null;
}

/**
 * callGemini関数からAPIを呼び出し、生成されたテキストを返す。失敗した場合、5回再試行する。
 * @param {string} prompt プロンプト
 * @param {object} schema 出力JSONスキーマ
 * @return {string} 解析結果（JSON形式）
 */
function callGeminiRetry(prompt, schema) {
    let tries = 0;
    let errorMessage = "";
    while (tries < 5) {
        try {
            return callGemini(prompt, schema);
        } catch (e) {
            errorMessage += e.message + "\n";
            const waitTime = Math.pow(2, tries) * 5000 + (Math.random() * 1000);
            Utilities.sleep(waitTime);
            tries++;
        }
    }
    // 5回試行しても成功しなかった場合、エラーを投げる
    throw new Error("伍度じゑみにを伺えども、返答を得られぬ。 ```" + errorMessage + "```");
}


/**
 * Gemini（AI）を使用してユーザーのメッセージ意図を分類します。
 * @param {object} event Slackのイベントオブジェクト
 * @return {object} 分類結果 { intent: 'SET_REMINDER' | 'STOP_REMINDER' | 'OTHER' }
 */
function classifyIntent(event) {
    const prompt = `
    ユーザーのテキストから意図を分類し、JSONで返してください。
    分類は "SET_REMINDER", "STOP_REMINDER" のいずれかです。
    どちらでもない場合は、"OTHER" を返してください。

    - "SET_REMINDER": 新しいリマインダーを設定、または時間について言及している。
    - "STOP_REMINDER": リマインダーの停止、完了、感謝を伝えている。
        例：stop, erase, kill, キル, 消して, やめて, 終了, 完了，えんど，エンド，おわり，ありがとう，サンキュー，サンクス、ストップ
    - "OTHER": 上記以外。

    例:
    - "3時間ごとに通知して" -> {"intent": "SET_REMINDER"}
    - "1日毎に教えろ" -> {"intent": "SET_REMINDER"}
    - "ほにゃららの件、1分毎にリマインダー" -> {"intent": "SET_REMINDER"}
    - "この件、もう大丈夫です" -> {"intent": "STOP_REMINDER"}
    - "ありがとう！" -> {"intent": "STOP_REMINDER"}
    - "こんにちは" -> {"intent": "OTHER"}

    ---
    テキスト: "${event.text}"
    `;

    const schema = {
        "type": "object",
        "properties": {
            "intent": {
                "type": "string",
                "enum": ["SET_REMINDER", "STOP_REMINDER", "OTHER"]
            }
        },
        "required": ["intent"]
    };

    return callGeminiRetry(prompt, schema);
}

/**
 * Geminiを使用して、テキストからリマインドの間隔、内容、開始日時、コメントを抽出する。
 * @param {object} event Slackのイベントオブジェクト
 * @return {object} { interval_hours: number | null, content: string | null, start_time: string | null }
 */
function extractReminderInfo(event) {
    const now = new Date();
    const formattedNow = Utilities.formatDate(now, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");

    const schema = {
        "type": "object",
        "properties": {
            "interval_hours": { "type": ["number"] },
            "content": { "type": ["string", "null"] },
            "start_time": { "type": ["string", "null"], "format": "date-time" }
        },
        "required": ["interval_hours"]
    };

    const prompt = `
    以下のテキストから「リマインドの間隔」「リマインドのメッセージ内容」「リマインドを開始する日時」を抽出し、JSONで返してください。

    # 現在時刻
    ${formattedNow} (日本標準時/JST)

    # 指示
    1. 間隔 (interval_hours):
        - 時間単位の数値に変換してください（例: 1分は0.016666、30分は0.5、2日は48）。
        - 認識できない場合は null を返してください。
    2. メッセージ内容 (content):
        - 基本的に簡潔な動詞の終止形で要約してください（例: 資料を作成する、メールを送る）。
        - 名詞単体となる場合、末尾に「についての」を必ず入れてください。
        - アラーム、リマインド、ストップなどの命令語は含めないでください。
        - 認識できない場合は null を返してください。
    3. 開始日時 (start_time):
        - 「明日から」「今日の21時から」「6日の12時から」といった表現がある場合、現在時刻を基準にその日時を特定してください。
        - 結果は ISO 8601 形式 (YYYY-MM-DDThh:mm:ss+09:00) の文字列で返してください。
        - タイムゾーンは必ず日本標準時（+09:00）を含めてください。
        - 明示的な指定がない場合や、過去の日時の場合は null を返してください。

    # 例(現在時刻が2026-08-01T12:00:00の場合)
    - "1時間おきに、家でろと言って" -> {"interval_hours": 1, "content": "家を出る", "start_time": null}
    - "明日の9時から1日ごとに教えて" -> {"interval_hours": 24, "content": null, "start_time": "2026-08-02T09:00:00"}
    - "30分毎にメールのリマインド" -> {"interval_hours": 0.5, "content": "メールについての", "start_time": null}

    ---
    テキスト: "${event.text}"
    `;

    return callGeminiRetry(prompt, schema);
}
/**
 * GASエディタから手で流すテスト（Slack やシートには書き込まない）
 *   testInterpretMention … TEST_CASES を Gemini に読み取らせ、正解と突き合わせる（Gemini を呼ぶ）
 *   testHelpers          … 文面の選び方・間隔の言葉・開始日時の読み方を確かめる（外部は呼ばない）
 * 本番で読み違いがあったら、そのメッセージと正解を TEST_CASES に足して確かめる。
 */

/** 読み取りのテスト事例（interval_hours は省けば確かめない） */
const TEST_CASES = [
    { text: '3時間ごとに通知して', intent: 'SET_REMINDER', interval_hours: 3 },
    { text: '1日毎に教えろ', intent: 'SET_REMINDER', interval_hours: 24 },
    { text: 'ほにゃららの件、1分毎にリマインダー', intent: 'SET_REMINDER', interval_hours: 0.016666 },
    { text: '30分毎にメールのリマインド', intent: 'SET_REMINDER', interval_hours: 0.5 },
    { text: '20:00から1時間ごとにリマインド', intent: 'SET_REMINDER', interval_hours: 1 },
    { text: 'この件、もう大丈夫です', intent: 'STOP_REMINDER' },
    { text: 'ありがとう！', intent: 'STOP_REMINDER' },
    { text: 'こんにちは', intent: 'OTHER' },
];

/**
 * TEST_CASES を Gemini に読み取らせ、正解と突き合わせる
 */
function testInterpretMention() {
    let failures = 0;
    TEST_CASES.forEach(testCase => {
        const result = interpretMention(testCase.text, new Date());
        const intentOk = result.intent === testCase.intent;
        const intervalOk = testCase.interval_hours === undefined
            || Math.abs(Number(result.interval_hours) - testCase.interval_hours) < 0.001;
        if (!intentOk || !intervalOk) failures++;
        console.log(`${intentOk && intervalOk ? 'OK ' : 'NG '} ${testCase.text} → ${JSON.stringify(result)}`);
    });
    console.log(`${TEST_CASES.length}件中 ${TEST_CASES.length - failures}件 正解`);
}

/**
 * 外部を呼ばない道具を確かめる
 */
function testHelpers() {
    const checks = [
        ['いつもの文面', buildReminderMessage(0, '資料を作成する').text.startsWith('差し出がましいとは存じますが、資料を作成する件'), true],
        ['5回目は怒る', buildReminderMessage(5, null).angry, true],
        ['26回目は愛想を尽かす', buildReminderMessage(26, '資料を作成する').text, GIVE_UP_MESSAGE],
        ['送信が遅れても予定はずれない', calcNextTime(28800, 24, 28800 + 480), 28800 + 86400],
        ['止まっていた分は飛ばす', calcNextTime(0, 1, 3600 * 5 + 10), 3600 * 6],
        ['48時間は2日', describeInterval(48), '2 日'],
        ['0.5時間は30分', describeInterval(0.5), '30 分'],
        ['時差なしは日本時間', parseStartTime('2026-08-02T09:00:00'), parseStartTime('2026-08-02T09:00:00+09:00')],
        ['読めない日時はnull', parseStartTime('あした'), null],
        ['思考の混じった出力', parseJsonText('* 考え: {"intent": "string"}\n* 答え: `{"intent": "SET_REMINDER"}`').intent, 'SET_REMINDER'],
    ];
    checks.forEach(([name, actual, expected]) => {
        console.log(`${actual === expected ? 'OK ' : 'NG '} ${name}: ${JSON.stringify(actual)}`);
    });
}

# SHIRASEMON（報衛門）

periodically remind bot on Slack

Slack でメンションして「1時間ごとにリマインドして」のように頼むと、そのスレッドに定期的にリマインドを送る、武士言葉の GAS（Google Apps Script）ボット。
済んだら「ありがとう」「end」などとメンションすれば止まる。

```
@報衛門 資料作成、明日の9時から1日ごとにリマインド
  └ 資料を作成する件、11月02日 09時00分 より、 1 日おきに、必ずや報せに参ります。
  └ @あなた 差し出がましいとは存じますが、資料を作成する件、捗っておりますか。…（1日おき）
@報衛門 ありがとう
  └ 報せの務め、完了いたしました。
```

## 使い方

| メンションの本文 | 動き |
|---|---|
| 間隔を含む依頼（「3時間おきに」「30分ごとに」「明日の9時から毎日」） | そのスレッドにリマインダーを設定する（1スレッドに1つ） |
| 停止・完了・お礼（「終わった」「やめて」「ありがとう」） | リマインダーを止め、リマインドの投稿を消す |
| `end` | 上と同じ（Gemini を通さずに止める） |
| `erase` | リマインドの投稿を消すだけ（リマインダーは止めない） |

- 依頼文で他の人をメンションすると、その人にも CC でリマインドが届く
- 何度も放っておくと、5回目から機嫌が悪くなり、25回を超えると愛想を尽かす

## 処理の流れ

```
Slack のメンション ─▶ doPost → handleMention（receiver.js）
   1. 本文が「erase」「end」だけなら、そのまま扱う
   2. それ以外は Gemini に、意図（設定・停止・その他）と、間隔・内容・開始日時を1回で読み取らせる   gemini.js
   3. 設定なら registerReminder でシートに1行足して返信、停止なら stopReminder               reminderSheet.js / slack.js

1分おきのトリガー ─▶ sendScheduledReminders（sender.js）
   時刻が来たリマインダーをスレッドに送り、次の時刻（予定の時刻 + 間隔）と回数を書き換える
   対応済みの行を消し、いちばん早い次の時刻を控える（その時刻までは、シートを開かずに休む）
```

- 次に確かめる時刻はスクリプトプロパティ `NEXT_CHECK_TIME` に控える。休むのは最長10分なので、シートを手で書き換えても10分以内には読み直す
- 設定・停止と送信は `LockService` で順番に動く（止めた直後にリマインドが届かないように）
- 送信に失敗したら、理由をスレッドに知らせて次の時刻へ進める。アーカイブ済み・チャンネルに入れない・間隔が壊れているものは止め、状態を書き換える

## ファイル構成

`src/` が clasp の rootDir（`clasp push` で送られるのはここだけ）。

| ファイル | 役割 |
|---|---|
| `config.js` | 設定・定数（シートの列の位置、文面、モデル名など）。まず読むならここ |
| `receiver.js` | Slack からのメンションを受け取り、リマインダーを設定・停止する |
| `sender.js` | 時刻が来たリマインダーを送る |
| `gemini.js` | Gemini によるメンションの読み取り |
| `reminderSheet.js` | 記録用シートの読み書き |
| `slack.js` | Slack Web API の呼び出し |
| `tests.js` | GAS エディタから手で流すテスト |

## 準備

### 1. スプレッドシート

`記録用シート` という名前のシートを作り、1行目に見出しを置く（2行目から1行 = 1件のリマインダー）。
列の並びは `config.js` の `COL` のとおり。状態が「対応済み」になった行は、送信のトリガーが自動で消す。

```
タイムスタンプ | 投稿日時 | 状態 | ユーザーID | ユーザー名 | CC ID | CC 名 | 依頼文 | チャンネルID | チャンネル名 | スレッド | リンク | 間隔(時間) | 次の時刻 | 回数 | 内容
```

### 2. Slack App

- Bot Token Scopes: `app_mentions:read`, `chat:write`, `chat:write.customize`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`
- Event Subscriptions: `app_mention` を購読し、Request URL に GAS のウェブアプリの URL を登録

### 3. GAS

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # scriptId を自分の GAS プロジェクトのものにする
clasp push
```

スクリプトプロパティ:

| 名前 | 内容 |
|---|---|
| `GEMINI_API_KEY` | Gemini API のキー |
| `SLACK_BOT_TOKEN` | `xoxb-` から始まる Bot User OAuth Token |
| `SLACK_BOT_ID` | ボットのユーザーID（`U` から始まる） |
| `SLACK_DOMAIN` | ワークスペースのドメイン（`xxx.slack.com` の `xxx`） |
| `SPREADSHEET_ID` | 記録用シートのあるスプレッドシートの ID |

トリガー: `sendScheduledReminders` を「時間主導型・1分おき」で登録する。

## デプロイ

1. `clasp push`
2. GAS エディタの「デプロイを管理」で、今のデプロイを新しいバージョンに更新（自分として実行・全員がアクセス可）
3. 新しくデプロイを作ったときだけ、Slack App の Event Subscriptions に、ウェブアプリの URL を登録

`sendScheduledReminders`（トリガー）は push した時点で新しいコードで動く。`doPost`（ウェブアプリ）はデプロイを更新するまで古いコードのまま。

## テスト（GAS エディタから実行。Slack やシートには書き込まない）

- `testHelpers` … 文面の選び方・間隔の言葉・開始日時の読み方を確かめる
- `testInterpretMention` … `tests.js` の `TEST_CASES` を Gemini に読み取らせ、正解と突き合わせる

読み違いがあったら、そのメッセージと正解を `TEST_CASES` に足して確かめる。

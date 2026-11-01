/**
 * 期限切れのリマインダーを送信し、次回の時間を更新する
 * GASのトリガーで1分毎に実行する
 */
function sendScheduledReminders() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName('記録用シート');
  const data = sheet.getDataRange().getValues();

  const now = Math.floor(new Date().getTime() / 1000);

  // ヘッダー行を除いてループ
  for (let i = 1; i < data.length; i++) {
    const row = data[i];

    const status = row[2];
    const userId = row[3];
    const ccuserId = row[5];
    const channelId = row[8];
    const threadTs = row[10];
    const intervalHours = row[12];
    const nextReminderTime = row[13];
    const reminderCount = row[14];
    const reminderContent = row[15];

    // 「リマインド中」で、実行時刻を過ぎている場合
    if (status === 'リマインド中' && nextReminderTime && now >= nextReminderTime) {


      try {
        let useAngerIcon = false;
        let message = '';

        switch (reminderCount) {
          case 5:
            message = '失礼。例の件、未だお済みではござりませぬか。一体、いかなるご事情か。仕舞いましたら、疾くご一報を。';
            useAngerIcon = true;
            break;
          case 10:
            message = '例の件、一体いつまでお待たせすれば気が済み申すか。拙者の務めを軽んじておられるか。迅速に済ませ、ご通達を。';
            useAngerIcon = true;
            break;
          case 15:
            message = 'これほど報せても動かぬとは、主も地に落ちたもの。例の件、もはや為遂げる気概もおありでないか。';
            useAngerIcon = true;
            break;
          case 20:
            message = 'これが何度目の報せと心得るか。例の件、最早拙者の忍耐も限界にござる。次が最後と思われよ。';
            useAngerIcon = true;
            break;
          case 25:
            message = 'もう、お声がけはいたしませぬ。例の件、貴殿には荷が勝ちすぎた様子。このような主に仕えた拙者が愚かであった。';
            useAngerIcon = true;
            break;
          default:
            // 25回より大きい場合もこのメッセージ
            if (reminderCount > 25) {
              message = '......';
              useAngerIcon = true;
            } else {
              // 通常のリマインドメッセージ
              message = '差し出がましいとは存じますが、例の件、捗っておりますか。仕舞と相成りましたら、当方へメンションにてご通達を。';
            }
            break;
        }

        // リマインド内容の差し込み
        if (reminderContent && reminderCount <= 25) {
          message = message.replace('例の件', `${reminderContent}件`);
        }

        // CCの差し込み
        if (ccuserId) {
          message = 'CC: ' + formatIdsToMentions(ccuserId) + '\n' + message;
        }
        message = `<@${userId}> \n` + message;

        const success = postRemindReplyRetry(channelId, message, threadTs.toString(), useAngerIcon);

        if (success) {
          // 次回の時間を計算して更新（時間単位）
          const newNextTime = now + (intervalHours * 60 * 60);
          sheet.getRange(i + 1, 14).setValue("'" + newNextTime); // I列を更新

          // 回数を更新
          sheet.getRange(i + 1, 15).setValue(reminderCount + 1); // J列を更新
        }
      } catch (e) {
        // エラー内容に 'is_archived' (チャンネルがアーカイブ済み) が含まれるか確認
        if (e.message.includes('is_archived')) {
          // スプレッドシートのステータスを更新して、次回の無限ループを防ぐ
          sheet.getRange(i + 1, 3).setValue('チャンネルアーカイブ済');
        }

        try {
          postRemindReplyRetry(channelId, '由々しき事態が起きておる。 ```' + e.message + '```', threadTs.toString(), false);
        } catch (e) {
          // エラー通知も失敗した場合は無視
        }

      }
    }
  }
}


/**
 * カンマ区切りのユーザーID文字列を、Slackのメンション形式（カンマ区切り）に変換します。
 * @param {string} idString カンマ区切りのユーザーID文字列 (例: "U01,U02")
 * @returns {string} Slackのメンション形式の文字列 (例: "<@U01>, <@U02>")
 */
function formatIdsToMentions(idString) {
  // 1. ID文字列が空の場合は、何もせずに空文字列を返す
  if (!idString) {
    return '';
  }

  // 2. カンマで文字列を分割して、IDの配列を作成する
  const ids = idString.split(',');

  // 3. 配列の各IDをメンション形式 <@ID> に変換する
  const mentions = ids.map(id => {
    // idの前後の余分な空白を削除
    const trimmedId = id.trim();
    return `<@${trimmedId}>`;
  });

  // 4. メンション形式の配列を「カンマ＋半角スペース」で連結して返す
  return mentions.join(', ');
}
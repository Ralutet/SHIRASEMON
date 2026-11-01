/**
 * リマインダー記録用のスプレッドシートシートを取得します。
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet() {
    const properties = PropertiesService.getScriptProperties();
    const spreadsheetId = properties.getProperty('SPREADSHEET_ID');
    return SpreadsheetApp.openById(spreadsheetId).getSheetByName('記録用シート');
}



const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const app = express();
const port = process.env.PORT || 3000;

// Google Sheets設定
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'FlowData';  // 固定

// ログ用
const logs = [];
let browser;

function addLog(step, detail = '', dump = null, level = 'info') {
  logs.push({ timestamp: new Date().toISOString(), step, detail, dump, level });
  if (logs.length > 500) logs.shift();
}

// Google Sheets APIクライアント作成
async function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

// Puppeteer起動（リトライ付き）
async function launchBrowserWithRetry(maxRetries = 3, waitMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      addLog('Puppeteer起動', `試行${attempt}回目`);
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process'
        ]
      });
      addLog('Puppeteer起動成功');
      return;
    } catch (e) {
      addLog('Puppeteer起動失敗', e.message, null, 'error');
      if (attempt === maxRetries) throw e;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

// Unazukiダム観測データ取得（tbodyから正しく読む版）
async function fetchUnazukiData() {
  if (!browser) await launchBrowserWithRetry();

  const page = await browser.newPage();
  try {
    await page.setCacheEnabled(true);
    await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6', {
      timeout: 60000,
      waitUntil: 'networkidle2'
    });
    await page.waitForSelector('table', { timeout: 10000 });

    const rawData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => Array.from(row.querySelectorAll('td')).map(col => col.innerText.trim()));
    });

    addLog('データ取得成功', `行数: ${rawData.length}`);

    let currentDate = null;
    const year = new Date().getFullYear();

    const parsedData = rawData
      .map(cols => {
        if (cols.length < 11) return null;  // 必要な列がない場合スキップ

        let [date, time, waterLevel, , , , , inflow, outflow, rain10min, rainTotal] = cols;

        if (date) {
          currentDate = date;
        } else {
          date = currentDate;
        }

        if (!date || !time) return null;

        const obsDateTimeStr = `${year}/${date} ${time}`;
        const obsDate = new Date(obsDateTimeStr);
        if (isNaN(obsDate)) return null;

        return {
          obsDateTime: obsDate,
          row: [date, time, waterLevel, inflow, outflow, rain10min, rainTotal]
        };
      })
      .filter(x => x !== null);

    parsedData.sort((a, b) => a.obsDateTime - b.obsDateTime);

    return parsedData.map(x => x.row);
  } finally {
    await page.close();
  }
}

// スプレッドシートに書き込み
async function writeToSheet(dataRows) {
  const sheets = await getSheetsClient();
  const now = new Date().toISOString(); // 取得時刻

  const values = dataRows.map(row => [
    now,
    ...row
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values }
  });

  addLog('スプレッドシート書き込み成功', `行数: ${values.length}`);
}

// /health エンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({ status: "ok", browserAlive: !!browser, timestamp: new Date().toISOString() });
});

// /unazuki エンドポイント
app.get('/unazuki', async (req, res) => {
  try {
    const data = await fetchUnazukiData();
    await writeToSheet(data);
    res.status(200).json({ success: true, rows: data.length });
  } catch (e) {
    addLog('unazukiエラー', e.message, null, 'error');
    res.status(500).json({ success: false, message: e.message });
  }
});

// /getlog エンドポイント
app.get('/getlog', (req, res) => {
  res.status(200).json(logs);
});

// サーバー起動
app.listen(port, async () => {
  addLog('サーバー起動', `ポート: ${port}`);
  try {
    await launchBrowserWithRetry();
  } catch (e) {
    addLog('初回起動失敗', e.message, null, 'error');
  }
});

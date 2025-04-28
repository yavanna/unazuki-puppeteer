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

// Unazukiダム観測データ取得（超安全版）
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

    let currentDateText = null;
    const year = new Date().getFullYear();

    const excelDateToString = (serial) => {
      const epoch = new Date(1899, 11, 30);
      const days = Number(serial);
      const date = new Date(epoch.getTime() + days * 86400000);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      return `${month}/${day}`;
    };

    const parsedData = rawData
      .map(cols => {
        try {
          if (cols.length < 11) return null;

          const dateRaw = cols[0];
          const timeRaw = cols[1];
          const waterLevel = cols[2];
          const storageVolume = cols[3];
          const utilCapacity = cols[4];
          const effCapacity = cols[5];
          const floodCapacity = cols[6];
          const inflow = cols[7];
          const outflow = cols[8];
          const rain10min = cols[9];
          const rainTotal = cols[10];

          let dateFixed = currentDateText;
          if (dateRaw) {
            if (!isNaN(dateRaw) && !dateRaw.includes('/')) {
              dateFixed = excelDateToString(dateRaw);
            } else {
              dateFixed = dateRaw;
            }
            currentDateText = dateFixed;
          }

          if (!dateFixed || !timeRaw) return null;

          let timeFixed = timeRaw;
          let dateFixedForObs = dateFixed;
          if (timeRaw.startsWith('24:')) {
            timeFixed = '00:' + timeRaw.split(':')[1];
            const dateParts = dateFixed.split('/');
            const tempDate = new Date(`${year}/${dateParts[0]}/${dateParts[1]} 00:00`);
            tempDate.setDate(tempDate.getDate() + 1);
            const month = (tempDate.getMonth() + 1).toString().padStart(2, '0');
            const day = tempDate.getDate().toString().padStart(2, '0');
            dateFixedForObs = `${month}/${day}`;
          }

          const obsDateTimeStr = `${year}/${dateFixedForObs} ${timeFixed}`;
          const obsDate = new Date(obsDateTimeStr);
          if (isNaN(obsDate)) return null;

          return {
            obsDateTime: obsDate,
            row: [
              dateFixedForObs,
              timeFixed,
              waterLevel,
              storageVolume,
              utilCapacity,
              effCapacity,
              inflow,
              outflow,
              rain10min,
              rainTotal
            ]
          };
        } catch (error) {
          console.error('データパースエラー:', error);
          return null;
        }
      })
      .filter(x => x !== null);

    parsedData.sort((a, b) => a.obsDateTime - b.obsDateTime);

    return parsedData.map(x => x.row);
  } catch (e) {
    console.error('fetchUnazukiDataエラー:', e);
    throw e;
  } finally {
    await page.close();
  }
}

// スプレッドシートに書き込み
async function writeToSheet(dataRows) {
  const sheets = await getSheetsClient();
  const now = new Date().toISOString();

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

// /healthエンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({ status: "ok", browserAlive: !!browser, timestamp: new Date().toISOString() });
});

// /unazukiエンドポイント
app.get('/unazuki', async (req, res) => {
  try {
    const data = await fetchUnazukiData();
    await writeToSheet(data);
    res.status(200).json({ success: true, rows: data.length });
  } catch (e) {
    addLog('unazukiエラー', e.message, null, 'error');
    console.error('unazukiエンドポイントエラー:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// /getlogエンドポイント
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
    console.error('サーバー起動エラー:', e);
  }
});

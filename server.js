// 最終版 server.js（観測値一覧テーブル限定で取得する版）

const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const app = express();
const port = process.env.PORT || 3000;

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'FlowData';

const logs = [];
let browser;

function addLog(step, detail = '', dump = null, level = 'info') {
  logs.push({ timestamp: new Date().toISOString(), step, detail, dump, level });
  if (logs.length > 500) logs.shift();
}

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function launchBrowserWithRetry(maxRetries = 3, waitMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      addLog('Puppeteer起動', `試行${attempt}回目`);
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process']
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

async function fetchUnazukiData() {
  if (!browser) await launchBrowserWithRetry();
  const page = await browser.newPage();
  try {
    await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6', {
      timeout: 60000,
      waitUntil: 'networkidle2'
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(5000);

    const rawData = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      const targetTable = tables.find(tbl => tbl.innerText.includes('貯水率利水容量'));
      if (!targetTable) return [];
      const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
      return rows.map(row => Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()));
    });

    addLog('データ取得成功', `行数: ${rawData.length}`);

    for (let i = 0; i < Math.min(5, rawData.length); i++) {
      addLog(`取得行${i}`, '', rawData[i]);
    }

    let currentDate = null;
    const year = new Date().getFullYear();
    const excelDateToString = (serial) => {
      const epoch = new Date(1899, 11, 30);
      const date = new Date(epoch.getTime() + Number(serial) * 86400000);
      return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    };

    const parsed = rawData
      .map(cols => {
        try {
          if (cols.length < 11) return null;
          const [dateRaw, timeRaw, wl, sv, ul, el, , inF, outF, rain10, rainSum] = cols;

          let date = currentDate;
          if (dateRaw) {
            date = (!isNaN(dateRaw) && !dateRaw.includes('/')) ? excelDateToString(dateRaw) : dateRaw;
            currentDate = date;
          }

          if (!date || !timeRaw) return null;

          let dateForObs = date;
          let time = timeRaw;
          if (timeRaw.startsWith('24:')) {
            time = '00:' + timeRaw.split(':')[1];
            const tmp = new Date(`${year}/${date} 00:00`);
            tmp.setDate(tmp.getDate() + 1);
            dateForObs = `${String(tmp.getMonth() + 1).padStart(2, '0')}/${String(tmp.getDate()).padStart(2, '0')}`;
          }

          const obsDate = new Date(`${year}/${dateForObs} ${time}`);
          if (isNaN(obsDate)) return null;

          return {
            obsDateTime: obsDate,
            row: [`${year}-${dateForObs} ${time}`, wl, sv, ul, el, '--', inF, outF, rain10, rainSum]
          };
        } catch {
          return null;
        }
      })
      .filter(r => r);

    parsed.sort((a, b) => a.obsDateTime - b.obsDateTime);
    return parsed.map(x => x.row);
  } finally {
    await page.close();
  }
}

async function writeToSheet(dataRows) {
  const sheets = await getSheetsClient();
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  const values = dataRows.map(row => [jstNow, ...row]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    resource: { values }
  });
  addLog('スプレッドシート書き込み成功', `行数: ${values.length}`);
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', browserAlive: !!browser, timestamp: new Date().toISOString() });
});

app.get('/unazuki', async (req, res) => {
  try {
    const data = await fetchUnazukiData();
    await writeToSheet(data);
    res.status(200).json({ success: true, rows: data.length });
  } catch (e) {
    addLog('unazukiエラー', e.message, null, 'error');
    console.error('unazukiエラー:', e);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/getlog', (req, res) => {
  res.status(200).json(logs);
});

app.listen(port, async () => {
  addLog('サーバー起動', `ポート: ${port}`);
  try {
    await launchBrowserWithRetry();
  } catch (e) {
    addLog('初回起動失敗', e.message, null, 'error');
  }
});

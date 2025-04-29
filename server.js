// server.js - ページ上のすべてのテーブル内容を確認するログ付きデバッグ版

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
    await page.setCacheEnabled(false);
    await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6', {
      timeout: 60000,
      waitUntil: 'networkidle2'
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(5000);

    const tables = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table')).map((table, index) => {
        const caption = table.querySelector('caption')?.innerText || `テーブル${index}`;
        const head = Array.from(table.querySelectorAll('thead tr')).map(tr => Array.from(tr.querySelectorAll('th')).map(th => th.innerText));
        const rows = Array.from(table.querySelectorAll('tbody tr')).map(row =>
          Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim())
        );
        return { caption, head, rows };
      });
    });

    addLog('テーブル総数', `count: ${tables.length}`);
    tables.slice(0, 5).forEach((tbl, i) => {
      addLog(`テーブル${i} caption`, tbl.caption);
      addLog(`テーブル${i} ヘッダ`, '', tbl.head);
      addLog(`テーブル${i} 先頭行`, '', tbl.rows[0]);
    });

    return [];
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

// server.js（コピー相当データ直読版）
const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const sheetName = 'FlowData';

function getFetchTime() {
  const now = new Date();
  now.setHours(now.getHours() + 9);
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

async function fetchData() {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const url = 'https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6';

  page.on('console', msg => {
    console.log(`📢 [browser log] ${msg.type()}: ${msg.text()}`);
  });

  console.info('🌐 ページ遷移:', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('table tbody');
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.info('📋 コピー相当データ読み取り開始');
  const copiedText = await page.evaluate(() => {
    const table = document.querySelector('table tbody');
    if (!table) return '';

    let result = '';
    const rows = table.querySelectorAll('tr');
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(cell => cell.innerText.trim());
      if (cells.length > 0) {
        result += cells.join('\t') + '\n';
      }
    }
    return result;
  });

  console.info('📋 コピー相当データ:', copiedText);

  const rows = copiedText.trim().split('\n').map(line => {
    const parts = line.split('\t');
    return {
      date: parts[0] || '',
      time: parts[1] || '',
      waterLevel: parts[2] || '',
      waterStorage: parts[3] || '',
      irrigationRate: parts[4] || '',
      effectiveRate: parts[5] || '',
      floodRate: parts[6] || '',
      inflow: parts[7] || '',
      outflow: parts[8] || '',
      rain10min: parts[9] || '',
      rainAccum: parts[10] || ''
    };
  });

  await browser.close();
  console.info('🛑 Puppeteerブラウザクローズ完了');

  return rows;
}

async function writeToSheet(newRows) {
  const auth = new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B2:B`
  });

  const existingObservedTimes = res.data.values ? res.data.values.flat() : [];
  const fetchTime = getFetchTime();

  const sortedRows = newRows.sort((a, b) => new Date(`${a.date} ${a.time}`) - new Date(`${b.date} ${b.time}`));
  const rowsToAdd = sortedRows.filter(row => !existingObservedTimes.includes(`${row.date} ${row.time}`));

  if (rowsToAdd.length === 0) {
    console.info('✅ 追加データなし');
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rowsToAdd.map(row => [
        fetchTime,
        `${row.date} ${row.time}`,
        row.waterLevel,
        row.waterStorage,
        row.irrigationRate,
        row.effectiveRate,
        row.floodRate,
        row.inflow,
        row.outflow,
        row.rain10min,
        row.rainAccum
      ]),
    },
  });

  console.info('✅ シート更新完了');
}

app.get('/unazuki', async (req, res) => {
  try {
    const rows = await fetchData();
    console.info('📥 fetchData完了、rows件数:', rows.length);

    if (rows.length === 0) {
      res.send('❌ データなし');
      return;
    }

    await writeToSheet(rows);
    res.send('✅ 保存完了！');
  } catch (error) {
    console.error('❌ エラー:', error.message);
    res.status(500).send('❌ サーバーエラー');
  }
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send('Hello Unazuki World!');
});

app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});

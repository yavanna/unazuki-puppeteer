// server.js（tbody.innerText版・観測値一覧 正式対応）
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

  console.log('🌐 ページ遷移:', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForSelector('table tbody');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const year = new Date().getFullYear();

  const rows = await page.evaluate((year) => {
    const data = [];
    const tbodyText = document.querySelector('table tbody').innerText;
    const lines = tbodyText.split('\n');
    let lastDate = null;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      let [date, time, waterLevel, waterStorage, irrigationRate, effectiveRate, floodRate, inflow, outflow, rain10min, rainAccum] = parts;

      if (date.includes('/')) {
        lastDate = date;
      } else {
        time = date;
        date = lastDate;
      }

      if (!date || !time) continue;

      const fullDateTime = new Date(`${year}/${date} ${time}`);
      fullDateTime.setHours(fullDateTime.getHours() + 9);

      const formattedDateTime = `${fullDateTime.getFullYear()}/${String(fullDateTime.getMonth() + 1).padStart(2, '0')}/${String(fullDateTime.getDate()).padStart(2, '0')} ${String(fullDateTime.getHours()).padStart(2, '0')}:${String(fullDateTime.getMinutes()).padStart(2, '0')}`;

      data.push({
        datetime: formattedDateTime,
        waterLevel,
        waterStorage,
        irrigationRate,
        effectiveRate,
        floodRate,
        inflow,
        outflow,
        rain10min,
        rainAccum
      });
    }
    return data.slice(0, 20); // 最新20件だけ取得
  }, year);

  console.log('📋 取得したデータ:', rows);

  await browser.close();
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

  const sortedRows = newRows.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const rowsToAdd = sortedRows.filter(row => !existingObservedTimes.includes(row.datetime));

  if (rowsToAdd.length === 0) {
    console.log('✅ 追加データなし');
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
        row.datetime,
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

  console.log('✅ シート更新完了');
}

app.get('/unazuki', async (req, res) => {
  try {
    const rows = await fetchData();
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

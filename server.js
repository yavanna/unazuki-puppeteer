// server.js（スクロール＋再取得版、仮想DOM対策完全対応）
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

  console.info('🛹 tbodyスクロールして最新行を描画');
  await page.evaluate(() => {
    const tableBody = document.querySelector('table tbody');
    tableBody.scrollIntoView({ behavior: 'instant', block: 'start' });
  });
  await new Promise(resolve => setTimeout(resolve, 3000));

  const year = new Date().getFullYear();

  const rows = await page.evaluate((year) => {
    const data = [];
    const tableRows = document.querySelectorAll('table tbody tr');
    console.info(`🔵 tableRows.length = ${tableRows.length}`);

    let lastDate = null;
    let successCount = 0;
    let failCount = 0;

    tableRows.forEach((row, rowIndex) => {
      const tds = row.querySelectorAll('td');

      if (tds.length < 11) {
        console.warn(`⚠️ tr[${rowIndex + 1}] td数不足(${tds.length})、スキップ`);
        failCount++;
        return;
      }

      const rawValues = Array.from(tds).map((td, tdIndex) => {
        const text = td.innerText.trim();
        console.info(`📍 tr[${rowIndex + 1}]/td[${tdIndex + 1}] = ${text}`);
        return text;
      });

      let rawDate = rawValues[0];
      let rawTime = rawValues[1];

      let date, time;

      if (rawDate && rawDate.includes('/')) {
        date = rawDate;
        time = rawTime;
        lastDate = date;
      } else if (rawTime) {
        date = lastDate;
        time = rawTime;
      } else {
        console.warn(`⚠️ tr[${rowIndex+1}] 日付も時刻も空！スキップ`);
        failCount++;
        return;
      }

      const fullDateTime = new Date(`${year}/${date} ${time}`);
      fullDateTime.setHours(fullDateTime.getHours() + 9);
      const formattedDateTime = `${fullDateTime.getFullYear()}/${String(fullDateTime.getMonth() + 1).padStart(2, '0')}/${String(fullDateTime.getDate()).padStart(2, '0')} ${String(fullDateTime.getHours()).padStart(2, '0')}:${String(fullDateTime.getMinutes()).padStart(2, '0')}`;

      console.info(`🟢 tr[${rowIndex + 1}] フォーマット済み日時: ${formattedDateTime}`);

      const obj = {
        datetime: formattedDateTime,
        waterLevel: rawValues[2],
        waterStorage: rawValues[3],
        irrigationRate: rawValues[4],
        effectiveRate: rawValues[5],
        floodRate: rawValues[6],
        inflow: rawValues[7],
        outflow: rawValues[8],
        rain10min: rawValues[9],
        rainAccum: rawValues[10]
      };

      console.info(`✅ tr[${rowIndex + 1}] 整形後データ:`, obj);

      data.push(obj);
      successCount++;
    });

    console.info(`🔵 データ取得サマリー: 成功${successCount}件 / 失敗${failCount}件`);
    return data.slice(0, 20);
  }, year);

  console.info('📋 最終取得データ:', JSON.stringify(rows, null, 2));

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

  const sortedRows = newRows.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const rowsToAdd = sortedRows.filter(row => !existingObservedTimes.includes(row.datetime));

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

  console.info('✅ シート更新完了');
}

app.get('/unazuki', async (req, res) => {
  try {
    const rows = await fetchData();
    console.info('📥 fetchData完了、rows件数:', rows.length);

    if (rows.length === 0) {
      console.info('✅ 追加データなし');
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

// server.js（innerText版 最新観測値パース対応）
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
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log('🌐 ページロード完了');

  const pageText = await page.evaluate(() => document.body.innerText);

  if (!pageText.includes('宇奈月ダム')) {
    throw new Error('違うダムページです');
  }

  const observationMatch = pageText.match(/最新観測値(\d{4})\/\d{2}\/\d{2} (\d{2}:\d{2})/);
  const dataMatch = pageText.match(/貯水位:(\d+\.\d+)m.*?貯水量:(\d+\.\d+)千m³.*?全流入量:(\d+\.\d+)m³\/s.*?全放流量:(\d+\.\d+)m³\/s.*?貯水率治水容量:([\d\-.]+).*?貯水率有効容量:(\d+\.\d+)%.*?貯水率利水容量:(\d+\.\d+)%.*?時間雨量:(\d+\.\d+)mm.*?10分雨量:(\d+\.\d+)mm.*?降り始めからの雨量:(\d+\.\d+)mm/);

  if (!observationMatch || !dataMatch) {
    throw new Error('最新観測値データが見つかりません');
  }

  const observationDatetime = `${observationMatch[1]}/${observationMatch[0].slice(7,17).replace(/\//g,'/')} ${observationMatch[2]}`;

  const row = {
    datetime: observationDatetime,
    waterLevel: dataMatch[1],
    waterStorage: dataMatch[2],
    inflow: dataMatch[3],
    outflow: dataMatch[4],
    floodRate: dataMatch[5],
    effectiveRate: dataMatch[6],
    irrigationRate: dataMatch[7],
    rainHour: dataMatch[8],
    rain10min: dataMatch[9],
    rainAccum: dataMatch[10]
  };

  console.log('📋 取得したデータ:', row);

  await browser.close();
  return [row];
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

  const rowsToAdd = newRows.filter(row => !existingObservedTimes.includes(row.datetime));

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

const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

// 環境変数
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
  console.log('🌐 Puppeteer起動開始');
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });
  const page = await browser.newPage();
  const url = 'https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6';

  page.on('console', msg => {
    console.log(`📢 [browser log] ${msg.type()}: ${msg.text()}`);
  });

  console.log('🌐 ページアクセス:', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  console.log('🌐 ページロード完了');

  console.log('🕰 更新完了サイン検知待機開始（最大10秒）');
  let isContentCached = false;
  const timeout = Date.now() + 10000;
  page.on('console', msg => {
    if (msg.text().includes('Content has been cached for offline use')) {
      isContentCached = true;
      console.log('✅ 更新完了サイン検知');
    }
  });

  while (!isContentCached && Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!isContentCached) {
    console.warn('⚠️ 更新完了サイン検知できずタイムアウト。念のため5秒追加待機');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log('🕰 Content Cached検知後さらに2秒待機');
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('📋 テーブルデータ読み取り開始');

  const tableData = await page.evaluate(() => {
    const result = [];
    const table = document.querySelector('table tbody');
    if (!table) return result;
    const rows = Array.from(table.querySelectorAll('tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(cell => cell.innerText.trim());
      if (cells.length >= 11 && cells[0] && cells[1]) { // 日付と時刻が存在する行だけ
        result.push({
          date: cells[0],
          time: cells[1],
          waterLevel: cells[2],
          waterStorage: cells[3],
          irrigationRate: cells[4],
          effectiveRate: cells[5],
          floodRate: cells[6],
          inflow: cells[7],
          outflow: cells[8],
          rain10min: cells[9],
          rainAccum: cells[10]
        });
      }
    }
    return result;
  });

  await browser.close();
  console.info('🛑 Puppeteerブラウザセッション終了');

  if (tableData.length === 0) {
    throw new Error('テーブルデータが空でした');
  }

  console.log(`📋 読み取った行数: ${tableData.length}`);
  console.log('📋 先頭3行サンプル:');
  console.log(tableData.slice(0, 3));

  const nowYear = new Date().getFullYear();
  const rows = tableData.map(row => ({
    datetime: `${nowYear}/${row.date} ${row.time}`,
    ...row
  }));

  console.log('📋 年付与＋観測日時整形完了');

  console.log('📋 新しい順に並べ替え開始');
  const sortedRows = rows.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  console.log('📋 並べ替え完了');

  return sortedRows;
}

async function writeToSheet(sortedRows) {
  const auth = new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('📥 既存データ取得開始');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B2:B`
  });

  const existingObservedTimes = res.data.values ? res.data.values.flat() : [];
  const fetchTime = getFetchTime();

  console.log('📥 既存観測時刻数:', existingObservedTimes.length);

  const rowsToAdd = sortedRows.filter(row => !existingObservedTimes.includes(row.datetime));

  console.log('📥 新規追加対象行数:', rowsToAdd.length);

  if (rowsToAdd.length === 0) {
    console.info('✅ 追加データなし');
    return;
  }

  console.log('📥 スプレッドシート書き込み開始');
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
  console.info('✅ スプレッドシート書き込み成功');
}

app.get('/unazuki', async (req, res) => {
  try {
    const sortedRows = await fetchData();
    console.info('📥 fetchData完了、rows件数:', sortedRows.length);

    if (sortedRows.length === 0) {
      res.send('❌ データなし');
      return;
    }

    await writeToSheet(sortedRows);
    res.send('✅ 保存完了！');
  } catch (error) {
    console.error('❌ サーバーエラー:', error.message);
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

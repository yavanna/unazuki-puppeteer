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
  console.log('🌐 Puppeteer起動開始');
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-experimental-web-platform-features'
    ]
  });
  const page = await browser.newPage();
  const url = 'https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6';

  let isContentCached = false;

  page.on('console', msg => {
    console.log(`📢 [browser log] ${msg.type()}: ${msg.text()}`);
    if (msg.text().includes('Content has been cached for offline use')) {
      console.log('✅ 更新完了サインを検知！');
      isContentCached = true;
    }
  });

  console.log('🌐 ページにアクセス開始:', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  console.log('🌐 ページロード完了');

  console.log('🕰 更新完了サイン検知待機開始（最大10秒）');
  const timeout = Date.now() + 10000;
  while (!isContentCached && Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!isContentCached) {
    console.warn('⚠️ 更新完了サイン検知できず、タイムアウト。さらに5秒待機');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log('🖱 コピークリック開始');
  try {
    await page.click('button:has-text("コピー")');
    console.log('✅ コピークリック成功');
  } catch (error) {
    console.error('❌ コピークリック失敗:', error.message);
    await browser.close();
    throw new Error('コピークリックに失敗しました');
  }

  console.log('🕰 コピークリック後待機（1秒）');
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('📋 クリップボード読み取り開始');
  let clipboardText = '';
  try {
    clipboardText = await page.evaluate(async () => {
      return await navigator.clipboard.readText();
    });
    console.log(`✅ クリップボード読み取り成功（${clipboardText.length} bytes）`);
  } catch (error) {
    console.error('❌ クリップボード読み取り失敗:', error.message);
    await browser.close();
    throw new Error('クリップボード読み取りに失敗しました');
  }

  if (clipboardText.trim() === '') {
    console.error('❌ クリップボード空データ');
    await browser.close();
    throw new Error('クリップボード内容が空でした');
  }

  console.log('📋 データパース開始');
  const lines = clipboardText.trim().split('\n');
  console.log(`📋 パース行数: ${lines.length}`);
  console.log('📋 先頭3行サンプル:\n', lines.slice(0, 3).join('\n'));

  const nowYear = new Date().getFullYear();
  const rows = lines.map(line => {
    const parts = line.split('\t');
    return {
      datetime: `${nowYear}/${parts[0]} ${parts[1]}`, // 観測日＋観測時刻
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

  console.log('📋 年付与＋観測日時整形完了');

  console.log('📋 データ並び替え開始（新しい順）');
  const sortedRows = rows.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  console.log('📋 データ並び替え完了');

  await browser.close();
  console.info('🛑 Puppeteerブラウザクローズ完了');

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

  console.log('📥 スプレッドシート既存データ取得開始');
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

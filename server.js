const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

// 🔥 超詳細ログ格納
let explorationLogs = [];

// 🔥 ログ追加用
function addLog(step, detail, dump = null, level = "info") {
  explorationLogs.push({
    timestamp: new Date().toISOString(),
    step,
    detail,
    dump,
    level
  });
}

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
  addLog('Puppeteer起動', 'ブラウザセッション開始');

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const url = 'https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6';

  page.on('console', msg => {
    addLog('ブラウザconsole', msg.text(), null, 'console');
  });

  addLog('ページアクセス', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  addLog('ページロード完了', '');

  addLog('更新完了サイン待機開始', '最大10秒');
  let isContentCached = false;
  const timeout = Date.now() + 10000;
  page.on('console', msg => {
    if (msg.text().includes('Content has been cached for offline use')) {
      isContentCached = true;
      addLog('更新完了サイン検知', 'Content cached detected');
    }
  });

  while (!isContentCached && Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!isContentCached) {
    addLog('更新完了サイン検知失敗', 'タイムアウト到達', null, 'warning');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  addLog('追加待機', 'Content Cached検知後さらに2秒待機');
  await new Promise(resolve => setTimeout(resolve, 2000));

  addLog('スクロール開始', '行数監視しながらスクロール');

  let previousRowCount = 0;
  for (let i = 0; i < 10; i++) {
    const currentRowCount = await page.evaluate(() => {
      const table = document.querySelector('table tbody');
      return table ? table.querySelectorAll('tr').length : 0;
    });

    addLog('スクロールチェック', `回数${i + 1}: 前回${previousRowCount}件 → 今回${currentRowCount}件`);

    if (currentRowCount <= previousRowCount) {
      addLog('スクロール停止', '行数増加なし → 停止');
      break;
    }

    previousRowCount = currentRowCount;

    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });

    addLog('スクロール操作', '1画面分スクロール実施');

    await new Promise(resolve => setTimeout(resolve, 2000));
    addLog('スクロール後待機', '2秒待機');
  }

  addLog('テーブル読み取り開始', '');

  const tableData = await page.evaluate(() => {
    const result = [];
    const table = document.querySelector('table tbody');
    if (!table) return { rows: [], tableHTML: null };

    const rows = Array.from(table.querySelectorAll('tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td')).map(cell => cell.innerText.trim());
      result.push({
        rawDate: cells[0] || '',
        time: cells[1] || '',
        waterLevel: cells[2] || '',
        waterStorage: cells[3] || '',
        irrigationRate: cells[4] || '',
        effectiveRate: cells[5] || '',
        floodRate: cells[6] || '',
        inflow: cells[7] || '',
        outflow: cells[8] || '',
        rain10min: cells[9] || '',
        rainAccum: cells[10] || ''
      });
    }
    return { rows: result, tableHTML: table.parentElement.innerHTML };
  });

  await browser.close();
  addLog('ブラウザ終了', 'Puppeteerセッション正常終了');

  if (tableData.rows.length === 0) {
    addLog('テーブルエラー', 'テーブルデータが空でした', null, 'error');
    throw new Error('テーブルデータが空でした');
  }

  addLog('テーブルデータ取得完了', `取得行数: ${tableData.rows.length}`, tableData.rows.slice(0, 5));
  addLog('テーブルHTMLダンプ', 'HTMLダンプ取得', tableData.tableHTML ? tableData.tableHTML.slice(0, 1000) : 'なし');

  // 🔥 日付引き継ぎ処理
  let lastDate = '';
  const nowYear = new Date().getFullYear();
  const validRows = [];

  for (const row of tableData.rows) {
    if (row.rawDate) {
      lastDate = row.rawDate;
    }
    if (lastDate && row.time) {
      validRows.push({
        datetime: `${nowYear}/${lastDate} ${row.time}`,
        ...row
      });
    }
  }

  addLog('年付与＋整形完了', `有効データ行数: ${validRows.length}`);

  const sortedRows = validRows.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  addLog('新しい順並べ替え完了', `並び替え後行数: ${sortedRows.length}`);

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

  addLog('既存データ取得開始', '');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!B2:B`
  });

  const existingObservedTimes = res.data.values ? res.data.values.flat() : [];
  const fetchTime = getFetchTime();

  addLog('既存データ件数', existingObservedTimes.length);

  const rowsToAdd = sortedRows.filter(row => !existingObservedTimes.includes(row.datetime));

  addLog('追加対象件数', rowsToAdd.length);

  if (rowsToAdd.length === 0) {
    addLog('追加不要', '既存と重複なし');
    return;
  }

  addLog('スプレッドシート書き込み開始', '');

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

  addLog('スプレッドシート書き込み完了', '');
}

app.get('/unazuki', async (req, res) => {
  try {
    explorationLogs = []; // ログ初期化
    const sortedRows = await fetchData();
    if (sortedRows.length === 0) {
      res.send('❌ データなし');
      return;
    }
    await writeToSheet(sortedRows);
    res.send('✅ 保存完了！');
  } catch (error) {
    addLog('サーバーエラー', error.message, null, 'error');
    console.error('❌ サーバーエラー:', error.message);
    res.status(500).send('❌ サーバーエラー');
  }
});

// 🔥 /getlogエンドポイントでログダウンロード
app.get('/getlog', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(explorationLogs, null, 2));
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

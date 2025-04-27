const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

// exploration log（ここに探索中の全ログを溜める）
let explorationLogs = [];

// ログを追加する関数
function addLog(step, detail, dump = null) {
  explorationLogs.push({
    timestamp: new Date().toISOString(),
    step,
    detail,
    dump
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
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });
  const page = await browser.newPage();
  const url = 'https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6';

  page.on('console', msg => {
    addLog('ブラウザconsole', msg.text());
  });

  addLog('ページアクセス', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  addLog('ページロード完了', '');

  addLog('更新完了サイン待機', '最大10秒待機');
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
    addLog('更新完了サイン検知失敗', 'タイムアウト到達');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  addLog('探索開始', 'window, table, Vueインスタンス調査開始');

  await page.evaluate(() => {
    window._explorationResults = {
      tables: [],
      vueElements: [],
      vueDevtoolsHook: Boolean(window.__VUE_DEVTOOLS_GLOBAL_HOOK__),
      windowKeys: Object.keys(window).filter(k => k.toLowerCase().includes('vue') || k.toLowerCase().includes('store') || k.toLowerCase().includes('app'))
    };

    const tables = Array.from(document.querySelectorAll('table'));
    tables.forEach((table, index) => {
      const vueAttached = '__vue__' in table;
      window._explorationResults.tables.push({
        index,
        rows: table.querySelectorAll('tr').length,
        vueAttached
      });
      if (vueAttached) {
        window._explorationResults.vueElements.push(`table[${index}]`);
      }
    });
  });

  const explorationResults = await page.evaluate(() => window._explorationResults);
  addLog('探索結果', '探索データ取得完了', explorationResults);

  await browser.close();
  addLog('ブラウザセッション終了', 'Puppeteerセッション正常終了');

  return explorationResults;
}

async function writeToSheet(data) {
  addLog('スプレッドシート書き込み', '省略（今回は探索専用）');
}

app.get('/unazuki', async (req, res) => {
  try {
    explorationLogs = []; // リクエストごとに初期化
    const data = await fetchData();
    await writeToSheet(data);
    res.send('✅ 探索完了！');
  } catch (error) {
    addLog('サーバーエラー', error.message);
    console.error('❌ サーバーエラー:', error.message);
    res.status(500).send('❌ サーバーエラー');
  }
});

// ★ ここが新しい！ JSONログダウンロードエンドポイント
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

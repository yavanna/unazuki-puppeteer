const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// 🛠 ログ保存用（最大500件まで）
const logs = [];

// 🛠 Puppeteerブラウザインスタンス
let browser;

// 🛠 最新取得データ
let latestData = null;

// 🛠 ログ追加関数
function addLog(step, detail = '', dump = null, level = 'info') {
  logs.push({
    timestamp: new Date().toISOString(),
    step,
    detail,
    dump,
    level
  });
  if (logs.length > 500) logs.shift(); // 古いログから削除
}

// 🛠 グローバルエラーハンドリング
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection:', reason);
  addLog('unhandledRejection', reason.toString(), null, 'error');
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error.stack || error);
  addLog('uncaughtException', error.stack || error.message, null, 'error');
});

// 🛠 Puppeteer起動リトライ付き
async function launchBrowserWithRetry(maxRetries = 3, waitMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      addLog('Puppeteer起動', `試行${attempt}回目`);
      browser = await puppeteer.launch({
        headless: "new",
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process'
        ]
      });
      addLog('Puppeteer起動成功');
      console.log('✅ Puppeteerブラウザ起動成功');
      return;
    } catch (e) {
      console.error(`⚡ Puppeteer起動失敗（${attempt}回目）: ${e.stack || e.message}`);
      addLog('Puppeteer起動失敗', e.stack || e.message, null, 'error');
      if (attempt === maxRetries) throw e;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

// 🛠 宇奈月ダムデータ取得関数
async function fetchUnazukiData() {
  if (!browser) {
    addLog('ブラウザ未検出', '再起動を試みます');
    await launchBrowserWithRetry();
  }

  const page = await browser.newPage();
  try {
    await page.setCacheEnabled(true); // キャッシュ有効
    addLog('ページアクセス開始', '宇奈月ダム');
    await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6', {
      timeout: 60000,
      waitUntil: 'networkidle2'
    });

    await page.waitForSelector('table', { timeout: 10000 }); // 🌟 テーブル出現待ち
    addLog('テーブル出現確認');

    const tableData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      return rows.map(row => {
        const cols = row.querySelectorAll('td');
        return Array.from(cols).map(col => col.innerText.trim());
      }).filter(row => row.length > 0);
    });

    console.log('✅ データ取得成功！取得行数:', tableData.length);
    addLog('データ取得成功', `取得行数: ${tableData.length}`);

    latestData = tableData;
    return tableData;
  } catch (error) {
    console.error('⚡ fetchUnazukiData失敗:', error.stack || error.message);
    addLog('fetchUnazukiData失敗', error.stack || error.message, null, 'error');
    throw error;
  } finally {
    await page.close();
  }
}

// 🛠 /health → サーバー生存＋ブラウザ生存チェック
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "ok",
    browserAlive: !!browser,
    timestamp: new Date().toISOString()
  });
});

// 🛠 /unazuki → 宇奈月ダムデータ取得
app.get('/unazuki', async (req, res) => {
  try {
    const data = await fetchUnazukiData();
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('❌ /unazukiエラー:', error.stack || error.message);
    addLog('/unazukiエラー', error.stack || error.message, null, 'error');
    res.status(500).json({ success: false, message: error.message });
  }
});

// 🛠 /getlog → ログ一覧出力
app.get('/getlog', (req, res) => {
  res.status(200).json(logs);
});

// 🛠 サーバー起動
app.listen(port, async () => {
  console.log(`🚀 サーバー起動完了 ポート:${port}`);
  addLog('サーバー起動完了', `ポート:${port}`);
  try {
    await launchBrowserWithRetry();
  } catch (e) {
    console.error('❌ 初回ブラウザ起動失敗。サーバーは生存継続。');
    addLog('初回ブラウザ起動失敗', e.stack || e.message, null, 'error');
  }
});

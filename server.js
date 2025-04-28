const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// Puppeteerブラウザインスタンス
let browser;

// 最新取得データ
let latestData = null;

// グローバルエラーハンドリング
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception:', error.stack || error);
});

// Puppeteer起動リトライ付き関数
async function launchBrowserWithRetry(maxRetries = 3, waitMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🛫 Puppeteerブラウザ起動 試行${attempt}回目`);
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
      console.log('✅ Puppeteerブラウザ起動成功');
      return;
    } catch (e) {
      console.error(`⚡ Puppeteer起動失敗（${attempt}回目）: ${e.stack || e.message}`);
      if (attempt === maxRetries) {
        console.error('❌ 最大リトライ回数に達しました。起動を諦めます。');
        throw e;
      }
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

// 宇奈月ダムデータ取得関数
async function fetchUnazukiData() {
  if (!browser) {
    console.log('♻️ ブラウザインスタンス未検出、再起動します。');
    await launchBrowserWithRetry();
  }

  const page = await browser.newPage();
  try {
    await page.setCacheEnabled(true); // キャッシュ活用
    console.log('🌐 宇奈月ダムページアクセス開始');
    await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6', { timeout: 30000, waitUntil: 'domcontentloaded' });

    const tableData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr'));
      return rows.map(row => {
        const cols = row.querySelectorAll('td');
        return Array.from(cols).map(col => col.innerText.trim());
      }).filter(row => row.length > 0);
    });

    console.log('✅ データ取得成功！取得行数:', tableData.length);
    latestData = tableData;
    return tableData;
  } catch (error) {
    console.error('⚡ fetchUnazukiData失敗:', error.stack || error.message);
    throw error;
  } finally {
    await page.close();
  }
}

// /health → サーバー生存確認＋ブラウザ生存確認
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "ok",
    browserAlive: !!browser,
    timestamp: new Date().toISOString()
  });
});

// /unazuki → データ取得エンドポイント
app.get('/unazuki', async (req, res) => {
  try {
    const data = await fetchUnazukiData();
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('❌ /unazukiエラー:', error.stack || error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// サーバー起動
app.listen(port, async () => {
  console.log(`🚀 サーバー起動完了 ポート:${port}`);
  try {
    await launchBrowserWithRetry();
  } catch (e) {
    console.error('❌ 初回ブラウザ起動失敗。サーバー自体は生存中。');
  }
});

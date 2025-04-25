const express = require('express');
const puppeteer = require('puppeteer');

const app = express();

app.get('/unazuki', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(
      'https://www.river.go.jp/kawabou/pcfull/tm?itmkndCd=7&ofcCd=21556&obsCd=6&isCurrent=true&fld=0',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );

    const html = await page.content();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    console.error('❌ Puppeteer failed:', error.message);
    res.status(500).send('Puppeteer failed: ' + error.message);
  } finally {
    if (browser) await browser.close();
  }
});

// 💡 Railwayでは環境変数 PORT を使うのが重要！
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Puppeteer server running on port ${port}`);
});

const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');

const app = express();

app.get('/unazuki', async (req, res) => {
  let browser = null;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath || process.env.CHROME_EXECUTABLE_PATH,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.goto(
      'https://www.river.go.jp/kawabou/pcfull/tm?itmkndCd=7&ofcCd=21556&obsCd=6&isCurrent=true&fld=0',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );

    const html = await page.content();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('❌ Puppeteer failed:', err.message);
    res.status(500).send('Puppeteer failed: ' + err.message);
  } finally {
    if (browser !== null) {
      await browser.close();
    }
  }
});

app.listen(3000, () => {
  console.log('✅ Puppeteer server running on port 3000');
});

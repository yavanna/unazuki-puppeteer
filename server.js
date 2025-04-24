const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');

const app = express();

app.get('/unazuki', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath || '/usr/bin/chromium-browser',
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.goto(
      'https://www.river.go.jp/kawabou/pcfull/tm?itmkndCd=7&ofcCd=21556&obsCd=6&isCurrent=true&fld=0',
      { waitUntil: 'domcontentloaded' }
    );

    const html = await page.content();
    await browser.close();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (error) {
    if (browser) await browser.close();
    console.error('🔥 Puppeteer error:', error);
    res.status(500).send('Puppeteer failed: ' + error.message);
  }
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});

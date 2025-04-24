const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('chrome-aws-lambda');

const app = express();

app.get('/unazuki', async (req, res) => {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath,
    headless: chromium.headless
  });

  const page = await browser.newPage();
  await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?itmkndCd=7&ofcCd=21556&obsCd=6&isCurrent=true&fld=0', {
    waitUntil: 'networkidle2'
  });

  const html = await page.content();
  await browser.close();

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});

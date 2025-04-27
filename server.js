async function fetchData() {
  addLog('Puppeteer起動', 'ブラウザセッション開始');

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  await page.setCacheEnabled(false);
  await page.emulateTimezone('Asia/Tokyo');
  addLog('キャッシュ無効化＋タイムゾーン設定', 'page.setCacheEnabled(false) & Asia/Tokyo');

  const url = 'https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6';
  addLog('ページアクセス', url);
  await page.goto(url, { waitUntil: 'networkidle0' });
  addLog('ページロード完了', '');

  let isContentCached = false;
  page.on('console', msg => {
    if (msg.text().includes('Content has been cached for offline use')) {
      isContentCached = true;
      addLog('更新完了サイン検知', 'Content cached detected');
    }
  });

  const timeout = Date.now() + 10000;
  while (!isContentCached && Date.now() < timeout) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (!isContentCached) {
    addLog('更新完了サイン検知失敗', 'タイムアウト到達', null, 'warning');
  }

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
  }

  addLog('テーブル読み取り開始', '');

  const tableData = await page.evaluate(() => {
    const result = [];
    const table = document.querySelector('table tbody');
    if (!table) return [];

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
    return result;
  });

  await browser.close();
  addLog('ブラウザ終了', 'Puppeteerセッション正常終了');

  if (tableData.length === 0) {
    addLog('テーブルエラー', 'テーブルデータが空でした', null, 'error');
    throw new Error('テーブルデータが空でした');
  }

  let lastDate = '';
  const nowYear = new Date().getFullYear();
  const validRows = [];

  for (const row of tableData) {
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

  // 🌟 ここで並び替え（古い順）
  const sortedRows = validRows.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  addLog('古い順に整列完了', `データ数: ${sortedRows.length}`);

  // 🌟 並び順をダンプ出力
  addLog('並び替え後データ確認', '', sortedRows.map(row => row.datetime));

  return sortedRows;
}

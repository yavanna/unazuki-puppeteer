async function fetchUnazukiData() {
  if (!browser) await launchBrowserWithRetry();

  const page = await browser.newPage();
  try {
    await page.setCacheEnabled(true);
    await page.goto('https://www.river.go.jp/kawabou/pcfull/tm?kbn=2&itmkndCd=7&ofcCd=21556&obsCd=6', {
      timeout: 60000,
      waitUntil: 'networkidle2'
    });
    await page.waitForSelector('table', { timeout: 10000 });

    const rawData = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => Array.from(row.querySelectorAll('td')).map(col => col.innerText.trim()));
    });

    addLog('データ取得成功', `行数: ${rawData.length}`);

    let currentDateText = null;
    const year = new Date().getFullYear();

    const excelDateToString = (serial) => {
      const epoch = new Date(1899, 11, 30); // Excelの起点日
      const days = Number(serial);
      const date = new Date(epoch.getTime() + days * 86400000);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      return `${month}/${day}`; // MM/DD形式
    };

    const parsedData = rawData
      .map(cols => {
        if (cols.length < 11) return null;  // 必須列なければスキップ

        let [dateRaw, time, waterLevel, storageVolume, utilCapacity, effCapacity, floodCapacity, inflow, outflow, rain10min, rainTotal] = cols;

        if (dateRaw) {
          // 日付が数値ならExcelシリアルとみなして変換
          if (!isNaN(dateRaw) && !dateRaw.includes('/')) {
            currentDateText = excelDateToString(dateRaw);
          } else {
            currentDateText = dateRaw;
          }
        }
        // 日付が空の場合、前回のを引き継ぐ
        const date = currentDateText;

        if (!date || !time) return null;

        // 24:00:00を00:00に直す（特別処理）
        let timeFixed = time;
        if (time.startsWith('24:')) {
          timeFixed = '00:' + time.split(':')[1];
          // 日付を1日進める（正確にやるなら）
          const dateParts = date.split('/');
          const fakeDate = new Date(`${year}/${dateParts[0]}/${dateParts[1]} 00:00`);
          fakeDate.setDate(fakeDate.getDate() + 1);
          const month = (fakeDate.getMonth() + 1).toString().padStart(2, '0');
          const day = fakeDate.getDate().toString().padStart(2, '0');
          date = `${month}/${day}`;
        }

        // 観測日時作成
        const obsDateTimeStr = `${year}/${date} ${timeFixed}`;
        const obsDate = new Date(obsDateTimeStr);

        if (isNaN(obsDate)) return null;

        return {
          obsDateTime: obsDate,
          row: [date, timeFixed, waterLevel, storageVolume, utilCapacity, effCapacity, inflow, outflow, rain10min, rainTotal]
        };
      })
      .filter(x => x !== null);

    // 観測日時で昇順ソート
    parsedData.sort((a, b) => a.obsDateTime - b.obsDateTime);

    return parsedData.map(x => x.row);
  } finally {
    await page.close();
  }
}

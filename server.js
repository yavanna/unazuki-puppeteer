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
      const epoch = new Date(1899, 11, 30); // Excel起点日
      const days = Number(serial);
      const date = new Date(epoch.getTime() + days * 86400000);
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      return `${month}/${day}`; // MM/DD形式
    };

    const parsedData = rawData
      .map(cols => {
        try {
          if (cols.length < 11) return null; // 必須列なければスキップ

          const dateRaw = cols[0];
          const timeRaw = cols[1];
          const waterLevel = cols[2];
          const storageVolume = cols[3];
          const utilCapacity = cols[4];
          const effCapacity = cols[5];
          const floodCapacity = cols[6];
          const inflow = cols[7];
          const outflow = cols[8];
          const rain10min = cols[9];
          const rainTotal = cols[10];

          // 日付補正
          let dateFixed = currentDateText;
          if (dateRaw) {
            if (!isNaN(dateRaw) && !dateRaw.includes('/')) {
              dateFixed = excelDateToString(dateRaw);
            } else {
              dateFixed = dateRaw;
            }
            currentDateText = dateFixed; // 現在日付更新
          }

          if (!dateFixed || !timeRaw) return null;

          // 時刻補正
          let timeFixed = timeRaw;
          let dateFixedForObs = dateFixed;
          if (timeRaw.startsWith('24:')) {
            timeFixed = '00:' + timeRaw.split(':')[1];
            const dateParts = dateFixed.split('/');
            const tempDate = new Date(`${year}/${dateParts[0]}/${dateParts[1]} 00:00`);
            tempDate.setDate(tempDate.getDate() + 1);
            const month = (tempDate.getMonth() + 1).toString().padStart(2, '0');
            const day = tempDate.getDate().toString().padStart(2, '0');
            dateFixedForObs = `${month}/${day}`;
          }

          // 観測日時作成
          const obsDateTimeStr = `${year}/${dateFixedForObs} ${timeFixed}`;
          const obsDate = new Date(obsDateTimeStr);
          if (isNaN(obsDate)) return null;

          return {
            obsDateTime: obsDate,
            row: [
              dateFixedForObs,
              timeFixed,
              waterLevel,
              storageVolume,
              utilCapacity,
              effCapacity,
              inflow,
              outflow,
              rain10min,
              rainTotal
            ]
          };
        } catch (error) {
          console.error('データパースエラー:', error);
          return null;
        }
      })
      .filter(x => x !== null);

    parsedData.sort((a, b) => a.obsDateTime - b.obsDateTime);

    return parsedData.map(x => x.row);
  } catch (e) {
    console.error('fetchUnazukiDataエラー:', e);
    throw e;
  } finally {
    await page.close();
  }
}

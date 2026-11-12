/* 離線示範資料（規格 #51-55）：虛構股票，固定種子， deterministic。
 * 策略摘要會標示「虛構示範資料｜勿用於投資」。 */
(function (global) {
  'use strict';
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const NAMES = [
    ['9001', '示範半導體'], ['9002', '虛構電子'], ['9003', '範例金控'], ['9004', '模擬航運'],
    ['9005', '示範生技'], ['9006', '虛構鋼鐵'], ['9007', '範例電信'], ['9008', '模擬食品'],
    ['9009', '示範光電'], ['9010', '虛構汽車'], ['9011', '範例塑化'], ['9012', '模擬軟體'],
    ['9013', '示範營建'], ['9014', '虛構紡織'], ['9015', '範例觀光'], ['9016', '模擬通路'],
    ['00901', '示範高股息ETF'], ['00902', '虛構市值ETF'],
  ];
  function tradingDates(n) {
    const dates = []; const d = new Date();
    while (dates.length < n) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) dates.unshift(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() - 1);
    } return dates;
  }
  function genStock(idx, code, name, dates, seedOverride, patternOverride) {
    const rnd = mulberry32(seedOverride != null ? seedOverride : 1234 + idx * 777);
    const days = dates.length;
    // 不同型態：強勢上漲 / 盤整 / 下跌 / 回檔後轉強，確保掃描有像樣的分布
    const pattern = patternOverride != null ? patternOverride : idx % 4;
    let price = 30 + rnd() * 220;
    const close = [], open = [], high = [], low = [], volume = [], amount = [];
    for (let i = 0; i < days; i++) {
      const t = i / days;
      let drift = 0, volBase = (pattern === 0 || pattern === 3) ? 0.03 : 0.012;
      if (pattern === 0) {                                                     // 強勢：漲→盤整回檔→末日突破
        if (i < days - 6) drift = 0.0016 + 0.001 * Math.sin(t * 9);
        else if (i < days - 1) drift = -0.0025;
        else drift = 0.032;
      }
      else if (pattern === 1) drift = 0.0002 * Math.sin(t * 14);              // 盤整
      else if (pattern === 2) drift = -0.0012;                                 // 下跌
      else drift = i < days * 0.55 ? -0.0006 : 0.0035;                         // 先跌後強（緩步墊高，收盤不遠離 MA20）
      const shockScale = pattern === 0 && i >= days - 6 ? 0.2 : 1; // 末段走勢乾淨，確保突破訊號成立
      const shock = (rnd() - 0.5) * 2 * volBase * shockScale;
      const o = price, cl = Math.max(5, price * (1 + drift + shock));
      const hi = Math.max(o, cl) * (1 + rnd() * 0.008);
      const lo = Math.min(o, cl) * (1 - rnd() * 0.008);
      const volSpike = i > days - 6 && (pattern === 0 || pattern === 3) ? 1.9 : 1;
      const vol = Math.round((600 + rnd() * 9000) * 1000 * volSpike * (0.7 + t * 0.6));
      open.push(+o.toFixed(2)); close.push(+cl.toFixed(2)); high.push(+hi.toFixed(2)); low.push(+lo.toFixed(2));
      volume.push(vol); amount.push(Math.round(vol * cl));
      price = cl;
    }
    return { code, name, market: idx % 3 === 2 ? 'TPEX' : 'TWSE', isDemo: true,
             bars: { dates, open, high, low, close, volume, amount } };
  }
  // 種子經離線搜尋校準：確保示範掃描在最新一日能呈現「可進場候選＋觀察名單」的真實分布
  const SEEDS = { 0: 45, 4: 471, 8: 661, 3: 268, 7: 352 };
  function generateDemoStocks() {
    const dates = tradingDates(300);
    return NAMES.map(([code, name], i) => genStock(i, code, name, dates, SEEDS[i]));
  }
  global.TWDemo = { generateDemoStocks };
  if (typeof module !== 'undefined' && module.exports) module.exports = { generateDemoStocks, genStock, tradingDates };
})(typeof window !== 'undefined' ? window : globalThis);

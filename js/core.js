/* 台股 AI 智慧選股工作台 V2.0（網頁版）核心引擎
 * 技術指標 / 13 項 100 分計分 / 策略價位 / 進場適合度 / 掃描篩選
 * 規則全部由本檔計算；AI（Gemini）只做文字解讀，不得改價位（規格 #12）。
 * 同時支援瀏覽器（window.TWCore）與 Node 測試（module.exports）。 */
(function (global) {
  'use strict';

  // ---------- 工具 ----------
  function sma(v, p) {
    const out = new Array(v.length).fill(null); let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i]; if (i >= p) s -= v[i - p];
      if (i >= p - 1) out[i] = s / p;
    } return out;
  }
  function ema(v, p) {
    const out = new Array(v.length).fill(null);
    if (v.length < p) return out;
    const k = 2 / (p + 1);
    let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
    out[p - 1] = prev;
    for (let i = p; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }
  // 移除價格全 0 的無成交佔位列（close<=0）：避免污染 low60→支撐→停損/目標計算。
  // 各陣列同步過濾；amount 可能不存在需防呆；無零列時直接回傳原物件。
  function filterBars(b) {
    if (!b || !b.close || !b.close.some(c => !(c > 0))) return b;
    const keep = [];
    for (let i = 0; i < b.close.length; i++) if (b.close[i] > 0) keep.push(i);
    const pick = arr => arr ? keep.map(i => arr[i]) : arr;
    const out = { dates: pick(b.dates), open: pick(b.open), high: pick(b.high), low: pick(b.low), close: pick(b.close), volume: pick(b.volume) };
    if (b.amount) out.amount = pick(b.amount);
    return out;
  }
  function tickSize(price) { // #118 台股升降單位
    if (price < 10) return 0.01; if (price < 50) return 0.05; if (price < 100) return 0.1;
    if (price < 500) return 0.5; if (price < 1000) return 1; return 5;
  }
  function roundTick(price) { const t = tickSize(price); return Math.round(Math.round(price / t) * t * 100) / 100; }
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ---------- 指標 (#95) ----------
  function computeIndicators(b) {
    const n = b.close.length, c = b.close, ind = { bars: b };
    ind.ma5 = sma(c, 5); ind.ma10 = sma(c, 10); ind.ma20 = sma(c, 20);
    ind.ma60 = sma(c, 60); ind.ma120 = sma(c, 120);
    ind.ema12 = ema(c, 12); ind.ema26 = ema(c, 26);
    ind.macd = ind.ema12.map((a, i) => (a != null && ind.ema26[i] != null) ? a - ind.ema26[i] : null);
    const vals = []; ind.macd.forEach((v, i) => { if (v != null) vals.push([i, v]); });
    ind.macdSignal = new Array(n).fill(null);
    if (vals.length >= 9) {
      const es = ema(vals.map(x => x[1]), 9);
      vals.forEach((x, j) => { ind.macdSignal[x[0]] = es[j]; });
    }
    ind.macdHist = ind.macd.map((a, i) => (a != null && ind.macdSignal[i] != null) ? a - ind.macdSignal[i] : null);
    // RSI14 (Wilder)
    ind.rsi14 = new Array(n).fill(null);
    if (n > 14) {
      let ag = 0, al = 0;
      for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; ag += Math.max(d, 0); al += Math.max(-d, 0); }
      ag /= 14; al /= 14;
      ind.rsi14[14] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      for (let i = 15; i < n; i++) {
        const d = c[i] - c[i - 1];
        ag = (ag * 13 + Math.max(d, 0)) / 14; al = (al * 13 + Math.max(-d, 0)) / 14;
        ind.rsi14[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
    }
    // KD (RSV 9，1/3 平滑)
    const rsv = new Array(n).fill(null);
    for (let i = 8; i < n; i++) {
      const hh = Math.max(...b.high.slice(i - 8, i + 1)), ll = Math.min(...b.low.slice(i - 8, i + 1));
      rsv[i] = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
    }
    ind.k = new Array(n).fill(null); ind.d = new Array(n).fill(null);
    let pk = 50, pd = 50;
    for (let i = 0; i < n; i++) if (rsv[i] != null) { pk = pk * 2 / 3 + rsv[i] / 3; ind.k[i] = pk; pd = pd * 2 / 3 + pk / 3; ind.d[i] = pd; }
    // 布林 MA20 ± 2σ
    ind.bollMid = ind.ma20; ind.bollUpper = new Array(n).fill(null); ind.bollLower = new Array(n).fill(null);
    for (let i = 19; i < n; i++) {
      const w = c.slice(i - 19, i + 1), m = ind.ma20[i];
      const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / 20);
      ind.bollUpper[i] = m + 2 * sd; ind.bollLower[i] = m - 2 * sd;
    }
    // ATR14 (Wilder)
    const tr = b.close.map((_, i) => i === 0 ? b.high[0] - b.low[0] :
      Math.max(b.high[i] - b.low[i], Math.abs(b.high[i] - c[i - 1]), Math.abs(b.low[i] - c[i - 1])));
    ind.atr14 = new Array(n).fill(null);
    if (n > 14) {
      let prev = tr.slice(1, 15).reduce((a, x) => a + x, 0) / 14; ind.atr14[14] = prev;
      for (let i = 15; i < n; i++) { prev = (prev * 13 + tr[i]) / 14; ind.atr14[i] = prev; }
    }
    // ADX / +DI / -DI (Wilder)
    ind.adx = new Array(n).fill(null); ind.plusDi = new Array(n).fill(null); ind.minusDi = new Array(n).fill(null);
    {
      const pdm = new Array(n).fill(0), mdm = new Array(n).fill(0);
      for (let i = 1; i < n; i++) {
        const up = b.high[i] - b.high[i - 1], dn = b.low[i - 1] - b.low[i];
        pdm[i] = (up > dn && up > 0) ? up : 0; mdm[i] = (dn > up && dn > 0) ? dn : 0;
      }
      const smooth = x => { const o = new Array(n).fill(0); if (n > 14) { o[14] = x.slice(1, 15).reduce((a, v) => a + v, 0); for (let i = 15; i < n; i++) o[i] = o[i - 1] - o[i - 1] / 14 + x[i]; } return o; };
      const sTr = smooth(tr), sP = smooth(pdm), sM = smooth(mdm), dx = new Array(n).fill(null);
      for (let i = 14; i < n; i++) if (sTr[i] > 0) {
        ind.plusDi[i] = sP[i] / sTr[i] * 100; ind.minusDi[i] = sM[i] / sTr[i] * 100;
        const den = ind.plusDi[i] + ind.minusDi[i];
        dx[i] = den ? Math.abs(ind.plusDi[i] - ind.minusDi[i]) / den * 100 : 0;
      }
      const vi = dx.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
      if (vi.length > 14) {
        let prev = vi.slice(0, 14).reduce((s, i) => s + dx[i], 0) / 14;
        ind.adx[vi[13]] = prev;
        for (let j = 14; j < vi.length; j++) { prev = (prev * 13 + dx[vi[j]]) / 14; ind.adx[vi[j]] = prev; }
      }
    }
    // MFI14
    ind.mfi14 = new Array(n).fill(null);
    { const tp = b.close.map((_, i) => (b.high[i] + b.low[i] + c[i]) / 3);
      for (let i = 14; i < n; i++) { let pos = 0, neg = 0;
        for (let j = i - 13; j <= i; j++) { const f = tp[j] * b.volume[j]; if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f; }
        ind.mfi14[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg); } }
    // OBV
    ind.obv = [0]; for (let i = 1; i < n; i++) ind.obv.push(ind.obv[i - 1] + (c[i] > c[i - 1] ? b.volume[i] : c[i] < c[i - 1] ? -b.volume[i] : 0));
    // Supertrend (10, 3)
    ind.stBull = new Array(n).fill(null); ind.stLine = new Array(n).fill(null);
    { let fU = null, fL = null, prevBull = true;
      for (let i = 0; i < n; i++) { if (ind.atr14[i] == null) continue;
        const mid = (b.high[i] + b.low[i]) / 2;
        let up = mid + 3 * ind.atr14[i], lo = mid - 3 * ind.atr14[i];
        if (fU != null) { up = (up < fU || c[i - 1] > fU) ? up : fU; lo = (lo > fL || c[i - 1] < fL) ? lo : fL; }
        let cur; if (fL == null) cur = true; else if (prevBull) cur = !(c[i] < fL); else cur = c[i] > fU;
        ind.stBull[i] = cur; ind.stLine[i] = cur ? lo : up; fU = up; fL = lo; prevBull = cur; } }
    // 一目均衡表
    const midP = (p, i) => i < p - 1 ? null : (Math.max(...b.high.slice(i - p + 1, i + 1)) + Math.min(...b.low.slice(i - p + 1, i + 1))) / 2;
    ind.tenkan = c.map((_, i) => midP(9, i)); ind.kijun = c.map((_, i) => midP(26, i));
    ind.senkouA = ind.tenkan.map((t, i) => (t != null && ind.kijun[i] != null) ? (t + ind.kijun[i]) / 2 : null);
    ind.senkouB = c.map((_, i) => midP(52, i));
    // 衍生量
    ind.volRatio = n >= 21 ? (b.volume[n - 1] / (b.volume.slice(n - 21, n - 1).reduce((a, x) => a + x, 0) / 20)) : null; // #96
    ind.avgAmount20M = n >= 20 ? b.close.slice(n - 20).reduce((s, _, j) => { // #97（百萬元）
      const i = n - 20 + j; const amt = (b.amount && b.amount[i]) ? b.amount[i] : b.volume[i] * b.close[i]; return s + amt; }, 0) / 20 / 1e6 : null;
    ind.prev20High = n >= 21 ? Math.max(...b.high.slice(n - 21, n - 1)) : null;
    ind.low20 = Math.min(...b.low.slice(-20)); ind.low60 = Math.min(...b.low.slice(-60));
    return ind;
  }
  const last = seq => seq && seq.length ? seq[seq.length - 1] : null;
  const prev = seq => seq && seq.length >= 2 ? seq[seq.length - 2] : null;
  const crossedUp = (a, b) => prev(a) != null && prev(b) != null && last(a) != null && last(b) != null && prev(a) <= prev(b) && last(a) > last(b);

  // ---------- 13 項計分 (#81-94，滿分 100) ----------
  const SIGNAL_DEFS = [
    ['MA多頭排列', 10, ind => last(ind.ma5) > last(ind.ma20) && last(ind.ma20) > last(ind.ma60)],
    ['均線黃金交叉', 8, ind => crossedUp(ind.ma5, ind.ma20)],
    ['MACD翻多', 10, ind => crossedUp(ind.macd, ind.macdSignal)],
    ['RSI偏多', 8, ind => last(ind.rsi14) >= 50 && last(ind.rsi14) <= 75],
    ['KD黃金交叉', 6, ind => crossedUp(ind.k, ind.d)],
    ['布林偏多', 6, ind => last(ind.bars.close) > last(ind.ma20) && last(ind.bars.close) <= last(ind.bollUpper) * 1.02],
    ['成交量放大', 10, ind => ind.volRatio != null && ind.volRatio >= 1.5],
    ['OBV偏多', 6, ind => last(ind.obv) > Math.max(...ind.obv.slice(-21, -1))],
    ['ADX強勢', 6, ind => last(ind.adx) >= 25 && last(ind.plusDi) > last(ind.minusDi)],
    ['突破前高', 10, ind => ind.prev20High != null && last(ind.bars.close) > ind.prev20High],
    ['Supertrend翻多', 8, ind => last(ind.stBull) === true],
    ['一目均衡表偏多', 6, ind => {
      const i = ind.bars.close.length - 1, a = ind.senkouA[i - 26], bb = ind.senkouB[i - 26], cl = ind.bars.close[i];
      return a != null && bb != null && cl > a && cl > bb && last(ind.tenkan) > last(ind.kijun);
    }],
    ['MFI偏多', 6, ind => last(ind.mfi14) >= 50],
  ];
  function scoreTech(ind) {
    const hit = [], miss = []; let score = 0;
    for (const [name, pts, fn] of SIGNAL_DEFS) {
      let ok = false; try { ok = !!fn(ind); } catch (e) { ok = false; }
      if (ok) { score += pts; hit.push({ name, pts }); } else miss.push({ name, pts });
    }
    return { score, hit, miss };
  }

  // ---------- 策略與價位 (#103-123) ----------
  function buildStrategy(ind, techScore, periodMode) {
    const b = ind.bars, close = last(b.close), atr = last(ind.atr14);
    if (close == null || atr == null || atr <= 0) return null;
    let period = periodMode && periodMode !== '自動判斷' ? periodMode : null;
    if (!period) period = (close > last(ind.ma60) && last(ind.ma20) > last(ind.ma60) && techScore >= 65) ? '中線' : '短線'; // #103
    const holding = period === '短線' ? '3～15 個交易日' : period === '長線' ? '1～6 個月（技術趨勢觀察）' : '3～8 週'; // #104-107
    const baseMa = period === '長線' ? last(ind.ma60) : last(ind.ma20);
    if (baseMa == null) return null;
    const isBreakout = ind.prev20High != null && close > ind.prev20High && ind.volRatio != null && ind.volRatio >= 1.2; // #109
    const type = isBreakout ? '突破進場' : '回檔進場'; // #108
    let entryLow = Math.min(close - 0.45 * atr, baseMa + 0.25 * atr);   // #110
    let entryHigh = Math.min(close, baseMa + 0.65 * atr);               // #111
    if (entryLow >= entryHigh) entryLow = entryHigh - tickSize(entryHigh);
    const entryMid = roundTick((entryLow + entryHigh) / 2);            // #112
    const support = Math.min(ind.low20, ind.low60, baseMa);             // #113（前低以近20日低代表，與60日低/基準均線取最低）
    let stop = Math.min(entryLow - 1.25 * atr, support - 0.15 * atr);   // #114
    if (stop >= entryLow) stop = entryLow - tickSize(entryLow);
    stop = roundTick(stop);
    const risk = entryMid - stop;
    if (risk <= 0) return null;
    const pressure = ind.prev20High != null && ind.prev20High > entryMid ? ind.prev20High : 0;
    const target1 = roundTick(Math.max(entryMid + 1.8 * risk, pressure)); // #115
    const target2 = roundTick(Math.max(target1 + tickSize(target1), entryMid + 3 * risk)); // #116
    const rr = (target1 - entryMid) / risk;                              // #117
    const distPct = Math.max(0, close - entryHigh) / entryHigh * 100;    // #119
    // 進場狀態 (#133-137)
    let status;
    if (close < entryLow - 0.5 * atr) status = '條件失效';
    else if (close >= entryLow && close <= entryHigh) status = '接近進場';
    else if (isBreakout && close <= entryHigh + 0.8 * atr) status = '突破觀察';
    else if (close > entryHigh + 0.8 * atr) status = '暫不追價';
    else status = '等待回檔';
    // 進場適合度 (#124-132)
    const parts = {
      base: 45,
      distPenalty: -Math.min(45, distPct * 2.2),
      techBonus: Math.min(20, Math.max(0, (techScore - 50) * 0.45)),
      volBonus: Math.min(15, Math.max(0, ((ind.volRatio ?? 0) - 0.8) * 10)),
      rrBonus: Math.min(15, Math.max(0, (rr - 1) * 7)),
      atrPenalty: -Math.min(15, Math.max(0, atr / close * 100 * 1.5)),
    };
    let entryScore = Math.round(parts.base + parts.distPenalty + parts.techBonus + parts.volBonus + parts.rrBonus + parts.atrPenalty);
    entryScore = status === '條件失效' ? 0 : clamp(entryScore, 0, 100);
    return {
      period, holding, type, baseMa, entryLow: roundTick(entryLow), entryHigh: roundTick(entryHigh),
      entryMid, stop, target1, target2, rr, distPct, status, entryScore, parts, support,
      basis: `基準均線 ${period === '長線' ? 'MA60' : 'MA20'}=${baseMa.toFixed(2)}｜ATR14=${atr.toFixed(2)}｜支撐參考=${support.toFixed(2)}`,
      trigger: `股價進入進場區間 ${roundTick(entryLow).toFixed(2)}～${roundTick(entryHigh).toFixed(2)}，且量價未轉弱`,
      invalid: `跌破停損 ${stop.toFixed(2)}、進場條件失效或重大基本面利空時須重新評估`,
    };
  }

  function analyze(stock, periodMode) {
    const ind = computeIndicators(stock.bars);
    const { score, hit, miss } = scoreTech(ind);
    const strat = buildStrategy(ind, score, periodMode);
    if (!strat) return null;
    const c = stock.bars.close, n = c.length;
    const chg = n >= 2 ? c[n - 1] - c[n - 2] : 0;
    return {
      code: stock.code, name: stock.name, market: stock.market, isDemo: !!stock.isDemo,
      date: stock.bars.dates[n - 1], close: c[n - 1], change: chg,
      changePct: n >= 2 && c[n - 2] ? chg / c[n - 2] * 100 : 0,
      techScore: score, hit, miss, ind, strat,
      vlag: strat.target1 > c[n - 1] * 1.5,
      entryScore: strat.entryScore, status: strat.status, period: strat.period, type: strat.type,
      avgAmount20M: ind.avgAmount20M, volRatio: ind.volRatio,
      reason: '',
    };
  }

  function isETF(code) { return /^00/.test(code); } // #47 粗略估算

  // ---------- 全市場掃描 (#98-99, #138-147) ----------
  function scan(stocks, opts) {
    const o = Object.assign({ topN: 10, minTech: 65, minAvgAmountM: 10, minEntry: 45, includeETF: false, periodMode: '自動判斷', sortMode: '綜合模式' }, opts);
    const stats = { scanned: 0, typeExcluded: 0, historyShort: 0, qualityBad: 0, amountLow: 0, techLow: 0, stratFail: 0, entryFail: 0 };
    const candidates = [], watch = [], seen = new Set(), eligible = [];
    for (const s of stocks) {
      if (seen.has(s.code)) continue; seen.add(s.code);
      if (!o.includeETF && isETF(s.code)) { stats.typeExcluded++; continue; }
      const b = filterBars(s.bars);
      if (b.close.length < 125) { stats.historyShort++; continue; } // #98（濾除零價佔位列後計）
      eligible.push({ code: s.code, name: s.name, market: s.market, isDemo: s.isDemo, bars: b });
    }
    // #145 日期一致性（2026-11-14 穩健化修正）：參考日期改採通過代號/歷史長度
    // 關卡股票最後日期的眾數，不再用全體最大值。部分更新時，多數股票仍可正常
    // 掃描；少數超前/落後者仍計入 qualityBad，保留資料一致性的檢查精神。
    const dateCounts = new Map();
    for (const s of eligible) {
      const d = s.bars.dates[s.bars.dates.length - 1];
      if (d) dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
    }
    let latestDate = '', latestCount = -1;
    for (const [d, n] of dateCounts) if (n > latestCount || (n === latestCount && d > latestDate)) { latestDate = d; latestCount = n; }
    for (const s of eligible) {
      const b = s.bars;
      // 資料品質 (#146)：日期重複/逆序、OHLCV 無效、最新兩筆相隔 >12 日
      let bad = false;
      for (let i = 1; i < b.dates.length; i++) if (b.dates[i] <= b.dates[i - 1]) { bad = true; break; }
      if (!bad && b.dates.length >= 2) {
        const gap = (new Date(b.dates[b.dates.length - 1]) - new Date(b.dates[b.dates.length - 2])) / 86400000;
        if (gap > 12) bad = true;
      }
      if (!bad) for (let i = 0; i < b.close.length; i++) {
        if (!(b.close[i] > 0 && b.high[i] >= b.low[i] && b.high[i] >= b.open[i] && b.high[i] >= b.close[i] && b.low[i] <= b.open[i] && b.low[i] <= b.close[i] && b.volume[i] >= 0)) { bad = true; break; }
      }
      if (bad) { stats.qualityBad++; continue; }
      if (b.dates[b.dates.length - 1] !== latestDate) { stats.qualityBad++; continue; } // #145 日期一致性
      stats.scanned++;
      let a = null;
      try { a = analyze({ code: s.code, name: s.name, market: s.market, isDemo: s.isDemo, bars: trimBars(b, 360) }, o.periodMode); } catch (e) { a = null; }
      if (!a) { stats.stratFail++; continue; }
      // 策略防線：停損非正值或目標未高於進場下限者，視為資料/策略異常，不進候選也不進觀察
      if (!(a.strat.stop > 0) || !(a.strat.target1 > a.strat.entryLow)) { stats.qualityBad++; continue; }
      if (a.avgAmount20M == null || a.avgAmount20M < o.minAvgAmountM) { stats.amountLow++; continue; }
      if (a.techScore < o.minTech) { stats.techLow++; continue; }
      const priceOk = a.strat.stop < a.strat.entryLow && a.strat.entryLow < a.strat.target1;
      const ok = a.entryScore >= o.minEntry && a.status !== '條件失效' && a.status !== '暫不追價' && priceOk && a.strat.rr >= 1.5; // #138-139
      if (ok) { a.reason = `技術 ${a.techScore} 分、進場適合度 ${a.entryScore} 分、風報 1:${a.strat.rr.toFixed(2)}，狀態「${a.status}」`; candidates.push(a); }
      else {
        let why;
        if (a.entryScore < o.minEntry) why = `進場適合度 ${a.entryScore} 未達 ${o.minEntry}`;
        else if (a.strat.rr < 1.5) why = `目標空間不足（風報比 1:${a.strat.rr.toFixed(2)} 未達 1.5）`;
        else if (a.status === '暫不追價') why = '漲多離進場區太遠，先等回檔';
        else if (a.status === '條件失效') why = '進場條件已失效';
        else why = `狀態「${a.status}」，等進場區間到位`;
        a.reason = '技術 ' + a.techScore + ' 分，' + why;
        watch.push(a); stats.entryFail++;
      }
    }
    const liqScore = a => Math.min(100, Math.max(0, Math.log10(Math.max(a.avgAmount20M || 1, 1)) * 50));
    const rrScore = a => Math.min(100, a.strat.rr / 3 * 100);
    const composite = a => a.techScore * 0.42 + a.entryScore * 0.38 + liqScore(a) * 0.10 + rrScore(a) * 0.10; // #142
    if (o.sortMode === '技術強勢優先') candidates.sort((x, y) => y.techScore - x.techScore || y.entryScore - x.entryScore || (y.avgAmount20M || 0) - (x.avgAmount20M || 0)); // #143
    else if (o.sortMode === '近期進場優先') candidates.sort((x, y) => y.entryScore - x.entryScore || x.strat.distPct - y.strat.distPct || y.techScore - x.techScore); // #144
    else candidates.sort((x, y) => composite(y) - composite(x));
    watch.sort((x, y) => y.techScore - x.techScore || y.entryScore - x.entryScore);
    return { candidates: candidates.slice(0, o.topN), allCandidates: candidates, watch, stats, latestDate }; // #66 門檻嚴格，不湊數
  }
  function trimBars(b, max) {
    if (b.close.length <= max) return b;
    const s = b.close.length - max;
    return { dates: b.dates.slice(s), open: b.open.slice(s), high: b.high.slice(s), low: b.low.slice(s), close: b.close.slice(s), volume: b.volume.slice(s), amount: (b.amount || []).slice(s) };
  }

  // ---------- 歷史訊號觀察 (#240-250) ----------
  // 訊號定義（2026-11-14 改版）：逐日重算，當天達到「目前所選風格的完整推薦條件」才算訊號日，
  // 與 scan 的候選條件一致——techScore ≥ minTech、entryScore ≥ minEntry、
  // avgAmount20M ≥ minAvgAmountM、status 不是「暫不追價」/「條件失效」、
  // strat.rr ≥ 1.5、priceOk（stop < entryLow < target1）且 stop > 0。門檻由呼叫端傳入。
  // 計次採逐日：每個訊號日都列入（days＝訊號日總數）；連續訊號日合併為一「波」（waves）。
  // 執行依訊號日狀態分組，照工具當天給使用者的建議模擬買進：
  //   直接買組（狀態「接近進場」或「突破觀察」）：訊號日收盤買進、抱滿天數；
  //     目標/停損觸及以訊號日策略價位、持有期間 high/low 判定。
  //   等回檔組（狀態「等待回檔」）：訊號日不買，往後 waitDays（預設 5）個交易日內，
  //     第一個收盤 ≤ 訊號日進場區上緣（entryHigh）的日子以該日收盤買進；沒等到＝未成交
  //     （計入成交率分母，不列入績效）。買進後抱滿天數與目標/停損觸及一律以實際買進日
  //     起算，價位用買進日的策略（當天 analyze；analyze 失敗時退回訊號日策略價位）。
  // 報酬一律扣 costRate+slippage（預設共 0.5%）。horizons 由呼叫端依週期傳入
  // （短線 [5,10,20]、中線 [10,20,40]、長線 [20,60,120]）。
  // 每組每 天數另回 medRet（與 avgRet 同一組已成交報酬樣本的中位數，偶數筆取中間
  // 兩筆平均）；entries 為每波一筆代表紀錄（見函式尾），供 K 線回顧標記使用。
  // 效能：逐日判定改用 analyzeWindow——只取當天往前 ≤360 日視窗，以與 computeIndicators
  // 相同的種子/遞迴順序重算路徑相依指標（EMA/MACD/RSI/KD/ATR/ADX/Supertrend），
  // 視窗位置型數值（均線/布林/OBV/一目/trailing 量）取視窗尾端，再經 scoreTechAt/
  // buildStrategyAt（scoreTech/buildStrategy 的逐索引鏡像）評分。已逐日驗證與
  // analyze(slice+trimBars 360) 位元一致（2886/2891 全 4,624 日＋demo 3,150 日零差異），
  // 訊號集合與 b29c219c 逐日 analyze 版完全相同；單檔 10 年歷史實測約 0.5 秒。
  function scoreTechAt(ind, i, volRatioAt, prevHighAt) {
    const c = ind.bars.close;
    const xup = (a, b) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
    let s = 0;
    if (ind.ma5[i] > ind.ma20[i] && ind.ma20[i] > ind.ma60[i]) s += 10;              // MA多頭排列
    if (xup(ind.ma5, ind.ma20)) s += 8;                                            // 均線黃金交叉
    if (xup(ind.macd, ind.macdSignal)) s += 10;                                    // MACD翻多
    if (ind.rsi14[i] >= 50 && ind.rsi14[i] <= 75) s += 8;                          // RSI偏多
    if (xup(ind.k, ind.d)) s += 6;                                                 // KD黃金交叉
    if (c[i] > ind.ma20[i] && c[i] <= ind.bollUpper[i] * 1.02) s += 6;             // 布林偏多
    if (volRatioAt != null && volRatioAt >= 1.5) s += 10;                          // 成交量放大
    { let m = -Infinity; for (let j = i - 20; j < i; j++) if (ind.obv[j] > m) m = ind.obv[j]; if (ind.obv[i] > m) s += 6; } // OBV偏多
    if (ind.adx[i] >= 25 && ind.plusDi[i] > ind.minusDi[i]) s += 6;                // ADX強勢
    if (prevHighAt != null && c[i] > prevHighAt) s += 10;                          // 突破前高
    if (ind.stBull[i] === true) s += 8;                                            // Supertrend翻多
    { const a = ind.senkouA[i - 26], bb = ind.senkouB[i - 26];                     // 一目均衡表偏多
      if (a != null && bb != null && c[i] > a && c[i] > bb && ind.tenkan[i] > ind.kijun[i]) s += 6; }
    if (ind.mfi14[i] >= 50) s += 6;                                                // MFI偏多
    return s;
  }
  function buildStrategyAt(ind, i, techScore, periodMode, sc) {
    const b = ind.bars, close = b.close[i], atr = ind.atr14[i];
    if (close == null || atr == null || atr <= 0) return null;
    let period = periodMode && periodMode !== '自動判斷' ? periodMode : null;
    if (!period) period = (close > ind.ma60[i] && ind.ma20[i] > ind.ma60[i] && techScore >= 65) ? '中線' : '短線';
    const baseMa = period === '長線' ? ind.ma60[i] : ind.ma20[i];
    if (baseMa == null) return null;
    const isBreakout = sc.prevHigh != null && close > sc.prevHigh && sc.volRatio != null && sc.volRatio >= 1.2;
    let entryLow = Math.min(close - 0.45 * atr, baseMa + 0.25 * atr);
    let entryHigh = Math.min(close, baseMa + 0.65 * atr);
    if (entryLow >= entryHigh) entryLow = entryHigh - tickSize(entryHigh);
    const entryMid = roundTick((entryLow + entryHigh) / 2);
    const support = Math.min(sc.low20, sc.low60, baseMa);
    let stop = Math.min(entryLow - 1.25 * atr, support - 0.15 * atr);
    if (stop >= entryLow) stop = entryLow - tickSize(entryLow);
    stop = roundTick(stop);
    const risk = entryMid - stop;
    if (risk <= 0) return null;
    const pressure = sc.prevHigh != null && sc.prevHigh > entryMid ? sc.prevHigh : 0;
    const target1 = roundTick(Math.max(entryMid + 1.8 * risk, pressure));
    const rr = (target1 - entryMid) / risk;
    const distPct = Math.max(0, close - entryHigh) / entryHigh * 100;
    let status;
    if (close < entryLow - 0.5 * atr) status = '條件失效';
    else if (close >= entryLow && close <= entryHigh) status = '接近進場';
    else if (isBreakout && close <= entryHigh + 0.8 * atr) status = '突破觀察';
    else if (close > entryHigh + 0.8 * atr) status = '暫不追價';
    else status = '等待回檔';
    const parts = {
      base: 45,
      distPenalty: -Math.min(45, distPct * 2.2),
      techBonus: Math.min(20, Math.max(0, (techScore - 50) * 0.45)),
      volBonus: Math.min(15, Math.max(0, ((sc.volRatio ?? 0) - 0.8) * 10)),
      rrBonus: Math.min(15, Math.max(0, (rr - 1) * 7)),
      atrPenalty: -Math.min(15, Math.max(0, atr / close * 100 * 1.5)),
    };
    let entryScore = Math.round(parts.base + parts.distPenalty + parts.techBonus + parts.volBonus + parts.rrBonus + parts.atrPenalty);
    entryScore = status === '條件失效' ? 0 : clamp(entryScore, 0, 100);
    return { entryLow: roundTick(entryLow), entryHigh: roundTick(entryHigh), entryMid, stop, target1, rr, distPct, status, entryScore };
  }
  // analyzeWindow(b, end, periodMode)：只取 end 往前 ≤360 日視窗，重算 analyze 在該視窗的
  // 全部判定輸出（techScore/entryScore/status/strat/avgAmount20M），與
  // analyze(trimBars(slice(0, end+1), 360)) 位元一致（驗證見上方效能註記）。
  // 路徑相依指標（EMA/MACD/RSI/KD/ATR/ADX/Supertrend）以與 computeIndicators 相同的
  // 種子與遞迴順序在視窗內重算；視窗位置型數值取視窗尾端；最後組裝成索引 26=當日、
  // 25=前日、senkou 位於 0 的 ind 形狀，交給 scoreTechAt/buildStrategyAt 評分。
  function analyzeWindow(b, end, periodMode) {
    const s = Math.max(0, end - 359);
    const c = b.close.slice(s, end + 1), h = b.high.slice(s, end + 1), l = b.low.slice(s, end + 1),
          v = b.volume.slice(s, end + 1), amt = b.amount ? b.amount.slice(s, end + 1) : null;
    const m = c.length, L = m - 1;
    if (m < 15) return null;
    const trAt = i => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    // 均線（sma 的 running sum 順序）
    let ma5p = null, ma5L = null, ma20p = null, ma20L = null, ma60L = null;
    { let s5 = 0, s20 = 0, s60 = 0;
      for (let j = 0; j <= L; j++) {
        s5 += c[j]; if (j >= 5) s5 -= c[j - 5];
        s20 += c[j]; if (j >= 20) s20 -= c[j - 20];
        s60 += c[j]; if (j >= 60) s60 -= c[j - 60];
        if (j === L - 1) { ma5p = s5 / 5; ma20p = s20 / 20; }
        if (j === L) { ma5L = s5 / 5; ma20L = s20 / 20; ma60L = j >= 59 ? s60 / 60 : null; }
      } }
    // EMA12/26、MACD 與訊號線（ema 的種子/遞迴順序）
    let macdP = null, macdL = null, sigP = null, sigL = null;
    { let e12 = null, e26 = null, sum12 = 0, sum26 = 0;
      const macdVals = [];
      for (let j = 0; j <= L; j++) {
        if (j < 12) sum12 += c[j]; if (j === 11) e12 = sum12 / 12; else if (j > 11) e12 = c[j] * (2 / 13) + e12 * (1 - 2 / 13);
        if (j < 26) sum26 += c[j]; if (j === 25) e26 = sum26 / 26; else if (j > 25) e26 = c[j] * (2 / 27) + e26 * (1 - 2 / 27);
        if (e12 != null && e26 != null) { const mv = e12 - e26; macdVals.push([j, mv]); if (j === L - 1) macdP = mv; if (j === L) macdL = mv; }
      }
      if (macdVals.length >= 9) {
        let prev = 0; for (let j = 0; j < 9; j++) prev += macdVals[j][1]; prev /= 9;
        const kk2 = 2 / 10;
        if (macdVals[8][0] === L - 1) sigP = prev;
        if (macdVals[8][0] === L) sigL = prev;
        for (let j = 9; j < macdVals.length; j++) { prev = macdVals[j][1] * kk2 + prev * (1 - kk2); if (macdVals[j][0] === L - 1) sigP = prev; if (macdVals[j][0] === L) sigL = prev; }
      } }
    // RSI14（Wilder）
    let rsiL = null;
    { let ag = 0, al = 0;
      for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; ag += Math.max(d, 0); al += Math.max(-d, 0); }
      ag /= 14; al /= 14;
      let r = al === 0 ? 100 : 100 - 100 / (1 + ag / al); if (L === 14) rsiL = r;
      for (let i = 15; i <= L; i++) { const d = c[i] - c[i - 1]; ag = (ag * 13 + Math.max(d, 0)) / 14; al = (al * 13 + Math.max(-d, 0)) / 14; r = al === 0 ? 100 : 100 - 100 / (1 + ag / al); if (i === L) rsiL = r; } }
    // KD（RSV 9 + 1/3 平滑）
    let kP = null, kL = null, dP = null, dL = null;
    { let pk = 50, pd = 50;
      for (let i = 0; i <= L; i++) {
        if (i < 8) continue;
        let hh = -Infinity, ll = Infinity;
        for (let j = i - 8; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; }
        const rsv = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
        pk = pk * 2 / 3 + rsv / 3; pd = pd * 2 / 3 + pk / 3;
        if (i === L - 1) { kP = pk; dP = pd; }
        if (i === L) { kL = pk; dL = pd; }
      } }
    // 布林上緣（ma20 ± 2σ，兩段式標準差）
    let bollUpperL = null;
    if (L >= 19 && ma20L != null) { let ss = 0; for (let j = L - 19; j <= L; j++) ss += (c[j] - ma20L) ** 2; bollUpperL = ma20L + 2 * Math.sqrt(ss / 20); }
    // ATR14（Wilder）與 Supertrend（同一趟遞迴）
    let atrL = null, stBullL = null;
    { let atrPrev = null, sum14 = 0, fU = null, fL = null, prevBull = true;
      for (let i = 0; i <= L; i++) {
        const tr = trAt(i);
        if (i >= 1 && i <= 14) sum14 += tr;
        if (i === 14) atrPrev = sum14 / 14;
        else if (i > 14) atrPrev = (atrPrev * 13 + tr) / 14;
        if (i < 14) continue;
        const atr = atrPrev;
        if (i === L) atrL = atr;
        const mid = (h[i] + l[i]) / 2;
        let up = mid + 3 * atr, lo = mid - 3 * atr;
        if (fU != null) { up = (up < fU || c[i - 1] > fU) ? up : fU; lo = (lo > fL || c[i - 1] < fL) ? lo : fL; }
        let cur; if (fL == null) cur = true; else if (prevBull) cur = !(c[i] < fL); else cur = c[i] > fU;
        if (i === L) stBullL = cur;
        fU = up; fL = lo; prevBull = cur;
      } }
    // ADX / +DI / -DI（Wilder 平滑 + DX 的 vi 壓縮遞迴）
    let adxL = null, plusDiL = null, minusDiL = null;
    { let sTr = 0, sP = 0, sM = 0, sumTr = 0, sumP = 0, sumM = 0, adxPrev = null, dxCnt = 0, dxSum = 0;
      for (let i = 1; i <= L; i++) {
        const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
        const pdm = (up > dn && up > 0) ? up : 0, mdm = (dn > up && dn > 0) ? dn : 0, tr = trAt(i);
        if (i <= 14) { sumTr += tr; sumP += pdm; sumM += mdm; if (i === 14) { sTr = sumTr; sP = sumP; sM = sumM; } }
        else { sTr = sTr - sTr / 14 + tr; sP = sP - sP / 14 + pdm; sM = sM - sM / 14 + mdm; }
        if (i < 14) continue;
        let dx = null, pDi = null, mDi = null;
        if (sTr > 0) { pDi = sP / sTr * 100; mDi = sM / sTr * 100; const den = pDi + mDi; dx = den ? Math.abs(pDi - mDi) / den * 100 : 0; }
        if (i === L) { plusDiL = pDi; minusDiL = mDi; }
        if (dx != null) {
          dxCnt++;
          if (dxCnt <= 14) dxSum += dx;
          if (dxCnt === 14) adxPrev = dxSum / 14;
          else if (dxCnt > 14) adxPrev = (adxPrev * 13 + dx) / 14;
          if (i === L) adxL = dxCnt > 14 ? adxPrev : null; // 原版需 vi 長度 > 14 才有 adx
        }
      } }
    // MFI14（當日）
    let mfiL = null;
    if (L >= 14) { const tp = i => (h[i] + l[i] + c[i]) / 3; let pos = 0, neg = 0;
      for (let j = L - 13; j <= L; j++) { const f = tp(j) * v[j]; if (tp(j) > tp(j - 1)) pos += f; else if (tp(j) < tp(j - 1)) neg += f; }
      mfiL = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg); }
    // OBV
    const obvArr = new Array(m); obvArr[0] = 0;
    for (let i = 1; i < m; i++) obvArr[i] = obvArr[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0);
    // 一目均衡表（當日與 26 日前的轉換/基準/先行）
    const midP = (p, i) => { if (i < p - 1) return null; let hh = -Infinity, ll = Infinity; for (let j = i - p + 1; j <= i; j++) { if (h[j] > hh) hh = h[j]; if (l[j] < ll) ll = l[j]; } return (hh + ll) / 2; };
    const tenkanL = midP(9, L), kijunL = midP(26, L);
    const iS = L - 26;
    const tS = iS >= 0 ? midP(9, iS) : null, kS = iS >= 0 ? midP(26, iS) : null;
    const senkouA = (tS != null && kS != null) ? (tS + kS) / 2 : null;
    const senkouB = iS >= 0 ? midP(52, iS) : null;
    // trailing 量（與 computeIndicators 同公式）
    let volRatio = null;
    if (m >= 21) { let sv = 0; for (let j = L - 20; j < L; j++) sv += v[j]; volRatio = v[L] / (sv / 20); }
    let avgAmount20M = null;
    if (m >= 20) { let sa = 0; for (let j = L - 19; j <= L; j++) sa += (amt && amt[j]) ? amt[j] : v[j] * c[j]; avgAmount20M = sa / 20 / 1e6; }
    let prev20High = null;
    if (m >= 21) { let mx = -Infinity; for (let j = L - 20; j < L; j++) if (h[j] > mx) mx = h[j]; prev20High = mx; }
    let low20 = Infinity, low60 = Infinity;
    for (let j = Math.max(0, L - 19); j <= L; j++) if (l[j] < low20) low20 = l[j];
    for (let j = Math.max(0, L - 59); j <= L; j++) if (l[j] < low60) low60 = l[j];
    // 組裝 ind 形狀（26=當日、25=前日、senkou 在 0）給 At 鏡像評分
    const A = () => new Array(27).fill(null);
    const indW = { bars: { close: A() }, ma5: A(), ma20: A(), ma60: A(), macd: A(), macdSignal: A(), rsi14: A(), k: A(), d: A(),
      bollUpper: A(), atr14: A(), adx: A(), plusDi: A(), minusDi: A(), mfi14: A(), obv: new Array(27).fill(0), stBull: A(), tenkan: A(), kijun: A(), senkouA: A(), senkouB: A() };
    indW.bars.close[26] = c[L];
    indW.ma5[25] = ma5p; indW.ma5[26] = ma5L;
    indW.ma20[25] = ma20p; indW.ma20[26] = ma20L;
    indW.ma60[26] = ma60L;
    indW.macd[25] = macdP; indW.macd[26] = macdL;
    indW.macdSignal[25] = sigP; indW.macdSignal[26] = sigL;
    indW.rsi14[26] = rsiL;
    indW.k[25] = kP; indW.k[26] = kL;
    indW.d[25] = dP; indW.d[26] = dL;
    indW.bollUpper[26] = bollUpperL;
    indW.atr14[26] = atrL;
    indW.adx[26] = adxL; indW.plusDi[26] = plusDiL; indW.minusDi[26] = minusDiL;
    indW.mfi14[26] = mfiL;
    for (let j = 0; j <= 20; j++) indW.obv[6 + j] = obvArr[L - 20 + j];
    indW.stBull[26] = stBullL;
    indW.tenkan[26] = tenkanL; indW.kijun[26] = kijunL;
    indW.senkouA[0] = senkouA; indW.senkouB[0] = senkouB;
    const techScore = scoreTechAt(indW, 26, volRatio, prev20High);
    const strat = buildStrategyAt(indW, 26, techScore, periodMode, { volRatio, prevHigh: prev20High, low20, low60 });
    if (!strat) return null;
    return { techScore, entryScore: strat.entryScore, status: strat.status, strat, avgAmount20M };
  }
  function historyStats(stock, opts = {}) {
    const o = Object.assign({ minTech: 65, minEntry: 45, minAvgAmountM: 10, horizons: [5, 10, 20], periodMode: '自動判斷', costRate: 0.004, slippage: 0.001, waitDays: 5 }, opts);
    const b = stock.bars, horizons = o.horizons, n = b.close.length;
    const blankG = () => { const g = {}; for (const h of horizons) g[h] = { count: 0, upRatio: 0, avgRet: 0, medRet: 0, targetHit: 0, stopHit: 0 }; return g; };
    const out = {
      waves: 0, days: 0, signalDays: [], entries: [],
      direct: Object.assign(blankG(), { days: 0, dates: [] }),
      wait: Object.assign(blankG(), { signalDays: 0, dates: [], filled: 0, filledDates: [], fillRate: 0 }),
    };
    if (n < 126) return out;
    const sums = { direct: {}, wait: {} }, ups = { direct: {}, wait: {} }, th = { direct: {}, wait: {} }, sh = { direct: {}, wait: {} };
    const retsArr = { direct: {}, wait: {} };
    for (const g of ['direct', 'wait']) for (const h of horizons) { sums[g][h] = 0; ups[g][h] = 0; th[g][h] = 0; sh[g][h] = 0; retsArr[g][h] = []; }
    const record = (g, entryIdx, strat) => {
      for (const h of horizons) {
        if (entryIdx + h >= n) continue;
        const ret = (b.close[entryIdx + h] / b.close[entryIdx] - 1) - o.costRate - o.slippage;
        out[g][h].count++; sums[g][h] += ret * 100; retsArr[g][h].push(ret * 100); if (ret > 0) ups[g][h]++;
        let hitT = false, hitS = false;
        for (let j = entryIdx + 1; j <= entryIdx + h; j++) { if (b.high[j] >= strat.target1) hitT = true; if (b.low[j] <= strat.stop) hitS = true; }
        if (hitT) th[g][h]++; if (hitS) sh[g][h]++;
      }
    };
    let prevOk = false;
    let curWave = null; const wavesArr = [];
    const newWave = () => ({ days: 0, direct: 0, waitFilled: 0, unfilled: 0, fills: [], firstSigIdx: -1 });
    for (let end = 125; end < n; end++) {
      const a = analyzeWindow(b, end, o.periodMode);
      const priceOk = !!a && a.strat.stop > 0 && a.strat.stop < a.strat.entryLow && a.strat.entryLow < a.strat.target1;
      const okDay = !!a && a.techScore >= o.minTech && a.entryScore >= o.minEntry
        && a.avgAmount20M != null && a.avgAmount20M >= o.minAvgAmountM
        && a.status !== '條件失效' && a.status !== '暫不追價' && a.strat.rr >= 1.5 && priceOk;
      if (okDay) {
        out.days++; out.signalDays.push(b.dates[end]);
        if (!prevOk) { out.waves++; curWave = newWave(); wavesArr.push(curWave); }
        curWave.days++; if (curWave.firstSigIdx < 0) curWave.firstSigIdx = end;
        if (a.status === '等待回檔') {
          const w = out.wait;
          w.signalDays++; w.dates.push(b.dates[end]);
          let buy = -1;
          for (let j = end + 1; j <= Math.min(end + o.waitDays, n - 1); j++) if (b.close[j] <= a.strat.entryHigh) { buy = j; break; }
          if (buy >= 0) {
            w.filled++; w.filledDates.push(b.dates[buy]);
            curWave.waitFilled++; curWave.fills.push({ idx: buy, sigIdx: end, group: 'wait' });
            const ba = analyzeWindow(b, buy, o.periodMode);
            record('wait', buy, (ba && ba.strat) || a.strat);
          } else curWave.unfilled++;
        } else { // 接近進場 / 突破觀察 → 直接買
          out.direct.days++; out.direct.dates.push(b.dates[end]);
          curWave.direct++; curWave.fills.push({ idx: end, sigIdx: end, group: 'direct' });
          record('direct', end, a.strat);
        }
      }
      prevOk = okDay;
    }
    for (const g of ['direct', 'wait']) for (const h of horizons) {
      const cnt = out[g][h].count;
      if (cnt) {
        out[g][h].upRatio = ups[g][h] / cnt * 100; out[g][h].avgRet = sums[g][h] / cnt;
        out[g][h].targetHit = th[g][h] / cnt * 100; out[g][h].stopHit = sh[g][h] / cnt * 100;
        const arr = retsArr[g][h].slice().sort((x, y) => x - y), mid = arr.length >> 1;
        out[g][h].medRet = arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
      }
    }
    out.wait.fillRate = out.wait.signalDays ? out.wait.filled / out.wait.signalDays * 100 : 0;
    // entries：每波一筆代表紀錄供 K 線標記——波內第一個已成交進場（以實際進場日先後計，
    // 同日取訊號日較早者）；整波無成交時以第一個訊號日為未成交代表。
    const entryRets = idx => { const r = {}; for (const h of horizons) r[h] = idx + h < n ? ((b.close[idx + h] / b.close[idx] - 1) - o.costRate - o.slippage) * 100 : null; return r; };
    out.entries = wavesArr.map((w, wi) => {
      const base = { wave: wi + 1, days: w.days, direct: w.direct, waitFilled: w.waitFilled, unfilled: w.unfilled };
      if (w.fills.length) {
        let best = w.fills[0];
        for (const f of w.fills) if (f.idx < best.idx || (f.idx === best.idx && f.sigIdx < best.sigIdx)) best = f;
        return Object.assign(base, { filled: true, group: best.group, idx: best.idx, date: b.dates[best.idx], sigIdx: best.sigIdx, sigDate: b.dates[best.sigIdx], price: b.close[best.idx], rets: entryRets(best.idx) });
      }
      const r = {}; for (const h of horizons) r[h] = null;
      return Object.assign(base, { filled: false, group: 'wait', idx: w.firstSigIdx, date: b.dates[w.firstSigIdx], sigIdx: w.firstSigIdx, sigDate: b.dates[w.firstSigIdx], price: b.close[w.firstSigIdx], rets: r });
    });
    return out;
  }

  // aggregateBars(b, unit)：日線合成週線（ISO 週一～週日）或月線（日曆月）。
  // 開＝首日開、高＝最高、低＝最低、收＝末日收、量＝合計；dates/endDates＝組內最後
  // 交易日、startDates＝首日、fromIdx/toIdx＝日線索引範圍（供訊號標記對位）。
  function aggregateBars(b, unit) {
    const n = b.close.length;
    const out = { dates: [], open: [], high: [], low: [], close: [], volume: [], amount: b.amount ? [] : null, startDates: [], endDates: [], fromIdx: [], toIdx: [] };
    if (!n) return out;
    const keyOf = dstr => {
      if (unit === 'month') return dstr.slice(0, 7);
      const d = new Date(dstr + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };
    let curKey = null, gi = -1;
    for (let i = 0; i < n; i++) {
      const k = keyOf(b.dates[i]);
      if (k !== curKey) {
        curKey = k; gi++;
        out.dates.push(b.dates[i]); out.open.push(b.open[i]); out.high.push(b.high[i]); out.low.push(b.low[i]); out.close.push(b.close[i]);
        out.volume.push(b.volume[i]); if (out.amount) out.amount.push(b.amount[i] || 0);
        out.startDates.push(b.dates[i]); out.endDates.push(b.dates[i]); out.fromIdx.push(i); out.toIdx.push(i);
      } else {
        if (b.high[i] > out.high[gi]) out.high[gi] = b.high[i];
        if (b.low[i] < out.low[gi]) out.low[gi] = b.low[i];
        out.close[gi] = b.close[i]; out.dates[gi] = b.dates[i]; out.endDates[gi] = b.dates[i]; out.toIdx[gi] = i;
        out.volume[gi] += b.volume[i]; if (out.amount) out.amount[gi] += (b.amount[i] || 0);
      }
    }
    return out;
  }

  const api = { sma, ema, tickSize, roundTick, filterBars, computeIndicators, scoreTech, buildStrategy, analyze, scan, historyStats, aggregateBars, isETF, trimBars, SIGNAL_DEFS };
  global.TWCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

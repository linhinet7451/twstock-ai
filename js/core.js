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
  function historyStats(stock, costRate = 0.004, slippage = 0.001) {
    const b = stock.bars, horizons = [5, 10, 20], out = {};
    for (const h of horizons) out[h] = { count: 0, upRatio: 0, avgRet: 0, targetHit: 0, stopHit: 0 };
    const sums = { 5: 0, 10: 0, 20: 0 }, ups = { 5: 0, 10: 0, 20: 0 }, th = { 5: 0, 10: 0, 20: 0 }, sh = { 5: 0, 10: 0, 20: 0 };
    for (let end = 125; end < b.close.length; end++) {
      const sub = trimBars({ dates: b.dates.slice(0, end + 1), open: b.open.slice(0, end + 1), high: b.high.slice(0, end + 1), low: b.low.slice(0, end + 1), close: b.close.slice(0, end + 1), volume: b.volume.slice(0, end + 1), amount: (b.amount || []).slice(0, end + 1) }, 360);
      let a = null; try { a = analyze({ code: stock.code, name: stock.name, market: stock.market, bars: sub }, '自動判斷'); } catch (e) { }
      if (!a || a.techScore < 70) continue; // #242
      for (const h of horizons) {
        if (end + h >= b.close.length) continue;
        const ret = (b.close[end + h] / b.close[end] - 1) - costRate - slippage; // #247
        out[h].count++; sums[h] += ret * 100; if (ret > 0) ups[h]++;
        let hitT = false, hitS = false;
        for (let j = end + 1; j <= end + h; j++) { if (b.high[j] >= a.strat.target1) hitT = true; if (b.low[j] <= a.strat.stop) hitS = true; }
        if (hitT) th[h]++; if (hitS) sh[h]++;
      }
    }
    for (const h of horizons) if (out[h].count) { out[h].upRatio = ups[h] / out[h].count * 100; out[h].avgRet = sums[h] / out[h].count; out[h].targetHit = th[h] / out[h].count * 100; out[h].stopHit = sh[h] / out[h].count * 100; }
    return out;
  }

  const api = { sma, ema, tickSize, roundTick, filterBars, computeIndicators, scoreTech, buildStrategy, analyze, scan, historyStats, isETF, trimBars, SIGNAL_DEFS };
  global.TWCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

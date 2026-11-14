import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const core = require('../js/core.js');
const demo = require('../js/demo.js');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.log('FAIL:', label); } }

// tick
ok(core.tickSize(5) === 0.01 && core.tickSize(30) === 0.05 && core.tickSize(80) === 0.1 && core.tickSize(300) === 0.5 && core.tickSize(800) === 1 && core.tickSize(2000) === 5, 'tick sizes');
ok(core.roundTick(100.3) === 100.5, 'roundTick 100.3 -> 100.5');

// demo stocks 分析與掃描
const stocks = demo.generateDemoStocks();
ok(stocks.length === 18, 'demo 18 檔');
ok(stocks.every(s => s.bars.close.length === 300), 'demo 300 日');
for (const s of stocks) {
  const a = core.analyze(s, '自動判斷');
  ok(a !== null, `analyze ${s.code}`);
  if (!a) continue;
  ok(a.techScore >= 0 && a.techScore <= 100, `score range ${s.code}`);
  ok(a.strat.stop < a.strat.entryLow && a.strat.entryLow <= a.strat.entryHigh && a.strat.entryMid <= a.strat.target1 && a.strat.target1 < a.strat.target2, `price order ${s.code}`);
  ok(a.entryScore >= 0 && a.entryScore <= 100, `entry range ${s.code}`);
  const sum = a.hit.reduce((x, h) => x + h.pts, 0);
  ok(sum === a.techScore, `score sum ${s.code}`);
}
const res = core.scan(stocks, { topN: 10, minTech: 65, minAvgAmountM: 10, minEntry: 45, includeETF: false });
ok(res.candidates.length <= 10, 'topN cap');
ok(res.candidates.every(a => a.techScore >= 65 && a.entryScore >= 45 && a.strat.rr >= 1.5), 'candidate thresholds strict');
ok(res.candidates.every(a => a.status !== '條件失效' && a.status !== '暫不追價'), 'candidate status');
const codes = new Set([...res.candidates, ...res.watch].map(a => a.code));
ok(codes.size === res.candidates.length + res.watch.length, 'no duplicate across lists');
console.log('scan stats:', JSON.stringify(res.stats), 'candidates:', res.candidates.map(a => a.code + ':' + a.techScore + '/' + a.entryScore).join(', '), 'watch:', res.watch.length);

// #145 眾數日期：多數同日、少數超前時，多數仍被掃描，少數被資料品質排除
function mixedDateStock(code, endDate) {
  const end = new Date(endDate + 'T00:00:00Z');
  const dates = [], open = [], high = [], low = [], close = [], volume = [], amount = [];
  for (let i = 129; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
    open.push(100); high.push(101); low.push(99); close.push(100); volume.push(1000000); amount.push(100000000);
  }
  return { code, name: '混合日期' + code, market: 'TWSE', bars: { dates, open, high, low, close, volume, amount } };
}
const mixed = [
  mixedDateStock('1111', '2026-11-12'), mixedDateStock('2222', '2026-11-12'),
  mixedDateStock('3333', '2026-11-12'), mixedDateStock('4444', '2026-11-13'),
];
const mixedRes = core.scan(mixed, { topN: 10, minTech: 0, minAvgAmountM: 0, minEntry: 0, includeETF: false });
ok(mixedRes.latestDate === '2026-11-12', 'mode date is majority date');
ok(mixedRes.stats.scanned === 3, 'mode date scans majority stocks');
ok(mixedRes.stats.qualityBad === 1, 'mode date excludes minority ahead stock');

// 歷史訊號（訊號＝目前所選風格的完整推薦條件，逐日計次＋波數；執行依訊號日狀態分組：
// 接近進場/突破觀察→訊號日直接買；等待回檔→5 日內回到進場區上緣才買，沒等到不算績效）
// 獨立重算（b29 式逐日 slice+trim+analyze，與 production 的 analyzeWindow 不同實作，互為對照）
function historyRef(stock, opts = {}) {
  const o = Object.assign({ minTech: 65, minEntry: 45, minAvgAmountM: 10, horizons: [5, 10, 20], periodMode: '自動判斷', costRate: 0.004, slippage: 0.001, waitDays: 5 }, opts);
  const b = stock.bars, n = b.close.length;
  const grp = () => { const g = {}; for (const h of o.horizons) g[h] = { count: 0, up: 0, sum: 0, t: 0, s: 0 }; return g; };
  const D = grp(), W = grp();
  const res = { waves: 0, days: 0, signalDays: [], directDays: 0, directDates: [], waitSignalDays: 0, waitDates: [], waitFilled: 0, filledDates: [] };
  const analyzeAt = (end) => {
    const sub = core.trimBars({ dates: b.dates.slice(0, end + 1), open: b.open.slice(0, end + 1), high: b.high.slice(0, end + 1), low: b.low.slice(0, end + 1), close: b.close.slice(0, end + 1), volume: b.volume.slice(0, end + 1), amount: (b.amount || []).slice(0, end + 1) }, 360);
    try { return core.analyze({ code: stock.code, name: stock.name, market: stock.market, bars: sub }, o.periodMode); } catch (e) { return null; }
  };
  const rec = (G, idx, strat) => { for (const h of o.horizons) { if (idx + h >= n) continue; const r = (b.close[idx + h] / b.close[idx] - 1) - o.costRate - o.slippage; const g = G[h]; g.count++; g.sum += r * 100; if (r > 0) g.up++; let t = false, s = false; for (let j = idx + 1; j <= idx + h; j++) { if (b.high[j] >= strat.target1) t = true; if (b.low[j] <= strat.stop) s = true; } if (t) g.t++; if (s) g.s++; } };
  let prevOk = false;
  for (let end = 125; end < n; end++) {
    const a = analyzeAt(end);
    const priceOk = !!a && a.strat.stop > 0 && a.strat.stop < a.strat.entryLow && a.strat.entryLow < a.strat.target1;
    const okDay = !!a && a.techScore >= o.minTech && a.entryScore >= o.minEntry && a.avgAmount20M != null && a.avgAmount20M >= o.minAvgAmountM && a.status !== '條件失效' && a.status !== '暫不追價' && a.strat.rr >= 1.5 && priceOk;
    if (okDay) {
      res.days++; res.signalDays.push(b.dates[end]); if (!prevOk) res.waves++;
      if (a.status === '等待回檔') {
        res.waitSignalDays++; res.waitDates.push(b.dates[end]);
        let buy = -1; for (let j = end + 1; j <= Math.min(end + o.waitDays, n - 1); j++) if (b.close[j] <= a.strat.entryHigh) { buy = j; break; }
        if (buy >= 0) { res.waitFilled++; res.filledDates.push(b.dates[buy]); const ba = analyzeAt(buy); rec(W, buy, (ba && ba.strat) || a.strat); }
      } else { res.directDays++; res.directDates.push(b.dates[end]); rec(D, end, a.strat); }
    }
    prevOk = okDay;
  }
  const fin = g => { const o2 = {}; for (const h of o.horizons) { const x = g[h]; o2[h] = { count: x.count, upRatio: x.count ? x.up / x.count * 100 : 0, avgRet: x.count ? x.sum / x.count : 0, targetHit: x.count ? x.t / x.count * 100 : 0, stopHit: x.count ? x.s / x.count * 100 : 0 }; } return o2; };
  res.direct = fin(D); res.wait = fin(W);
  res.fillRate = res.waitSignalDays ? res.waitFilled / res.waitSignalDays * 100 : 0;
  return res;
}
function cmpHist(actual, ref, horizons, label) {
  ok(actual.days === ref.days && actual.waves === ref.waves, `${label}: days/waves match ref (${actual.days}/${ref.days}, ${actual.waves}/${ref.waves})`);
  ok(JSON.stringify(actual.signalDays) === JSON.stringify(ref.signalDays), `${label}: signalDays match ref`);
  ok(actual.direct.days === ref.directDays && JSON.stringify(actual.direct.dates) === JSON.stringify(ref.directDates)
    && actual.wait.signalDays === ref.waitSignalDays && JSON.stringify(actual.wait.dates) === JSON.stringify(ref.waitDates)
    && actual.wait.filled === ref.waitFilled && JSON.stringify(actual.wait.filledDates) === JSON.stringify(ref.filledDates)
    && Math.abs(actual.wait.fillRate - ref.fillRate) < 1e-9, `${label}: group counts/fillRate match ref`);
  const statOk = (g, r) => horizons.every(hh => { const x = g[hh], y = r[hh]; return x.count === y.count && Math.abs(x.upRatio - y.upRatio) < 1e-9 && Math.abs(x.avgRet - y.avgRet) < 1e-9 && Math.abs(x.targetHit - y.targetHit) < 1e-9 && Math.abs(x.stopHit - y.stopHit) < 1e-9; });
  ok(statOk(actual.direct, ref.direct) && statOk(actual.wait, ref.wait), `${label}: per-group horizon stats match ref`);
}
function synthStock(closes, amountPerDay) {
  const n = closes.length, end = new Date('2026-11-13T00:00:00Z'), dates = [], open = [], high = [], low = [], volume = [], amount = [];
  for (let i = 0; i < n; i++) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - (n - 1 - i)); dates.push(d.toISOString().slice(0, 10)); }
  closes.forEach((c, i) => { open.push(i ? closes[i - 1] : c); high.push(+(c + 0.02).toFixed(2)); low.push(+(c - 0.02).toFixed(2)); volume.push(3000000); amount.push(amountPerDay); });
  return { code: '9999', name: '合成測試', market: 'TWSE', bars: { dates, open, high, low, close: closes, volume, amount } };
}

// (a) 回傳形狀（逐日＋波數＋兩組）
{
  const h = core.historyStats(stocks[0], { horizons: [5, 10, 20] });
  ok([5, 10, 20].every(k => h.direct[k] && typeof h.direct[k].count === 'number' && h.wait[k] && typeof h.wait[k].count === 'number'), 'history grouped stats shape');
  ok(typeof h.days === 'number' && typeof h.waves === 'number' && Array.isArray(h.signalDays) && h.signalDays.length === h.days
    && h.direct.days + h.wait.signalDays === h.days && typeof h.wait.fillRate === 'number', 'history waves/days/groups accounting');
  const hDef = core.historyStats(stocks[0]);
  ok([5, 10, 20].every(k => hDef.direct[k] && typeof hDef.direct[k].count === 'number'), 'history stats default opts shape');
}

// (b) 與獨立重算逐項對照（多檔 × 兩預設 × 不同天數組/週期模式）
cmpHist(core.historyStats(stocks[0], { minTech: 65, minEntry: 45, horizons: [5, 10, 20] }), historyRef(stocks[0], { minTech: 65, minEntry: 45, horizons: [5, 10, 20] }), [5, 10, 20], '9001 穩健');
cmpHist(core.historyStats(stocks[0], { minTech: 50, minEntry: 30, horizons: [5, 10, 20] }), historyRef(stocks[0], { minTech: 50, minEntry: 30, horizons: [5, 10, 20] }), [5, 10, 20], '9001 積極');
cmpHist(core.historyStats(stocks[4], { minTech: 65, minEntry: 45, horizons: [10, 20, 40] }), historyRef(stocks[4], { minTech: 65, minEntry: 45, horizons: [10, 20, 40] }), [10, 20, 40], '9005 穩健 中線天數');
cmpHist(core.historyStats(stocks[8], { minTech: 50, minEntry: 30, horizons: [5, 10, 20] }), historyRef(stocks[8], { minTech: 50, minEntry: 30, horizons: [5, 10, 20] }), [5, 10, 20], '9009 積極');
cmpHist(core.historyStats(stocks[4], { minTech: 65, minEntry: 45, horizons: [5, 10, 20], periodMode: '中線' }), historyRef(stocks[4], { minTech: 65, minEntry: 45, horizons: [5, 10, 20], periodMode: '中線' }), [5, 10, 20], '9005 穩健 指定中線');

// (c) 等回檔組語意釘版：9005 穩健的每個等待回檔訊號日，成交日＝其後 5 日內第一個收盤 ≤ 訊號日 entryHigh
{
  const s = stocks[4], b = s.bars, n = b.close.length;
  const expBuys = [];
  let waitSeen = 0;
  for (let end = 125; end < n; end++) {
    const sub = core.trimBars({ dates: b.dates.slice(0, end + 1), open: b.open.slice(0, end + 1), high: b.high.slice(0, end + 1), low: b.low.slice(0, end + 1), close: b.close.slice(0, end + 1), volume: b.volume.slice(0, end + 1), amount: (b.amount || []).slice(0, end + 1) }, 360);
    let a = null; try { a = core.analyze({ code: s.code, name: s.name, market: s.market, bars: sub }, '自動判斷'); } catch (e) { }
    const priceOk = !!a && a.strat.stop > 0 && a.strat.stop < a.strat.entryLow && a.strat.entryLow < a.strat.target1;
    const okDay = !!a && a.techScore >= 65 && a.entryScore >= 45 && a.avgAmount20M != null && a.avgAmount20M >= 10 && a.status !== '條件失效' && a.status !== '暫不追價' && a.strat.rr >= 1.5 && priceOk;
    if (okDay && a.status === '等待回檔') {
      waitSeen++;
      let buy = -1; for (let j = end + 1; j <= Math.min(end + 5, n - 1); j++) if (b.close[j] <= a.strat.entryHigh) { buy = j; break; }
      if (buy >= 0) expBuys.push(b.dates[buy]);
    }
  }
  const h = core.historyStats(s, { minTech: 65, minEntry: 45, horizons: [5, 10, 20] });
  ok(waitSeen > 0 && h.wait.signalDays === waitSeen, '9005 wait signal days found and counted');
  ok(JSON.stringify(h.wait.filledDates) === JSON.stringify(expBuys), '9005 filled dates = first close <= entryHigh within 5 days');
  ok(h.wait.filled < h.wait.signalDays && h.wait.fillRate > 0 && h.wait.fillRate < 100, '9005 has both filled and unfilled wait signals (partial fill rate)');
}

// (d) 零訊號與門檻單調性
{
  const closes = []; for (let i = 0; i < 300; i++) closes.push(+(200 - i * 0.1).toFixed(2));
  const hz0 = core.historyStats(synthStock(closes, 300000000), { horizons: [5, 10, 20] });
  ok(hz0.days === 0 && hz0.waves === 0 && hz0.direct.days === 0 && hz0.wait.signalDays === 0 && hz0.wait.fillRate === 0, 'downtrend: zero signals in both groups');
  ok([5, 10, 20].every(k => hz0.direct[k].count === 0 && hz0.wait[k].count === 0), 'zero-signal horizons stay zeroed (no NaN rows)');
  const short = synthStock(closes.slice(0, 100), 300000000);
  ok(core.historyStats(short, { horizons: [5] }).days === 0, 'history shorter than 126 days: zero signals');
  const s5 = stocks[4];
  const dAll = core.historyStats(s5, { minTech: 0, minEntry: 0, horizons: [5] }).days;
  const dAct = core.historyStats(s5, { minTech: 50, minEntry: 30, horizons: [5] }).days;
  const dSte = core.historyStats(s5, { minTech: 65, minEntry: 45, horizons: [5] }).days;
  const dStr = core.historyStats(s5, { minTech: 75, minEntry: 60, horizons: [5] }).days;
  ok(dAll >= dAct && dAct >= dSte && dSte >= dStr && dAll > dStr, 'signal days monotone in preset thresholds');
  const hAct = core.historyStats(s5, { minTech: 50, minEntry: 30, horizons: [5] });
  ok(hAct.waves <= hAct.days && hAct.waves > 0, 'waves <= days under daily counting');
}

// (e) horizons 依傳入參數回傳對應 key（兩組皆然）
{
  const hz = core.historyStats(stocks[0], { horizons: [20, 60, 120] });
  ok([20, 60, 120].every(k => hz.direct[k] && typeof hz.direct[k].count === 'number' && hz.wait[k] && typeof hz.wait[k].avgRet === 'number'), 'history horizons keys follow opts in both groups');
}

// filterBars：移除 close<=0 的無成交佔位列，各陣列同步過濾
ok(typeof core.filterBars === 'function', 'filterBars exported');
{
  const fb = core.filterBars({
    dates: ['2026-01-01', '2026-01-02', '2026-01-03'], open: [10, 0, 12], high: [11, 0, 13],
    low: [9, 0, 11], close: [10, 0, 12], volume: [100, 0, 120], amount: [1000, 0, 1440],
  });
  ok(fb.close.length === 2 && fb.close[0] === 10 && fb.close[1] === 12, 'filterBars removes zero-close rows');
  ok([fb.dates, fb.open, fb.high, fb.low, fb.close, fb.volume, fb.amount].every(a => a.length === 2), 'filterBars keeps all arrays same length');
  ok(fb.dates[1] === '2026-01-03' && fb.amount[1] === 1440, 'filterBars keeps surviving rows aligned');
  const noAmt = core.filterBars({ dates: ['2026-01-01', '2026-01-02'], open: [10, 0], high: [11, 0], low: [9, 0], close: [10, 0], volume: [100, 0] });
  ok(noAmt.close.length === 1 && noAmt.volume.length === 1, 'filterBars tolerates missing amount');
  const clean = { dates: ['2026-01-01'], open: [10], high: [11], low: [9], close: [10], volume: [100] };
  ok(core.filterBars(clean).close.length === 1, 'filterBars leaves clean bars intact');
}

// 零價佔位列污染：近 60 日含零列的股票，掃描結果不得出現 stop<=0
function cloneBarsOf(s) { return JSON.parse(JSON.stringify(s.bars)); }
function zeroOut(b, idxs) { for (const i of idxs) { b.open[i] = 0; b.high[i] = 0; b.low[i] = 0; b.close[i] = 0; b.volume[i] = 0; b.amount[i] = 0; } }
{
  const zb = cloneBarsOf(stocks[0]);
  const idxs = []; for (let k = 0; k < 10; k++) idxs.push(zb.close.length - 60 + k * 6);
  zeroOut(zb, idxs);
  ok(core.filterBars(zb).close.length === zb.close.length - 10, 'zero rows in last 60d are filtered');
  const zRes = core.scan([{ code: '8888', name: '零列測試', market: 'TWSE', bars: zb }], { topN: 10, minTech: 0, minAvgAmountM: 0, minEntry: 0, includeETF: false });
  ok(zRes.candidates.length + zRes.watch.length === 1, 'zero-row stock still scanned after filtering');
  ok([...zRes.candidates, ...zRes.watch].every(a => a.strat.stop > 0), 'no stop<=0 in candidates/watch after zero-row filtering');
}

// 大量零列使濾後 <125 列 → 計入 historyShort
{
  const hb = cloneBarsOf(stocks[0]);
  const idxs = []; for (let i = 100; i < hb.close.length; i++) idxs.push(i);
  zeroOut(hb, idxs);
  ok(core.filterBars(hb).close.length === 100, 'heavy zero rows leave 100 bars');
  const sRes = core.scan([{ code: '6666', name: '短歷史測試', market: 'TWSE', bars: hb }], { topN: 10, minTech: 0, minAvgAmountM: 0, minEntry: 0, includeETF: false });
  ok(sRes.stats.historyShort === 1 && sRes.stats.scanned === 0, 'filtered-short stock counted as historyShort');
}

// analyze 的 vlag 為布林值，且定義與 target1/收盤一致
{
  const va = core.analyze(stocks[0], '自動判斷');
  ok(typeof va.vlag === 'boolean', 'analyze vlag is boolean');
  ok(va.vlag === (va.strat.target1 > va.close * 1.5), 'analyze vlag matches target1 > close*1.5');
}

// 觀察名單 reason 依卡關原因分流：暫不追價 → 先等回檔；進場分不足 → 未達門檻；兩者文字不同且非舊模板
function spikeStock() {
  const n = 200, end = new Date('2026-11-12T00:00:00Z'), dates = [], closes = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - i); dates.push(d.toISOString().slice(0, 10)); }
  for (let i = 0; i < n - 1; i++) closes.push(+(100 + i * 0.35).toFixed(2));
  closes.push(+(closes[n - 2] * 1.15).toFixed(2)); // 末日大漲，收盤遠離進場區
  const open = [], high = [], low = [], volume = [], amount = [];
  closes.forEach((c, i) => { const o = i ? closes[i - 1] : c; open.push(o); high.push(Math.max(o, c) * 1.005); low.push(Math.min(o, c) * 0.995); const v = i === n - 1 ? 8000000 : 2000000; volume.push(v); amount.push(v * c); });
  return { code: '7777', name: '急漲測試', market: 'TWSE', bars: { dates, open, high, low, close: closes, volume, amount } };
}
{
  const sa = core.analyze(spikeStock(), '自動判斷');
  ok(sa !== null && sa.status === '暫不追價', 'spike stock status is 暫不追價');
  ok(sa.techScore >= 65, 'spike stock tech score is high');
  const wRes = core.scan([spikeStock()], { topN: 10, minTech: 0, minAvgAmountM: 0, minEntry: 0, includeETF: false });
  ok(wRes.watch.length === 1 && wRes.candidates.length === 0, 'spike stock lands in watch only');
  ok(wRes.watch[0].reason.includes('先等回檔'), 'watch reason for 暫不追價 mentions 先等回檔');
  ok(!wRes.watch[0].reason.includes('技術強勢'), 'watch reason is not the old template');
  const wRes2 = core.scan([spikeStock()], { topN: 10, minTech: 0, minAvgAmountM: 0, minEntry: 99, includeETF: false });
  ok(wRes2.watch.length === 1 && wRes2.watch[0].reason.includes('未達 99'), 'watch reason for low entryScore mentions threshold');
  ok(wRes2.watch[0].reason !== wRes.watch[0].reason, 'watch reasons differ by blocking cause');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

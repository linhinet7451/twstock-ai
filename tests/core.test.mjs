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

// 歷史訊號（訊號定義固定為 C3 強勢日，逐日計次；horizons 由呼叫端依週期傳入）
const h = core.historyStats(stocks[0], { horizons: [5, 10, 20] });
ok([5, 10, 20].every(k => h[k] && typeof h[k].count === 'number'), 'history stats shape');
ok(typeof h.days === 'number' && typeof h.waves === 'number' && Array.isArray(h.signalDays) && h.signalDays.length === h.days, 'history waves/days/signalDays shape');
const hDef = core.historyStats(stocks[0]);
ok([5, 10, 20].every(k => hDef[k] && typeof hDef[k].count === 'number'), 'history stats default opts shape');

// C3 定義的獨立重算（對照 round2 pass2/evaluate 的樸素窗格實作）：
// 趨勢模板（收盤>MA50>MA150>MA200 且距 240 日高 ≤25%）∧ 距 240 日高 ≤10% ∧ 收盤突破前 60 日最高價，
// 再以訊號日 analyze 的 avgAmount20M ≥ minAvgAmountM 把關。回傳訊號日的 bar index 陣列。
function c3DaysBrute(stock, minAmt = 10) {
  const b = stock.bars, n = b.close.length, days = [];
  const sma = (p, i) => { if (i < p - 1) return null; let s = 0; for (let j = i - p + 1; j <= i; j++) s += b.close[j]; return s / p; };
  const maxOf = (arr, x, y) => { let m = -Infinity; for (let j = x; j <= y; j++) if (arr[j] > m) m = arr[j]; return m; };
  for (let end = 125; end < n; end++) {
    const dh240 = end >= 239 ? b.close[end] / maxOf(b.high, end - 239, end) - 1 : null;
    const ma50 = sma(50, end), ma150 = sma(150, end), ma200 = sma(200, end);
    const tmpl = ma200 != null && dh240 != null && b.close[end] > ma50 && ma50 > ma150 && ma150 > ma200 && dh240 >= -0.25;
    const brk60 = end >= 60 && b.close[end] > maxOf(b.high, end - 60, end - 1);
    if (!(tmpl && dh240 >= -0.10 && brk60)) continue;
    const sub = core.trimBars({ dates: b.dates.slice(0, end + 1), open: b.open.slice(0, end + 1), high: b.high.slice(0, end + 1), low: b.low.slice(0, end + 1), close: b.close.slice(0, end + 1), volume: b.volume.slice(0, end + 1), amount: (b.amount || []).slice(0, end + 1) }, 360);
    let a = null; try { a = core.analyze({ code: stock.code, name: stock.name, market: stock.market, bars: sub }, '自動判斷'); } catch (e) { }
    if (a && a.avgAmount20M != null && a.avgAmount20M >= minAmt) days.push(end);
  }
  return days;
}
function synthStock(closes, amountPerDay) {
  const n = closes.length, end = new Date('2026-11-13T00:00:00Z'), dates = [], open = [], high = [], low = [], volume = [], amount = [];
  for (let i = 0; i < n; i++) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - (n - 1 - i)); dates.push(d.toISOString().slice(0, 10)); }
  closes.forEach((c, i) => { open.push(i ? closes[i - 1] : c); high.push(+(c + 0.02).toFixed(2)); low.push(+(c - 0.02).toFixed(2)); volume.push(3000000); amount.push(amountPerDay); });
  return { code: '9999', name: '合成測試', market: 'TWSE', bars: { dates, open, high, low, close: closes, volume, amount } };
}

// (a) 線性上升合成序列：239 日後每天都是 C3 日（已知答案）＋ brute-force 逐日對照
{
  const closes = []; for (let i = 0; i < 300; i++) closes.push(+(100 + i * 0.3).toFixed(2));
  const up = synthStock(closes, 300000000);
  const hu = core.historyStats(up, { horizons: [5, 20] });
  const brute = c3DaysBrute(up);
  ok(brute.length === 61 && brute[0] === 239, 'brute-force C3 on uptrend = 61 days from idx 239');
  ok(hu.days === 61 && hu.waves === 1, 'uptrend: 61 entry days, 1 wave');
  ok(JSON.stringify(hu.signalDays) === JSON.stringify(brute.map(i => up.bars.dates[i])), 'core signalDays match brute-force set');
  ok(hu[5].count === 56 && hu[20].count === 41, 'per-horizon counts exclude tail days without forward data');
  ok(hu[5].upRatio > 90 && hu[5].avgRet > 0, 'uptrend forward returns positive');
  // 中途一天小回檔（不破前高）→ 波數變 2、進場日少 1
  const closes2 = closes.slice(); closes2[270] = +(closes2[269] - 0.05).toFixed(2);
  const dip = synthStock(closes2, 300000000);
  const hd = core.historyStats(dip, { horizons: [5] });
  ok(JSON.stringify(hd.signalDays) === JSON.stringify(c3DaysBrute(dip).map(i => dip.bars.dates[i])), 'dip series signalDays match brute-force set');
  ok(hd.days === 60 && hd.waves === 2, 'one non-signal day splits the run into 2 waves');
}

// (b) 下降序列 → 零訊號；金額不足 → 被共同門檻擋下（放寬門檻後恢復）
{
  const closes = []; for (let i = 0; i < 300; i++) closes.push(+(200 - i * 0.1).toFixed(2));
  const hz0 = core.historyStats(synthStock(closes, 300000000), { horizons: [5, 10, 20] });
  ok(hz0.days === 0 && hz0.waves === 0 && hz0.signalDays.length === 0, 'downtrend: zero signals');
  ok([5, 10, 20].every(k => hz0[k].count === 0 && hz0[k].avgRet === 0), 'zero-signal horizons stay zeroed (no NaN rows)');
  const upCloses = []; for (let i = 0; i < 300; i++) upCloses.push(+(100 + i * 0.3).toFixed(2));
  const lowAmt = synthStock(upCloses, 5000000); // avgAmount20M = 5 < 10
  ok(core.historyStats(lowAmt, { horizons: [5] }).days === 0, 'avgAmount20M below gate blocks signals');
  ok(core.historyStats(lowAmt, { horizons: [5], minAvgAmountM: 0 }).days === 61, 'relaxing amount gate restores signals');
  const short = synthStock(upCloses.slice(0, 200), 300000000); // 歷史 <240 日
  ok(core.historyStats(short, { horizons: [5] }).days === 0, 'history shorter than 240 days: zero signals');
}

// (c) horizons 依傳入參數回傳對應 key
{
  const hz = core.historyStats(stocks[0], { horizons: [20, 60, 120] });
  ok([20, 60, 120].every(k => hz[k] && typeof hz[k].count === 'number' && typeof hz[k].avgRet === 'number'), 'history horizons keys follow opts');
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

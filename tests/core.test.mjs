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

// 歷史訊號
const h = core.historyStats(stocks[0]);
ok([5, 10, 20].every(k => h[k] && typeof h[k].count === 'number'), 'history stats shape');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

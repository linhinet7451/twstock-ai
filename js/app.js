/* 台股 AI 智慧選股工作台 V2.0 網頁版 — UI 與資料/外部服務邏輯
 * 技術分數與價位全部由 TWCore（規則引擎）計算；Gemini 只產生文字解讀（規格 #12）。
 * API Key 只存在頁面記憶體，不寫入 localStorage（#68）。 */
'use strict';
const $ = id => document.getElementById(id);
const state = {
  mode: 'real',            // 'real' | 'demo'（#11, #54 資料隔離）
  realStocks: [],          // 正式＋匯入
  demoStocks: [],
  snapshot: [],            // 官方最新一日快照（僅供查詢參考，不含完整歷史）
  results: { candidates: [], watch: [], custom: [] },
  selected: null,          // 目前選取的分析結果
  selectedStock: null,
  newsByCode: {},          // code -> [{title, source, date, link}]
  newsStatus: {},          // code -> 'loading' | 'ok' | 'error'（區分「查到 0 篇」與「根本沒查成」）
  backendLoading: false,   // 後端資料包載入中（此時鎖查詢，避免命中 IndexedDB 舊資料）
  aiByCode: {},            // code -> Gemini 結構化結果（僅記憶體, #239）
  stopFlag: false,
  busy: false,
  failedDates: [],
  scanDone: false,         // 掃描完成後「開始掃描」改顯示「重新掃描」
  pendingPresetMsg: '',    // 套用預設後，掃描起始訊息顯示「已套用…正在重新掃描」
  presetLabel: '',         // 目前套用的選股模式名稱（精簡列／②標題用）
};
const stocksNow = () => state.mode === 'demo' ? state.demoStocks : state.realStocks;

// ---------- 執行紀錄 (#268) ----------
function log(msg) {
  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const box = $('logBox');
  box.textContent += `[${t}] ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}
function setProgress(pct, msg) { $('progBar').style.width = pct + '%'; if (msg) $('progMsg').textContent = msg; }
function fmtUpd(iso) { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
function setBusy(b) {
  state.busy = b;
  $('btnScan').disabled = b; $('btnStop').disabled = !b;
  $('btnStop').classList.toggle('hidden', !b); // 停止鈕只在掃描／背景工作進行中顯示
  const cb = $('btnScanCompact'); if (cb) cb.disabled = b;
}
function updateScanLabel() { $('btnScan').textContent = state.scanDone ? '↻ 重新掃描' : '▶ 開始掃描及產生推薦'; }
function updateCompactInfo() {
  const c = $('compactInfo'); if (!c) return;
  c.textContent = `${state.presetLabel || '穩健推薦'}｜推薦 ${state.results.candidates.length} 檔`;
}

// ---------- 設定保存 (#65；不含 API Key #68) ----------
const SETTING_IDS = ['inpTopN', 'inpMinTech', 'inpMinAmount', 'selPeriod', 'selSort', 'inpMinEntry', 'chkEtf', 'inpNewsCount', 'inpModel', 'inpDays'];
function saveSettings() {
  const d = {};
  for (const id of SETTING_IDS) { const el = $(id); d[id] = el.type === 'checkbox' ? el.checked : el.value; }
  localStorage.setItem('twstock_settings', JSON.stringify(d));
}
function loadSettings() {
  try {
    const d = JSON.parse(localStorage.getItem('twstock_settings') || '{}');
    for (const id of SETTING_IDS) if (id in d) { const el = $(id); if (el.type === 'checkbox') el.checked = !!d[id]; else el.value = d[id]; }
  } catch (e) { /* ignore */ }
}
// ---------- 選股風格預設（把分數門檻藏在直觀名稱後面） ----------
const PRESETS = {
  strict: { tech: 75, entry: 60, label: '嚴選強勢', desc: '嚴選強勢：只列趨勢與動能最強、且已在合理進場位置的股票。名單通常很短，盤勢偏弱時可能一檔都沒有——那是系統在保護你，不是故障。' },
  steady: { tech: 65, entry: 45, label: '穩健推薦', desc: '穩健推薦：技術面夠強、又接近合理進場點才列入（原系統預設標準；不確定選哪個，就用這個）。盤勢弱時名單會明顯變短。' },
  active: { tech: 50, entry: 30, label: '積極進場', desc: '積極進場：趨勢剛確立（約一半技術訊號成立）的股票也納入，名單較多，適合願意自己再篩一輪的人。' },
  all:    { tech: 0,  entry: 0,  label: '全部探索', desc: '全部探索：通過策略基本檢查的全部列出，自己慢慢研究（風報比太差、條件失效的仍會擋下）。' },
};
function markPreset() {
  const t = +$('inpMinTech').value || 0, e = +$('inpMinEntry').value || 0;
  let active = '';
  for (const k in PRESETS) if (PRESETS[k].tech === t && PRESETS[k].entry === e) active = k;
  state.presetLabel = active ? PRESETS[active].label : '自訂';
  document.querySelectorAll('.preset').forEach(b => {
    const p = PRESETS[b.dataset.preset], isA = b.dataset.preset === active;
    b.classList.toggle('active', isA);
    b.innerHTML = `<span class="p-name">${p.label}</span><span class="p-sub">${isA ? '✓ 使用中' : '套用並重掃'}</span>`;
  });
  const ss = $('settingsSummary');
  if (ss) ss.textContent = `② 選股設定（目前：${state.presetLabel}）`;
  const hint = $('presetHint');
  if (hint) hint.textContent = active ? PRESETS[active].desc : '自訂門檻：你已手動微調下面的分數，不屬於任何預設風格。';
  updateCompactInfo();
}
async function applyPreset(k) {
  const p = PRESETS[k]; if (!p) return;
  $('inpMinTech').value = p.tech; $('inpMinEntry').value = p.entry;
  saveSettings(); markPreset();
  log(`已套用選股風格「${p.label}」（技術分 ≥ ${p.tech}、進場適合度 ≥ ${p.entry}）`);
  state.pendingPresetMsg = `已套用「${p.label}」，正在重新掃描…`;
  setProgress(5, state.pendingPresetMsg);
  if (stocksNow().length) {
    const y = window.scrollY;         // 掃描會重繪上方結果區、改變頁面高度，先記住位置
    await runScan();
    window.scrollTo(0, y);            // 掃完回到原位，避免畫面亂跳
  }
}

function scanOpts() {
  return {
    topN: Math.max(1, Math.min(9999, +$('inpTopN').value || 10)),
    minTech: +$('inpMinTech').value || 0,
    minAvgAmountM: +$('inpMinAmount').value || 0,
    minEntry: +$('inpMinEntry').value || 0,
    includeETF: $('chkEtf').checked,
    periodMode: $('selPeriod').value,
    sortMode: $('selSort').value,
  };
}

// ---------- IndexedDB 持久化（匯入資料） ----------
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('twstock_ai', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { idb.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  async set(k, v) { if (!idb.db) return; return new Promise(res => { const tx = idb.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; }); },
  async get(k) { if (!idb.db) return null; return new Promise(res => { const rq = idb.db.transaction('kv').objectStore('kv').get(k); rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => res(null); }); },
};
async function persistReal() { try { await idb.set('realStocks', state.realStocks); } catch (e) { log('匯入資料保存失敗（可能超過瀏覽器儲存上限）：' + e.message); } }

// ---------- 資料狀態列 (#31-33) ----------
function refreshStatus() {
  const stocks = stocksNow();
  let latest = '';
  for (const s of stocks) { const d = s.bars.dates.at(-1); if (d && d > latest) latest = d; }
  $('dataStatus').textContent = `${state.mode === 'demo' ? '離線示範資料' : '正式／匯入資料'}｜${stocks.length} 檔｜最新資料：${latest || '—'}`;
  let stale = false;
  if (state.mode === 'real' && latest) stale = (Date.now() - new Date(latest).getTime()) / 86400000 >= 5; // #32
  $('staleWarn').classList.toggle('hidden', !stale);
  return latest;
}

// ---------- CSV 匯入 (#49-50) ----------
const CSV_ALIAS = { code: ['code', '代號', '股票代號', '證券代號'], name: ['name', '名稱', '股票名稱'], market: ['market', '市場'],
  date: ['date', '日期', '交易日期'], open: ['open', '開盤', '開盤價'], high: ['high', '最高', '最高價'], low: ['low', '最低', '最低價'],
  close: ['close', '收盤', '收盤價'], volume: ['volume', '成交量', '成交股數'], amount: ['amount', '成交金額', '成交值'] };
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(x => x.trim());
  if (lines.length < 2) throw new Error('CSV 內容不足');
  const head = lines[0].split(',').map(h => h.trim());
  const idx = {};
  for (const [key, aliases] of Object.entries(CSV_ALIAS)) { idx[key] = head.findIndex(h => aliases.includes(h)); }
  if (idx.code < 0 || idx.date < 0 || idx.close < 0) throw new Error('CSV 需至少包含 代號、日期、收盤 欄位');
  const byCode = new Map();
  for (let li = 1; li < lines.length; li++) {
    const c = lines[li].split(',');
    const code = String(c[idx.code]).trim().padStart(4, '0');
    const get = (k, def = 0) => idx[k] >= 0 && c[idx[k]] !== '' ? parseFloat(String(c[idx[k]]).replace(/,/g, '')) : def;
    const row = { date: String(c[idx.date]).trim().replace(/\//g, '-'), open: get('open'), high: get('high'), low: get('low'), close: get('close'), volume: get('volume'), amount: get('amount') };
    if (!row.date || !(row.close > 0)) continue;
    if (!byCode.has(code)) byCode.set(code, { code, name: idx.name >= 0 ? String(c[idx.name]).trim() : code, market: idx.market >= 0 ? String(c[idx.market]).trim().toUpperCase() : 'TWSE', rows: [] });
    byCode.get(code).rows.push(row);
  }
  const stocks = [];
  for (const s of byCode.values()) {
    s.rows.sort((a, b) => a.date < b.date ? -1 : 1);
    stocks.push({ code: s.code, name: s.name, market: s.market.includes('TP') || s.market.includes('櫃') ? 'TPEX' : 'TWSE', isDemo: false,
      bars: { dates: s.rows.map(r => r.date), open: s.rows.map(r => r.open || r.close), high: s.rows.map(r => r.high || r.close), low: s.rows.map(r => r.low || r.close), close: s.rows.map(r => r.close), volume: s.rows.map(r => r.volume), amount: s.rows.map(r => r.amount) } });
  }
  return stocks;
}

// ---------- 後端資料包自動載入（GitHub Actions 排程更新 → data/ 靜態檔案） ----------
async function fetchGzipJson(url, onProgress) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + url);
  if (typeof DecompressionStream === 'undefined' || !resp.body) {
    throw new Error('瀏覽器不支援 gzip 解壓（DecompressionStream），請更新瀏覽器');
  }
  let stream = resp.body;
  if (onProgress) { // 串流計量下載進度：Content-Length 拿不到總長時只報已下載 MB
    const total = +resp.headers.get('Content-Length') || 0;
    const reader = stream.getReader();
    let loaded = 0, lastShown = -1;
    stream = new ReadableStream({
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) { ctrl.close(); return; }
        loaded += value.byteLength;
        const pct = total ? Math.floor(loaded / total * 100) : -1;
        if (pct !== lastShown) { lastShown = pct; onProgress(loaded, total); }
        ctrl.enqueue(value);
      },
      cancel(r) { reader.cancel(r); },
    });
  }
  const pipe = stream.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(pipe).text());
}
function rowsToStock(code, name, market, rows) {
  return { code, name, market, isDemo: false, bars: {
    dates: rows.map(r => r[0]), open: rows.map(r => r[1]), high: rows.map(r => r[2]),
    low: rows.map(r => r[3]), close: rows.map(r => r[4]), volume: rows.map(r => r[5]), amount: rows.map(r => r[6]) } };
}
let backendLoaded = false;
async function loadBackendData(autoScanAfter) {
  const statusEl = $('backendStatus');
  state.backendLoading = true;
  $('btnQuery').disabled = true; // 載入完成前鎖查詢，避免命中 IndexedDB 還原的舊資料
  try {
    statusEl.textContent = '後端資料：載入中…';
    const man = await (await fetch('data/manifest.json', { cache: 'no-store' })).json();
    if (!man || !man.scanFile) throw new Error('manifest 格式不正確');
    const totalMB = (man.scanBytes / 1048576).toFixed(1);
    setProgress(15, `下載後端掃描包（${man.scanStocks} 檔，${totalMB} MB）…`);
    const bundle = await fetchGzipJson('data/' + man.scanFile, (loaded, total) => {
      const mb = (loaded / 1048576).toFixed(1);
      if (total > 0) setProgress(15 + Math.round(loaded / total * 70), `下載後端掃描包：已下載 ${mb}／${totalMB} MB（${Math.round(loaded / total * 100)}%）`);
      else setProgress(50, `下載後端掃描包：已下載 ${mb} MB…`);
    });
    const backendStocks = bundle.stocks.map(s => rowsToStock(s.c, s.n, s.m, s.r));
    const csvOnly = state.realStocks.filter(s => !backendStocks.some(b => b.code === s.code));
    state.realStocks = backendStocks.concat(csvOnly);
    state.mode = 'real'; backendLoaded = true;
    state.backendUpdatedAt = man.updatedAt; state.backendLatest = man.latestDate;
    statusEl.textContent = `後端資料：${man.scanStocks} 檔可掃描（共 ${man.stockCount} 檔含完整歷史）｜最新行情 ${man.latestDate}｜更新於 ${fmtUpd(man.updatedAt)}（每日盤後由後端排程自動更新）`;
    log(`後端資料載入完成：${backendStocks.length} 檔，最新 ${man.latestDate}`);
    refreshStatus(); setProgress(100, '後端資料載入完成');
    if (autoScanAfter) runScan();
    return true;
  } catch (e) {
    statusEl.textContent = '後端資料：尚未產生（repo 尚未執行資料回補）— 可先用下方示範資料或 CSV 匯入。';
    log('後端資料載入失敗（可能尚未回補）：' + e.message);
    return false;
  } finally {
    state.backendLoading = false;
    $('btnQuery').disabled = false;
  }
}
const fullHistoryCache = {};
async function ensureFullHistory(stock) {
  if (!stock || stock.isDemo) return stock;
  if (fullHistoryCache[stock.code]) return fullHistoryCache[stock.code];
  try {
    const data = await fetchGzipJson(`data/history/${stock.code}.json.gz`);
    const full = rowsToStock(data.code, data.name, data.market, data.rows);
    fullHistoryCache[stock.code] = full;
    const idx = state.realStocks.findIndex(s => s.code === stock.code);
    if (idx >= 0) state.realStocks[idx] = full;
    log(`已載入 ${stock.code} 完整歷史：${full.bars.close.length} 筆（10 年）`);
    return full;
  } catch (e) { return stock; } // 無完整歷史檔時用既有資料
}

// ---------- 更新最新資料（後端線路） ----------
// 官方 TWSE/TPEx OpenAPI 皆未提供 Access-Control-Allow-Origin 標頭（2026-11-12 實測），
// 瀏覽器直連必被 CORS 阻擋，且舊版快照下載後未併入資料集、按下等於沒作用。
// 改走穩定線路：後端（GitHub Actions）每日盤後自動更新 data/ 資料包，本鈕負責檢查並取回最新一版後自動重掃。
async function updateToLatest() {
  if (state.busy) return noteBusy();
  setBusy(true); setProgress(10, '檢查後端最新資料…');
  try {
    const man = await (await fetch('data/manifest.json', { cache: 'no-store' })).json();
    if (!man || !man.scanFile) throw new Error('後端 manifest 格式不正確');
    const isNewer = !state.backendUpdatedAt || man.updatedAt !== state.backendUpdatedAt;
    const okLoad = await loadBackendData(false);
    if (!okLoad) throw new Error('後端資料載入失敗');
    setProgress(100, isNewer
      ? `已更新到最新資料：行情 ${man.latestDate}、${man.scanStocks} 檔可掃描（後端更新於 ${fmtUpd(man.updatedAt)}）`
      : `目前已是最新資料：行情 ${man.latestDate}、${man.scanStocks} 檔（後端每日 18:30 自動更新，有新版時按此鈕即可取得）`);
    runScan();
  } catch (e) {
    log('更新失敗：' + e.message);
    setProgress(0, '更新失敗：' + e.message);
  } finally { setBusy(false); refreshStatus(); }
}
async function fetchStockHistoryTWSE(code, months) {
  // 逐月抓 TWSE STOCK_DAY；瀏覽器直連可能受 CORS 限制，失敗即回傳 null 並紀錄
  const rows = [];
  const now = new Date();
  for (let m = 0; m < months; m++) {
    if (state.stopFlag) break;
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const yyyymm = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    try {
      const j = await (await fetch(`https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymm}&stockNo=${code}`)).json();
      if (j && j.data) for (const r of j.data) {
        const [yy, mm, dd] = r[0].split('/').map(Number);
        const num = s => parseFloat(String(s).replace(/,/g, '')) || 0;
        rows.push({ date: `${yy + 1911}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, volume: num(r[1]), amount: num(r[2]), open: num(r[3]), high: num(r[4]), low: num(r[5]), close: num(r[6]) });
      }
    } catch (e) { /* 該月失敗略過 */ }
    setProgress(Math.round((m + 1) / months * 100), `補抓 ${code} 官方歷史 ${m + 1}/${months} 個月…`);
  }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  return rows.length ? rows : null;
}

// ---------- 全市場掃描 (#74-80) ----------
async function runScan() {
  if (state.busy) return noteBusy();
  const stocks = stocksNow();
  if (!stocks.length) { alert('目前沒有可掃描的資料，請先載入示範資料、匯入 CSV，或查詢個股補抓歷史。'); return; }
  setBusy(true); state.stopFlag = false;
  const apMsg = state.pendingPresetMsg; state.pendingPresetMsg = '';
  setProgress(0, apMsg || '掃描中…');
  // 分段執行以更新進度並允許停止：TWCore.scan 為同步全量計算，這裡先做逐檔預檢統計進度，實際計分仍由 TWCore.scan 一次完成（規則一致）
  const total = stocks.length;
  for (let i = 0; i < total; i += 40) {
    if (state.stopFlag) { setProgress(0, '已停止'); setBusy(false); log('掃描被使用者停止'); return; }
    setProgress(Math.round(i / total * 90), apMsg || `掃描中 ${Math.min(i + 40, total)}/${total} 檔…`);
    await new Promise(r => setTimeout(r, 0));
  }
  try {
    const res = TWCore.scan(stocks, scanOpts());
    state.lastStats = res.stats;
    state.results.candidates = res.allCandidates.slice(0, scanOpts().topN);
    state.results.watch = res.watch;
    // 頂端統計改一句摘要：已掃描＝實際計分檔數、推薦＝實際推薦（topN 截斷後）、觀察＝技術強勢觀察名單
    // 有排除時同句補人話說明（保持一行）：未納入的 ETF 與資料不全檔數
    const exclParts = [];
    if (res.stats.typeExcluded) exclParts.push(`ETF ${res.stats.typeExcluded} 檔`);
    if (res.stats.qualityBad + res.stats.historyShort) exclParts.push(`資料不全 ${res.stats.qualityBad + res.stats.historyShort} 檔`);
    $('sumLine').textContent = `已掃描 ${res.stats.scanned} 檔｜推薦 ${state.results.candidates.length} 檔｜觀察 ${res.watch.length} 檔` +
      (exclParts.length ? `（未納入：${exclParts.join('、')}）` : '');
    state.scanDone = true; updateScanLabel(); updateCompactInfo();
    log(`掃描完成｜掃描 ${res.stats.scanned} 檔，排除統計：代號類型 ${res.stats.typeExcluded}、歷史不足 ${res.stats.historyShort}、資料品質 ${res.stats.qualityBad}、成交額不足 ${res.stats.amountLow}、技術分不足 ${res.stats.techLow}、策略失敗 ${res.stats.stratFail}、進場未達 ${res.stats.entryFail}`);
    if (!res.allCandidates.length && res.stats.scanned > 0) {
      // 推薦 0 檔：指名下一檔較寬的預設，讓使用者知道下一步點哪顆
      const order = ['strict', 'steady', 'active', 'all'];
      const curKey = Object.keys(PRESETS).find(k => PRESETS[k].label === state.presetLabel);
      if (curKey && curKey !== 'all') setProgress(100, `「${state.presetLabel}」今天沒有符合的股票，可試試「${PRESETS[order[order.indexOf(curKey) + 1]].label}」`);
      else if (curKey === 'all') setProgress(100, '今天沒有符合的股票；盤勢偏弱時這是正常現象，系統不會為了湊數放寬標準。');
      else setProgress(100, '目前門檻下今天沒有符合的股票，可點上方選股風格放寬條件。');
    } else {
      setProgress(100, `掃描完成：推薦 ${state.results.candidates.length} 檔、觀察 ${res.watch.length} 檔（最新日期 ${res.latestDate}）`);
    }
    $('selList').value = 'candidates';
    renderList();
  } catch (e) { log('掃描失敗：' + e.message); setProgress(0, '掃描失敗'); }
  finally { setBusy(false); }
}
function noteBusy() { alert('已有背景工作執行中，請先等待或按「停止」。'); }

// ---------- 名單呈現 (#148-161) ----------
const fmt = (x, d = 2) => x == null || isNaN(x) ? '—' : Number(x).toFixed(d);
const fmtSign = (x, d = 2) => x == null || isNaN(x) ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(d);
function currentList() {
  const kind = $('selList').value;
  let list = state.results[kind] || [];
  const q = $('inpFilter').value.trim();
  if (q) list = list.filter(a => a.code.includes(q) || a.name.includes(q));
  if ($('chkNear').checked) list = list.filter(a => a.status === '接近進場');
  return list;
}
const CARD_KEY = [1, 2, 5, 8, 9, 11, 14]; // 手機卡片第一層只顯示七項：代號、名稱、收盤、技術分、進場適合度、狀態、進場區間；停損／目標／風報／原因等其餘欄位收進「展開全部欄位」
const statusBadgeCls = s => s === '接近進場' ? 'b-ok' : s === '等待回檔' ? 'b-wait' : s === '突破觀察' ? 'b-info' : 'b-mut';
function renderList() {
  const list = currentList();
  const body = $('resultBody');
  body.innerHTML = '';
  list.forEach((a, i) => {
    const tr = document.createElement('tr');
    if (state.selected && state.selected.code === a.code) tr.className = 'selected';
    const scoreCls = v => v >= 80 ? 'score-hi' : 'score-mid';
    const cells = [
      ['排行', i + 1], ['代號', a.code], ['名稱', a.name], ['市場', a.market], ['最新日期', a.date],
      ['收盤', fmt(a.close)], ['當日漲跌', `<span class="${a.change >= 0 ? 'up' : 'down'}">${fmtSign(a.change)}</span>`],
      ['漲跌幅', `<span class="${a.changePct >= 0 ? 'up' : 'down'}">${fmtSign(a.changePct)}%</span>`],
      ['技術分', `<span class="${scoreCls(a.techScore)}">${a.techScore}</span>`],
      ['進場適合度', `<span class="${scoreCls(a.entryScore)}">${a.entryScore}</span>`],
      ['距離進場%', fmtSign(a.strat.distPct) + '%'], ['狀態', `<span class="badge ${statusBadgeCls(a.status)}">${a.status}</span>`], ['週期', a.period], ['策略', a.type],
      ['進場區間', `${fmt(a.strat.entryLow)}～${fmt(a.strat.entryHigh)}`], ['停損', fmt(a.strat.stop)],
      ['目標1 / 目標2', `${fmt(a.strat.target1)} / ${fmt(a.strat.target2)}${a.vlag ? '<div class="vlag">波段大漲後回落，目標僅供參考</div>' : ''}`],
      ['風險報酬', '1 : ' + fmt(a.strat.rr)], ['推薦／觀察原因', a.reason],
    ];
    tr.innerHTML = cells.map(([label, v], ci) => `<td data-label="${label}" class="${ci === 18 ? 'reason ' : ''}${CARD_KEY.includes(ci) ? 'k' : 'x'}">${v}</td>`).join('');
    const lv = document.createElement('td'); // 手機卡第一層一小列：停損・目標一（桌面隱藏，表格已有專欄）
    lv.className = 'lvrow';
    lv.innerHTML = `<span class="stop-txt">停損 ${fmt(a.strat.stop)}</span>・<span class="target-txt">目標一 ${fmt(a.strat.target1)}</span>`;
    tr.appendChild(lv);
    const tg = document.createElement('td');
    tg.className = 'tg'; tg.textContent = '▾ 展開全部欄位';
    tg.addEventListener('click', ev => { ev.stopPropagation(); const open = tr.classList.toggle('open'); tg.textContent = open ? '▴ 收合欄位' : '▾ 展開全部欄位'; });
    tr.appendChild(tg);
    tr.addEventListener('click', () => selectAnalysis(a, true));
    body.appendChild(tr);
  });
  const empty = $('emptyHint');
  if (!list.length) {
    empty.classList.remove('hidden');
    const st = state.lastStats;
    if (st && st.scanned === 0 && st.qualityBad > 0 && st.qualityBad >= st.typeExcluded && st.qualityBad >= st.historyShort) {
      empty.textContent = '多數股票的資料日期不一致，今天的更新未完成，請稍後再試或等待今晚自動更新修復。';
    } else if (st && st.scanned === 0 && st.typeExcluded > 0) {
      empty.textContent = `目前這批資料的 ${st.typeExcluded} 檔全是代號 00 開頭的 ETF／ETN，而你沒有勾選「納入 ETF 推薦」，所以實際掃描 0 檔、名單為空。勾選「納入 ETF」後重新掃描就會有結果；一般股票（代號 1101 起）會隨後端回補進度陸續加入（回補依代號順序進行中）。`;
    } else {
      empty.textContent = '目前名單是空的。可能原因：門檻過高、資料不足或最新日期不一致。可到「選股設定」改點「積極進場」或「全部探索」、放寬成交額、勾選納入 ETF，或先補齊歷史資料。系統不會為了湊數放寬標準。';
    }
  } else empty.classList.add('hidden');
  if (list.length && (!state.selected || !list.some(a => a.code === state.selected.code))) selectAnalysis(list[0], false);
  else if (state.selected) selectAnalysis(state.selected, false);
}

// ---------- 選股詳細：走勢圖＋策略摘要 (#175, #181-210) ----------
function selectAnalysis(a, scroll) {
state.selected = a;
const stock = stocksNow().find(s => s.code === a.code) || state.realStocks.find(s => s.code === a.code) || state.demoStocks.find(s => s.code === a.code);
state.selectedStock = stock;
document.querySelectorAll('#resultBody tr').forEach(tr => {
tr.classList.toggle('selected', tr.children[1] && tr.children[1].textContent === a.code);
});
drawChart(a);
renderStrategyCard(a);
renderTech(a);
if (state.aiByCode[a.code]) renderAI(a.code); else $('aiResult').textContent = '尚未進行 AI 分析。AI 只解讀既有數據，不得捏造價格或改寫交易價位。';
$('historyResult').textContent = a._history? renderHistoryText(a): '尚未計算。這是固定交易日後的歷史訊號統計（技術分 ≥70），不是完整逐筆回測。';
renderNews(a.code);
if (!state.newsStatus[a.code]) fetchNews(a); // 首次選到就自動嘗試載入新聞（失敗會顯示外部搜尋連結，不再假裝查無）
// 手機：點卡片／查詢後把明細帶到眼前（扣掉置頂操作列高度）
if (scroll && window.innerWidth <= 900) {
  const tabs = $('detailTabs'), bar = document.querySelector('.action-bar');
  const y = tabs.getBoundingClientRect().top + window.scrollY - ((bar ? bar.offsetHeight : 0) + 10);
  window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}
}
function drawChart(a) {
const cv = $('chart');
const dpr = window.devicePixelRatio || 1;
const W = cv.clientWidth || 320, H = 260;
cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
ctx.fillStyle = '#10223b'; ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#9db8d8'; ctx.font = '12px sans-serif';
ctx.fillText('收盤價格走勢（元）｜最近最多 100 個交易日', 8, 16);
const stock = state.selectedStock;
if (!stock) { ctx.fillText('請先選擇有歷史行情的股票', 8, 40); return;}
const n = Math.min(100, stock.bars.close.length);
const closes = stock.bars.close.slice(-n), dates = stock.bars.dates.slice(-n);
const s = a.strat;
// 刻度以股價本身的區間為主（±18% 留白），避免遠處的停損／目標把價格線壓扁、上方留大片空白
let lo = Math.min(...closes), hi = Math.max(...closes);
const pad = (hi - lo) * 0.18 || 1; lo -= pad; hi += pad;
const X = i => 34 + (W - 44) * i / (n - 1), Y = v => 24 + (H - 52) * (1 - (v - lo) / (hi - lo));
ctx.strokeStyle = '#24497c'; ctx.fillStyle = '#9db8d8';
for (let g = 0; g < 5; g++) { const v = lo + (hi - lo) * g / 4, y = Y(v); ctx.beginPath(); ctx.moveTo(34, y); ctx.lineTo(W - 10, y); ctx.stroke(); ctx.fillText(v.toFixed(1), 2, y + 4);}
for (let g = 0; g < 5; g++) { const i = Math.round((n - 1) * g / 4); const label = dates[i].slice(5); ctx.fillText(label, Math.max(34, Math.min(X(i) - 14, W - 10 - label.length * 7)), H - 6);}
const lines = [[s.entryLow, '#38bdf8', '進場下緣'], [s.entryHigh, '#38bdf8', '進場上緣'], [s.stop, '#ff5252', '停損'], [s.target1, '#35c759', '目標1'], [s.target2, '#a3e635', '目標2']];
ctx.setLineDash([5, 4]);
// 先決定每條價位線的 y：範圍內用實際位置；超出範圍在邊緣畫短線，同側多條逐條錯開
let stubTop = 0, stubBot = 0;
const jobs = lines.map(([v, color, name]) => {
  const inR = v >= lo && v <= hi;
  const yLine = inR ? Y(v) : (v > hi ? 28 + (stubTop++) * 7 : H - 34 - (stubBot++) * 7);
  return { v, color, name, yLine, y: yLine };
});
for (const j of jobs) { ctx.strokeStyle = j.color; ctx.beginPath(); ctx.moveTo(34, j.yLine); ctx.lineTo(W - 10, j.yLine); ctx.stroke(); }
ctx.setLineDash([]);
ctx.strokeStyle = closes.at(-1) >= closes[0]? '#2dd4bf': '#ff8a80'; ctx.lineWidth = 1.8; ctx.beginPath();
closes.forEach((v, i) => i? ctx.lineTo(X(i), Y(v)): ctx.moveTo(X(i), Y(v))); ctx.stroke(); ctx.lineWidth = 1;
// 標籤防重疊布局：全部標籤右對齊畫布右緣，y 強制最小間距 13px 並夾回圖表區，被推離原位的加引導線指回價位線
jobs.sort((a, b) => a.y - b.y);
for (let i = 1; i < jobs.length; i++) if (jobs[i].y < jobs[i - 1].y + 13) jobs[i].y = jobs[i - 1].y + 13;
const overBot = jobs[jobs.length - 1].y - (H - 28);
if (overBot > 0) for (const j of jobs) j.y -= overBot;
if (jobs[0].y < 26) { const sh = 26 - jobs[0].y; for (const j of jobs) j.y += sh; }
ctx.textAlign = 'right';
for (const j of jobs) {
  const text = `${j.name} ${j.v.toFixed(1)}`;
  const tw = ctx.measureText(text).width;
  if (Math.abs(j.y - j.yLine) > 3) { // 被推離原位才畫引導線指回價位線
    ctx.strokeStyle = j.color; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(W - 14 - tw, j.y); ctx.lineTo(W - 10, j.yLine); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = '#10223b'; // 標籤底襯：遮掉穿過文字的虛線/價格線，字才看得清
  ctx.fillRect(W - 15 - tw, j.y - 6, tw + 5, 14);
  ctx.fillStyle = j.color;
  ctx.fillText(text, W - 12, j.y + 4);
}
ctx.textAlign = 'left';
const lx = X(n - 1), ly = Y(closes.at(-1));
ctx.fillStyle = '#ffd54f'; ctx.beginPath(); ctx.arc(lx - 2, ly, 4, 0, 7); ctx.fill();
// 最新收盤標籤：在候選位置中挑第一個與所有價位標籤基線相距 ≥12px 的，都不行就挑最遠的
const labelBase = jobs.map(j => j.y + 4);
let closeY = ly - 8, closeScore = Math.min(...labelBase.map(b => Math.abs(b - closeY)));
for (const cand of [ly - 8, ly + 16, ly - 22, ly + 28]) {
  const d = Math.min(...labelBase.map(b => Math.abs(b - cand)));
  if (d >= 12) { closeY = cand; closeScore = d; break; }
  if (d > closeScore) { closeY = cand; closeScore = d; }
}
const closeText = closes.at(-1).toFixed(2);
if (closeScore >= 8) { // 找不到乾淨位置就不畫：硬擠只會疊字，收盤價在下方策略卡有大字呈現
  ctx.fillStyle = '#10223b';
  ctx.fillRect(Math.max(34, lx - 46), closeY - 10, ctx.measureText(closeText).width + 4, 13);
  ctx.fillStyle = '#ffd54f';
  ctx.fillText(closeText, Math.max(34, lx - 44), closeY);
}
}
function renderStrategyCard(a) {
const s = a.strat, demo = a.isDemo? '虛構示範資料｜勿用於投資\n': '';
$('strategyCard').innerHTML =
`${demo ? `<div class="sc-demo">${demo.trim()}</div>` : ''}<div class="sc-title">${a.code} ${a.name}｜技術 ${a.techScore} / 100｜進場適合度 ${a.entryScore} / 100</div>
<div class="kv-grid">
<div><span>收盤（${a.date}）</span><b>${fmt(a.close)}（${fmtSign(a.changePct)}%）</b></div>
<div><span>進場狀態</span><b class="status-txt">${s.status}</b></div>
<div><span>進場區間</span><b class="entry-txt">${fmt(s.entryLow)} ～ ${fmt(s.entryHigh)}</b></div>
<div><span>停損價位</span><b class="stop-txt">${fmt(s.stop)}</b></div>
<div><span>目標一／目標二</span><b class="target-txt">${fmt(s.target1)} / ${fmt(s.target2)}</b></div>${a.vlag ? '\n<div class="vlag-note">波段大漲後回落，目標僅供參考</div>' : ''}
<div><span>距離進場區</span><b>${fmt(s.distPct)}%</b></div>
<div><span>風險報酬比</span><b>1 : ${fmt(s.rr)}</b></div>
<div><span>操作策略／持有期間</span><b>${s.period}／${s.holding}</b></div>
<div><span>進場策略類型</span><b>${s.type}</b></div>
</div>
<div class="sc-notes">策略計算依據：${s.basis}｜目標一以 1.8 倍風險估算，非預測
進場觸發條件：${s.trigger}
策略失效條件：${s.invalid}
指標快覽：RSI ${fmt(a.ind.rsi14.at(-1), 1)}｜K ${fmt(a.ind.k.at(-1), 1)}／D ${fmt(a.ind.d.at(-1), 1)}｜量比 ${fmt(a.volRatio)}｜ATR ${fmt(a.ind.atr14.at(-1))}
策略提醒：歷史價位不保證成交，停損與目標價皆屬技術情境推導；量能轉弱或追高過度時請重新評估。</div>`;
}
function renderTech(a) {
const ind = a.ind, p = a.strat.parts;
const row = (k, v) => `${k}：${v == null || (typeof v === 'number' && isNaN(v))? '—': typeof v === 'number'? fmt(v): v}`;
const sub = (title, body) => `<details class="tech-sub"><summary>${title}</summary><div class="ts-body">${body}</div></details>`;
// 預設只顯示技術分與進場適合度；訊號／拆解／均線指標各自收合，點開才看
$('techDetail').innerHTML =
`<div class="tech-legend">MA＝均線（平均成本）・RSI＝熱度（70 以上偏熱）・ATR＝波動大小・乖離＝離均線遠近</div>` +
`<div class="tech-head">技術分 ${a.techScore} / 100｜進場適合度 ${a.entryScore} / 100</div>` +
sub(`成立訊號（${a.hit.length}）`, escapeHtml(a.hit.map(h => `${h.name} +${h.pts}`).join('、') || '無')) +
sub(`未成立訊號（${a.miss.length}）`, escapeHtml(a.miss.map(h => `${h.name}（${h.pts} 分）`).join('、') || '無')) +
sub('進場適合度拆解', `基礎 ${p.base}｜距離扣分 ${fmt(p.distPenalty, 1)}｜技術加分 +${fmt(p.techBonus, 1)}｜成交量加分 +${fmt(p.volBonus, 1)}｜風報加分 +${fmt(p.rrBonus, 1)}｜波動扣分 ${fmt(p.atrPenalty, 1)} → ${a.entryScore} 分`) +
sub('均線與指標', `${row('MA5', ind.ma5.at(-1))}｜${row('MA10', ind.ma10.at(-1))}｜${row('MA20', ind.ma20.at(-1))}｜${row('MA60', ind.ma60.at(-1))}｜${row('MA120', ind.ma120.at(-1))}
${row('MACD', ind.macd.at(-1))}｜${row('訊號線', ind.macdSignal.at(-1))}｜${row('RSI14', ind.rsi14.at(-1))}｜${row('K', ind.k.at(-1))}｜${row('D', ind.d.at(-1))}
${row('布林上緣', ind.bollUpper.at(-1))}｜${row('布林下緣', ind.bollLower.at(-1))}｜${row('ATR14', ind.atr14.at(-1))}
${row('ADX', ind.adx.at(-1))}｜${row('+DI', ind.plusDi.at(-1))}｜${row('-DI', ind.minusDi.at(-1))}｜${row('MFI14', ind.mfi14.at(-1))}
${row('量比', ind.volRatio)}｜${row('近20日均成交額(百萬元)', ind.avgAmount20M)}｜${row('前20日最高', ind.prev20High)}`);
}

// ---------- 個股查詢 (#162-174) ----------
async function queryStock() {
if (state.busy) return noteBusy();
if (state.mode === 'real' && state.backendLoading) { setProgress(0, '後端資料載入中，請稍候再查詢'); return; }
const q = $('inpQuery').value.trim();
if (!q) { alert('請輸入股票代號或名稱'); return;}
let pool = stocksNow();
let found = pool.filter(s => s.code === q.padStart(4, '0') || s.code === q);
if (!found.length) found = pool.filter(s => s.name.includes(q));
if (found.length > 1) {
const pick = prompt('找到多檔符合，請輸入要查詢的代號：\n' + found.map(s => `${s.code} ${s.name}`).join('\n'));
if (!pick) return;
found = found.filter(s => s.code === pick.trim().padStart(4, '0'));
}
if (!found.length && backendLoaded) {
const full = await ensureFullHistory({ code: q.padStart(4, '0'), isDemo: false });
if (full && full.bars && full.bars.close.length) found = [full];
}
if (!found.length) {
// 查無此代號/名稱：明講查無，並清掉舊的查詢結果顯示、回到掃描名單（不再留著上一筆誤導）
// （舊版官方逐檔補抓同樣受 CORS 限制多半失敗，一併移除，改以此訊息收尾）
state.results.custom = [];
$('selList').value = 'candidates';
renderList();
setProgress(0, `查無「${q}」，請確認代號或名稱`);
log(`個股查詢查無「${q}」`);
return;
}
const foundStock = found[0];
const stock = (typeof TWCore.filterBars === 'function') ? { ...foundStock, bars: TWCore.filterBars(foundStock.bars) } : foundStock;
if (stock.bars.close.length < 125) { alert(`「${stock.code} ${stock.name}」歷史行情僅 ${stock.bars.close.length} 日，不足 125 日，無法完成技術分析。`); return;}
let a = null;
try { a = TWCore.analyze(stock, $('selPeriod').value);} catch (e) {}
if (!a) { alert('策略無法計算（資料不足或 ATR 異常）'); return;}
a.reason = '個股查詢結果（不列入每日推薦排行）';
state.results.custom = [a];
$('selList').value = 'custom';
renderList(); selectAnalysis(a, true);
switchTab('tabStrategy');
setProgress(100, `已載入 ${a.code} ${a.name}｜技術 ${a.techScore} 分｜進場適合度 ${a.entryScore} 分 — 明細在下方`);
fetchNews(a); // #173 自動取得新聞（不自動呼叫 Gemini #174）
}

// ---------- 新聞 (#211-220) ----------
// 查因（2026-11-14）：Google News RSS 沒有 CORS 標頭，瀏覽器直連 fetch 必被擋下；
// 舊版 catch 把結果設成 []，與「真的查到 0 篇」無法區分，才會沒查成卻顯示「查無近期新聞」。
// 改版：newsStatus 區分 loading／ok／error，失敗顯示真實原因；不論成敗都附外部新聞搜尋
// 連結（免金鑰可用、新分頁開啟），只有直連真的成功且 0 篇時才說查無。
function newsLinksHtml(a) {
const q = encodeURIComponent(`${a.code} ${a.name} 股票`);
const links = [
['Google 新聞', `https://news.google.com/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`],
['Yahoo 股市', `https://tw.stock.yahoo.com/quote/${a.code}.${a.market === 'TPEX' ? 'TWO' : 'TW'}`],
['鉅亨網', `https://www.cnyes.com/search/news?keyword=${encodeURIComponent(a.code)}`],
['MoneyDJ', `https://www.moneydj.com/z/zc/zca/zca_${a.code}.djhtm`],
];
return '外部新聞搜尋（新分頁開啟）：' + links.map(([t, u]) => `<a target="_blank" rel="noopener" href="${u}">${t}</a>`).join('｜');
}
function newsTarget(code) {
if (state.selected && state.selected.code === code) return state.selected;
const stock = stocksNow().find(s => s.code === code) || state.realStocks.find(s => s.code === code) || state.demoStocks.find(s => s.code === code);
return stock ? { code: stock.code, name: stock.name, market: stock.market } : { code, name: code, market: 'TWSE' };
}
function renderNews(code) {
const a = newsTarget(code);
const list = state.newsByCode[code];
const status = state.newsStatus[code];
const links = newsLinksHtml(a);
if (list && list.length) {
$('newsList').innerHTML = list.map(n =>
`• <a target="_blank" rel="noopener" href="${n.link}">${escapeHtml(n.title)}</a>\n ${escapeHtml(n.source || '')}｜${n.date || ''}`).join('\n') + `\n\n${links}`;
return;
}
if (status === 'error') { $('newsList').innerHTML = `即時新聞清單無法直接載入（新聞來源不允許跨網域讀取），這不代表沒有新聞，請用外部搜尋查看：\n${links}`; return;}
if (status === 'ok') { $('newsList').innerHTML = `查詢完成：近 14 天沒有「${escapeHtml(a.name)}」的相關新聞。\n${links}`; return;}
if (status === 'loading') { $('newsList').innerHTML = `新聞載入中…\n${links}`; return;}
$('newsList').innerHTML = `尚未查詢新聞。\n${links}`;
}
function googleNewsUrl(name) { return 'https://news.google.com/search?q=' + encodeURIComponent(name + ' 股票') + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';}
function escapeHtml(s) { return String(s?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));}
async function fetchNews(a) {
const count = Math.max(1, Math.min(30, +$('inpNewsCount').value || 10));
const since = Date.now() - 14 * 86400000;
state.newsStatus[a.code] = 'loading';
renderNews(a.code);
try {
const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(a.name + ' 股票') + '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
const txt = await (await fetch(url)).text();
const doc = new DOMParser().parseFromString(txt, 'text/xml');
const seen = new Set(), items = [];
for (const it of doc.querySelectorAll('item')) {
const title = it.querySelector('title')?.textContent || '';
if (!title || seen.has(title)) continue; seen.add(title);
const pub = new Date(it.querySelector('pubDate')?.textContent || '');
if (!isNaN(pub) && pub.getTime() < since) continue;
items.push({ title, source: it.querySelector('source')?.textContent || '', date: isNaN(pub)? '': pub.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false}), link: it.querySelector('link')?.textContent || googleNewsUrl(a.name)});
if (items.length >= count) break;
}
state.newsByCode[a.code] = items;
state.newsStatus[a.code] = 'ok';
log(`新聞查詢 ${a.code} ${a.name}：${items.length} 篇`);
} catch (e) {
state.newsStatus[a.code] = 'error'; // 不寫入空陣列：失敗與「查到 0 篇」必須分得開
log('新聞 RSS 直連失敗（新聞來源不允許跨網域讀取），已改提供外部新聞搜尋連結：' + e.message);
}
renderNews(a.code);
}

// ---------- Gemini (#221-239) ----------
function geminiPayload(a) {
const news = (state.newsByCode[a.code] || []).map(n => ({ title: n.title, source: n.source, date: n.date}));
return { code: a.code, name: a.name, market: a.market, date: a.date, close: a.close, techScore: a.techScore, entryScore: a.entryScore,
ma5: a.ind.ma5.at(-1), ma20: a.ind.ma20.at(-1), ma60: a.ind.ma60.at(-1), rsi: a.ind.rsi14.at(-1), macd: a.ind.macd.at(-1),
adx: a.ind.adx.at(-1), mfi: a.ind.mfi14.at(-1), volRatio: a.volRatio, signals: a.hit.map(h => h.name),
entry: [a.strat.entryLow, a.strat.entryHigh], stop: a.strat.stop, target1: a.strat.target1, target2: a.strat.target2, rr: a.strat.rr, news};
}
async function callGemini(a) {
const key = $('inpApiKey').value.trim(), model = $('inpModel').value.trim() || 'gemini-2.5-flash';
if (!key) throw new Error('請先輸入 Gemini API Key');
const prompt = `你是台股研究助理。只能根據下列 JSON 資料撰寫解讀，禁止捏造股價、新聞、財報、EPS、估值或來源，禁止改寫其中任何交易價位；沒有提供的財務/產業資料必須明說缺乏。
請只回傳 JSON（不要 markdown），欄位：techConclusion（技術結論）、entryAnalysis（進場解析）、exitAnalysis（退出解析）、newsTheme（新聞／題材）、risks（風險）、periodView（週期判斷）、dataLimits（資料限制）。
資料：${JSON.stringify(geminiPayload(a))}`;
let lastErr = null;
for (let attempt = 0; attempt < 3; attempt++) {
const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
method: 'POST', headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ contents: [{ parts: [{ text: prompt}]}], generationConfig: { temperature: 0.2, responseMimeType: 'application/json'}}),
});
if (!resp.ok) { const err = new Error('Gemini HTTP ' + resp.status); err.status = resp.status; throw err;}
try {
const j = await resp.json();
const text = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '{}';
return JSON.parse(text);
} catch (e) { lastErr = e;}
}
throw lastErr || new Error('Gemini 回應解析失敗');
}
function renderAI(code) {
const r = state.aiByCode[code]; if (!r) return;
const sec = (t, v) => `\n${v || '（無）'}\n`;
$('aiResult').textContent = sec('技術結論', r.techConclusion) + '\n' + sec('進場解析', r.entryAnalysis) + '\n' + sec('退出解析', r.exitAnalysis) + '\n' + sec('新聞／題材', r.newsTheme) + '\n' + sec('風險', r.risks) + '\n' + sec('週期判斷', r.periodView) + '\n' + sec('資料限制', r.dataLimits);
}
async function runAI(batch) {
if (state.busy) return noteBusy();
const list = batch? (state.results.candidates.length? state.results.candidates: currentList()): (state.selected? [state.selected]: []);
if (!list.length) { alert('沒有可分析的股票'); return;}
if (!$('inpApiKey').value.trim()) { // 未填金鑰先明講，不進忙碌狀態、不假裝完成
setProgress(0, '請先輸入 Gemini API Key（在左側「③ Gemini 設定」）');
log('Gemini 未執行：尚未輸入 API Key');
return;
}
if (batch &&!confirm(`批次分析將對 ${list.length} 檔股票分別呼叫 Gemini API，可能產生費用。確定開始？`)) return;
setBusy(true); state.stopFlag = false;
let okCount = 0, lastErr = '';
try {
for (let i = 0; i < list.length; i++) {
if (state.stopFlag) { log('批次 AI 已停止'); break;}
setProgress(Math.round(i / list.length * 100), `Gemini 分析 ${list[i].code}（${i + 1}/${list.length}）…`);
try { state.aiByCode[list[i].code] = await callGemini(list[i]); okCount++; log(`Gemini 完成 ${list[i].code}`);}
catch (e) {
lastErr = e.message;
log(`Gemini 失敗 ${list[i].code}：${e.message}`);
if (batch && [400, 401, 403, 429].includes(e.status)) { log('遇到 ' + e.status + '，依規則停止後續批次呼叫'); break;}
if (!batch) alert(e.message);
}
}
// 成功提示只在真的成功時出現；全部失敗就顯示真實錯誤，不再跳「AI 分析完成」
if (okCount) setProgress(100, batch ? `AI 分析完成（成功 ${okCount}/${list.length} 檔）` : 'AI 分析完成');
else if (lastErr) setProgress(0, `AI 分析失敗：${lastErr}`);
if (state.selected && state.aiByCode[state.selected.code]) renderAI(state.selected.code);
} finally { setBusy(false);}
}
async function testGemini() {
const key = $('inpApiKey').value.trim(), model = $('inpModel').value.trim();
if (!key) { alert('請先輸入 Gemini API Key'); setProgress(0, '請先輸入 Gemini API Key'); log('Gemini 測試未執行：尚未輸入 API Key'); return;}
try {
const j = await (await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key))).json();
const models = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'));
const okModel = models.some(m => m.name === 'models/' + model || m.name === model);
alert(`連線成功。可用文字生成模型 ${models.length} 個。\n目前模型「${model}」：${okModel? '可用': '不在清單中，請確認名稱'}`);
log(`Gemini 測試：可用模型 ${models.length} 個（${models.slice(0, 8).map(m => m.name.replace('models/', '')).join(', ')}…），目前模型 ${okModel? '可用': '未確認'}`);
} catch (e) { alert('Gemini 連線失敗：' + e.message); log('Gemini 測試失敗：' + e.message);}
}

// ---------- 歷史訊號觀察 (#240-250) ----------
function renderHistoryText(a) {
const h = a._history;
return [5, 10, 20].map(k => `${k} 日｜訊號次數 ${h[k].count}｜上漲比例 ${fmt(h[k].upRatio, 1)}%｜平均報酬 ${fmtSign(h[k].avgRet)}%｜目標達成 ${fmt(h[k].targetHit, 1)}%｜停損比例 ${fmt(h[k].stopHit, 1)}%`).join('\n')
+ '\n（成本率 0.4%＋滑價 0.1% 已計入報酬；此為固定持有天數的訊號統計，不是完整逐筆回測）';
}
async function runHistory() {
if (!state.selected ||!state.selectedStock) { alert('請先選取股票'); return;}
if (state.busy) return noteBusy();
const a = state.selected;
if (a._history) { $('historyResult').textContent = renderHistoryText(a); return;}
setBusy(true); setProgress(15, '載入完整 10 年歷史…');
state.selectedStock = await ensureFullHistory(state.selectedStock);
setProgress(40, '計算歷史訊號統計…');
await new Promise(r => setTimeout(r, 30));
try { a._history = TWCore.historyStats(state.selectedStock); $('historyResult').textContent = renderHistoryText(a); setProgress(100, '歷史統計完成'); log(`歷史訊號統計完成 ${a.code}（${state.selectedStock.bars.close.length} 筆日線）`);}
catch (e) { log('歷史統計失敗：' + e.message);}
finally { setBusy(false);}
}

// ---------- Excel 匯出 (#251-262) ----------
function exportExcel() {
const date = (refreshStatus() || new Date().toISOString().slice(0, 10));
const demoTag = state.mode === 'demo'? '_DEMO': '';
const fname = `台股技術選股_${date}${demoTag}.xlsx`;
const rec = state.results.candidates, watch = state.results.watch;
if (!rec.length &&!watch.length) { alert('目前沒有可匯出的推薦或觀察名單'); return;}
if (!window.XLSX) { // CDN 未載入時退回 CSV（Excel 可開啟）
const rows = [['代號', '名稱', '市場', '日期', '收盤', '技術分', '進場適合度', '狀態', '週期', '策略', '進場區間', '停損', '目標1', '目標2', '風險報酬', '原因'],
...rec.map(a => [a.code, a.name, a.market, a.date, a.close, a.techScore, a.entryScore, a.status, a.period, a.type, `${a.strat.entryLow}~${a.strat.entryHigh}`, a.strat.stop, a.strat.target1, a.strat.target2, a.strat.rr, a.reason])];
const csv = '\uFEFF' + rows.map(r => r.map(x => `"${String(x?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
download(new Blob([csv], { type: 'text/csv'}), fname.replace('.xlsx', '.csv'));
log('Excel 套件未載入，已改匯出 CSV'); setProgress(100, '已匯出 CSV（Excel 套件未載入，改存 CSV）'); return;
}
const wb = XLSX.utils.book_new();
const head = ['代號', '名稱', '市場', '最新日期', '收盤', '當日漲跌', '漲跌幅%', '技術分', '進場適合度', '距離進場%', '狀態', '週期', '策略', '進場下緣', '進場上緣', '停損', '目標1', '目標2', '風險報酬', '進場觸發條件', '原因'];
const toRow = a => [a.code, a.name, a.market, a.date, a.close, a.change, +a.changePct.toFixed(2), a.techScore, a.entryScore, +a.strat.distPct.toFixed(2), a.status, a.period, a.type, a.strat.entryLow, a.strat.entryHigh, a.strat.stop, a.strat.target1, a.strat.target2, +a.strat.rr.toFixed(2), a.strat.trigger, a.reason];
const sheet = (name, rows) => { const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = rows[0].map(() => ({ wch: 14})); XLSX.utils.book_append_sheet(wb, ws, name);};
sheet('選股排行', [head,...rec.map(toRow)]);
if (watch.length) sheet('技術強勢觀察', [head,...watch.map(toRow)]);
const all = [...rec,...watch];
sheet('指標明細', [['代號', '名稱', 'MA5', 'MA20', 'MA60', 'RSI', 'MACD', '訊號線', 'K', 'D', '量比', 'ADX', 'MFI', 'ATR', '成立訊號', '未成立訊號'],
...all.map(a => [a.code, a.name,...[a.ind.ma5, a.ind.ma20, a.ind.ma60, a.ind.rsi14, a.ind.macd, a.ind.macdSignal, a.ind.k, a.ind.d].map(s => s? +s.at(-1).toFixed(2): ''), +(a.volRatio || 0).toFixed(2), +a.ind.adx.at(-1).toFixed(2), +a.ind.mfi14.at(-1).toFixed(2), +a.ind.atr14.at(-1).toFixed(2), a.hit.map(h => h.name).join('、'), a.miss.map(h => h.name).join('、')])]);
const newsRows = [['代號', '名稱', '日期', '新聞標題', '媒體來源', '連結']];
for (const a of all) for (const n of (state.newsByCode[a.code] || [])) newsRows.push([a.code, a.name, n.date, n.title, n.source, n.link]);
sheet('新聞索引', newsRows);
sheet('Gemini分析', [['代號', '名稱', '技術結論', '進場解讀', '出場解讀', '新聞趨勢', '風險', '週期理由', '資料限制'],
...all.map(a => { const r = state.aiByCode[a.code] || {}; return [a.code, a.name, r.techConclusion || '', r.entryAnalysis || '', r.exitAnalysis || '', r.newsTheme || '', r.risks || '', r.periodView || '', r.dataLimits || ''];})]);
sheet('使用說明', [['項目', '內容'], ['產生時間', new Date().toLocaleString('zh-TW')], ['行情日期', date], ['資料模式', state.mode === 'demo'? '離線示範（虛構）': '正式／匯入'], ['符合條件檔數', rec.length], ['資料來源', 'TWSE／TPEx 公開行情、CSV 匯入或示範資料'], ['使用限制', '盤後研究用途，非即時行情，不保證預測，不提供自動下單']]);
XLSX.writeFile(wb, fname);
log('已匯出 Excel：' + fname);
setProgress(100, `已匯出 Excel：${fname}`);
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);}

// ---------- 完整性統計 (#45-48) ----------
function showIntegrity() {
  try {
    const stocks = stocksNow();
    if (!stocks.length) { setProgress(0, '目前沒有資料可檢查，請先載入後端資料或示範資料'); return; }
    const by = {};
    for (const s of stocks) { const m = s.market; by[m] = by[m] || { count: 0, rows: 0, min: '9999', max: '' }; by[m].count++; by[m].rows += s.bars.close.length; const f = s.bars.dates[0], l = s.bars.dates[s.bars.dates.length - 1]; if (f < by[m].min) by[m].min = f; if (l > by[m].max) by[m].max = l; }
    let bad = 0;
    for (const s of stocks) { const b = s.bars; for (let i = 0; i < b.close.length; i++) { if (!(b.high[i] >= b.low[i] && b.close[i] > 0 && b.volume[i] >= 0)) bad++; } }
    const etf = stocks.filter(s => TWCore.isETF(s.code)).length;
    $('integrityBody').innerHTML = `目前模式：${state.mode === 'demo' ? '示範' : '正式／匯入'}<br>` +
      Object.entries(by).map(([m, v]) => `${m}：${v.count} 檔、${v.rows.toLocaleString()} 筆日線、${v.min} ～ ${v.max}`).join('<br>') +
      `<br>ETF 粗估數量（代號 00 開頭）：${etf}<br>異常 OHLCV 筆數：${bad}<br>先前下載失敗市場日期數：${state.failedDates.length}`;
    $('integrityDialog').showModal();
    log('已開啟完整性統計');
  } catch (e) { setProgress(0, '完整性檢查失敗：' + e.message); log('完整性檢查失敗：' + e.message); }
}

// ---------- 分頁切換 ----------
function switchTab(id) {
document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === id));
document.querySelectorAll('#detailTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
if (id === 'tabStrategy' && state.selected) drawChart(state.selected);
if (id === 'tabNews' && state.selected && !state.newsStatus[state.selected.code]) fetchNews(state.selected);
}

// ---------- 事件綁定與init ----------
function init() {
loadSettings();
SETTING_IDS.forEach(id => $(id).addEventListener('change', saveSettings));
document.querySelectorAll('.preset').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
['inpMinTech', 'inpMinEntry'].forEach(id => $(id).addEventListener('change', markPreset));
markPreset();
document.querySelectorAll('[data-days]').forEach(b => b.addEventListener('click', () => { $('inpDays').value = b.dataset.days; saveSettings();}));
$('btnIntegrity').addEventListener('click', showIntegrity);
$('btnDemo').addEventListener('click', () => { state.mode = 'demo'; if (!state.demoStocks.length) state.demoStocks = TWDemo.generateDemoStocks(); refreshStatus(); log('已載入離線示範資料（虛構）'); runScan();});
$('btnReal').addEventListener('click', async () => {
// 切回正式：重新載入後端資料並自動重掃，名單真的恢復正式資料（不再只改表頭文字）
state.mode = 'real'; refreshStatus(); log('已切回正式資料模式，重新載入後端資料…');
const okLoad = await loadBackendData(true);
if (!okLoad) { refreshStatus(); if (state.realStocks.length) runScan(); }
});
$('fileCsv').addEventListener('change', async e => {
const f = e.target.files[0]; if (!f) return;
try {
const stocks = parseCSV(await f.text());
const map = new Map(state.realStocks.map(s => [s.code, s]));
for (const s of stocks) map.set(s.code, s);
state.realStocks = [...map.values()]; state.mode = 'real';
await persistReal(); refreshStatus();
log(`CSV 匯入完成：${stocks.length} 檔`); setProgress(100, `CSV 匯入完成：${stocks.length} 檔`);
} catch (err) { alert('CSV 匯入失敗：' + err.message); log('CSV 匯入失敗：' + err.message);}
e.target.value = '';
});
$('btnScan').addEventListener('click', runScan);
$('btnScanCompact').addEventListener('click', runScan);
{ // 滑過標題區後，置頂操作列切精簡模式（只留模式＋推薦數＋重新掃描）
const barEl = document.querySelector('.action-bar'), topEl = document.querySelector('.topbar');
window.addEventListener('scroll', () => { barEl.classList.toggle('compact', window.scrollY > (topEl ? topEl.offsetHeight : 100) + 10); }, { passive: true });
}
$('btnStop').addEventListener('click', () => { state.stopFlag = true;});
$('btnExplain').addEventListener('click', () => {
$('explainBody').innerHTML = '<table><tr><th>項目</th><th>加分</th><th>成立條件</th></tr>' +
[['MA多頭排列', 10, 'MA5＞MA20＞MA60'], ['均線黃金交叉', 8, 'MA5 上穿 MA20'], ['MACD翻多', 10, 'MACD 上穿訊號線'], ['RSI偏多', 8, 'RSI14 介於 50～75'], ['KD黃金交叉', 6, 'K 上穿 D'], ['布林偏多', 6, '收盤＞MA20 且 ≤ 布林上緣 102%'], ['成交量放大', 10, '量比 ≥ 1.5'], ['OBV偏多', 6, 'OBV 高於前20日最高'], ['ADX強勢', 6, 'ADX ≥ 25 且 +DI＞-DI'], ['突破前高', 10, '收盤突破前20日最高價'], ['Supertrend翻多', 8, 'Supertrend 多頭狀態'], ['一目均衡表偏多', 6, '收盤高於雲層且轉換線＞基準線'], ['MFI偏多', 6, 'MFI14 ≥ 50']]
.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('') + '</table>';
$('explainDialog').showModal();
});
$('selList').addEventListener('change', renderList);
$('inpFilter').addEventListener('input', renderList);
$('chkNear').addEventListener('change', renderList);
// 表頭排序（數值欄位以數值排序 #151-152）
document.querySelectorAll('#resultTable thead th').forEach((th, ci) => th.addEventListener('click', () => sortByColumn(ci)));
$('btnQuery').addEventListener('click', queryStock);
$('inpQuery').addEventListener('keydown', e => { if (e.key === 'Enter') queryStock();});
$('btnNews').addEventListener('click', () => { if (state.selected) fetchNews(state.selected);});
$('btnTestGemini').addEventListener('click', testGemini);
$('btnAI').addEventListener('click', () => runAI(false));
$('btnAIBatch').addEventListener('click', () => runAI(true));
$('btnHistory').addEventListener('click', runHistory);
$('btnExport').addEventListener('click', exportExcel);
document.querySelectorAll('#detailTabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
window.addEventListener('resize', () => { if (state.selected) drawChart(state.selected);});
$('btnReloadData').addEventListener('click', updateToLatest);
$('btnClearQuery').addEventListener('click', () => { $('inpQuery').value = ''; state.results.custom = []; $('selList').value = 'candidates'; renderList(); $('inpQuery').focus(); });
idb.open().then(async () => { const saved = await idb.get('realStocks'); if (Array.isArray(saved) && saved.length) { state.realStocks = saved; log(`已還原先前匯入資料 ${saved.length} 檔`);} refreshStatus(); loadBackendData(true); }).catch(() => { refreshStatus(); loadBackendData(true); });
refreshStatus();
log('台股 AI 智慧選股工作台 V2.0（網頁版）就緒。建議先按「載入離線示範資料」體驗完整流程。');
}
const SORT_GETTERS = [a => 0, a => a.code, a => a.name, a => a.market, a => a.date, a => a.close, a => a.change, a => a.changePct, a => a.techScore, a => a.entryScore, a => a.strat.distPct, a => a.status, a => a.period, a => a.type, a => a.strat.entryLow, a => a.strat.stop, a => a.strat.target1, a => a.strat.rr, a => a.reason];
let sortAsc = false;
function sortByColumn(ci) {
const kind = $('selList').value, list = state.results[kind]; if (!list) return;
const get = SORT_GETTERS[ci]; sortAsc =!sortAsc;
list.sort((x, y) => { const vx = get(x), vy = get(y); const c = (typeof vx === 'number' && typeof vy === 'number')? vx - vy: String(vx).localeCompare(String(vy), 'zh-Hant'); return sortAsc? c: -c;});
renderList(); // renderList 依新順序重新編號排行（#152）
}
document.addEventListener('DOMContentLoaded', init);

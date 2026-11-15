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
  results: { candidates: [], watch: [], custom: [], rev: [], revwatch: [] },
  selected: null,          // 目前選取的分析結果
  selectedStock: null,
  newsByCode: {},          // code -> [{title, source, date, link}]
  newsStatus: {},          // code -> 'loading' | 'ok' | 'error'（區分「查到 0 篇」與「根本沒查成」）
  backendLoading: false,   // 後端資料包載入中（此時鎖查詢，避免命中 IndexedDB 舊資料）
  revenue: null,           // E1 營收資料（revenue.json.gz 的內容）；null＝無營收模式（可選資料，抓不到不影響主流程）
  revstate: null,          // 營收原始狀態（revstate.json.gz）；null＝未載入（可選資料，歷史事件計算用）
  revSeries: null,         // revstate 轉換結果：Map<code, Map<monthIdx, 營收>>；涵蓋率仍在逐日累積
  sumBase: null,           // 掃描摘要列文字（已掃描／推薦／觀察）
  revHistShown: false,     // 營收模式下歷史表現分頁是否已按鈕產出（整體績效＋個股紀錄）；進出營收模式時重置
  revLoading: false,       // 營收事件名單建立中（進入營收模式同步切換後、建名單完成前）；摘要與營收鈕顯示載入中
  aiByCode: {},            // code -> Gemini 結構化結果（僅記憶體, #239）
  stopFlag: false,
  busy: false,
  failedDates: [],
  scanDone: false,         // 掃描完成後「開始掃描」改顯示「重新掃描」
  pendingPresetMsg: '',    // 套用預設後，掃描起始訊息顯示「已套用…正在重新掃描」
  presetLabel: '',         // 目前套用的選股模式名稱（精簡列／②標題用）
};
const stocksNow = () => state.mode === 'demo' ? state.demoStocks : state.realStocks;

// ---------- 更新紀錄 (#268) ----------
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
  const sc = $('btnStopCompact'); if (sc) { sc.classList.toggle('hidden', !b); sc.disabled = !b; } // 精簡列的停止鈕：掃描中才出現（精簡列會藏掉一般掃描列，停止鈕不能跟著消失）
}
function updateScanLabel() { $('btnScan').textContent = state.scanDone ? '↻ 重新掃描' : '▶ 開始掃描'; }
function updateCompactInfo() {
  const c = $('compactInfo'); if (!c) return;
  if (revActive()) { c.textContent = `營收推薦 ${state.results.rev.length} 檔、觀察 ${state.results.revwatch.length} 檔`; return; }
  c.textContent = `${state.presetLabel || '穩健推薦'}｜推薦 ${state.results.candidates.length} 檔`;
}

// ---------- 設定保存 (#65；不含 API Key #68) ----------
const SETTING_IDS = ['inpTopN', 'inpMinTech', 'inpMinAmount', 'selPeriod', 'selSort', 'inpMinEntry', 'chkEtf', 'inpNewsCount', 'inpModel', 'inpDays', 'inpRevTier'];
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
// 五顆按鈕（四顆風格預設＋營收事件）是單一互斥群組：任何時刻恰好一顆「使用中」。
// 營收模式（revActive）時四顆預設一律非 active、說明文字改營收定義、摘要改營收脈絡，
// 全部由 markPreset／syncRevButton／refreshSumLine 依目前模式統一渲染（syncModeUI）。
function markPreset() {
  const t = +$('inpMinTech').value || 0, e = +$('inpMinEntry').value || 0;
  let active = '';
  for (const k in PRESETS) if (PRESETS[k].tech === t && PRESETS[k].entry === e) active = k;
  state.presetLabel = active ? PRESETS[active].label : '自訂';
  const rev = revActive();
  document.querySelectorAll('.preset').forEach(b => {
    const p = PRESETS[b.dataset.preset]; if (!p) return; // 營收事件鈕（data-preset="rev"）不是風格預設，由 syncRevButton 管理
    const isA = !rev && b.dataset.preset === active; // 營收模式下預設鈕全數讓位，維持互斥
    b.classList.toggle('active', isA);
    b.innerHTML = `<span class="p-name">${p.label}</span><span class="p-sub">${isA ? '✓ 使用中' : '套用並重掃'}</span>`;
  });
  const ss = $('settingsSummary');
  if (ss) ss.textContent = `② 選股設定（目前：${rev ? '營收推薦' : state.presetLabel}）`;
  const hint = $('presetHint');
  if (hint) hint.textContent = rev ? REV_DEF : (active ? PRESETS[active].desc : '自訂門檻：你已手動微調下面的分數，不屬於任何預設風格。');
  updateCompactInfo();
}
// 模式切換的統一收斂點：按鈕 active、說明、摘要、精簡列一次對齊目前模式
function syncModeUI() { markPreset(); syncRevButton(); refreshSumLine(); syncRevSortUI(); }
async function applyPreset(k) {
  const p = PRESETS[k]; if (!p) return;
  $('inpFilter').value = ''; // 切換預設時清空名單關鍵字，避免殘留關鍵字把新名單濾成空的、誤以為選不到股票
  if (revView()) { setListOptions('preset', 'candidates'); state.revHistShown = false; } // 離開營收模式（推薦／觀察任一檢視）：下拉先換回預設模式選項並切回候選名單，markPreset 才能正確渲染預設群組
  $('inpMinTech').value = p.tech; $('inpMinEntry').value = p.entry;
  saveSettings(); syncModeUI(); // 同步收斂（任何 await 之前）：新預設立即亮起、營收鈕立即熄滅、說明／摘要立即回預設脈絡，掃描期間不得雙亮
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

// ---------- 後端資料包自動載入（GitHub Actions 排程更新 → 靜態檔案） ----------
// 資料來源（2026-11-15 起）：主要來源為專用資料 repo（linhinet7451/twstock-ai-data）的 Pages，
// 主要來源失敗時自動改用本站 data/ 的凍結舊副本。manifest、掃描包、完整歷史三種抓取
// 一律走 fetchDataJson / fetchDataGzip 單一入口；某來源成功後記住它，本次工作階段沿用。
// 每個來源內先重試（首次＋2 次，退避 0.8s／2s）：fetch 拋錯、HTTP 非 200、gzip 解壓或
// JSON 解析失敗都算一次失敗，吃掉下載中途瞬斷這類暫時故障；來源 3 次都失敗才換下一個來源。
const DATA_BASES = [
  'https://linhinet7451.github.io/twstock-ai-data/data/',
  'data/',
];
let dataBaseIdx = 0;
const DATA_RETRY_DELAYS = [800, 2000];
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
async function withDataBase(fn) {
  let lastErr = null;
  for (let i = dataBaseIdx; i < DATA_BASES.length; i++) {
    for (let attempt = 0; attempt <= DATA_RETRY_DELAYS.length; attempt++) {
      try {
        const r = await fn(DATA_BASES[i]);
        dataBaseIdx = i;
        return r;
      } catch (e) {
        lastErr = e;
        if (e && /DecompressionStream/.test(e.message || '')) throw e; // 瀏覽器不支援解壓：重試或換來源都沒用
        if (attempt < DATA_RETRY_DELAYS.length) await sleepMs(DATA_RETRY_DELAYS[attempt]);
      }
    }
  }
  throw lastErr || new Error('資料來源無回應');
}
async function fetchDataJson(path) {
  return withDataBase(async base => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000); // 單次嘗試逾時，避免連線卡死無限等待
    try {
      const resp = await fetch(base + path, { cache: 'no-store', signal: ctrl.signal });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + base + path);
      return await resp.json();
    } finally { clearTimeout(timer); }
  });
}
async function fetchDataGzip(path, onProgress) {
  return withDataBase(base => fetchGzipJson(base + path, onProgress));
}
async function fetchGzipJson(url, onProgress) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 單次嘗試逾時（16MB 掃描包綽綽有餘），避免連線卡死無限等待
  try {
    const resp = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
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
        async pull(ctrl2) {
          const { done, value } = await reader.read();
          if (done) { ctrl2.close(); return; }
          loaded += value.byteLength;
          const pct = total ? Math.floor(loaded / total * 100) : -1;
          if (pct !== lastShown) { lastShown = pct; onProgress(loaded, total); }
          ctrl2.enqueue(value);
        },
        cancel(r) { reader.cancel(r); },
      });
    }
    const pipe = stream.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(pipe).text());
  } finally { clearTimeout(timer); }
}
// ---------- E1 營收事件（月營收年增 > 20% 公布後 20 個交易日內） ----------
// revenue.json.gz 是可選資料：與後端主資料平行加載，抓不到（404／失敗）就靜默維持
// 無營收模式，絕不可讓主載入失敗或跳錯誤提示。標記皆為事實陳述（營收月份＋年增率）。
const REV_DEF = '營收推薦：月營收年增 > 20%，公布後 20 個交易日內（不套用風格門檻）';
// 推薦分層日：使用者可在「選股設定」自訂（1–19，預設 10，持久化於 twstock_settings）。
// age <= 分層日為營收推薦、分層日 < age <= 20 為營收觀察；年增門檻 > 20% 與事件窗
// 20 日是 E1 驗證標準、鎖定不給改，故只有分層日開放自訂。
function revTierDays() {
  const el = $('inpRevTier');
  let v = el ? parseInt(el.value, 10) : 10;
  if (!Number.isFinite(v)) v = 10;
  return Math.max(1, Math.min(19, v));
}
// 營收名單排序（使用者可切換；預設 fresh＝事件新鮮度：age 小到大、同 age 時 yoy 大到小，
// 與改版前完全相同）。選擇存 localStorage（twstock_rev_sort），非法值回退 fresh。
// 只影響營收檢視的顯示順序：state.results 的分層與內容不動，預設模式名單的排序
// （選股設定的 sortMode）不在此範圍、不受影響。
const REV_SORT_KEYS = ['fresh', 'tech', 'entry', 'yoy'];
function revSortKey() {
  try { const v = localStorage.getItem('twstock_rev_sort'); return REV_SORT_KEYS.includes(v) ? v : 'fresh'; }
  catch (e) { return 'fresh'; }
}
// 檢視標頭的排序說明（跟著目前選擇走；fresh 的文字與改版前完全相同）
function revSortText() {
  switch (revSortKey()) {
    case 'tech': return '技術分高到低';
    case 'entry': return '進場適合度高到低';
    case 'yoy': return '年增高到低';
    default: return '事件新到舊、年增高到低';
  }
}
// 非 fresh 排序比較：主鍵降冪，tie-break 依序 age 小到大、yoy 大到小、代號小到大（穩定確定）
function cmpRevSort(a, b) {
  const k = revSortKey();
  let d = 0;
  if (k === 'tech') d = b.techScore - a.techScore;
  else if (k === 'entry') d = b.entryScore - a.entryScore;
  else if (k === 'yoy') d = (b._rev ? b._rev.yoy : -Infinity) - (a._rev ? a._rev.yoy : -Infinity);
  if (d) return d;
  d = (a._rev ? a._rev.age : 0) - (b._rev ? b._rev.age : 0);
  if (d) return d;
  d = (b._rev ? b._rev.yoy : 0) - (a._rev ? a._rev.yoy : 0);
  if (d) return d;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}
// 排序下拉只在營收模式顯示（預設模式隱藏），且值與持久化選擇同步
function syncRevSortUI() {
  const sel = $('selRevSort'); if (!sel) return;
  sel.value = revSortKey();
  sel.classList.toggle('hidden', !revActive());
}
// 檢視標頭的分層定義（跟著分層日設定值走）：E1 全集（age <= 20）依新鮮度拆兩層
const revRecDef = () => `營收推薦：月營收年增 > 20%，事件後 ${revTierDays()} 個交易日內（不套用風格門檻）`;
const revWatchDef = () => `營收觀察：月營收年增 > 20%，事件後 ${revTierDays() + 1}–20 個交易日（不套用風格門檻）`;
const HIST_STANDBY = '還沒算過。按上面的按鈕，看這檔以前出現強勢訊號時，後來通常漲還是跌。';
// 目前檢視是否為營收檢視（rev＝營收推薦／revwatch＝營收觀察），是回傳其 value、否則回傳 ''
function revView() {
  const v = $('selList') ? $('selList').value : '';
  return v === 'rev' || v === 'revwatch' ? v : '';
}
// 營收模式的唯一判定：正式模式＋營收資料已載入＋目前檢視為營收推薦或營收觀察（兩檢視共用同一模式）
function revActive() {
  return state.mode === 'real' && !!state.revenue && !!revView();
}
function revInfo(code) {
  if (state.mode !== 'real' || !state.revenue || !state.revenue.stocks) return null;
  return state.revenue.stocks[code] || null;
}
function revIsEvent(info) { return !!info && info.age != null && info.age <= 20; }
function revBadgeHtml(a) {
  if (!a || a.isDemo) return '';
  // 兩套徹底分離：營收標籤只在營收檢視（推薦／觀察）內渲染（那是事件名單本體資訊）；
  // 主名單（推薦／觀察／查詢）的列不顯示營收標籤，個股層級改由展開欄位與策略卡呈現。
  if (!revView()) return '';
  const info = revInfo(a.code);
  if (!revIsEvent(info)) return '';
  return ` <span class="badge b-rev">${parseInt(info.m.slice(5), 10)}月營收 ${fmtYoyCap(info.yoy)}</span>`;
}
function refreshSumLine() {
  const el = $('sumLine'); if (!el) return;
  if (revActive()) { // 營收模式：摘要切換為營收脈絡（推薦／觀察雙計數），不殘留預設掃描的數字
    if (state.revLoading) { el.textContent = '營收推薦｜載入中…'; refreshCompLine(); return; } // 建名單期間只顯示過渡文字，不先跳定版數字
    const d = state.backendLatest || (state.revenue && state.revenue.latestDate) || '—';
    el.textContent = `營收推薦 ${state.results.rev.length} 檔、觀察 ${state.results.revwatch.length} 檔｜最新行情 ${d}`;
    refreshCompLine();
    return;
  }
  if (state.sumBase == null) return;
  el.textContent = state.sumBase; // 預設模式：已掃描／推薦／觀察（不含營收事件計數，兩套分離）
  refreshCompLine();
}
// 掃描後現況一行（預設模式專屬）：推薦名單的狀態組成，避免「積極進場 10 檔全是等待回檔」
// 這種名稱與內容落差讓使用者誤讀；營收模式不套用（其摘要已是營收脈絡）。
function refreshCompLine() {
  const el = $('sumComp'); if (!el) return;
  const list = state.results.candidates;
  if (revActive() || !state.scanDone || !list.length) { el.classList.add('hidden'); el.textContent = ''; return; }
  const counts = {};
  for (const a of list) counts[a.status] = (counts[a.status] || 0) + 1;
  el.classList.remove('hidden');
  if (counts['等待回檔'] === list.length) {
    el.textContent = `推薦 ${list.length} 檔目前皆為等待回檔——等價格回到進場區再考慮，不是現在買。`;
    el.classList.add('warn-line');
  } else {
    const order = ['接近進場', '等待回檔', '突破觀察', '暫不追價', '條件失效'];
    el.textContent = `推薦 ${list.length} 檔：` + order.filter(s => counts[s]).map(s => `${s} ${counts[s]}`).join('、');
    el.classList.remove('warn-line');
  }
}
// 主名單第一層的營收數據（純文字、非標籤造型）：有營收資料的股票都在名稱欄下方
// 以小字顯示「M月營收 ±XX.X%」，不分是否達標事件，與其他數據欄同級。
// 營收檢視（推薦／觀察）用狀態欄的事件標籤呈現同一資訊，故營收檢視不重複顯示此行。
function revTextHtml(a) {
  if (!a || a.isDemo) return '';
  if (revView()) return '';
  const info = revInfo(a.code);
  if (!info) return '';
  return `<div class="rev-sub">${parseInt(info.m.slice(5), 10)}月營收 ${fmtYoyCap(info.yoy)}</div>`;
}
function loadRevenue() {
  return fetchDataGzip('revenue.json.gz').then(d => {
    state.revenue = (d && d.stocks && typeof d.stocks === 'object') ? d : null;
    syncRevOption();
    if (state.revenue) {
      log(`營收資料載入：${Object.keys(state.revenue.stocks).length} 檔有月營收年增率（最新營收月 ${state.revenue.latestRevMonth || '—'}）`);
      refreshSumLine();
      buildRevList();
      if (state.scanDone) renderList();
      else if (state.selected) renderStrategyCard(state.selected);
    }
    return state.revenue;
  }).catch(() => { state.revenue = null; syncRevOption(); return null; });
}
// ---------- 營收事件歷史（revstate 原始月營收序列） ----------
// revstate.json.gz 是後端狀態檔（同域 Pages 有發佈）：每檔近 26 個月的 (月份, 營收) 序列。
// 與 revenue.json.gz 一樣是可選資料：平行加載、抓不到就靜默無歷史功能。
// 涵蓋率仍在逐日累積（每日 +300 檔），用到它的功能都要能處理「這檔還沒有營收歷史」。
// 事件定義與後端 compute_revenue_payload／研究端 E1 逐字一致：
//   monthIdx = 年*12+(月-1)；M 月營收自 M+1 月 15 日起可用；YoY = 當月/去年同月 - 1
//   （去年同月缺漏或 <= 0 則不可計算）；事件 = YoY > 20%；事件日 = 該股 bars 中
//   第一個 >= 可用日的交易日；事件後 20 日報酬以事件日收盤買進、20 個交易日後收盤計，扣 0.5% 成本。
function loadRevstate() {
  return fetchDataGzip('revstate.json.gz').then(d => {
    if (!d || !d.stocks || typeof d.stocks !== 'object') { state.revstate = null; state.revSeries = null; return null; }
    const map = new Map();
    for (const [code, pairs] of Object.entries(d.stocks)) {
      if (!Array.isArray(pairs)) continue;
      const s = new Map();
      for (const p of pairs) if (Array.isArray(p) && p.length >= 2) s.set(+p[0], +p[1]);
      if (s.size) map.set(code, s);
    }
    state.revstate = d; state.revSeries = map;
    state._revStatsKey = null; // 涵蓋範圍變了，整體歷史統計要重算
    log(`營收歷史資料載入：${map.size} 檔有月營收序列（涵蓋率累積中）`);
    if (revView()) updateRevLine();
    // revstate 剛到：若營收模式的歷史績效已按鈕產出且人正停在分頁，重算刷新（涵蓋已變）；未產出前不自動呈現
    if (revActive() && state.revHistShown && $('tabHistory').classList.contains('active')) renderRevStats($('historyResult'));
    if ($('tabHistory').classList.contains('active')) maybeRenderRevHist();
    return d;
  }).catch(() => { state.revstate = null; state.revSeries = null; return null; });
}
const revMonthLabel = idx => `${Math.floor(idx / 12)}-${String(idx % 12 + 1).padStart(2, '0')}`;
function revAvailDate(idx) { // M 月營收的可用日：次月 15 日（ISO 字串）
  const n = idx + 1;
  return `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}-15`;
}
function revYoyRatio(series, idx) {
  const v = series.get(idx), p = series.get(idx - 12);
  if (v == null || p == null || !(p > 0)) return null;
  return v / p - 1;
}
// 以營收序列＋某檔 bars 算出全部歷史事件（新到舊）：
// [{m, yoy(%), event(事件日), ret(事件後 20 日報酬 %，已扣 0.5% 成本；無 20 日後收盤時為 null)}]
function stockRevEvents(series, bars) {
  if (!series || !bars || !bars.dates || !bars.dates.length) return [];
  const dates = bars.dates, closes = bars.close, out = [];
  const idxs = [...series.keys()].sort((a, b) => b - a);
  for (const idx of idxs) {
    const yoy = revYoyRatio(series, idx);
    if (yoy == null || yoy <= 0.20) continue;
    const avail = revAvailDate(idx);
    let lo = 0, hi = dates.length; // 二元搜尋：第一個 >= avail 的交易日
    while (lo < hi) { const mid = (lo + hi) >> 1; if (dates[mid] < avail) lo = mid + 1; else hi = mid; }
    if (lo >= dates.length) continue;
    const ret = (lo + 20 < dates.length && closes[lo] > 0)
      ? (closes[lo + 20] / closes[lo] - 1) * 100 - 0.5 : null;
    out.push({ m: revMonthLabel(idx), yoy: yoy * 100, event: dates[lo], ret });
  }
  return out;
}
function revStatsOf(rets) { // 平均／中位數／勝率（報酬 > 0 算勝）；空集合回傳 null 欄位
  const xs = rets.filter(r => r != null);
  if (!xs.length) return { n: 0, avg: null, med: null, win: null };
  const sorted = xs.slice().sort((a, b) => a - b);
  const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return { n: xs.length, avg: xs.reduce((s, r) => s + r, 0) / xs.length, med, win: xs.filter(r => r > 0).length / xs.length * 100 };
}
// ---------- 營收事件整體歷史統計（歷史表現分頁的「營收事件歷史表現」） ----------
// 以 revstate＋掃描資料包 bars 即時計算近一年可計算的全部事件（事件日落在最近一年、
// 且有 20 日後收盤者），並同列同期間全市場隨機買進基準（掃描包內每股每日買進、
// 抱 20 日的報酬），口徑與研究端一致（報酬皆扣 0.5% 成本）。數字一律即時計算、不寫死。
function computeRevStats() {
  const stocks = state.realStocks;
  if (!state.revSeries || !stocks.length) return null;
  let latest = '';
  for (const s of stocks) { const d = s.bars.dates.at(-1); if (d && d > latest) latest = d; }
  if (!latest) return null;
  const endD = new Date(latest + 'T00:00:00Z'); endD.setUTCFullYear(endD.getUTCFullYear() - 1);
  const winStart = endD.toISOString().slice(0, 10);
  const byCode = new Map(stocks.map(s => [s.code, s]));
  const evRets = [];
  let covered = 0;
  for (const [code, series] of state.revSeries) {
    const stock = byCode.get(code);
    if (!stock) continue;
    covered++;
    for (const e of stockRevEvents(series, stock.bars)) {
      if (e.event >= winStart && e.ret != null) evRets.push(e.ret);
    }
  }
  const baseRets = [];
  for (const s of stocks) {
    const { dates, close } = s.bars;
    for (let i = 0; i + 20 < dates.length; i++) {
      if (dates[i] < winStart || !(close[i] > 0)) continue;
      baseRets.push((close[i + 20] / close[i] - 1) * 100 - 0.5);
    }
  }
  return { winStart, latest, covered, total: stocks.length, ev: revStatsOf(evRets), base: revStatsOf(baseRets) };
}
// 營收事件訊號的歷史績效：與其他模式一致，由歷史表現分頁的既有按鈕觸發後才計算，
// 產出寫入 #historyResult（與「策略回測總覽」同一張卡、同一套 bt-* 樣式）。
// 數字仍由 computeRevStats 即時計算、口徑不變；切換分頁不再自動渲染。
function renderRevStats(el) {
  if (!el) return;
  const head = '<div class="bt-title">營收事件歷史表現</div>';
  if (!state.revSeries) { el.innerHTML = head + '<div>營收歷史資料尚未載入，無法計算。</div>'; return; }
  const key = `${state.backendUpdatedAt || ''}|${state.realStocks.length}|${state.revSeries ? state.revSeries.size : 0}`;
  if (state._revStatsKey === key && state._revStatsHtml) { el.innerHTML = state._revStatsHtml; return; }
  const r = computeRevStats();
  if (!r) { el.innerHTML = head + '<div>營收歷史資料尚未載入，無法計算。</div>'; return; }
  const pct = (v, d = 2) => v == null ? '—' : fmtSign(v, d) + '%';
  const cmpCard = (name, s, cap) =>
    `<div class="bt-cmp-card"><div class="bt-cmp-name">${name}</div><div class="bt-cmp-num">${s.win == null ? '—' : fmt(s.win, 1) + '%'}</div><div class="bt-cmp-cap">${cap}</div></div>`;
  state._revStatsHtml = head +
    `<div class="bt-stats"><div class="bt-stat"><span class="bt-stat-label">統計期間</span><span class="bt-stat-num range">${r.winStart} ～ ${r.latest}</span></div>` +
    `<div class="bt-stat"><span class="bt-stat-label">涵蓋股票</span><span class="bt-stat-num">${r.covered}<span class="bt-unit">檔</span></span></div>` +
    `<div class="bt-stat"><span class="bt-stat-label">事件總數</span><span class="bt-stat-num">${r.ev.n}<span class="bt-unit">次</span></span></div></div>` +
    `<div class="bt-sec"><div class="bt-sec-title">事件後 20 日表現<span class="bt-sec-note">近一年站內資料計算・大字為勝率</span></div>` +
    (r.ev.n
      ? `<div class="bt-cmp">${cmpCard('營收事件', r.ev, `平均報酬 ${pct(r.ev.avg)}｜中位數 ${pct(r.ev.med)}`)}${cmpCard('隨機買進（同期間全市場）', r.base, `平均報酬 ${pct(r.base.avg)}｜中位數 ${pct(r.base.med)}｜共 ${r.base.n.toLocaleString()} 筆`)}</div>`
      : '<div>這段期間沒有可計算的事件（涵蓋股票的事件日都還沒有 20 日後收盤）。</div>') +
    `<div class="rs-note">涵蓋股票 ${r.covered} 檔（營收資料逐日補齊中，站內共 ${r.total} 檔）；隨機買進基準為全市場每股每日買進、抱 20 日。報酬皆已扣交易成本約 0.5%；這是簡單統計，不是照策略實際買賣的回測。</div></div>`;
  state._revStatsKey = key;
  el.innerHTML = state._revStatsHtml;
}
// 個股營收事件紀錄的呈現把關：預設模式照舊（選股／進分頁即呈現）；營收模式改為
// 按鈕驅動——未按鈕產出（revHistShown=false）前不呈現，與其他模式的待機流程一致。
function maybeRenderRevHist() {
  if (!state.selected) return;
  if (revActive() && !state.revHistShown) return;
  renderRevHist(state.selected);
}
function hideRevHist() {
  const el = $('revHistResult'); if (!el) return;
  el.classList.add('hidden'); el.innerHTML = '';
}
// 進入營收模式時，歷史表現分頁回到與其他模式相同的待機狀態
function resetRevHistView() {
  state.revHistShown = false;
  const hr = $('historyResult'); if (hr) hr.textContent = HIST_STANDBY;
  hideRevHist();
}
// ---------- 個股營收事件紀錄（歷史表現分頁） ----------
// 該股有 revstate 資料時才出現：用近 26 個月營收序列＋完整歷史 bars 列出過去事件
// （營收月、年增、事件日、事件後 20 日報酬）與摘要；無事件／未涵蓋各有一行事實說明。
async function renderRevHist(a) {
  const el = $('revHistResult'); if (!el) return;
  if (!a || a.isDemo || state.mode !== 'real' || !state.revSeries) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const series = state.revSeries.get(a.code);
  if (!series) {
    el.innerHTML = '<div class="bt-title">營收事件紀錄</div><div class="rh-note">這檔股票的月營收資料尚未補齊（營收資料逐日累積涵蓋中），暫時無法列出事件紀錄。</div>';
    return;
  }
  const stock0 = state.selectedStock && state.selectedStock.code === a.code ? state.selectedStock
    : (state.realStocks.find(s => s.code === a.code) || { code: a.code, isDemo: false });
  const full = await ensureFullHistory(stock0);
  if (state.selected !== a) return; // 計算期間已換股
  const events = stockRevEvents(series, full.bars);
  const st = revStatsOf(events.map(e => e.ret));
  let html = '<div class="bt-title">營收事件紀錄</div>';
  if (!events.length) {
    html += '<div>過去沒有營收事件紀錄（近 26 個月月營收年增未曾超過 20%，或事件日不在歷史行情範圍內）。</div>';
  } else {
    if (st.n) html += `<div class="bt-stats"><div class="bt-stat"><span class="bt-stat-label">事件次數</span><span class="bt-stat-num">${st.n}</span></div>` +
      `<div class="bt-stat"><span class="bt-stat-label">20 日平均報酬</span><span class="bt-stat-num rate">${fmtSign(st.avg)}<span class="bt-unit">%</span></span></div>` +
      `<div class="bt-stat"><span class="bt-stat-label">勝率</span><span class="bt-stat-num rate">${fmt(st.win, 1)}<span class="bt-unit">%</span></span></div></div>`;
    if (st.n < 10) html += '<div class="rh-note">事件次數少於 10 次，參考價值低。</div>';
    const lines = events.map(e =>
      `${e.m} 營收年增 ${fmtSign(e.yoy, 1)}%｜事件日 ${e.event}｜事件後 20 日報酬 ${e.ret == null ? '—（尚無 20 日後收盤）' : fmtSign(e.ret) + '%'}`).join('\n');
    html += `<details class="bt-detail"><summary>逐筆事件紀錄（報酬已扣 0.5% 成本）</summary><div class="bt-detail-text">${escapeHtml(lines)}</div></details>`;
  }
  el.innerHTML = html;
}
// 「營收事件」檢視：名單定義與後端／研究端 E1 完全一致——revenue 資料中 age <= 20 的
// 全部股票，不套用任何預設門檻、技術分或進場分。排序為事件新鮮度（age 小到大）、同 age 以 yoy 大到小。
// 每列的狀態/分數與主名單同口徑：已在掃描（推薦/觀察）或查詢結果中的股票直接複用該分析
// 物件（同股同值，可逐欄比對）；其餘股票以掃描引擎相同路徑即時計算
// （filterBars → trimBars(360) → analyze，週期參數同 scanOpts）。
function revEventEntries() {
  if (!state.revenue || !state.revenue.stocks) return [];
  return Object.entries(state.revenue.stocks)
    .filter(([, v]) => v && v.age != null && v.age <= 20)
    .map(([code, v]) => ({ code, m: v.m, yoy: v.yoy, event: v.event, age: v.age }));
}
// onProgress(done, total)：進入營收模式時傳入，讓建名單比照掃描有真實進度回饋；
// 背景呼叫（loadRevenue）不傳，行為與原本相同。每處理 8 檔讓出一次主執行緒讓進度條能重繪
// （比照 runScan 的分段讓出，不是假延遲）。
async function buildRevList(onProgress) {
  const entries = revEventEntries();
  state.revTotal = entries.length;
  const out = [];
  if (state.mode === 'real') {
    const scanned = new Map(); // code -> 已計算的分析（推薦→觀察→查詢，先到者優先）
    for (const a of [...state.results.candidates, ...state.results.watch, ...state.results.custom]) {
      if (a && a.code && !a.isDemo && !scanned.has(a.code)) scanned.set(a.code, a);
    }
    let done = 0;
    for (const e of entries) {
      const revNote = `營收事件：${parseInt(e.m.slice(5), 10)} 月營收年增 ${fmtYoyCap(e.yoy)}（事件日 ${e.event} 起第 ${e.age + 1} 個交易日）`;
      const hit = scanned.get(e.code);
      if (hit) { // 複用主名單的分析物件：淺拷貝後掛 _rev 並在原因欄附加事件說明，不污染原物件
        const a = { ...hit };
        a._rev = { m: e.m, yoy: e.yoy, event: e.event, age: e.age };
        a.reason = hit.reason ? `${hit.reason}；${revNote}` : revNote;
        out.push(a);
      } else {
        let stock = state.realStocks.find(s => s.code === e.code);
        if (!stock) stock = await ensureFullHistory({ code: e.code, isDemo: false });
        if (stock && stock.bars) {
          const filtered = (typeof TWCore.filterBars === 'function') ? { ...stock, bars: TWCore.filterBars(stock.bars) } : stock;
          if (filtered.bars.close.length >= 125) { // 卡片需足夠歷史計算（與掃描/查詢一致）；事件定義本身不受此限，未列入者在計數行註明
            const bars360 = (typeof TWCore.trimBars === 'function') ? TWCore.trimBars(filtered.bars, 360) : filtered.bars; // 與 TWCore.scan 相同的計算窗口
            let a = null;
            try { a = TWCore.analyze({ ...filtered, bars: bars360 }, $('selPeriod').value); } catch (err) { a = null; }
            if (a) {
              a._rev = { m: e.m, yoy: e.yoy, event: e.event, age: e.age };
              a.reason = revNote;
              out.push(a);
            }
          }
        }
      }
      done++;
      if (onProgress) {
        onProgress(done, entries.length);
        if (done % 8 === 0) await new Promise(r => setTimeout(r, 0)); // 讓進度條有機會重繪
      }
    }
    out.sort((x, y) => (x._rev.age - y._rev.age) || (y._rev.yoy - x._rev.yoy));
  }
  // 分層：age <= 分層日（設定值，預設 10）為營收推薦、其後至 20 日為營收觀察（E1 全集
  // 不變）；out 已全域排序，兩份子名單各自維持 age 小到大、同 age 以 yoy 大到小。
  const tier = revTierDays();
  state.results.rev = out.filter(a => a._rev && a._rev.age <= tier);
  state.results.revwatch = out.filter(a => a._rev && a._rev.age > tier);
  updateRevLine();
  if (revView()) renderList();
  return out;
}
// 營收檢視（推薦／觀察）的標頭：僅在營收檢視＋正式模式＋營收資料已載入時出現。
// 標頭固定一行該層的定義與排序說明（事實文案）；名單恆為該層完整集合（檢視內無篩選下拉），
// 計數只隨關鍵字搜尋變動（displayed 由 renderList 傳入實際顯示檔數）。
// chkNear 是主名單的顯示篩選，營收檢視不套用，故在檢視期間隱藏其標籤。
function updateRevLine(displayed) {
  const el = $('revLine'); if (!el) return;
  const view = revView();
  const isRev = !!view && !!state.revenue && state.mode === 'real';
  el.classList.toggle('hidden', !isRev);
  const nearLbl = $('chkNear') && $('chkNear').closest('label');
  if (nearLbl) nearLbl.classList.toggle('hidden', isRev);
  if (!isRev) return;
  const def = view === 'revwatch' ? revWatchDef() : revRecDef();
  if (state.revLoading) { el.textContent = def + `・排序：${revSortText()}｜名單載入中…`; return; }
  const total = state.revTotal != null ? state.revTotal : revEventEntries().length;
  const cardableAll = state.results.rev.length + state.results.revwatch.length;
  const cardable = state.results[view].length;
  const shown = displayed != null ? displayed : cardable;
  el.textContent = def + `・排序：${revSortText()}｜` +
    (shown < cardable ? `共 ${cardable} 檔，搜尋後顯示 ${shown} 檔` : `目前 ${cardable} 檔`) +
    (total > cardableAll ? `（另 ${total - cardableAll} 檔歷史不足 125 日，無法產生卡片）` : '');
}
// 名單下拉改為模式專屬（兩套系統不在同一下拉混列）：預設模式只有候選／觀察／查詢
// 三項，營收模式只有營收推薦／營收觀察兩項；營收檢視只能由「營收推薦」按鈕進入，
// 進入後在營收模式內以下拉切換推薦／觀察。選項集合的切換點：enterRevMode（進營收）、
// applyPreset／runScan（離營收）、syncRevOption（營收資料變得不可用時收斂回預設）。
const LIST_OPTIONS = {
  preset: [['candidates', '可進場候選'], ['watch', '技術強勢觀察'], ['custom', '個股查詢結果']],
  rev: [['rev', '營收推薦'], ['revwatch', '營收觀察']],
};
function setListOptions(mode, value) {
  const sel = $('selList'); if (!sel) return;
  const opts = LIST_OPTIONS[mode] || LIST_OPTIONS.preset;
  const keep = opts.some(([v]) => v === sel.value) ? sel.value : '';
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  sel.value = value && opts.some(([v]) => v === value) ? value : (keep || opts[0][0]);
}
function syncRevOption() {
  const sel = $('selList'); if (!sel) return;
  const show = !!state.revenue && state.mode === 'real';
  if (!show) {
    // 營收不可用（示範模式／未載入／載入失敗）：下拉收斂回預設三項；
    // 正停在營收檢視時一併切回候選名單，避免 selList 指向不存在的選項。
    if (revView()) { setListOptions('preset', 'candidates'); state.revHistShown = false; }
    else setListOptions('preset'); // 已是預設檢視：重建同組選項並保留目前值
    updateRevLine();
  }
  // 營收可用時不在此更動選項集合：目前是哪個模式就維持該模式的選項，
  // 避免在預設模式把營收選項塞回下拉（模式轉換點才負責切換集合）。
  syncRevButton();
}
// 「營收推薦」按鈕：與四顆風格預設完全同級的按鈕元件（同 .btn.preset 樣式、同尺寸、
// 同 active 呈現），排進同一組按鈕列做第五顆；僅營收資料已載入且正式模式時出現。
// 點按直接切到營收推薦檢視——名單就是 E1 集合本體依新鮮度分層（age <= 分層日，
// 設定值預設 10），不套用任何風格預設門檻（忠實度紅線）；「不套用風格門檻」的
// 說明放在檢視標頭行。營收觀察（分層日後至 20 日）在營收模式內由名單下拉切換
// （下拉此時只有營收推薦／營收觀察兩項），與推薦共用同一顆按鈕的 active 狀態。
// 點按即進入營收模式：五顆按鈕互斥、說明與摘要同步切換（見 syncModeUI）。
function ensureRevButton() {
  let btn = $('btnRevPreset');
  if (btn) return btn;
  const row = $('presetRow');
  if (!row) return null;
  btn = document.createElement('button');
  btn.id = 'btnRevPreset'; btn.type = 'button';
  btn.dataset.preset = 'rev';
  btn.className = 'btn small preset hidden';
  btn.innerHTML = '<span class="p-name">營收推薦</span><span class="p-sub">套用並重掃</span>';
  btn.addEventListener('click', async () => {
    if (!state.revenue || state.mode !== 'real') return;
    if (state.busy) return noteBusy(); // 與掃描鈕一致：已有背景工作時不疊加
    await enterRevMode('rev');
    const tb = document.querySelector('.toolbar');
    if (tb) { // 把結果區帶到眼前（扣掉置頂操作列高度）
      const barEl = document.querySelector('.action-bar');
      const y = tb.getBoundingClientRect().top + window.scrollY - ((barEl ? barEl.offsetHeight : 0) + 10);
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  });
  row.appendChild(btn);
  return btn;
}
// 進入營收模式（營收鈕與 selList 切到營收檢視共用同一條路徑；target 為目標檢視，
// 營收鈕固定進 'rev' 營收推薦，selList 則進使用者選的推薦／觀察檢視）：
// 同步段（任何 await 之前）就把模式 UI 原子切換——檢視切換、按鈕互斥收斂、
// 說明改營收定義、摘要改「載入中」、已建立的名單先即時呈現（不殘留預設名單）；
// 之後才以掃描式進度回饋重建名單，完成後摘要定版。任何時間點畫面不得雙亮。
async function enterRevMode(target) {
  $('inpFilter').value = ''; // 進入營收模式時清空名單關鍵字（同 applyPreset，避免殘留關鍵字造成空名單）
  setListOptions('rev', target === 'revwatch' ? 'revwatch' : 'rev'); // 下拉同步換成營收模式專屬選項（只有推薦／觀察兩項）
  resetRevHistView(); // 歷史表現分頁回到待機（按鈕驅動，與其他模式一致）
  state.revLoading = true;
  syncModeUI(); // 互斥收斂：預設鈕全取消 active、營收鈕 active、說明改營收定義、摘要改載入中
  renderList(); // 先呈現先前已建立的事件名單（背景通常已建好），不等建名單完成
  const wasBusy = state.busy;
  if (!wasBusy) setBusy(true);
  try { await runRevBuild(); }
  finally { if (!wasBusy) setBusy(false); }
}
// 以進度回饋重建營收名單（推薦＋觀察兩份一起建，比照 runScan 的 setProgress 步驟，
// 皆為真實工作進度）：載入營收資料 → 逐檔整理名單 → 完成訊息；結束後摘要與標頭定版。
// 完成列與摘要列同口徑：營收脈絡雙計數，不得殘留預設掃描的推薦／觀察數字。
async function runRevBuild() {
  state.revLoading = true;
  syncModeUI();
  setProgress(5, '載入營收資料…');
  try {
    await buildRevList((d, t) => setProgress(5 + Math.round(d / Math.max(1, t) * 90), `整理營收推薦名單 ${d}/${t}…`));
    const d = state.backendLatest || (state.revenue && state.revenue.latestDate) || '—';
    setProgress(100, `掃描完成：營收推薦 ${state.results.rev.length} 檔、觀察 ${state.results.revwatch.length} 檔（最新日期 ${d}）`);
    log(`營收推薦名單已更新：推薦 ${state.results.rev.length} 檔、觀察 ${state.results.revwatch.length} 檔`);
  } finally {
    state.revLoading = false;
    renderList();
    syncModeUI(); // 摘要定版「營收推薦 X 檔、觀察 Y 檔｜最新行情 DATE」、營收鈕回「✓ 使用中」
  }
}
function syncRevButton() {
  const btn = ensureRevButton(); if (!btn) return;
  const show = !!state.revenue && state.mode === 'real';
  btn.classList.toggle('hidden', !show);
  const row = $('presetRow'); if (row) row.classList.toggle('has-rev', show);
  const active = show && !!revView(); // 推薦／觀察任一檢視下按鈕都亮（同一模式）
  btn.classList.toggle('active', active);
  // 分層日自訂（≠ 預設 10）時，比照預設群組「自訂」的標示慣例，在使用中副標註明分層自訂
  const sub = active ? (state.revLoading ? '載入中…' : (revTierDays() !== 10 ? '✓ 使用中（分層自訂）' : '✓ 使用中')) : '套用並重掃';
  btn.innerHTML = `<span class="p-name">營收推薦</span><span class="p-sub">${sub}</span>`;
  updateCompactInfo(); // 精簡列跟著模式走（營收模式顯示推薦／觀察雙計數）
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
    loadRevenue(); // 平行加載營收資料（不 await：它是可選資料，成敗不影響主載入）
    loadRevstate(); // 平行加載營收歷史序列（同上，可選資料）
    const man = await fetchDataJson('manifest.json');
    if (!man || !man.scanFile) throw new Error('manifest 格式不正確');
    const totalMB = (man.scanBytes / 1048576).toFixed(1);
    setProgress(15, `下載後端掃描包（${man.scanStocks} 檔，${totalMB} MB）…`);
    const bundle = await fetchDataGzip(man.scanFile, (loaded, total) => {
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
    const data = await fetchDataGzip(`history/${stock.code}.json.gz`);
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
    const man = await fetchDataJson('manifest.json');
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
    state.sumBase = `已掃描 ${res.stats.scanned} 檔｜推薦 ${state.results.candidates.length} 檔｜觀察 ${res.watch.length} 檔` +
      (exclParts.length ? `（未納入：${exclParts.join('、')}）` : '');
    refreshSumLine();
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
    setListOptions('preset', 'candidates'); // 下拉收斂回預設模式選項（涵蓋由營收模式經更新資料等路徑觸發掃描的情況）
    state.revHistShown = false; // 預設掃描即離開營收模式
    syncModeUI(); // 按鈕群組／說明／摘要回到預設脈絡（避免殘留營收模式的 active 與文案）
    renderList();
  } catch (e) { log('掃描失敗：' + e.message); setProgress(0, '掃描失敗'); }
  finally { setBusy(false); }
}
// 主掃描鈕依目前模式行為：預設模式跑全市場掃描；營收模式以進度回饋重建營收事件名單
// （不跑預設掃描、不把畫面帶回預設脈絡，維持模式自洽）。
async function onScanButton() {
  if (!revActive()) { runScan(); return; }
  if (state.busy) return noteBusy();
  setBusy(true);
  try { await runRevBuild(); }
  finally { setBusy(false); }
}
function noteBusy() { alert('已有背景工作執行中，請先等待或按「停止」。'); }

// ---------- 名單呈現 (#148-161) ----------
const fmt = (x, d = 2) => x == null || isNaN(x) ? '—' : Number(x).toFixed(d);
const fmtSign = (x, d = 2) => x == null || isNaN(x) ? '—' : (x > 0 ? '+' : '') + Number(x).toFixed(d);
// 價位相對收盤的距離%（停損／目標旁標示用）：回傳「（±X.X%）」，資料不足回空字串
const distTxt = (price, base) => (price == null || !base) ? '' : `（${fmtSign((price / base - 1) * 100, 1)}%）`;
// 極端年增封頂顯示：|YoY| > 999% 時顯示 ±999%↑↓（基期過小灌出的數字避免誤導）；
// 只套用在名單層級的顯示，個股明細與事件紀錄保留真實值。
function fmtYoyCap(yoy) {
  if (yoy == null || isNaN(yoy)) return '—';
  if (yoy > 999) return '+999%↑';
  if (yoy < -999) return '-999%↓';
  return fmtSign(yoy, 1) + '%';
}
// 名單／結論卡的一句依據（依狀態決定性產生，一行、規則一致）：
// 先講狀態對使用者的意思，再帶技術面強弱與命中數，不用術語堆疊。
function basisText(a) {
  const s = a.strat, hits = a.hit ? a.hit.length : 0;
  const strength = a.techScore >= 65 ? '技術面強勢' : a.techScore >= 50 ? '技術面中上' : '技術面偏弱';
  switch (a.status) {
    case '接近進場':
      return a.techScore < 50
        ? `價已回到進場區，技術面偏弱（${a.techScore}/100）`
        : `價已回到進場區，${strength}（命中 ${hits}/13 項訊號）`;
    case '等待回檔':
      return `${strength}（命中 ${hits}/13 項訊號），等回檔到進場區再考慮`;
    case '突破觀察':
      return `剛突破進場區，${strength}（命中 ${hits}/13 項訊號），留意追高風險`;
    case '暫不追價':
      return `現價離進場區太遠（距離 ${fmt(s.distPct, 1)}%），暫不追價`;
    case '條件失效':
      return '股價已跌出進場區，條件失效，先觀望';
    default:
      return `命中 ${hits}/13 項訊號`;
  }
}
// 結論卡的一句話結論：與 basisText 同邏輯、稍完整（帶現價與下一步）
function conclusionText(a) {
  const s = a.strat, hits = a.hit ? a.hit.length : 0;
  const strength = a.techScore >= 65 ? '技術面強勢' : a.techScore >= 50 ? '技術面中上' : '技術面偏弱';
  switch (a.status) {
    case '接近進場':
      return a.techScore < 50
        ? `價格已回到進場區，但技術面偏弱（技術分 ${a.techScore}/100，命中 ${hits}/13 項訊號），留意假突破。`
        : `價格已回到進場區，${strength}（命中 ${hits}/13 項訊號），可依下方進場區間與停損規劃。`;
    case '等待回檔':
      return `${strength}，命中 ${hits}/13 項訊號；但現價 ${fmt(a.close)} 還高於進場區，先等回檔，到了再考慮。`;
    case '突破觀察':
      return `剛突破進場區，${strength}（命中 ${hits}/13 項訊號）；追高風險較高，留意量能是否延續。`;
    case '暫不追價':
      return `現價已高於進場區 ${fmt(s.distPct, 1)}%，離進場位置太遠，暫不追價，等回檔再看。`;
    case '條件失效':
      return '股價已跌出進場區，進場條件失效，先觀望，等重新站回再評估。';
    default:
      return `命中 ${hits}/13 項訊號，${strength}。`;
  }
}
function currentList() {
  const kind = $('selList').value;
  let list = state.results[kind] || [];
  const q = $('inpFilter').value.trim();
  if (q) list = list.filter(a => a.code.includes(q) || a.name.includes(q));
  // 營收檢視（推薦／觀察）恆顯示該層完整名單本體（檢視內不設狀態／新鮮度篩選，僅關鍵字
  // 搜尋，與其他名單同層次）；chkNear 的「只看接近進場」只作用於主名單，不套用到營收檢視。
  if (kind !== 'rev' && kind !== 'revwatch' && $('chkNear').checked) {
    list = list.filter(a => a.status === '接近進場');
  }
  // 營收檢視的排序：先關鍵字篩選、後排序（可疊加）。fresh＝state 陣列本身的新鮮度
  // 順序（buildRevList 已排好），不重排以維持改版前完全相同的順序；其餘排序排副本，
  // 不動 state.results 本體，切回 fresh 即恢復原順序。
  if ((kind === 'rev' || kind === 'revwatch') && revSortKey() !== 'fresh') {
    list = [...list].sort(cmpRevSort);
  }
  return list;
}
const CARD_KEY = [1, 2, 5, 8, 9, 11, 14]; // 手機卡片第一層只顯示七項：代號、名稱、收盤、技術分、進場適合度、狀態、進場區間；停損／目標／風報／原因等其餘欄位收進「展開全部欄位」
// 狀態固定色票（全站一致）：接近進場＝藍綠、等待回檔＝黃、突破觀察＝紫、暫不追價＝灰、條件失效＝紅
const statusBadgeCls = s => s === '接近進場' ? 'b-ok' : s === '等待回檔' ? 'b-wait' : s === '突破觀察' ? 'b-info' : s === '條件失效' ? 'b-bad' : 'b-mut';
function renderList() {
  if (!revActive()) state.revHistShown = false; // 已離開營收模式 → 營收歷史產出狀態不殘留
  updateRevLine();
  syncRevButton();
  syncRevSortUI();
  const list = currentList();
  const body = $('resultBody');
  body.innerHTML = '';
  list.forEach((a, i) => {
    const tr = document.createElement('tr');
    if (state.selected && state.selected.code === a.code) tr.className = 'selected';
    const cells = [
      ['排行', i + 1], ['代號', a.code], ['名稱', `${a.name}${revTextHtml(a)}<div class="basis-sub">${escapeHtml(basisText(a))}</div>`], ['市場', a.market], ['最新日期', a.date],
      ['收盤', fmt(a.close)], ['當日漲跌', `<span class="${a.change >= 0 ? 'up' : 'down'}">${fmtSign(a.change)}</span>`],
      ['漲跌幅', `<span class="${a.changePct >= 0 ? 'up' : 'down'}">${fmtSign(a.changePct)}%</span>`],
      ['技術分', `${a.techScore}/100`],
      ['進場適合度', `${a.entryScore}/100`],
      ['距離進場%', fmtSign(a.strat.distPct) + '%'], ['狀態', `<span class="badge ${statusBadgeCls(a.status)}">${a.status}</span>${revBadgeHtml(a)}`], ['週期', a.period], ['策略', a.type],
      ['進場區間', `${fmt(a.strat.entryLow)}～${fmt(a.strat.entryHigh)}`], ['停損', `${fmt(a.strat.stop)}${distTxt(a.strat.stop, a.close)}`],
      ['目標1 / 目標2', `${fmt(a.strat.target1)}${distTxt(a.strat.target1, a.close)} / ${fmt(a.strat.target2)}${distTxt(a.strat.target2, a.close)}${a.vlag ? '<div class="vlag">波段大漲後回落，目標僅供參考</div>' : ''}`],
      ['風險報酬', '1 : ' + fmt(a.strat.rr)], ['推薦／觀察原因', a.reason],
    ];
    tr.innerHTML = cells.map(([label, v], ci) => `<td data-label="${label}" class="${ci === 18 ? 'reason ' : ''}${CARD_KEY.includes(ci) ? 'k' : 'x'}">${v}</td>`).join('');
    const bs = document.createElement('td'); // 手機卡第一層依據行（全寬、排在卡片最上方；桌面隱藏，桌面版依據在名稱欄下方）
    // 注意：只能 append 在列尾（第 20 個 cell）——插進中間會位移桌面表格 nth-child 欄位規則
    bs.className = 'basisrow';
    bs.textContent = basisText(a);
    tr.appendChild(bs);
    const lv = document.createElement('td'); // 手機卡第一層一小列：停損・目標一（桌面隱藏，表格已有專欄）
    lv.className = 'lvrow';
    lv.innerHTML = `<span class="stop-txt">停損 ${fmt(a.strat.stop)}${distTxt(a.strat.stop, a.close)}</span>・<span class="target-txt">目標一 ${fmt(a.strat.target1)}${distTxt(a.strat.target1, a.close)}</span>`;
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
    if (revView()) {
      // 營收檢視的空狀態要講清楚「這一層沒有、另一層有幾檔」，不得看起來像壞掉或掃描失敗
      if (state.revLoading) empty.textContent = '營收推薦名單載入中…';
      else if (!state.revenue) empty.textContent = '營收資料尚未載入。';
      else if ($('inpFilter').value.trim()) empty.textContent = '沒有符合搜尋的股票，請清除搜尋再試。';
      else if (revView() === 'rev') {
        const w = state.results.revwatch.length;
        const tier = revTierDays();
        empty.textContent = w > 0
          ? `目前沒有 ${tier} 個交易日內的營收事件；${tier + 1}–20 日的事件在營收觀察（${w} 檔），用上方名單下拉切換即可看。`
          : '目前沒有股票在營收事件窗內（月營收年增 > 20%，公布後 20 個交易日）。';
      } else {
        const r = state.results.rev.length;
        const tier = revTierDays();
        empty.textContent = r > 0
          ? `目前沒有 ${tier + 1}–20 個交易日的營收事件；${tier} 個交易日內的事件在營收推薦（${r} 檔），用上方名單下拉切換即可看。`
          : '目前沒有股票在營收事件窗內（月營收年增 > 20%，公布後 20 個交易日）。';
      }
    } else if ((state.results[$('selList').value] || []).length > 0) {
      // 原名單有股票、是關鍵字搜尋或「只看接近進場」篩選濾到空：講清楚是篩選結果，
      // 不要丟「門檻過高、去改設定」那套（那會讓使用者誤以為自己設定錯或資料壞掉）
      const q = $('inpFilter').value.trim();
      empty.textContent = q
        ? `這份名單裡沒有符合「${q}」的股票，可改用下方「個股查詢」直接分析這檔股票。`
        : '這份名單裡目前沒有「接近進場」的股票（已開啟只看接近進場），取消勾選即可看全部。';
    } else if (st && st.scanned === 0 && st.qualityBad > 0 && st.qualityBad >= st.typeExcluded && st.qualityBad >= st.historyShort) {
      empty.textContent = '多數股票的資料日期不一致，今天的更新未完成，請稍後再試或等待今晚自動更新修復。';
    } else if (st && st.scanned === 0 && st.typeExcluded > 0) {
      empty.textContent = `目前這批資料的 ${st.typeExcluded} 檔全是代號 00 開頭的 ETF／ETN，而你沒有勾選「納入 ETF 推薦」，所以實際掃描 0 檔、名單為空。勾選「納入 ETF」後重新掃描就會有結果；一般股票（代號 1101 起）會隨後端回補進度陸續加入（回補依代號順序進行中）。`;
    } else {
      empty.textContent = '目前名單是空的。可能原因：門檻過高、資料不足或最新日期不一致。可到「選股設定」改點「積極進場」或「全部探索」、放寬成交額、勾選納入 ETF，或先補齊歷史資料。系統不會為了湊數放寬標準。';
      if (state.presetLabel !== '穩健推薦') { // 門檻空時給一顆直接行動鈕，少繞一圈去設定區找預設
        const swBtn = document.createElement('button');
        swBtn.type = 'button'; swBtn.className = 'btn small'; swBtn.style.marginLeft = '8px';
        swBtn.textContent = '改用穩健推薦';
        swBtn.addEventListener('click', () => applyPreset('steady'));
        empty.appendChild(swBtn);
      }
    }
  } else empty.classList.add('hidden');
  if (revView()) updateRevLine(list.length); // 營收檢視標頭計數跟著關鍵字搜尋後檔數走
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
if ($('tabStrategy').classList.contains('active')) maybeCardHistory(a); // 背景補算歷史統計，算完自動補進策略卡
renderTech(a);
if (state.aiByCode[a.code]) renderAI(a.code); else $('aiResult').textContent = '尚未進行 AI 分析。AI 只解讀既有數據，不得捏造價格或改寫交易價位。';
if (revActive()) {
  // 營收模式：歷史分頁只呈現營收事件訊號的績效（不混入預設條件的個股回測）；
  // 未按鈕產出前維持與其他模式相同的待機提示，產出後換股跟著更新整體績效與事件紀錄。
  if (state.revHistShown) {
    renderRevStats($('historyResult'));
    if ($('tabHistory').classList.contains('active')) renderRevHist(a);
  } else { $('historyResult').textContent = HIST_STANDBY; hideRevHist(); }
} else {
  if (a._history) renderHistory(a); else $('historyResult').textContent = HIST_STANDBY;
  if ($('tabHistory').classList.contains('active')) renderRevHist(a); // 停在歷史表現分頁時換股 → 營收事件紀錄跟著換
}
if ($('tabKline').classList.contains('active')) openKline(); // 停在 K 線回顧時換股 → 直接換成新股的圖
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
// ---------- 策略卡補充資訊：為何入選／為何未推薦／歷史統計 ----------
// 入選主因：命中訊號中加分最高的前 3 項（同分者依訊號定義順序）；候選＝目前推薦或觀察名單成員。
function topHitNames(a, n = 3) { return a.hit.slice().sort((x, y) => y.pts - x.pts).slice(0, n); }
function inCurrentLists(a) {
  return state.results.candidates.some(x => x.code === a.code) || state.results.watch.some(x => x.code === a.code);
}
// 未推薦主因：五個固定類別擇一，附實際數字對目前所選預設的門檻。
// 優先序（多因並存時）：資料不足 → 技術分不足 → 成交額不足 → 風報不足 → 距離過遠。
// 「距離過遠」含位置不合：狀態暫不追價／條件失效，或進場適合度未達門檻（其主要扣分來自距離）。
// 五類都不成立時回傳 null（例如通過條件但不在目前名單範圍，如推薦名額已滿）。
function whyOut(a) {
  const o = scanOpts(), s = a.strat;
  if (!s || !(s.stop > 0) || !(s.target1 > s.entryLow) || a.avgAmount20M == null)
    return { cat: '資料不足', detail: '策略價位或成交額資料不足，無法完成判斷' };
  if (a.techScore < o.minTech) return { cat: '技術分不足', detail: `技術分 ${a.techScore}，未達 ${o.minTech}` };
  if (a.avgAmount20M < o.minAvgAmountM) return { cat: '成交額不足', detail: `近 20 日均成交額 ${fmt(a.avgAmount20M, 1)} 百萬元，未達 ${o.minAvgAmountM} 百萬元` };
  if (s.rr < 1.5) return { cat: '風報不足', detail: `風險報酬 1：${fmt(s.rr)}，未達 1.5` };
  if (s.status === '暫不追價') return { cat: '距離過遠', detail: `收盤距進場區上緣 ${fmt(s.distPct, 1)}%，狀態「暫不追價」` };
  if (s.status === '條件失效') return { cat: '距離過遠', detail: '狀態「條件失效」，股價已跌出進場區' };
  if (a.entryScore < o.minEntry) return { cat: '距離過遠', detail: `進場適合度 ${a.entryScore}，未達 ${o.minEntry}（距進場區 ${fmt(s.distPct, 1)}%）` };
  return null;
}
function whyLineHtml(a) {
  if (inCurrentLists(a)) {
    const top = topHitNames(a);
    return `<div class="sc-why">為何入選：共命中 ${a.hit.length}／13 項訊號${top.length ? `，主要成立：${escapeHtml(top.map(h => `${h.name}（+${h.pts}）`).join('、'))}` : ''}</div>`;
  }
  const w = whyOut(a);
  return w ? `<div class="sc-why">為何未推薦：${w.cat}（${escapeHtml(w.detail)}）</div>` : '';
}
// 卡片歷史統計：與「歷史表現」分頁同一份 historyStats（同預設條件、同口徑），
// 目標一/二觸及比例為兩種進場方式（直接買＋等回檔）在最長持有天數下以筆數加權合併；
// 狀態為等待回檔者加列等回檔組的整體成交率與平均等待天數（此股過去訊號的整體統計，非單一訊號數字）。
function cardHistoryHtml(a) {
  const h = a._history;
  if (!h || !h.days || a._historySig !== histCtx(a).sig) return '';
  const hs = a._historyHorizons || [5, 10, 20];
  const hh = hs.includes(a._selHorizon) ? a._selHorizon : hs[hs.length - 1];
  let cnt = 0, t1 = 0, t2 = 0;
  for (const g of ['direct', 'wait']) { const s = h[g][hh]; if (s && s.count) { cnt += s.count; t1 += s.targetHit * s.count; t2 += (s.target2Hit || 0) * s.count; } }
  if (!cnt) return '';
  let line = `歷史統計（${(a._historyCond || {}).name || '目前'}條件・此股過去訊號的整體統計）：抱滿 ${hh} 天，目標一曾觸及 ${fmt(t1 / cnt, 1)}%、目標二曾觸及 ${fmt(t2 / cnt, 1)}%`;
  if (a.status === '等待回檔' && h.wait.signalDays) line += `\n等待回檔整體統計：歷史成交率 ${fmt(h.wait.fillRate, 1)}%、平均等 ${fmt(h.wait.avgWaitDays, 1)} 天成交`;
  if (h.days < 10) line += '\n（訊號出現次數少於 10 次，參考價值低）';
  return `<div class="sc-hist">${escapeHtml(line)}</div>`;
}
// 選到股票後在背景補算歷史統計（完整歷史＋calcHistory，與歷史表現/K線回顧共用快取），
// 算完若仍停在同一檔就重繪策略卡補上歷史統計行；失敗或換股就靜默放棄。
async function maybeCardHistory(a) {
  if (!a || a._histBusy) return;
  const ctx = histCtx(a);
  if (a._history && a._historySig === ctx.sig) return;
  const stock0 = state.selectedStock;
  if (!stock0 || stock0.code !== a.code) return;
  a._histBusy = true;
  try {
    const full = await ensureFullHistory(stock0);
    if (state.selected !== a) return;
    state.selectedStock = full;
    if (calcHistory(a, ctx) && state.selected === a) renderStrategyCard(a);
  } catch (e) { /* 背景補算失敗不影響主流程 */ }
  finally { a._histBusy = false; }
}
function renderStrategyCard(a) {
const s = a.strat, demo = a.isDemo? '虛構示範資料｜勿用於投資\n': '';
const ri = a.isDemo ? null : revInfo(a.code);
$('strategyCard').innerHTML =
`${demo ? `<div class="sc-demo">${demo.trim()}</div>` : ''}<div class="sc-title">${a.code} ${a.name}｜技術分 ${a.techScore} / 100<button type="button" class="info-btn" data-explain title="技術分／進場適合度計算說明">?</button>｜進場適合度 ${a.entryScore} / 100<button type="button" class="info-btn" data-explain title="技術分／進場適合度計算說明">?</button></div>
<div class="sc-meta">資料截至 ${a.date}｜盤後資料、非即時行情</div>
<div class="concl-card"><span class="badge ${statusBadgeCls(s.status)}">${s.status}</span><div class="concl-line">${escapeHtml(conclusionText(a))}</div><div class="concl-chips"><span class="chip">技術分 ${a.techScore}/100</span><span class="chip">進場適合度 ${a.entryScore}/100</span><span class="chip">資料 ${a.date}・盤後</span></div></div>
<div class="kv-grid">
<div><span>收盤（${a.date}）</span><b>${fmt(a.close)}（${fmtSign(a.changePct)}%）</b></div>
<div><span>進場狀態</span><b><span class="badge ${statusBadgeCls(s.status)}">${s.status}</span></b></div>
<div><span>進場區間</span><b class="entry-txt">${fmt(s.entryLow)} ～ ${fmt(s.entryHigh)}</b></div>
<div><span>停損價位</span><b class="stop-txt">${fmt(s.stop)}${distTxt(s.stop, a.close)}</b></div>
<div><span>目標一／目標二</span><b class="target-txt">${fmt(s.target1)}${distTxt(s.target1, a.close)} / ${fmt(s.target2)}${distTxt(s.target2, a.close)}</b></div>${a.vlag ? '\n<div class="vlag-note">波段大漲後回落，目標僅供參考</div>' : ''}${ri ? `\n<div><span>最新月營收（${ri.m}）</span><b>年增 ${fmtSign(ri.yoy, 1)}%</b></div>` : ''}
<div><span>距離進場區</span><b>${fmt(s.distPct)}%</b></div>
<div><span>風險報酬比</span><b>1 : ${fmt(s.rr)}</b></div>
<div><span>操作策略／持有期間</span><b>${s.period}／${s.holding}</b></div>
<div><span>進場策略類型</span><b>${s.type}</b></div>
</div>${whyLineHtml(a)}${cardHistoryHtml(a)}
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
// 預設只顯示摘要：命中 N／13 項＋主要成立訊號（命中且加分最高的前 5 項，同分依訊號定義順序）；
// 完整 13 項（成立與未成立）與拆解／均線指標各自收合，點開才看
const top = topHitNames(a, 5);
const allSignals = [...a.hit.map(h => `${h.name} +${h.pts}（成立）`), ...a.miss.map(h => `${h.name}（未成立，${h.pts} 分）`)].join('、');
$('techDetail').innerHTML =
`<div class="tech-legend">MA＝均線（平均成本）・RSI＝熱度（70 以上偏熱）・ATR＝波動大小・乖離＝離均線遠近</div>` +
`<div class="tech-head">技術分 ${a.techScore} / 100<button type="button" class="info-btn" data-explain title="技術分／進場適合度計算說明">?</button>｜進場適合度 ${a.entryScore} / 100<button type="button" class="info-btn" data-explain title="技術分／進場適合度計算說明">?</button></div>` +
`<div class="tech-sum">命中 ${a.hit.length}／13 項${top.length ? `｜主要成立：${escapeHtml(top.map(h => `${h.name} +${h.pts}`).join('、'))}` : '｜目前沒有成立的訊號'}</div>` +
sub('全部 13 項訊號', escapeHtml(allSignals || '無')) +
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
setProgress(30, `查詢「${q}」中…`); // 補抓完整歷史需要一點時間，先給即時回饋，不要讓畫面像沒反應
const full = await ensureFullHistory({ code: q.padStart(4, '0'), isDemo: false });
if (full && full.bars && full.bars.close.length) found = [full];
}
if (!found.length) {
// 查無此代號/名稱：在查詢區附近（進度列）＋紀錄都明講查無，且不更動目前顯示的個股明細，
// 避免使用者以為按鈕壞掉、或把畫面上別檔的明細誤認成查詢結果。
const isCode = /^\d{1,6}$/.test(q);
const msg = isCode ? `查無代號 ${q}，請確認代號是否正確` : `查無「${q}」，請確認代號或名稱是否正確`;
setProgress(0, msg);
log(`個股查詢：${msg}`);
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
if (!revView()) { $('selList').value = 'custom'; renderList(); } // 營收模式：下拉只有營收檢視（無 custom 選項），不硬塞；個股明細照常由 selectAnalysis 呈現，名單維持營收檢視
selectAnalysis(a, true);
switchTab('tabStrategy');
setProgress(100, `已載入 ${a.code} ${a.name}｜技術分 ${a.techScore}/100｜進場適合度 ${a.entryScore}/100 — 明細在下方`);
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
log('新聞：站內無法直接載入（新聞來源不允許跨網域讀取），已改提供外部新聞搜尋連結'); // 紀錄只寫白話，不露原始錯誤字串（如 Failed to fetch）
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
if (!$('inpApiKey').value.trim()) { // 未填金鑰：在 AI 區塊就地提示＋給跳轉按鈕，不進忙碌狀態、不假裝完成（只寫進度列/紀錄等於沒反應）
$('aiResult').innerHTML = '此功能需要 Gemini API Key 才能進行 AI 解讀。<br><button type="button" class="btn small" id="btnGoGeminiKey" style="margin-top:8px">前往設定 Key</button>';
const gk = $('btnGoGeminiKey');
if (gk) gk.addEventListener('click', gotoGeminiSettings);
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
// 「前往設定 Key」：展開 Gemini 設定區塊、捲到眼前並聚焦 Key 輸入框
function gotoGeminiSettings() {
const d = document.querySelector('.b-gem');
if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
const k = $('inpApiKey');
if (k) setTimeout(() => { try { k.focus({ preventScroll: true }); } catch (e) { k.focus(); } }, 400);
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

// ---------- 歷史表現 (#240-250) ----------
const HISTORY_HORIZONS = { '短線': [5, 10, 20], '中線': [10, 20, 40], '長線': [20, 60, 120] };
function currentCondName() {
const t = +$('inpMinTech').value || 0, e = +$('inpMinEntry').value || 0;
for (const k in PRESETS) if (PRESETS[k].tech === t && PRESETS[k].entry === e) return PRESETS[k].label;
return '自訂門檻';
}
// 回測假設／成本／成交規則的說明文字（「回測說明」摺疊與完整統計明細共用同一份，口徑一致）
function historyHeadFoot(a) {
const c = a._historyCond || { name: '穩健推薦', tech: 65, entry: 45, period: (a.strat && a.strat.period) || a.period || '短線' };
const head = `算法：翻這檔股票的完整歷史，每次達到『${c.name}』推薦條件（技術 ≥${c.tech}、進場 ≥${c.entry}、狀態可進場、風報比 ≥1.5）的那天，照當天狀態模擬進場（天數依這檔的週期 ${c.period}，報酬已先扣交易成本約 0.5%）：\n狀態是接近進場或突破觀察，當天收盤直接買；狀態是等待回檔，先不買，5 天內收盤回到建議進場區上緣才買，沒等到就不買。連續達標的日子合併算一波。`;
const foot = '「賺錢」指扣掉成本後報酬大於 0；「曾漲到目標價／曾跌到停損價」指持有期間盤中有碰到（等回檔組以實際買進日與當天價位起算）。這是簡單統計，不是照策略實際買賣的回測；出現次數少於 10 次時，參考價值低。';
return { head, foot };
}
function renderHistoryText(a) {
const h = a._history;
const hs = a._historyHorizons || [5, 10, 20];
const { head, foot } = historyHeadFoot(a);
if (!h.days) return head + '\n過去沒有達到過這套條件的紀錄（條件太嚴或歷史不足），可換較寬的風格再看。\n' + foot;
const rows = g => hs.filter(k => h[g][k] && h[g][k].count > 0).map(k => `抱 ${k} 天｜賺錢 ${fmt(h[g][k].upRatio, 1)}%｜平均 ${fmtSign(h[g][k].avgRet)}%｜中位數 ${fmtSign(h[g][k].medRet)}%｜曾漲到目標價 ${fmt(h[g][k].targetHit, 1)}%｜曾跌到停損價 ${fmt(h[g][k].stopHit, 1)}%`);
let s = head + `\n出現 ${h.waves} 波・共 ${h.days} 個進場日`;
if (h.direct.days) { s += `\n直接買（狀態：接近進場・突破觀察）｜共 ${h.direct.days} 個進場日`; const r = rows('direct'); if (r.length) s += '\n' + r.join('\n'); }
if (h.wait.signalDays) { s += `\n等回檔才買（狀態：等待回檔）｜共 ${h.wait.signalDays} 個訊號日，等到 ${h.wait.filled} 個，成交率 ${fmt(h.wait.fillRate, 1)}%`; const r = rows('wait'); if (r.length) s += '\n' + r.join('\n'); }
return s + '\n' + foot;
}
// 卡片式總覽：數字全取自同一份 historyStats 輸出；完整文字明細收進摺疊區（renderHistoryText 原樣）
// selH（a._selHorizon）為比較卡與 K 線標記上色共用的持有天數；a._btMetric 為比較表的
// 報酬指標（avg 平均／med 中位數）。兩者都存在該檔分析物件上，換股或換預設重算時重設。
function renderHistory(a) {
const el = $('historyResult');
const h = a._history;
if (!h.days) { el.textContent = '過去沒有達到過這套條件的紀錄（條件太嚴或歷史不足），可換較寬的風格再看。'; return; }
const hs = a._historyHorizons || [5, 10, 20];
const lastH = hs[hs.length - 1];
const selH = hs.includes(a._selHorizon) ? a._selHorizon : lastH;
const metric = a._btMetric === 'med' ? 'med' : 'avg';
// 成交率＝實際有買到的筆數（直接買日數＋等回檔成交數）／全部訊號日；無等回檔組時恆為 100%
const fillRate = (h.direct.days + h.wait.filled) / h.days * 100;
const bigPct = g => (h[g][selH] && h[g][selH].count > 0) ? fmt(h[g][selH].upRatio, 1) + '%' : '—';
let cmp = '';
const cmpCap = g => { // 比較卡的說明帶實際筆數；少於 10 筆直接在卡上提醒，不藏進回測說明摺疊
  const s = h[g][selH]; const cnt = s && s.count ? s.count : 0;
  return `${selH} 日正報酬比例${cnt ? `・共 ${cnt} 筆` : ''}${cnt && cnt < 10 ? '（少於 10 筆，參考價值低）' : ''}`;
};
if (h.direct.days) cmp += `<div class="bt-cmp-card"><div class="bt-cmp-name">直接買進</div><div class="bt-cmp-num">${bigPct('direct')}</div><div class="bt-cmp-cap">${cmpCap('direct')}</div></div>`;
if (h.wait.signalDays) cmp += h.wait.filled
? `<div class="bt-cmp-card"><div class="bt-cmp-name">等待回檔</div><div class="bt-cmp-num">${bigPct('wait')}</div><div class="bt-cmp-cap">${cmpCap('wait')}</div></div>`
: `<div class="bt-cmp-card"><div class="bt-cmp-name">等待回檔</div><div class="bt-cmp-num">—</div><div class="bt-cmp-cap">無成交</div></div>`;
const cmpCls = (h.direct.days ? 1 : 0) + (h.wait.signalDays ? 1 : 0) === 1 ? 'bt-cmp one' : 'bt-cmp';
const chips = hs.map(k => `<button type="button" class="bt-chip${k === selH ? ' active' : ''}" data-h="${k}">${k} 天</button>`).join('');
const cell = (g, k) => { const s = h[g][k]; if (!s || !s.count) return '<td>—</td>'; const v = metric === 'med' ? s.medRet : s.avgRet; const cls = v > 0 ? 'bt-pos' : v < 0 ? 'bt-neg' : ''; return `<td class="${cls}">${fmtSign(v)}%</td>`; };
const rowsHtml = hs.map(k => `<tr><td class="bt-l">${k} 天</td>${cell('direct', k)}${cell('wait', k)}</tr>`).join('');
el.innerHTML =
`<div class="bt-title">策略回測總覽</div>`
+ (h.waves < 10 ? `<div class="bt-small-note">訊號波次僅 ${h.waves} 波，少於 10 次，參考價值低——下面的百分比請保守看待。</div>` : '')
+ `<div class="bt-stats"><div class="bt-stat"><span class="bt-stat-label">訊號波次</span><span class="bt-stat-num">${h.waves}</span></div>`
+ `<div class="bt-stat"><span class="bt-stat-label">進場日</span><span class="bt-stat-num">${h.days}</span></div>`
+ `<div class="bt-stat"><span class="bt-stat-label">成交率</span><span class="bt-stat-num rate">${fmt(fillRate, 1)}<span class="bt-unit">%</span></span></div></div>`
+ `<div class="bt-sec"><div class="bt-sec-title">不同進場方式比較</div><div class="bt-chips">${chips}</div><div class="${cmpCls}">${cmp}</div></div>`
+ `<div class="bt-sec"><div class="bt-sec-title">持有期間比較<span class="bt-sec-note bt-toggle" id="btMetricToggle" title="點一下切換平均／中位數">${metric === 'med' ? '中位數' : '平均'}報酬率 ⇄</span></div>`
+ `<table class="bt-table"><thead><tr><th class="bt-l">持有</th><th>直接買進</th><th>等待回檔</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
+ `<details class="bt-detail"><summary>回測說明</summary><div class="bt-detail-text bt-explain-text"></div></details>`
+ `<details class="bt-detail"><summary>完整統計明細</summary><div class="bt-detail-text"></div></details>`;
{ const hf = historyHeadFoot(a); el.querySelector('.bt-explain-text').textContent = hf.head + '\n' + hf.foot; }
el.querySelector('.bt-detail-text:not(.bt-explain-text)').textContent = renderHistoryText(a);
el.querySelectorAll('.bt-chip').forEach(btn => btn.addEventListener('click', () => {
  a._selHorizon = +btn.dataset.h;
  renderHistory(a);
  if (klState.a === a) drawKline(); // K 線標記上色跟著 selH 走
}));
const tg = el.querySelector('#btMetricToggle');
if (tg) tg.addEventListener('click', () => { a._btMetric = metric === 'med' ? 'avg' : 'med'; renderHistory(a); });
}
// 本次歷史統計的條件上下文（預設門檻＋週期＋天數組＋簽名）；runHistory 與 K 線回顧共用
function histCtx(a) {
const o = scanOpts();
const condName = currentCondName();
const period = (a.strat && a.strat.period) || a.period || '短線';
const horizons = HISTORY_HORIZONS[period] || [5, 10, 20];
// 記下本次計算用的條件；門檻或週期變了就重算，避免拿舊條件的結果誤讀
const sig = [condName, o.minTech, o.minEntry, o.minAvgAmountM, period, o.periodMode].join('|');
return { o, condName, period, horizons, sig };
}
// 以 ctx 條件計算 a 的歷史統計（呼叫端先 ensureFullHistory）；成功回 true
function calcHistory(a, ctx) {
try {
a._history = TWCore.historyStats(state.selectedStock, { minTech: ctx.o.minTech, minEntry: ctx.o.minEntry, minAvgAmountM: ctx.o.minAvgAmountM, horizons: ctx.horizons, periodMode: ctx.o.periodMode });
a._historyCond = { name: ctx.condName, tech: ctx.o.minTech, entry: ctx.o.minEntry, period: ctx.period };
a._historyHorizons = ctx.horizons; a._historySig = ctx.sig;
a._selHorizon = ctx.horizons[ctx.horizons.length - 1]; // 換預設重算 → 比較天數重設為最長
return true;
} catch (e) { log('歷史統計失敗：' + e.message); return false; }
}
// 營收模式的歷史按鈕：產出營收事件訊號的整體歷史績效（即時計算、口徑不變），
// 下方接著呈現目前選取股的營收事件紀錄；不混入預設條件的個股回測。
async function runRevHistory() {
if (state.busy) return noteBusy();
setBusy(true);
$('historyResult').textContent = '計算中…';
setProgress(40, '計算營收事件歷史統計…');
await new Promise(r => setTimeout(r, 30));
try {
  renderRevStats($('historyResult'));
  state.revHistShown = true;
  if (state.selected) await renderRevHist(state.selected);
  setProgress(100, '歷史統計完成');
  log('營收事件歷史統計完成（近一年站內資料，事件後 20 日報酬，皆扣 0.5% 成本）');
} finally { setBusy(false); }
}
async function runHistory() {
if (revActive()) return runRevHistory(); // 營收模式改走營收事件訊號的歷史績效
if (!state.selected ||!state.selectedStock) { alert('請先選取股票'); return;}
if (state.busy) return noteBusy();
const a = state.selected;
const ctx = histCtx(a);
if (a._history && a._historySig === ctx.sig) { renderHistory(a); return;}
setBusy(true); setProgress(15, '載入完整 10 年歷史…');
$('historyResult').textContent = '計算中…（會翻最長 10 年歷史，稍等一下）';
state.selectedStock = await ensureFullHistory(state.selectedStock);
setProgress(40, '計算中…（會翻最長 10 年歷史，稍等一下）');
await new Promise(r => setTimeout(r, 30));
if (calcHistory(a, ctx)) { renderHistory(a); renderRevHist(a); setProgress(100, '歷史統計完成'); log(`歷史訊號統計完成 ${a.code}（${state.selectedStock.bars.close.length} 筆日線，條件：${ctx.condName} 技術≥${ctx.o.minTech} 進場≥${ctx.o.minEntry}，週期 ${ctx.period}）`);}
setBusy(false);
}

// ---------- K 線回顧（完整歷史 K 線＋每波進場標記） ----------
// 標記取自與回測總覽同一份 historyStats 的 entries（每波一筆代表紀錄）；上色天數與
// 回測總覽比較卡共用 a._selHorizon。只在分頁打開時計算與繪製。
const klState = { a: null, stock: null, unit: 'D', range: 12, start: 0, count: 0, total: 0, agg: null, byBar: new Map(), markers: [], slotW: 0, plotL: 0 };
let klRaf = 0;
function klSelH(a) { const hs = a._historyHorizons || [5, 10, 20]; return hs.includes(a._selHorizon) ? a._selHorizon : hs[hs.length - 1]; }
async function openKline() {
const info = $('klineInfo');
if (!state.selected || !state.selectedStock) { info.textContent = '請先選取股票。'; return; }
const a = state.selected;
const ctx = histCtx(a);
state.selectedStock = await ensureFullHistory(state.selectedStock);
if (!a._history || a._historySig !== ctx.sig) {
  info.textContent = '計算中…（會翻最長 10 年歷史，稍等一下）';
  await new Promise(r => setTimeout(r, 30));
  if (!calcHistory(a, ctx)) { info.textContent = '歷史統計計算失敗，請看更新紀錄。'; return; }
  log(`K 線回顧：已計算 ${a.code} 歷史訊號（條件：${ctx.condName}，週期 ${ctx.period}）`);
}
klState.a = a; klState.stock = state.selectedStock;
$('klineNote').style.display = a._history.days ? 'none' : 'block';
buildKlineAgg(); klSyncChips(); drawKline();
info.textContent = '點圖上的標記看那一波的進場明細；點其他位置看那根 K 線的開高低收。';
}
function buildKlineAgg() {
const b = klState.stock.bars, n = b.close.length;
let agg;
if (klState.unit === 'D') {
  const idx = b.close.map((_, i) => i);
  agg = { dates: b.dates, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, startDates: b.dates, endDates: b.dates, fromIdx: idx, toIdx: idx };
} else agg = TWCore.aggregateBars(b, klState.unit === 'W' ? 'week' : 'month');
klState.agg = agg; klState.total = agg.close.length;
// 日線索引 → 合成根索引（entries 的代表進場日對位）
const map = new Int32Array(n);
for (let g = 0; g < agg.close.length; g++) for (let i = agg.fromIdx[g]; i <= agg.toIdx[g]; i++) map[i] = g;
klState.byBar = new Map();
for (const e of (klState.a._history.entries || [])) {
  const g = map[e.idx]; if (g === undefined) continue;
  if (!klState.byBar.has(g)) klState.byBar.set(g, []);
  klState.byBar.get(g).push(e);
}
// 可視根數：範圍（月）換算截止日，視窗結尾對齊最後一根
let count = klState.total;
if (klState.range > 0 && klState.total) {
  const endD = new Date(agg.endDates[klState.total - 1] + 'T00:00:00Z');
  endD.setUTCMonth(endD.getUTCMonth() - klState.range);
  const cut = endD.toISOString().slice(0, 10);
  let lo = 0; while (lo < klState.total && agg.endDates[lo] < cut) lo++;
  count = klState.total - lo;
}
klState.count = count; klState.start = klState.total - count;
}
function drawKline() {
const cv = $('klineChart'); if (!cv || !klState.agg || !klState.total) return;
const agg = klState.agg, total = klState.total, count = Math.min(klState.count, total);
if (!count) return;
const start = Math.max(0, Math.min(klState.start, total - count));
klState.start = start;
const dpr = window.devicePixelRatio || 1;
const W = cv.clientWidth || 320, H = 330;
cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
ctx.fillStyle = '#10223b'; ctx.fillRect(0, 0, W, H);
const plotL = 4, plotR = W - 46, plotW = plotR - plotL;
const priceTop = 20, priceBot = H - 62, volTop = H - 52, volBot = H - 18;
let lo = Infinity, hi = -Infinity, vmax = 0;
for (let g = start; g < start + count; g++) { if (agg.low[g] < lo) lo = agg.low[g]; if (agg.high[g] > hi) hi = agg.high[g]; if (agg.volume[g] > vmax) vmax = agg.volume[g]; }
const pad = (hi - lo) * 0.07 || 1; lo -= pad; hi += pad;
const Y = v => priceTop + (priceBot - priceTop) * (1 - (v - lo) / (hi - lo));
const slotW = plotW / count; klState.slotW = slotW; klState.plotL = plotL;
const X = g => plotL + slotW * (g - start + 0.5);
ctx.font = '11px sans-serif';
for (let gi = 0; gi < 5; gi++) { const v = lo + (hi - lo) * gi / 4, y = Y(v); ctx.strokeStyle = '#24497c'; ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke(); ctx.fillStyle = '#9db8d8'; ctx.fillText(v.toFixed(1), plotR + 5, y + 4); }
ctx.fillStyle = '#9db8d8';
for (let gi = 0; gi < 4; gi++) { const g = start + Math.round((count - 1) * gi / 3); const label = klState.unit === 'M' ? agg.endDates[g].slice(0, 7) : agg.endDates[g].slice(5); ctx.fillText(label, Math.max(plotL, Math.min(X(g) - 14, W - 44)), H - 4); }
const bodyW = Math.max(1, Math.min(9, slotW * 0.62));
for (let g = start; g < start + count; g++) {
  const up = agg.close[g] >= agg.open[g];
  ctx.fillStyle = up ? 'rgba(45,212,191,0.55)' : 'rgba(255,138,128,0.55)';
  const vh = vmax ? agg.volume[g] / vmax * (volBot - volTop) : 0;
  ctx.fillRect(X(g) - bodyW / 2, volBot - vh, bodyW, vh);
}
for (let g = start; g < start + count; g++) {
  const up = agg.close[g] >= agg.open[g], col = up ? '#2dd4bf' : '#ff8a80', x = X(g);
  ctx.strokeStyle = col; ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(x, Y(agg.high[g])); ctx.lineTo(x, Y(agg.low[g])); ctx.stroke();
  const y1 = Y(Math.max(agg.open[g], agg.close[g])), y2 = Y(Math.min(agg.open[g], agg.close[g]));
  ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
}
// 標記：實心＝已成交（顏色依 selH 該筆報酬），空心灰＝整波未成交
klState.markers = [];
const selH = klSelH(klState.a);
const klLegendH = $('klineLegendH'); if (klLegendH) klLegendH.textContent = selH; // 圖例天數跟著比較天數走
for (let g = start; g < start + count; g++) {
  const list = klState.byBar.get(g); if (!list) continue;
  list.forEach((e, k) => {
    const x = X(g), y = Y(agg.high[g]) - 10 - k * 12;
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7);
    if (!e.filled) { ctx.fillStyle = '#10223b'; ctx.fill(); ctx.strokeStyle = '#9db8d8'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.lineWidth = 1; }
    else { const r = e.rets[selH]; ctx.fillStyle = r == null || r === 0 ? '#7d94b5' : r > 0 ? '#35c759' : '#ff5252'; ctx.fill(); }
    klState.markers.push({ x, y, e });
  });
}
}
function klineTap(x, y) {
const info = $('klineInfo'), a = klState.a; if (!a) return;
let best = null, bd = 24; // 標記命中範圍放大：點在標記約 24px 內就吸附最近標記（手指點小圓點本來就不準）
for (const m of klState.markers) { const d = Math.hypot(m.x - x, m.y - y); if (d < bd) { bd = d; best = m; } }
const selH = klSelH(a);
if (best) {
  const e = best.e;
  const split = `進場日 ${e.days} 天（直接買 ${e.direct}・等回檔成交 ${e.waitFilled}・未成交 ${e.unfilled}）`;
  if (e.filled) { const r = e.rets[selH]; info.textContent = `第 ${e.wave} 波｜${split}\n${e.date} ${e.group === 'direct' ? '直接買進' : '等待回檔成交'}｜買進 ${fmt(e.price)}｜抱 ${selH} 天 ${r == null ? '—（資料不足）' : fmtSign(r) + '%'}`; }
  else info.textContent = `第 ${e.wave} 波｜${split}\n${e.sigDate} 等待回檔訊號，5 天內沒回到進場區（未成交）`;
  return;
}
const agg = klState.agg;
let g = klState.start + Math.floor((x - klState.plotL) / klState.slotW);
g = Math.max(klState.start, Math.min(klState.start + klState.count - 1, g));
const when = klState.unit === 'D' ? agg.dates[g] : `${agg.startDates[g]} ～ ${agg.endDates[g]}`;
info.textContent = `${when}｜開 ${fmt(agg.open[g])} 高 ${fmt(agg.high[g])} 低 ${fmt(agg.low[g])} 收 ${fmt(agg.close[g])}`;
}
function klSyncChips() {
document.querySelectorAll('#klineRange button').forEach(b => b.classList.toggle('active', +b.dataset.range === klState.range));
document.querySelectorAll('#klineUnit button').forEach(b => b.classList.toggle('active', b.dataset.unit === klState.unit));
}

// ---------- Excel 匯出 (#251-262) ----------
function exportExcel() {
const date = (refreshStatus() || new Date().toISOString().slice(0, 10));
const fname = `twstock-${String(date).replace(/-/g, '')}.xlsx`; // 固定英文檔名＋日期：手機下載才認得出、開得了（舊版下載成無名檔案）
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
// 主要分頁三鈕（策略／歷史表現／K線回顧）＋「更多」收納其餘分頁；更多內的分頁被選中時
// 「更多」鈕本身呈現使用中狀態，讓使用者知道目前分頁在哪一組。
const MORE_TABS = ['tabTech', 'tabNews', 'tabAI', 'tabLog'];
function switchTab(id) {
document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === id));
document.querySelectorAll('button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
const mt = $('btnMoreTabs'); if (mt) mt.classList.toggle('active', MORE_TABS.includes(id));
if (id === 'tabStrategy' && state.selected) drawChart(state.selected);
if (id === 'tabKline') openKline();
if (id === 'tabHistory') maybeRenderRevHist(); // 個股事件紀錄：預設模式照舊自動呈現；營收模式僅在已按鈕產出後呈現（不自動渲染整體統計）
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
$('btnDemo').addEventListener('click', () => { state.mode = 'demo'; syncRevOption(); if (!state.demoStocks.length) state.demoStocks = TWDemo.generateDemoStocks(); refreshStatus(); log('已載入離線示範資料（虛構）'); runScan();});
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
$('btnScan').addEventListener('click', onScanButton);
$('btnScanCompact').addEventListener('click', onScanButton);
{ // 滑過標題區後，置頂操作列切精簡模式（只留模式＋推薦數＋重新掃描）
const barEl = document.querySelector('.action-bar'), topEl = document.querySelector('.topbar');
window.addEventListener('scroll', () => { barEl.classList.toggle('compact', window.scrollY > (topEl ? topEl.offsetHeight : 100) + 10); }, { passive: true });
}
$('btnStop').addEventListener('click', () => { state.stopFlag = true;});
$('btnStopCompact').addEventListener('click', () => { state.stopFlag = true;});
function openExplain() {
$('explainBody').innerHTML = '<table><tr><th>項目</th><th>加分</th><th>成立條件</th></tr>' +
[['MA多頭排列', 10, 'MA5＞MA20＞MA60'], ['均線黃金交叉', 8, 'MA5 上穿 MA20'], ['MACD翻多', 10, 'MACD 上穿訊號線'], ['RSI偏多', 8, 'RSI14 介於 50～75'], ['KD黃金交叉', 6, 'K 上穿 D'], ['布林偏多', 6, '收盤＞MA20 且 ≤ 布林上緣 102%'], ['成交量放大', 10, '量比 ≥ 1.5'], ['OBV偏多', 6, 'OBV 高於前20日最高'], ['ADX強勢', 6, 'ADX ≥ 25 且 +DI＞-DI'], ['突破前高', 10, '收盤突破前20日最高價'], ['Supertrend翻多', 8, 'Supertrend 多頭狀態'], ['一目均衡表偏多', 6, '收盤高於雲層且轉換線＞基準線'], ['MFI偏多', 6, 'MFI14 ≥ 50']]
.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('') + '</table>';
$('explainDialog').showModal();
}
$('btnExplain').addEventListener('click', openExplain);
document.addEventListener('click', e => { if (e.target && e.target.closest && e.target.closest('[data-explain]')) openExplain(); });
$('selList').addEventListener('change', async () => {
  if (revView()) await enterRevMode($('selList').value); // 與營收鈕同一條路徑：同步先原子切換 UI，再以進度回饋重建名單（推薦／觀察皆然）
  else { state.revHistShown = false; renderList(); syncModeUI(); } // 檢視切換即模式切換：按鈕 active／說明／摘要一併收斂
});
$('selRevSort').addEventListener('change', () => {
  try { localStorage.setItem('twstock_rev_sort', $('selRevSort').value); } catch (e) { /* 寫入失敗（如隱私模式）時僅本次瀏覽有效 */ }
  renderList(); // 即時重排目前名單，不需重掃；檢視標頭的排序說明由 updateRevLine 跟著目前選擇更新
});
$('inpFilter').addEventListener('input', renderList);
$('chkNear').addEventListener('change', renderList);
ensureRevButton(); syncRevButton();
// 表頭排序（數值欄位以數值排序 #151-152）
document.querySelectorAll('#resultTable thead th').forEach((th, ci) => th.addEventListener('click', () => sortByColumn(ci)));
$('btnQuery').addEventListener('click', queryStock);
$('inpQuery').addEventListener('keydown', e => { if (e.key === 'Enter') queryStock();});
$('btnNews').addEventListener('click', () => { if (state.selected) fetchNews(state.selected);});
$('btnTestGemini').addEventListener('click', testGemini);
$('btnAI').addEventListener('click', () => runAI(false));
$('btnAIBatch').addEventListener('click', () => runAI(true));
$('btnHistory').addEventListener('click', runHistory);
document.querySelectorAll('#klineRange button').forEach(b => b.addEventListener('click', () => { klState.range = +b.dataset.range; klSyncChips(); if (klState.a) { buildKlineAgg(); drawKline(); } }));
document.querySelectorAll('#klineUnit button').forEach(b => b.addEventListener('click', () => { klState.unit = b.dataset.unit; klSyncChips(); if (klState.a) { buildKlineAgg(); drawKline(); } }));
{ const cv = $('klineChart');
let drag = null;
cv.addEventListener('pointerdown', ev => { drag = { x0: ev.clientX, start0: klState.start, moved: false }; });
cv.addEventListener('pointermove', ev => {
  if (!drag) return;
  const dx = ev.clientX - drag.x0;
  if (Math.abs(dx) > 4) drag.moved = true;
  if (drag.moved && klState.slotW > 0 && klState.count < klState.total) {
    const ns = Math.max(0, Math.min(klState.total - klState.count, drag.start0 - Math.round(dx / klState.slotW)));
    if (ns !== klState.start) { klState.start = ns; if (!klRaf) klRaf = requestAnimationFrame(() => { klRaf = 0; drawKline(); }); }
  }
});
cv.addEventListener('pointerup', ev => { if (!drag) return; const wasDrag = drag.moved; drag = null; if (!wasDrag && klState.a) { const r = cv.getBoundingClientRect(); klineTap(ev.clientX - r.left, ev.clientY - r.top); } });
cv.addEventListener('pointercancel', () => { drag = null; });
}
$('btnExport').addEventListener('click', exportExcel);
document.querySelectorAll('button[data-tab]').forEach(b => b.addEventListener('click', () => {
  switchTab(b.dataset.tab);
  if (b.closest('#moreTabs')) { // 從「更多」選了分頁後收合更多列（目前分頁由「更多」鈕的使用中狀態標示）
    $('moreTabs').classList.add('hidden');
    const mt = $('btnMoreTabs'); mt.setAttribute('aria-expanded', 'false'); mt.textContent = '更多 ▾';
  }
}));
$('btnMoreTabs').addEventListener('click', () => {
  const box = $('moreTabs');
  const open = box.classList.toggle('hidden') === false;
  const mt = $('btnMoreTabs');
  mt.setAttribute('aria-expanded', open ? 'true' : 'false');
  mt.textContent = open ? '更多 ▴' : '更多 ▾';
});
window.addEventListener('resize', () => { if (state.selected) drawChart(state.selected); if ($('tabKline').classList.contains('active') && klState.a) drawKline(); if (window.innerWidth <= 768 && $('tabAI').classList.contains('active')) switchTab('tabStrategy'); }); // 手機寬度隱藏 AI 分頁：正停在 AI 分頁時切回策略分頁兜底
$('btnReloadData').addEventListener('click', updateToLatest);
$('btnClearQuery').addEventListener('click', () => { $('inpQuery').value = ''; state.results.custom = []; $('selList').value = revView() ? 'rev' : 'candidates'; renderList(); syncModeUI(); $('inpQuery').focus(); }); // 清除查詢：營收模式回營收推薦檢視、預設模式回候選檢視（下拉選項為模式專屬，值須落在目前選項集合內），按鈕／說明／摘要同步收斂
$('inpRevTier').addEventListener('change', async () => {
  // 分層日自訂：夾限 1–19 後存檔（SETTING_IDS 的 change 保存會先跑一次，這裡夾限後再存定版）
  const el = $('inpRevTier');
  let v = parseInt(el.value, 10);
  if (!Number.isFinite(v)) v = 10;
  el.value = Math.max(1, Math.min(19, v));
  saveSettings();
  if (revActive()) {
    // 營收模式：分層界線變了 → 即時重建推薦／觀察兩份名單並重繪（比照 enterRevMode 的建名單段）
    state.revLoading = true;
    syncModeUI();
    renderList();
    const wasBusy = state.busy;
    if (!wasBusy) setBusy(true);
    try { await runRevBuild(); }
    finally { if (!wasBusy) setBusy(false); }
  } else {
    syncRevButton(); // 預設模式：只存設定並更新營收鈕副標（分層自訂標記），不打斷目前畫面
  }
});
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

# 台股 AI 智慧選股工作台 V2.0｜網頁版

手機就能方便使用的靜態網頁版，提供台灣上市、上櫃股票及 ETF 的**盤後**行情分析、技術選股、進場策略規劃、新聞查詢、Gemini AI 解讀與歷史訊號統計。純前端（HTML/CSS/JS），**可直接部署在 GitHub Pages**，不需要伺服器、不需要資料庫主機。

> 本工具僅供研究學習，不保證預測、不提供自動下單。盤後價不等於即時價。

## 架構：GitHub Actions 就是後端（免伺服器、免付費）

```
FinMind API ──► GitHub Actions 後端（backend/update_data.py）
                ├─ 每日排程（週一至五 18:30 台灣時間）：增量更新最近 14 天
                └─ 手動回補（分批、可續跑）：每檔完整 10 年歷史
                     │ commit 回 repo
                     ▼
                data/ 靜態資料（history/<代號>.json.gz 每檔約 51KB、
                     scan.json.gz 全市場最近 370 日掃描包、manifest.json）
                     │ GitHub Pages 自動部署
                     ▼
                手機/電腦瀏覽器：開站自動下載資料包 → 本機計分掃描
```

- 使用者**不需要做任何更新動作**：開站即自動載入後端最新資料，並自動跑一次掃描。
- 全市場掃描包（最近 370 日）首次下載約 16MB（全市場回補完成後），之後瀏覽器會快取；個股完整 10 年歷史在查看該股「歷史訊號觀察」時才逐檔載入（每檔約 51KB）。
- repo 目前已內含 5 檔種子資料（2330、2317、2454、6488、0050，各 2,430+ 筆、2016 至今完整 10 年）可立即驗證；其餘股票由回補 workflow 分批補齊。

## 部署到 GitHub Pages（約 2 分鐘）

1. 在 GitHub 新建一個 repo（例如 `twstock-ai`），把本資料夾所有檔案上傳到 repo 根目錄（`index.html` 必須在根目錄）。
2. Repo → Settings → Pages → Build and deployment → Source 選 **GitHub Actions**（本 repo 已附 `.github/workflows/pages.yml`）。
3. Push 到 `main` 後 Actions 會自動部署，完成後網址為 `https://<你的帳號>.github.io/<repo 名稱>/`。
4. 手機開啟該網址即可使用；也可「加入主畫面」當 App 用（已附 PWA manifest）。

### 一次性回補 10 年歷史（部署後做一次）

1. Repo → Actions →「歷史回補（10 年，可續跑）」→ Run workflow（預設每批 300 檔）。
2. 進度保存在 `data/state.json` 並自動 commit；重複觸發直到 log 顯示「尚餘 0 檔」。全市場約 2,700 檔代號（含已下市，會自動略過），約 9～10 批。
3. 之後不需要再管：每日排程（週一至五 18:30）自動增量更新並重新部署。
4. （選用）到 [FinMind](https://finmindtrade.com/) 免費註冊取得 Token，存到 repo 的 Settings → Secrets → Actions，名稱 `FINMIND_TOKEN`，可提高 API 配額、加快回補；不設定也能跑（未登入配額，批次間會自動節流，被限流時該批會保存進度後停止，下次續跑）。

## 使用流程

下載／匯入行情 → 設定選股條件 → 開始掃描 → 點選股票 → 看走勢、技術指標與策略 → 查新聞或 Gemini 解讀 → 匯出 Excel。

第一次使用建議先按左側「**載入離線示範資料**」：內建 18 檔虛構股票（固定種子、可重現），完整跑通掃描→推薦→策略→歷史統計流程，摘要會標示「虛構示範資料｜勿用於投資」。

## 資料來源與網頁版的取捨（重要）

GitHub Pages 是靜態托管、瀏覽器有 CORS 限制，因此資料層與桌面版規格有以下對應調整：

| 功能 | 網頁版做法 |
|---|---|
| 全市場歷史掃描 | **後端資料包自動載入**（見上方架構）；CSV 匯入仍保留為補充來源，匯入後存入瀏覽器 IndexedDB |
| 官方最新日線 | 後端每日排程自動更新為主；頁面上的「更新官方最新日線」按鈕為輔助（TWSE／TPEx OpenAPI 最新一日快照） |
| 個股歷史補抓 | 優先讀後端 `data/history/<代號>.json.gz` 完整 10 年歷史；無此檔時才向 TWSE 逐月補抓（上市股，可能受 CORS 阻擋） |
| 示範資料 | 產生器即時產生，不佔儲存空間，與正式資料以模式旗標隔離 |
| 資料庫 | 以 IndexedDB 取代 SQLite（本機、免架設伺服器的定位不變） |
| 視窗狀態記憶 | 以 localStorage 保存選股設定；Gemini API Key **永不保存**，只供當次使用 |
| 自動排程 | 改由 **GitHub Actions 排程**取代 Windows 工作排程：週間 18:30（台灣時間）自動更新行情並重新部署 |
| Excel 匯出 | 透過 SheetJS（CDN）產生 .xlsx（選股排行／技術強勢觀察／指標明細／新聞索引／Gemini分析／使用說明）；CDN 未載入時自動退回 CSV |
| 新聞 | Google News RSS 直連；被 CORS 阻擋時自動改提供 Google 新聞搜尋連結，不會假造新聞 |

### CSV 格式

第一列為欄名（中英文皆可）：`code,name,market,date,open,high,low,close,volume,amount`

```
code,name,market,date,open,high,low,close,volume,amount
2330,台積電,TWSE,2026-11-11,1000,1015,995,1010,25000000,25250000000
```

代號會以字串處理，前導零（如 0050）會保留。每檔至少 125 個交易日才能納入掃描。

## 計算規則（與規格書一致，全部由 `js/core.js` 規則引擎計算）

- **技術分 100 分**：13 項訊號各有固定權重（MA 多頭排列 10、均線黃金交叉 8、MACD 翻多 10、RSI 偏多 8、KD 黃金交叉 6、布林偏多 6、成交量放大 10、OBV 偏多 6、ADX 強勢 6、突破前高 10、Supertrend 翻多 8、一目均衡表偏多 6、MFI 偏多 6），成立才加分。
- **策略價位**：週期自動判斷（短線／中線／中長線／長線）、回檔／突破進場、進場區間（ATR 公式）、停損（支撐與 ATR 取低）、目標一（≥1.8 倍風險）、目標二（≥3 倍風險）、風險報酬比、台股升降單位取整。
- **進場適合度**：基礎 45 分，距離扣分、技術／量能／風報加分、ATR 波動扣分，條件失效直接 0 分；個股頁列出完整拆解。
- **推薦條件**：技術分、近 20 日均成交額、進場適合度三門檻＋狀態排除（條件失效、暫不追價）＋風險報酬 ≥ 1.5；**門檻嚴格執行，不湊數**。
- **排序模式**：綜合（技術 42%＋適合度 38%＋流動性 10%＋風報 10%）、技術強勢優先、近期進場優先。
- **Gemini**：只用既有數據產生文字解讀（temperature 0.2、JSON 結構化輸出），禁止捏造價格或改寫價位；批次遇 HTTP 400/401/403/429 即停止。
- **歷史訊號觀察**：歷史每日重算、技術分 ≥ 70 的訊號，統計 5／10／20 日後報酬（扣成本 0.4%＋滑價 0.1%）、上漲比例、目標／停損觸及比例。屬訊號統計，非完整回測。

## 本機測試

```
node tests/core.test.mjs   # 核心引擎測試（99 項斷言）
```

直接用瀏覽器開啟 `index.html` 也能運作（部分瀏覽器對 `file://` 的 IndexedDB／fetch 有限制，建議用 GitHub Pages 或本機 `python3 -m http.server` 開啟）。

## 檔案結構

```
index.html            頁面骨架（標題列、左側設定、右側表格與六大分頁）
css/style.css         深色金融工作台樣式（#0d1728 紅漲綠跌，手機版表格轉卡片）
js/core.js            指標／計分／策略／適合度／掃描／歷史統計（規則引擎，可用 Node 測試）
js/demo.js            虛構示範資料產生器（固定種子，種子經離線校準）
js/app.js             UI、後端資料包自動載入、CSV 匯入、新聞、Gemini、Excel 匯出
backend/update_data.py  資料後端（FinMind 抓取、回補/每日增量、掃描包建置；僅用 Python 標準庫）
data/                 後端產出的靜態資料（manifest.json、scan.json.gz、history/*.json.gz、state.json）
manifest.webmanifest  PWA 設定
.github/workflows/pages.yml        GitHub Pages 自動部署
.github/workflows/data-daily.yml   每日行情自動更新（週間 18:30 台灣時間）
.github/workflows/data-backfill.yml 10 年歷史回補（手動觸發、分批續跑）
```

後端離線自我測試：`python3 backend/update_data.py selftest --data-dir /tmp/x`

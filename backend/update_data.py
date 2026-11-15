#!/usr/bin/env python3
"""台股 AI 智慧選股工作台 V2.0（網頁版）— 資料後端

架構：GitHub Actions 就是後端。本腳本在 Actions 裡執行（排程每日增量、
手動分批回補），把行情寫成靜態檔案 commit 回 repo，GitHub Pages 部署後
前端直接讀取，使用者開站即是最新資料，不需要任何人手動更新。

資料來源：歷史回補用 FinMind API（TaiwanStockInfo / TaiwanStockPrice，涵蓋
TWSE＋TPEx，單一請求即可取回一檔股票的完整歷史）；每日更新主線改用
TWSE／TPEx 官方全市場每日行情各抓一次，官方整包失敗時才 fallback FinMind 逐檔。
可選環境變數 FINMIND_TOKEN（在 repo Secrets 設定）可提高 API 配額；
未設定時以未登入配額執行，腳本會自動節流且可中斷續跑。

檔案產出（data/）：
  history/<code>.json.gz 每檔完整歷史（gzip，約 51KB/檔）：{"code","name","market","rows":[[date,o,h,l,c,v,amt],...]}
  scan.json.gz          最近 370 個交易日的全市場精簡包（前端掃描用，gzip）
  manifest.json         {updatedAt, latestDate, stockCount, withHistory, scanFile,...}
  state.json            回補進度 {done:[...], empty:[...], failed:{...}}（commit 後可續跑）
  revstate.json.gz      月營收原始狀態（後端專用）：每檔最近 26 個月的營收與抓取進度
  revenue.json.gz       E1 營收事件前端契約（daily 每次重算）：{generatedAt, latestDate,
                        latestRevMonth, stocks:{code:{m, yoy, event, age}}}

用法：
  python3 backend/update_data.py backfill --years 10 --batch 150 [--sleep 0.5]
  python3 backend/update_data.py daily    [--sleep 0.3]        # 最近 14 天增量合併
  python3 backend/update_data.py build                          # 重建 scan.json.gz + manifest
  python3 backend/update_data.py selftest                       # 離線自我測試
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from bisect import bisect_left
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

API = "https://api.finmindtrade.com/api/v4/data"
TWSE_DAILY_URL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=json"
TPEX_DAILY_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
CODE_RE = re.compile(r"^[0-9A-Z]{4,6}$")
SCAN_DAYS = 370          # 前端全市場掃描需要的最大日線數（core.js 上限 360，留緩衝）
MIN_SCAN_ROWS = 125      # 納入掃描的最少交易日（規格 #98）


def log(*a):
    print("[update_data]", *a, flush=True)


def fetch_json(dataset: str, token: str = "", **params) -> list[dict]:
    q = {"dataset": dataset, **{k: v for k, v in params.items() if v not in ("", None)}}
    if token:
        q["token"] = token
    url = API + "?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers={"User-Agent": "twstock-web-backend/2.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if payload.get("status") != 200:
        raise RuntimeError(f"FinMind {dataset}: {payload.get('msg')}")
    return payload.get("data") or []


def get_stock_list(token: str) -> list[dict]:
    rows = fetch_json("TaiwanStockInfo", token)
    best: dict[str, dict] = {}
    for r in rows:
        if r.get("type") not in ("twse", "tpex"):
            continue
        code = str(r.get("stock_id", "")).strip()
        if not CODE_RE.match(code):
            continue
        if code not in best or (r.get("date") or "") > (best[code].get("date") or ""):
            best[code] = r
    out = [{
        "code": code,
        "name": r.get("stock_name") or code,
        "market": "TWSE" if r["type"] == "twse" else "TPEX",
    } for code, r in sorted(best.items())]
    log(f"股票清單：{len(out)} 檔（TWSE/TPEx 去重後）")
    return out


def clean_rows(rows) -> list:
    cleaned = []
    for r in rows or []:
        try:
            if len(r) >= 5 and r[4] > 0:
                cleaned.append(r)
        except (TypeError, IndexError):
            continue
    return cleaned


def rows_from_prices(data: list[dict]) -> list[list]:
    rows = []
    for r in data:
        try:
            close = float(r["close"])
            if close <= 0:
                continue
            rows.append([
                r["date"],
                round(float(r["open"]), 2), round(float(r["max"]), 2),
                round(float(r["min"]), 2), round(close, 2),
                int(float(r["Trading_Volume"])), int(float(r["Trading_money"])),
            ])
        except (KeyError, TypeError, ValueError):
            continue
    return rows


def merge_rows(old: list[list], new: list[list]) -> list[list]:
    by_date = {r[0]: r for r in old}
    for r in new:
        by_date[r[0]] = r
    return clean_rows([by_date[d] for d in sorted(by_date)])


def _num(value) -> float | None:
    """官方欄位轉數字：移除千分位逗號與正負號空白；'---' 等無成交值回傳 None。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text or text in {"---", "--", "-"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _iso_date(value) -> str | None:
    """民國日期（1151113／115/11/13）或西元日期轉 ISO；無法辨識回傳 None。"""
    if value is None:
        return None
    text = str(value).strip()
    m = re.fullmatch(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", text)
    if m:
        y, mo, d = map(int, m.groups())
        return date(y, mo, d).isoformat()
    compact = re.sub(r"\D", "", text)
    if len(compact) == 8:  # YYYYMMDD
        return date(int(compact[:4]), int(compact[4:6]), int(compact[6:])).isoformat()
    if len(compact) == 7:  # ROC YYYMMDD
        return date(int(compact[:3]) + 1911, int(compact[3:5]), int(compact[5:])).isoformat()
    return None


def _official_row(day, open_, high, low, close, volume, amount) -> list | None:
    vals = [_num(open_), _num(high), _num(low), _num(close), _num(volume), _num(amount)]
    if not day or any(v is None for v in vals) or vals[3] <= 0 or vals[4] < 0:
        return None
    return [day, round(vals[0], 2), round(vals[1], 2), round(vals[2], 2),
            round(vals[3], 2), int(vals[4]), int(vals[5])]


def _fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "twstock-web-backend/2.0"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return resp.read().decode("utf-8-sig")


def _dict_value(row: dict, *names):
    for name in names:
        if name in row and row[name] not in ("", None):
            return row[name]
    return None


def parse_twse_daily_payload(text: str) -> dict[str, list]:
    """解析 TWSE STOCK_DAY_ALL；實測同一端點會回 CSV，也保留 JSON 形狀支援。"""
    text = text.strip()
    out: dict[str, list] = {}
    if not text:
        return out
    if text.startswith("{") or text.startswith("["):
        payload = json.loads(text)
        records = payload.get("data") if isinstance(payload, dict) else payload
        fields = payload.get("fields") if isinstance(payload, dict) else None
        global_day = _iso_date(payload.get("date")) if isinstance(payload, dict) else None
        for rec in records or []:
            if isinstance(rec, list):
                if fields:
                    rec = dict(zip(fields, rec))
                elif len(rec) >= 11:  # CSV 欄位順序（含日期）
                    rec = dict(zip(["日期", "證券代號", "證券名稱", "成交股數", "成交金額",
                                    "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數"], rec))
                elif len(rec) >= 9:  # JSON data 欄位順序（日期在 payload.date）
                    rec = dict(zip(["證券代號", "證券名稱", "成交股數", "成交金額", "開盤價",
                                    "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數"], rec))
                else:
                    continue
            code = str(_dict_value(rec, "證券代號", "Code", "code") or "").strip()
            day = _iso_date(_dict_value(rec, "日期", "Date", "date")) or global_day
            row = _official_row(
                day,
                _dict_value(rec, "開盤價", "OpeningPrice", "Open", "open"),
                _dict_value(rec, "最高價", "HighestPrice", "High", "high"),
                _dict_value(rec, "最低價", "LowestPrice", "Low", "low"),
                _dict_value(rec, "收盤價", "ClosingPrice", "Close", "close"),
                _dict_value(rec, "成交股數", "TradeVolume", "TradingShares", "Volume", "volume"),
                _dict_value(rec, "成交金額", "TradeValue", "TransactionAmount", "Amount", "amount"),
            )
            if code and row:
                out[code] = row
        return out

    # 實測格式：第一欄是民國日期的 CSV，表頭含日期／證券代號／成交金額等欄位。
    for rec in csv.DictReader(io.StringIO(text)):
        code = str(_dict_value(rec, "證券代號", "Code", "code") or "").strip()
        row = _official_row(
            _iso_date(_dict_value(rec, "日期", "Date", "date")),
            _dict_value(rec, "開盤價", "OpeningPrice", "Open", "open"),
            _dict_value(rec, "最高價", "HighestPrice", "High", "high"),
            _dict_value(rec, "最低價", "LowestPrice", "Low", "low"),
            _dict_value(rec, "收盤價", "ClosingPrice", "Close", "close"),
            _dict_value(rec, "成交股數", "TradeVolume", "TradingShares", "Volume", "volume"),
            _dict_value(rec, "成交金額", "TradeValue", "TransactionAmount", "Amount", "amount"),
        )
        if code and row:
            out[code] = row
    return out


def parse_tpex_daily_payload(text: str) -> tuple[dict[str, list], int]:
    """解析 TPEx OpenAPI 每日收盤行情；回傳 rows 與 amount 近似筆數。"""
    payload = json.loads(text)
    if not isinstance(payload, list):
        raise RuntimeError("TPEx 每日行情格式不正確")
    out: dict[str, list] = {}
    approx = 0
    for rec in payload:
        if not isinstance(rec, dict):
            continue
        code = str(_dict_value(rec, "SecuritiesCompanyCode", "證券代號", "Code", "code") or "").strip()
        amount = _dict_value(rec, "TransactionAmount", "成交金額", "TradeValue", "Amount", "amount")
        if amount is None:
            close = _num(_dict_value(rec, "Close", "收盤價", "ClosingPrice", "close"))
            volume = _num(_dict_value(rec, "TradingShares", "成交股數", "TradeVolume", "volume"))
            if close is not None and volume is not None:
                amount = close * volume
                approx += 1
        row = _official_row(
            _iso_date(_dict_value(rec, "Date", "日期", "date")),
            _dict_value(rec, "Open", "開盤價", "OpeningPrice", "open"),
            _dict_value(rec, "High", "最高價", "HighestPrice", "high"),
            _dict_value(rec, "Low", "最低價", "LowestPrice", "low"),
            _dict_value(rec, "Close", "收盤價", "ClosingPrice", "close"),
            _dict_value(rec, "TradingShares", "成交股數", "TradeVolume", "volume"),
            amount,
        )
        if code and row:
            out[code] = row
    return out, approx


def fetch_official_daily() -> tuple[dict[str, list], dict]:
    """一次抓 TWSE 全市場與 TPEx 全市場最新交易日行情。

    任一市場整包失敗就視為官方主線失敗，讓 cmd_daily 走 FinMind fallback，
    避免只更新單一市場又製造跨市場日期不一致。
    """
    twse = parse_twse_daily_payload(_fetch_text(TWSE_DAILY_URL))
    if not twse:
        raise RuntimeError("TWSE 每日全市場行情為空")
    tpex, amount_approx = parse_tpex_daily_payload(_fetch_text(TPEX_DAILY_URL))
    if not tpex:
        raise RuntimeError("TPEx 每日全市場行情為空")
    if amount_approx:
        log(f"TPEx 有 {amount_approx} 筆缺少成交金額，已以 close×volume 近似")
    merged = dict(twse)
    overlap = set(merged) & set(tpex)
    if overlap:
        log(f"官方清單有 {len(overlap)} 檔代號重複，TPEx 欄位優先")
    merged.update(tpex)
    dates = Counter(r[0] for r in merged.values())
    target = dates.most_common(1)[0][0]
    meta = {"targetDate": target, "twse": len(twse), "tpex": len(tpex),
            "total": len(merged), "amountApprox": amount_approx, "dates": dict(dates)}
    log(f"官方每日行情：TWSE {len(twse)} 檔、TPEx {len(tpex)} 檔，目標日期 {target}")
    return merged, meta


def is_quota_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "402" in msg or "429" in msg or "limit" in msg or "quota" in msg


class Store:
    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.hist = data_dir / "history"
        self.hist.mkdir(parents=True, exist_ok=True)
        self.state_path = data_dir / "state.json"
        self.state = {"done": [], "empty": [], "failed": {}}
        if self.state_path.exists():
            try:
                self.state.update(json.loads(self.state_path.read_text(encoding="utf-8")))
            except Exception:
                pass

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")

    def stock_file(self, code: str) -> Path:
        return self.hist / f"{code}.json.gz"

    def read_stock(self, code: str) -> dict | None:
        p = self.stock_file(code)
        if not p.exists():
            return None
        try:
            with gzip.open(p, "rb") as f:
                return json.loads(f.read().decode("utf-8"))
        except Exception:
            return None

    def write_stock(self, code: str, name: str, market: str, rows: list[list]):
        payload = {"code": code, "name": name, "market": market, "rows": clean_rows(rows)}
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with gzip.open(self.stock_file(code), "wb", compresslevel=9) as f:
            f.write(raw)


def polite_sleep(sec: float):
    if sec > 0:
        time.sleep(sec)


def cmd_backfill(args, store: Store, token: str) -> int:
    start = (date.today() - timedelta(days=int(args.years * 365.25))).isoformat()
    try:
        stocks = get_stock_list(token)
    except Exception as e:
        # 不要讓 workflow 紅燈吞掉診斷：把錯誤寫進 state.json 並正常結束，
        # 後續 commit 步驟會把 state 傳回 repo，方便遠端判讀。
        store.state["last_error"] = f"stock_list: {e}"
        store.save_state()
        log(f"股票清單取得失敗，錯誤已記錄到 state.json：{e}")
        return 0
    store.state.pop("last_error", None)
    store.state.pop("rate_limited", None)
    done = set(store.state["done"]) | set(store.state["empty"])
    todo = [s for s in stocks if s["code"] not in done]
    log(f"回補起始日 {start}；待處理 {len(todo)} 檔，本批上限 {args.batch} 檔")
    processed = 0
    for s in todo:
        if processed >= args.batch:
            break
        code = s["code"]
        try:
            data = fetch_json("TaiwanStockPrice", token, data_id=code, start_date=start)
            rows = rows_from_prices(data)
            if rows:
                existing = store.read_stock(code)
                if existing:
                    rows = merge_rows(existing["rows"], rows)
                store.write_stock(code, s["name"], s["market"], rows)
                store.state["done"].append(code)
                store.state["failed"].pop(code, None)
                log(f"  {code} {s['name']}：{len(rows)} 筆")
            else:
                store.state["empty"].append(code)   # 下市/無交易資料，之後不再重試
            processed += 1
        except Exception as e:
            msg = str(e)
            store.state["failed"][code] = msg
            log(f"  {code} 失敗：{msg}")
            if "429" in msg or "rate" in msg.lower():
                log("疑似觸及 API 配額，停止本批並保存進度，下次執行會自動續跑")
                store.state["rate_limited"] = True
                remain = len([s for s in stocks if s["code"] not in set(store.state["done"]) | set(store.state["empty"])])
                store.state["remaining"] = remain
                store.state["runs"] = int(store.state.get("runs", 0)) + 1
                store.save_state()
                return 0   # 限流是預期中的暫停，不是失敗；讓 commit 步驟保存進度
            processed += 1
        store.save_state()
        polite_sleep(args.sleep)
    remain = len([s for s in stocks if s["code"] not in set(store.state["done"]) | set(store.state["empty"])])
    store.state["remaining"] = remain
    store.state["runs"] = int(store.state.get("runs", 0)) + 1
    store.save_state()
    log(f"本批完成 {processed} 檔；尚餘 {remain} 檔待回補（累計第 {store.state['runs']} 批）")
    return 0


def cmd_daily_finmind(args, store: Store, token: str, files: list[Path], start: str) -> dict:
    """FinMind 逐檔 fallback；把完成清單寫入 state，配額中斷後下次可續跑。"""
    progress = store.state.get("daily_progress")
    if not isinstance(progress, dict) or progress.get("start") != start:
        progress = {"start": start, "done": []}
        store.state["daily_progress"] = progress
    done = set(progress.get("done", []))
    ok = fail = skipped = 0
    quota_hit = False
    for i, p in enumerate(files):
        code = p.name.replace(".json.gz", "")
        if code in done:
            skipped += 1
            continue
        try:
            cur = store.read_stock(code) or {"name": code, "market": "TWSE", "rows": []}
            data = fetch_json("TaiwanStockPrice", token, data_id=code, start_date=start)
            rows = rows_from_prices(data)
            if rows:
                merged = merge_rows(cur["rows"], rows)
                if merged != cur["rows"]:
                    store.write_stock(code, cur.get("name", code), cur.get("market", "TWSE"), merged)
            done.add(code)
            progress["done"] = sorted(done)
            ok += 1
        except Exception as e:
            fail += 1
            log(f"  {code} 增量失敗：{e}")
            if is_quota_error(e):
                quota_hit = True
                progress["done"] = sorted(done)
                store.state["daily"] = {
                    "source": "finmind-fallback", "start": start, "quotaHit": True,
                    "done": len(done), "total": len(files), "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                store.save_state()
                log("疑似觸及 FinMind 配額（402/429/limit），停止並保存已完成清單，下次執行會續跑")
                break
        if (i + 1) % 200 == 0:
            progress["done"] = sorted(done)
            store.save_state()
            log(f"  FinMind 進度 {i + 1}/{len(files)}（成功 {ok}、失敗 {fail}、已完成跳過 {skipped}）")
        polite_sleep(args.sleep)
    progress["done"] = sorted(done)
    summary = {"source": "finmind-fallback", "start": start, "quotaHit": quota_hit,
               "done": len(done), "ok": ok, "failed": fail, "skipped": skipped, "total": len(files),
               "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    store.state["daily"] = summary
    store.save_state()
    log(f"每日增量（FinMind fallback）完成：成功 {ok}、失敗 {fail}、已完成跳過 {skipped}、累計完成 {len(done)}/{len(files)}")
    return summary


def cmd_daily(args, store: Store, token: str) -> int:
    start = (date.today() - timedelta(days=14)).isoformat()
    files = sorted(store.hist.glob("*.json.gz"))
    if not files:
        log("尚無歷史檔案，請先執行 backfill")
        return 1

    try:
        official, meta = fetch_official_daily()
    except Exception as e:
        log(f"官方全市場每日行情抓取失敗，改走 FinMind 逐檔 fallback：{e}")
        cmd_daily_finmind(args, store, token, files, start)
        _revenue_safe(args, store, token)
        return 0

    target = meta["targetDate"]
    updated = already = missing = covered = 0
    for p in files:
        code = p.name.replace(".json.gz", "")
        cur = store.read_stock(code)
        if not cur or not cur.get("rows"):
            missing += 1
            continue
        rows = cur["rows"]
        last_day = rows[-1][0]
        row = official.get(code)
        if row and row[0] > last_day:
            merged = merge_rows(rows, [row])
            if merged != rows:
                store.write_stock(code, cur.get("name", code), cur.get("market", "TWSE"), merged)
                rows = merged
                updated += 1
        elif row and row[0] == last_day:
            already += 1
        if rows and rows[-1][0] == target:
            covered += 1
    summary = {"source": "official-twse-tpex", "targetDate": target, "officialTotal": meta["total"],
               "twse": meta["twse"], "tpex": meta["tpex"], "amountApprox": meta["amountApprox"],
               "updated": updated, "alreadyCurrent": already, "missingOrSuspended": missing,
               "covered": covered, "total": len(files),
               "coveragePct": round(covered / len(files) * 100, 2) if files else 0,
               "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    store.state["daily"] = summary
    store.state.pop("daily_progress", None)
    store.save_state()
    log(f"每日更新覆蓋率：{covered}/{len(files)} 檔已達目標日期 {target}（{summary['coveragePct']}%；本次新增 {updated}、原本已達 {already}、無歷史或官方無此檔 {missing}）")
    log(f"每日增量（官方主線）完成：{summary}")
    _revenue_safe(args, store, token)
    return 0


def build_bundle(store: Store) -> dict:
    stocks = []
    latest = ""
    for p in sorted(store.hist.glob("*.json.gz")):
        s = store.read_stock(p.name.replace(".json.gz", ""))
        if not s:
            continue
        cleaned = clean_rows(s.get("rows", []))
        if len(cleaned) < MIN_SCAN_ROWS:
            continue
        rows = cleaned[-SCAN_DAYS:]
        stocks.append({"c": s["code"], "n": s["name"], "m": s["market"], "r": rows})
        if rows and rows[-1][0] > latest:
            latest = rows[-1][0]
    payload = {"latestDate": latest, "stocks": stocks}
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz_path = store.dir / "scan.json.gz"
    with gzip.open(gz_path, "wb", compresslevel=9) as f:
        f.write(raw)
    total_hist = len(list(store.hist.glob("*.json.gz")))
    manifest = {
        "app": "twstock-web",
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "latestDate": latest,
        "stockCount": total_hist,
        "scanStocks": len(stocks),
        "scanFile": "scan.json.gz",
        "scanBytes": gz_path.stat().st_size,
        "scanRawBytes": len(raw),
        "source": "FinMind history + TWSE/TPEx official daily quotes",
    }
    (store.dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"掃描包完成：{len(stocks)} 檔、最新 {latest}、gzip {manifest['scanBytes']} bytes（原始 {len(raw)}）")
    return manifest


# ---------- E1 營收事件（月營收年增 > 20%，研究端 Round 6B 預註冊驗證通過） ----------
# 定義（與研究端 round6b/PREREG.md 逐字一致，不得改動）：
#   M 月營收自 M+1 月 15 日起可用；事件日 = 可用日起、該股自身交易日序的第一個交易日；
#   事件窗 = 事件日後 20 個交易日（含事件日）。前端只顯示 age <= 20 的事件標記。
# FinMind TaiwanStockMonthRevenue 不支援無 data_id 的批量查詢（實測 HTTP 400），
# 故採逐檔抓取＋revstate 進度輪替：每次 daily 依優先序抓一批（未抓過 > 有新月份待補 >
# 最久未更新），全市場約 9 次 daily 完成首輪，之後每月新月份陸續補入。
REV_KEEP = 26            # revstate 每檔保留的最近月份數
REV_FETCH_YEARS = 4      # 逐檔抓取回溯年數（夠算最近 26 個月的 YoY）
REV_BATCH = 300          # 無 token 時每次 daily 的抓取上限（FinMind 未登入配額自律）
REV_BATCH_TOKEN = 1200   # 有 FINMIND_TOKEN 時的上限


def rev_month_idx(y: int, m: int) -> int:
    return y * 12 + (m - 1)


def rev_month_label(idx: int) -> str:
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def rev_avail_date(idx: int) -> str:
    """營收月 idx 的可用日：次月 15 日（ISO）。"""
    nxt = idx + 1
    return date(nxt // 12, nxt % 12 + 1, 15).isoformat()


def rev_latest_available_idx(latest_date: str) -> int:
    """截至 latest_date 已可用的最新營收月 idx（可用日 <= latest_date 的最大月份）。"""
    y, m, d = int(latest_date[:4]), int(latest_date[5:7]), int(latest_date[8:10])
    cand = rev_month_idx(y, m) - 1      # 其可用日 = 本月 15 日
    if d < 15:
        cand -= 1
    return cand


def rev_yoy_ratio(series: dict, idx: int):
    """YoY（比率）：去年同月缺漏或 <= 0 時回傳 None（比照研究端定義）。"""
    v = series.get(idx)
    prev = series.get(idx - 12)
    if v is None or prev is None or prev <= 0:
        return None
    return v / prev - 1


def rev_event_age(dates: list, avail: str):
    """事件日 = dates 中第一個 >= avail 的交易日；age 以 dates 序計（事件日 = 0）。"""
    j = bisect_left(dates, avail)
    if j >= len(dates):
        return None, None
    return dates[j], (len(dates) - 1) - j


def compute_revenue_payload(series_by_code: dict, dates_by_code: dict, generated_at: str) -> dict:
    """組前端契約 revenue.json 的內容（純函數，供 selftest 與正式路徑共用）。

    每檔取「不晚於全域最新可用月、且 YoY 可計算」的新近月份為其營收狀態；
    YoY > 20% 才給 event/age（event 不存在於 bars 範圍時兩者皆 null）。
    """
    latest = ""
    for dates in dates_by_code.values():
        if dates and dates[-1] > latest:
            latest = dates[-1]
    payload = {"generatedAt": generated_at, "latestDate": latest,
               "latestRevMonth": None, "stocks": {}}
    if not latest:
        return payload
    cap = rev_latest_available_idx(latest)
    payload["latestRevMonth"] = rev_month_label(cap)
    for code in sorted(series_by_code):
        series = series_by_code[code]
        if not series:
            continue
        start_idx = min(max(series), cap)
        idx, yoy = start_idx, None
        while idx >= start_idx - 12 and idx >= 0:
            yoy = rev_yoy_ratio(series, idx)
            if yoy is not None:
                break
            idx -= 1
        if yoy is None:
            continue
        entry = {"m": rev_month_label(idx), "yoy": round(yoy * 100, 1),
                 "event": None, "age": None}
        if yoy > 0.20:
            ev, age = rev_event_age(dates_by_code.get(code) or [], rev_avail_date(idx))
            entry["event"] = ev
            entry["age"] = age
        payload["stocks"][code] = entry
    return payload


def load_revstate(store: Store) -> dict:
    rs = {"stocks": {}, "fetched": {}}
    p = store.dir / "revstate.json.gz"
    if p.exists():
        try:
            with gzip.open(p, "rb") as f:
                raw = json.loads(f.read().decode("utf-8"))
            for code, pairs in (raw.get("stocks") or {}).items():
                rs["stocks"][code] = {int(i): float(v) for i, v in pairs}
            rs["fetched"] = raw.get("fetched") or {}
        except Exception as e:
            log(f"revstate 讀取失敗，視為空白重建：{e}")
    return rs


def save_revstate(store: Store, rs: dict):
    raw = {"stocks": {c: [[i, s[i]] for i in sorted(s)] for c, s in rs["stocks"].items()},
           "fetched": rs["fetched"]}
    data = json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(store.dir / "revstate.json.gz", "wb", compresslevel=9) as f:
        f.write(data)


def maintain_revenue(args, store: Store, token: str):
    """營收維護：逐檔抓取（輪替）→ 保存 revstate → 重算 revenue.json.gz。

    任何未預期錯誤由呼叫端 _revenue_safe 攔截，不影響價格主流程；
    單檔抓取失敗只記錄、隔日再試；配額錯誤則停止本日抓取但照常產出。
    """
    rs = load_revstate(store)
    series, fetched = rs["stocks"], rs["fetched"]
    files = sorted(store.hist.glob("*.json.gz"))
    codes = [p.name.replace(".json.gz", "") for p in files]
    today = date.today()
    # 已公布的最新營收月估計（M 月於 M+1 月 10 日前公布）：僅用於抓取優先序
    pub = rev_month_idx(today.year, today.month) - (1 if today.day >= 10 else 2)

    def priority(code):
        f = fetched.get(code)
        s = series.get(code)
        if f is None:
            # 未抓過：一般公司優先；00 開頭多為 ETF/基金（實測不申報月營收）排後，
            # 避免首批額度全耗在無資料證券上（它們仍會在輪替中被抓到）
            return (2, "") if code.startswith("00") else (0, "")
        if s and max(s) < pub:
            return (1, f)
        return (3, f)

    todo = sorted(codes, key=lambda c: (priority(c), c))
    batch = REV_BATCH_TOKEN if token else REV_BATCH
    start = (today - timedelta(days=int(REV_FETCH_YEARS * 365.25))).isoformat()
    n_ok = n_empty = n_fail = attempted = 0
    for code in todo:
        if attempted >= batch:
            break
        if fetched.get(code) == today.isoformat() and code in series:
            continue  # 同日重跑（備援排程）不重複抓，把額度留給下一批
        attempted += 1
        try:
            data = fetch_json("TaiwanStockMonthRevenue", token, data_id=code, start_date=start)
            s = {}
            for r in data:
                try:
                    s[rev_month_idx(int(r["revenue_year"]), int(r["revenue_month"]))] = float(r["revenue"])
                except (KeyError, TypeError, ValueError):
                    continue
            keep = sorted(s)[-REV_KEEP:]
            series[code] = {i: s[i] for i in keep}
            fetched[code] = today.isoformat()
            if s:
                n_ok += 1
            else:
                n_empty += 1
        except Exception as e:
            n_fail += 1
            log(f"  營收 {code} 抓取失敗：{e}")
            if is_quota_error(e):
                log("疑似觸及 FinMind 配額，停止本日營收抓取（已抓部分照常保存與產出）")
                break
        if attempted % 100 == 0:
            save_revstate(store, rs)
            log(f"  營收抓取進度 {attempted}/{batch}（成功 {n_ok}、無資料 {n_empty}、失敗 {n_fail}）")
        polite_sleep(max(args.sleep, 0.3))
    save_revstate(store, rs)
    covered = sum(1 for c in codes if fetched.get(c))
    log(f"營收抓取：本日嘗試 {attempted} 檔（成功 {n_ok}、無營收資料 {n_empty}、失敗 {n_fail}）；"
        f"累計已抓 {covered}/{len(codes)} 檔")

    dates_by_code, series_by_code = {}, {}
    for p in files:
        code = p.name.replace(".json.gz", "")
        s = store.read_stock(code)
        if s and s.get("rows"):
            dates_by_code[code] = [r[0] for r in clean_rows(s["rows"])]
        if code in series:
            series_by_code[code] = series[code]
    payload = compute_revenue_payload(
        series_by_code, dates_by_code,
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out = store.dir / "revenue.json.gz"
    with gzip.open(out, "wb", compresslevel=9) as f:
        f.write(raw)
    in_window = sum(1 for v in payload["stocks"].values()
                    if v.get("age") is not None and v["age"] <= 20)
    log(f"營收輸出 revenue.json.gz：{len(payload['stocks'])} 檔有 YoY、事件窗內 {in_window} 檔、"
        f"最新營收月 {payload['latestRevMonth']}、行情最新 {payload['latestDate']}、"
        f"gzip {out.stat().st_size} bytes")


def _revenue_safe(args, store: Store, token: str):
    """營收維護的隔離包裝：失敗沿用既有 revenue.json.gz，絕不讓 daily 主流程失敗。"""
    try:
        maintain_revenue(args, store, token)
    except Exception as e:
        log(f"營收維護失敗（沿用既有 revenue.json.gz，不影響價格更新）：{e}")


def cmd_selftest(store: Store) -> int:
    # 合併/去重
    a = [["2026-01-02", 10, 11, 9, 10.5, 1000, 10500], ["2026-01-05", 10.5, 11, 10, 11, 1200, 13200]]
    b = [["2026-01-05", 10.5, 11.5, 10, 11.2, 1300, 14560], ["2026-01-06", 11.2, 12, 11, 11.8, 900, 10620]]
    m = merge_rows(a, b)
    assert len(m) == 3 and m[1][4] == 11.2 and m[-1][0] == "2026-01-06", m
    # rows 轉換
    rows = rows_from_prices([{"date": "2026-01-02", "open": 1, "max": 2, "min": 0.5, "close": 1.5,
                               "Trading_Volume": 100, "Trading_money": 150}])
    assert rows == [["2026-01-02", 1.0, 2.0, 0.5, 1.5, 100, 150]], rows
    # 官方每日行情解析：TWSE 民國日期 CSV、TPEx OpenAPI 欄位與單位（股數/元）
    assert _iso_date("1151113") == "2026-11-13" and _num("1,234.5") == 1234.5 and _num("---") is None
    twse = parse_twse_daily_payload(
        "日期,證券代號,證券名稱,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數\n"
        '"1151113","2330","台積電","1,000","2,350,000","2,375.00","2,390.00","2,340.00","2,350.00","10.0000","10"')
    assert twse["2330"] == ["2026-11-13", 2375.0, 2390.0, 2340.0, 2350.0, 1000, 2350000], twse
    tpex, approx = parse_tpex_daily_payload(json.dumps([{
        "Date": "1151113", "SecuritiesCompanyCode": "6488", "Close": "630.00", "Open": "645.00",
        "High": "658.00", "Low": "623.00", "TradingShares": "1000", "TransactionAmount": "630000"}]))
    assert approx == 0 and tpex["6488"] == ["2026-11-13", 645.0, 658.0, 623.0, 630.0, 1000, 630000], tpex
    assert is_quota_error(RuntimeError("HTTP 402")) and is_quota_error(RuntimeError("rate limit")) \
        and not is_quota_error(RuntimeError("network down"))
    # 建置掃描包：130 筆的股票應入包、100 筆的不入
    base = date(2025, 1, 2)
    def fake_rows(n):
        return [[(base + timedelta(days=i)).isoformat(), 10, 10.5, 9.5, 10.2, 1000, 10200] for i in range(n)]
    store.write_stock("9999", "測試股", "TWSE", fake_rows(130))
    store.write_stock("9998", "短歷史", "TWSE", fake_rows(100))
    # close=0 污染列應在寫入端被濾除：140 筆含 15 筆 close=0 → 回讀 125 筆且無 close<=0
    dirty_rows = fake_rows(140)
    for _idx in [i * 9 for i in range(15)]:
        dirty_rows[_idx][4] = 0
    assert len(dirty_rows) == 140 and sum(1 for r in dirty_rows if r[4] == 0) == 15
    store.write_stock("9997", "污染測試股", "TWSE", dirty_rows)
    back_9997 = store.read_stock("9997")
    assert back_9997 is not None and len(back_9997["rows"]) == 125, back_9997 and len(back_9997["rows"])
    assert all(r[4] > 0 for r in back_9997["rows"]), back_9997["rows"]
    man = build_bundle(store)
    assert man["scanStocks"] == 2 and man["stockCount"] == 3, man
    with gzip.open(store.dir / "scan.json.gz", "rb") as f:
        payload = json.loads(f.read().decode("utf-8"))
    by_code = {s["c"]: s for s in payload["stocks"]}
    assert by_code["9999"]["c"] == "9999" and len(by_code["9999"]["r"]) == 130
    assert len(by_code["9997"]["r"]) == 125 and all(r[4] > 0 for r in by_code["9997"]["r"]), by_code.get("9997")
    # 營收 E1：可用日／最新可用月／YoY／事件日與 age（合成資料，逐值核對）
    i_sep25, i_sep26 = rev_month_idx(2025, 9), rev_month_idx(2026, 9)
    i_oct25, i_oct26 = rev_month_idx(2025, 10), rev_month_idx(2026, 10)
    assert rev_avail_date(i_oct26) == "2026-11-15" and rev_avail_date(rev_month_idx(2026, 12)) == "2027-01-15"
    assert rev_latest_available_idx("2026-11-13") == i_sep26, rev_latest_available_idx("2026-11-13")
    assert rev_latest_available_idx("2026-11-15") == i_oct26 and rev_latest_available_idx("2026-11-14") == i_sep26
    assert abs(rev_yoy_ratio({i_oct25: 100.0, i_oct26: 130.0}, i_oct26) - 0.30) < 1e-9
    assert rev_yoy_ratio({i_oct25: 0, i_oct26: 5.0}, i_oct26) is None
    assert rev_yoy_ratio({i_oct26: 5.0}, i_oct26) is None
    ndays = ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"]
    assert rev_event_age(ndays, "2026-11-15") == ("2026-11-16", 1)   # 可用日逢週日 → 次一交易日
    assert rev_event_age(ndays, "2026-11-13") == ("2026-11-13", 2)   # 可用日即交易日
    assert rev_event_age(ndays, "2026-12-01") == (None, None)        # bars 範圍外
    days = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-11-16", "2026-11-17"]
    bars_map = {"AAA": days, "BBB": days, "CCC": days, "DDD": days}
    series_map = {
        "AAA": {i_sep25: 100.0, i_sep26: 130.0},   # YoY +30% → 事件（2026-09 月，10/15 可用）
        "BBB": {i_sep25: 100.0, i_sep26: 90.0},    # YoY −10% → 無事件
        "CCC": {i_sep25: 100.0, i_sep26: 120.0},   # YoY 恰 +20% → 不算事件（須嚴格 > 20%）
        "DDD": {i_sep26: 100.0},                   # 缺去年同月 → 整檔省略
    }
    pl = compute_revenue_payload(series_map, bars_map, "2026-11-17T00:00:00Z")
    assert pl["latestDate"] == "2026-11-17" and pl["latestRevMonth"] == "2026-10", pl
    assert pl["stocks"]["AAA"] == {"m": "2026-09", "yoy": 30.0, "event": "2026-10-15", "age": 3}, pl["stocks"]
    assert pl["stocks"]["BBB"] == {"m": "2026-09", "yoy": -10.0, "event": None, "age": None}, pl["stocks"]
    assert pl["stocks"]["CCC"]["event"] is None and pl["stocks"]["CCC"]["age"] is None, pl["stocks"]
    assert "DDD" not in pl["stocks"], pl["stocks"]
    log("selftest OK")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="twstock-web 資料後端")
    ap.add_argument("mode", choices=["backfill", "daily", "build", "selftest"])
    ap.add_argument("--data-dir", default=str(Path(__file__).resolve().parent.parent / "data"))
    ap.add_argument("--years", type=float, default=10)
    ap.add_argument("--batch", type=int, default=150)
    ap.add_argument("--sleep", type=float, default=0.5)
    args = ap.parse_args(argv)
    store = Store(Path(args.data_dir))
    token = os.environ.get("FINMIND_TOKEN", "")
    if args.mode == "selftest":
        return cmd_selftest(store)
    if args.mode == "backfill":
        rc = cmd_backfill(args, store, token)
        build_bundle(store)
        return rc
    if args.mode == "daily":
        rc = cmd_daily(args, store, token)
        build_bundle(store)
        return rc
    build_bundle(store)
    return 0


if __name__ == "__main__":
    sys.exit(main())

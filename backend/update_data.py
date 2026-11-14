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


def rows_from_prices(data: list[dict]) -> list[list]:
    rows = []
    for r in data:
        try:
            rows.append([
                r["date"],
                round(float(r["open"]), 2), round(float(r["max"]), 2),
                round(float(r["min"]), 2), round(float(r["close"]), 2),
                int(float(r["Trading_Volume"])), int(float(r["Trading_money"])),
            ])
        except (KeyError, TypeError, ValueError):
            continue
    return rows


def merge_rows(old: list[list], new: list[list]) -> list[list]:
    by_date = {r[0]: r for r in old}
    for r in new:
        by_date[r[0]] = r
    return [by_date[d] for d in sorted(by_date)]


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
        payload = {"code": code, "name": name, "market": market, "rows": rows}
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
    return 0


def build_bundle(store: Store) -> dict:
    stocks = []
    latest = ""
    for p in sorted(store.hist.glob("*.json.gz")):
        s = store.read_stock(p.name.replace(".json.gz", ""))
        if not s or len(s.get("rows", [])) < MIN_SCAN_ROWS:
            continue
        rows = s["rows"][-SCAN_DAYS:]
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
    man = build_bundle(store)
    assert man["scanStocks"] == 1 and man["stockCount"] == 2, man
    with gzip.open(store.dir / "scan.json.gz", "rb") as f:
        payload = json.loads(f.read().decode("utf-8"))
    assert payload["stocks"][0]["c"] == "9999" and len(payload["stocks"][0]["r"]) == 130
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

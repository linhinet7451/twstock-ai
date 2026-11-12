#!/usr/bin/env python3
"""台股 AI 智慧選股工作台 V2.0（網頁版）— 資料後端

架構：GitHub Actions 就是後端。本腳本在 Actions 裡執行（排程每日增量、
手動分批回補），把行情寫成靜態檔案 commit 回 repo，GitHub Pages 部署後
前端直接讀取，使用者開站即是最新資料，不需要任何人手動更新。

資料來源：FinMind API（TaiwanStockInfo / TaiwanStockPrice，涵蓋 TWSE＋TPEx，
單一請求即可取回一檔股票的完整歷史，適合回補 10 年）。
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
import gzip
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

API = "https://api.finmindtrade.com/api/v4/data"
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


def cmd_daily(args, store: Store, token: str) -> int:
    start = (date.today() - timedelta(days=14)).isoformat()
    files = sorted(store.hist.glob("*.json.gz"))
    if not files:
        log("尚無歷史檔案，請先執行 backfill")
        return 1
    log(f"每日增量：{len(files)} 檔，自 {start} 起合併")
    ok = fail = 0
    for i, p in enumerate(files):
        code = p.name.replace(".json.gz", "")
        try:
            cur = store.read_stock(code) or {"name": code, "market": "TWSE", "rows": []}
            data = fetch_json("TaiwanStockPrice", token, data_id=code, start_date=start)
            rows = rows_from_prices(data)
            if rows:
                merged = merge_rows(cur["rows"], rows)
                if merged != cur["rows"]:
                    store.write_stock(code, cur.get("name", code), cur.get("market", "TWSE"), merged)
                ok += 1
            else:
                ok += 1
        except Exception as e:
            fail += 1
            log(f"  {code} 增量失敗：{e}")
            if "429" in str(e):
                log("疑似觸及 API 配額，停止並保存已完成部分")
                break
        if (i + 1) % 200 == 0:
            log(f"  進度 {i + 1}/{len(files)}（成功 {ok}、失敗 {fail}）")
        polite_sleep(args.sleep)
    log(f"每日增量完成：成功 {ok}、失敗 {fail}")
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
        "source": "FinMind TaiwanStockPrice (TWSE/TPEx)",
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

#!/usr/bin/env python3
"""Download / refresh public/prices_cache.json (VOO, QQQ, SMH, EURUSD=X).

Default: last 10 years through today. Re-runs merge onto the existing file and
only re-download from (last cached day - a few days) when --incremental.
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "prices_cache.json"
SYMBOLS = ["VOO", "QQQ", "SMH", "EURUSD=X"]


def load_existing() -> dict:
    if not OUT.exists():
        return {"asOf": None, "prices": {s: {} for s in SYMBOLS}}
    data = json.loads(OUT.read_text())
    data.setdefault("prices", {})
    for s in SYMBOLS:
        data["prices"].setdefault(s, {})
    return data


def series_to_map(s: pd.Series) -> dict[str, float]:
    out: dict[str, float] = {}
    for idx, val in s.dropna().items():
        d = pd.Timestamp(idx).tz_localize(None).normalize().date().isoformat()
        out[d] = round(float(val), 6)
    return out


def download_range(start: date, end: date) -> dict[str, dict[str, float]]:
    # yfinance end is exclusive-ish; pad a day
    end_excl = end + timedelta(days=1)
    raw = yf.download(
        SYMBOLS,
        start=start.isoformat(),
        end=end_excl.isoformat(),
        progress=False,
        auto_adjust=True,
        threads=True,
    )
    if raw.empty:
        raise SystemExit(f"No Yahoo data for {start}..{end}")

    if isinstance(raw.columns, pd.MultiIndex):
        close = raw["Close"]
    else:
        close = raw[["Close"]].rename(columns={"Close": SYMBOLS[0]})

    close.index = pd.to_datetime(close.index).tz_localize(None).normalize()
    result: dict[str, dict[str, float]] = {}
    for sym in SYMBOLS:
        if sym not in close.columns:
            result[sym] = {}
            continue
        result[sym] = series_to_map(close[sym])
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--years",
        type=int,
        default=10,
        help="Full history window when not incremental (default 10)",
    )
    ap.add_argument(
        "--incremental",
        action="store_true",
        help="Only fetch from a few days before last cached date",
    )
    ap.add_argument(
        "--end",
        type=str,
        default=None,
        help="End date YYYY-MM-DD (default: today UTC)",
    )
    args = ap.parse_args()

    end = (
        datetime.strptime(args.end, "%Y-%m-%d").date()
        if args.end
        else date.today()
    )
    existing = load_existing()

    if args.incremental:
        lasts = []
        for sym in SYMBOLS:
            keys = sorted(existing["prices"].get(sym, {}))
            if keys:
                lasts.append(datetime.strptime(keys[-1], "%Y-%m-%d").date())
        if lasts:
            start = min(lasts) - timedelta(days=5)
        else:
            start = end - timedelta(days=365 * args.years)
    else:
        start = end - timedelta(days=365 * args.years)

    print(f"fetching {SYMBOLS} {start} → {end}")
    fresh = download_range(start, end)

    for sym in SYMBOLS:
        existing["prices"][sym].update(fresh.get(sym, {}))
        # keep sorted insert order for readability
        existing["prices"][sym] = dict(sorted(existing["prices"][sym].items()))

    existing["asOf"] = end.isoformat()
    existing["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(existing, separators=(",", ":")))
    sizes = {s: len(existing["prices"][s]) for s in SYMBOLS}
    kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT} ({kb:.1f} KiB) asOf={existing['asOf']} counts={sizes}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Build a synthetic Classic demo chart from prices_cache.json (not a real portfolio)."""

from __future__ import annotations

import json
import random
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "public" / "prices_cache.json"
OUT_CHART = ROOT / "public" / "chart_data.json"
OUT_POS = ROOT / "public" / "default_positions.json"
OUT_SAVED = ROOT / "saved_positions.json"

TICKERS = ["VOO", "QQQ", "SMH"]
COLORS = {
    "VOO": "#1f77b4",
    "QQQ": "#9467bd",
    "SMH": "#8c564b",
    "TOTAL": "#2ca02c",
    "ALL_VOO": "#d62728",
}
LABELS = {
    "VOO": "VOO",
    "QQQ": "QQQ",
    "SMH": "SMH",
    "TOTAL": "TOTAL",
    "ALL_VOO": "if all → VOO",
}

# Deterministic fake DCA schedule: (offset_days_from_start, symbol, eur_amount)
# Amounts are round demo figures — not from any brokerage statement.
DEMO_PLAN = [
    (0, "VOO", 1000),
    (18, "VOO", 750),
    (45, "QQQ", 600),
    (70, "VOO", 1200),
    (95, "SMH", 500),
    (120, "VOO", 900),
    (145, "QQQ", 800),
    (165, "SMH", 650),
    (185, "VOO", 1100),
    (200, "QQQ", 550),
    (215, "SMH", 700),
]


def ffill(series: dict[str, float], days: list[str]) -> list[float]:
    keys = sorted(series)
    last = float(keys and series[keys[0]] or 1.0)
    for k in keys:
        if k <= days[0]:
            last = series[k]
    out: list[float] = []
    for d in days:
        if d in series:
            last = series[d]
        out.append(last)
    return out


def main() -> None:
    cache = json.loads(CACHE.read_text())
    prices: dict[str, dict[str, float]] = cache["prices"]
    rng = random.Random(42)

    # Demo window: ~8 months ending at cache asOf (or last VOO day)
    end_s = cache.get("asOf") or sorted(prices["VOO"])[-1]
    end = datetime.strptime(end_s, "%Y-%m-%d").date()
    start = end - timedelta(days=230)
    # snap start to a weekday with price
    voo_days = sorted(d for d in prices["VOO"] if start.isoformat() <= d <= end_s)
    if not voo_days:
        raise SystemExit("prices_cache has no overlap for demo window")
    start = datetime.strptime(voo_days[0], "%Y-%m-%d").date()

    days = [
        (start + timedelta(days=i)).isoformat()
        for i in range((end - start).days + 1)
    ]
    fx = ffill(prices["EURUSD=X"], days)
    px = {t: ffill(prices[t], days) for t in TICKERS}

    # Materialize fake buys on nearest trading day (has VOO print)
    trading = set(prices["VOO"])
    buys_agg: dict[tuple[str, str], dict[str, float]] = {}
    for offset, sym, eur in DEMO_PLAN:
        # small jitter so it doesn't look like a perfect calendar
        jitter = rng.randint(-2, 2)
        raw = start + timedelta(days=max(0, offset + jitter))
        d = raw.isoformat()
        # walk forward to a session
        for _ in range(7):
            if d in trading and d <= end_s:
                break
            raw += timedelta(days=1)
            d = raw.isoformat()
        if d not in trading or d > end_s:
            continue
        i = days.index(d)
        rate = fx[i]
        usd = eur * rate
        qty = usd / px[sym][i]
        key = (d, sym)
        cur = buys_agg.setdefault(key, {"usd": 0.0, "qty": 0.0, "eur": 0.0})
        cur["usd"] += usd
        cur["qty"] += qty
        cur["eur"] += eur

    hold = {t: 0.0 for t in TICKERS}
    inv = {t: 0.0 for t in TICKERS}
    series = {t: [] for t in TICKERS}
    buy_pts = []
    alt_shares = 0.0
    alt_invested = 0.0
    all_voo: list[float] = []

    for i, d in enumerate(days):
        rate = fx[i]
        for sym in TICKERS:
            prev = hold[sym]
            b = buys_agg.get((d, sym))
            if b:
                hold[sym] += b["qty"]
                inv[sym] += b["eur"]
                earn = 0.0 if prev == 0 else hold[sym] * px[sym][i] / rate - inv[sym]
                buy_pts.append(
                    {
                        "id": f"{sym}-{d}",
                        "date": d,
                        "sym": sym,
                        "y": round(earn, 2),
                        "eur": round(b["eur"], 2),
                        "label": f"{sym} €{b['eur']:.0f}",
                    }
                )
            if hold[sym]:
                earn = 0.0 if prev == 0 else hold[sym] * px[sym][i] / rate - inv[sym]
            else:
                earn = 0.0
            series[sym].append(round(earn, 2))

        prev_alt = alt_shares
        voo_b = buys_agg.get((d, "VOO"))
        if voo_b:
            alt_shares += voo_b["qty"]
            alt_invested += voo_b["eur"]
        other_usd = sum(
            buys_agg[(d, s)]["usd"] for s in ("QQQ", "SMH") if (d, s) in buys_agg
        )
        if other_usd:
            alt_shares += other_usd / px["VOO"][i]
            alt_invested += other_usd / rate
        if alt_shares:
            alt_earn = (
                0.0
                if prev_alt == 0
                else alt_shares * px["VOO"][i] / rate - alt_invested
            )
        else:
            alt_earn = 0.0
        all_voo.append(round(alt_earn, 2))

    total = [
        round(series["VOO"][i] + series["QQQ"][i] + series["SMH"][i], 2)
        for i in range(len(days))
    ]
    delta = round(all_voo[-1] - total[-1], 2)
    title_day = f"{end.day} {end.strftime('%b %Y')}"

    start_title = f"{start.day} {start.strftime('%b %Y')}"
    chart = {
        "asOf": end.isoformat(),
        "source": "demo",
        "dates": days,
        "tickers": TICKERS,
        "baseline": "VOO",
        "series": {**series, "TOTAL": total, "ALL_VOO": all_voo},
        "deltaAllVoo": delta,
        "buys": buy_pts,
        "colors": COLORS,
        "labels": {**LABELS, "ALL_VOO": "if all → VOO"},
        "title": (
            f"Demo earnings ({', '.join(TICKERS)}) · {start_title} → {title_day}"
        ),
    }
    OUT_CHART.write_text(json.dumps(chart))

    # Short leader-line layout (mirrors the in-app auto placer)
    day_ms = 86400000
    y_gap = 24
    placed: list[tuple[float, float, float]] = []

    def half_w(label: str) -> float:
        return max(len(label) * 0.28, 3.2) * day_ms

    def overlaps(lx: float, ly: float, label: str) -> bool:
        w = half_w(label)
        return any(
            abs(lx - plx) < (w + pw) * 0.7 and abs(ly - ply) < y_gap
            for plx, ply, pw in placed
        )

    positions = {}
    ordered = sorted(buy_pts, key=lambda x: (x["date"], x["sym"]))
    for i, b in enumerate(ordered):
        t = (
            datetime.strptime(b["date"], "%Y-%m-%d")
            .replace(tzinfo=timezone.utc)
            .timestamp()
            * 1000
        )
        y = float(b["y"])
        near = sum(
            1
            for o in ordered[:i]
            if abs(
                datetime.strptime(o["date"], "%Y-%m-%d")
                .replace(tzinfo=timezone.utc)
                .timestamp()
                * 1000
                - t
            )
            < 12 * day_ms
        )
        prefer_up = near % 2 == 0
        primary = [14, 22, 30] if prefer_up else [-14, -22, -30]
        secondary = [-14, -22, -30] if prefer_up else [14, 22, 30]
        ys = [*primary, *secondary, 40 if prefer_up else -40, -40 if prefer_up else 40]
        xs = (0.8, 1.3, 1.8, -0.8, 2.2, -1.3)
        slots = [(t + dx * day_ms, y + dy) for dy in ys for dx in xs]
        chosen = slots[0]
        for s in slots:
            if not overlaps(s[0], s[1], b["label"]):
                chosen = s
                break
        placed.append((chosen[0], chosen[1], half_w(b["label"])))
        positions[b["id"]] = {
            "lx": chosen[0],
            "ly": round(chosen[1], 2),
        }
    payload = {"buys": positions}
    OUT_POS.write_text(json.dumps(payload, indent=2) + "\n")
    OUT_SAVED.write_text(json.dumps(payload, indent=2) + "\n")

    print(f"wrote demo chart days={len(days)} buys={len(buy_pts)} asOf={end}")
    print("ends", {k: v[-1] for k, v in chart["series"].items()})
    print("buy ids:", [b["id"] for b in buy_pts])


if __name__ == "__main__":
    main()

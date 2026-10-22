# Invest Calculator

Portfolio earnings chart in the browser:

- Upload a brokerage **Activity Statement** CSV (Interactive Brokers format)
- Keep a synthetic **Classic (demo)** chart plus your private uploads in a left sidebar (uploads stay in browser `localStorage` only; trash to delete)
- Drag buy-point labels (saved per portfolio)
- Toggle series (including **if all → VOO** — same cash, all into VOO)
- **Refresh to today** — rebuild active portfolio with latest prices through today
- Export PNG

Live (GitHub Pages): after enabling Pages,  
`https://denyspiven.github.io/InvestCalculator/`

## Local

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43127](http://127.0.0.1:43127).

## GitHub Pages

1. Push to `main` or `master`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. The workflow `.github/workflows/deploy-pages.yml` builds with
   `VITE_BASE=/InvestCalculator/` and deploys `dist/`.

## Data

- **Price cache:** `public/prices_cache.json` holds ~10y daily closes for VOO / QQQ / SMH / EURUSD. Refresh locally with `npm run update-prices` (incremental) or `npm run update-prices:full`. CI refreshes the cache on every Pages deploy and on a weekday schedule (no flaky browser CORS relays). On GitHub Pages, equity prices come only from that cache; EURUSD tip uses [Frankfurter](https://www.frankfurter.app/) (CORS-friendly). Local `npm run dev` can still tip equities via the Vite Yahoo proxy.
- **Upload:** client reads equity tickers / dates / amounts from the Trades section, builds matching series, and sets the time axis from first buy → today. Prices come from the bundled cache (add more with `python3 scripts/update_prices_cache.py --symbols SPY,IWM`). Earnings = **total return**: market value − invested + net dividends (€, after withholding); open day starts at €0 for the price leg. Dividend rows come from the statement’s Dividends / Withholding Tax sections (diamond markers on the chart). **Invested (`in`)** uses net EUR funding from **Deposits & Withdrawals** (or Cash Report Deposits − Withdrawals): TOTAL and the sum of per-ticker `in` both equal what you actually deposited (FX conversion vs mid-market included). Trade `Basis` already includes IBKR commission. Use a statement period that covers all deposits; after uploading, **Refresh to today** rebuilds older saved charts.
- **Classic demo:** synthetic buys in `public/chart_data.json` (regenerate with `python3 scripts/generate_demo_chart.py`). Not a real brokerage statement.
- **Your uploads** never leave the browser; they are not committed to the repo.

## Notes

- End labels sit on the far right at their own Y (no arrows).
- On GitHub Pages, label positions persist in the browser only (no server write).

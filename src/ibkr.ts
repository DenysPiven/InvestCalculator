/** Parse IBKR Activity Statement CSV and build EUR earnings series in the browser. */

export type BuyPoint = {
  id: string
  date: string
  sym: string
  y: number
  eur: number
  label: string
}

export type ChartData = {
  asOf?: string
  dates: string[]
  /** Equity tickers present in this portfolio (from CSV or demo). */
  tickers: string[]
  /** Counterfactual benchmark symbol (prefer VOO when prices exist). */
  baseline: string
  series: Record<string, number[]>
  buys: BuyPoint[]
  colors: Record<string, string>
  labels: Record<string, string>
  deltaAllVoo: number
  title: string
  source?: string
  /** First day each ticker had a position (for avg/BE guides). */
  holdFrom?: Record<string, string>
  /** Volume-weighted average fill price (USD) per ticker. */
  avgCostUsd?: Record<string, number>
}

/** @deprecated use string series keys; kept for older call sites */
export type SeriesKey = string

const PALETTE = [
  '#1f77b4',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#17becf',
  '#ff7f0e',
  '#bcbd22',
  '#7f7f7f',
  '#aec7e8',
  '#c5b0d5',
]

export const CHART_COLORS: Record<string, string> = {
  VOO: '#1f77b4',
  QQQ: '#9467bd',
  SMH: '#8c564b',
  TOTAL: '#2ca02c',
  ALL_VOO: '#d62728',
}

export const CHART_LABELS: Record<string, string> = {
  VOO: 'VOO',
  QQQ: 'QQQ',
  SMH: 'SMH',
  TOTAL: 'TOTAL',
  ALL_VOO: 'if all → VOO',
}

type Trade = { date: string; sym: string; usd: number; qty: number }

/** Minimal CSV row splitter (handles quoted commas). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQ = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function isEquitySymbol(sym: string): boolean {
  // IBKR stock/ETF symbols; skip FX pairs and odd cash markers
  if (!sym || sym.length > 12) return false
  if (sym.includes('=')) return false
  if (sym.includes(' ')) return false
  return /^[A-Z][A-Z0-9./^-]*$/.test(sym)
}

export function parseIbkrTrades(csvText: string): Trade[] {
  const text = csvText.replace(/^\uFEFF/, '')
  const trades: Trade[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseCsvLine(line)
    if (
      row.length < 12 ||
      row[0] !== 'Trades' ||
      row[1] !== 'Data' ||
      row[2] !== 'Order'
    ) {
      continue
    }
    // Stocks / Equity; some statements label ETFs as Stocks
    const asset = row[3]
    if (asset !== 'Stocks' && asset !== 'Equity') continue
    const sym = row[5].trim().toUpperCase()
    if (!isEquitySymbol(sym)) continue
    const date = row[6].split(',')[0].trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const qty = Number(String(row[7]).replace(/,/g, ''))
    const proceeds = Number(String(row[10]).replace(/,/g, ''))
    if (!(qty > 0) || !Number.isFinite(proceeds)) continue
    trades.push({ date, sym, usd: -proceeds, qty })
  }
  if (!trades.length) {
    throw new Error(
      'No stock buys found. Upload an Activity Statement CSV (Trades section).',
    )
  }
  return trades
}

export function seriesKeys(data: ChartData): string[] {
  const tickers = data.tickers?.length
    ? data.tickers
    : Object.keys(data.series).filter((k) => k !== 'TOTAL' && k !== 'ALL_VOO')
  return [...tickers, 'TOTAL', 'ALL_VOO']
}

export function colorFor(sym: string, index = 0): string {
  if (sym === 'TOTAL') return CHART_COLORS.TOTAL
  if (sym === 'ALL_VOO') return CHART_COLORS.ALL_VOO
  if (CHART_COLORS[sym]) return CHART_COLORS[sym]
  return PALETTE[index % PALETTE.length]
}

function dayMs(iso: string) {
  return new Date(iso + 'T00:00:00Z').getTime()
}

function isoFromMs(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

function eachDay(startIso: string, endIso: string): string[] {
  const out: string[] = []
  for (let t = dayMs(startIso); t <= dayMs(endIso); t += 86400000) {
    out.push(isoFromMs(t))
  }
  return out
}

async function fetchJson<T>(url: string, ms = 8000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json() as Promise<T>
}

export function assetUrl(path: string) {
  const base = import.meta.env.BASE_URL || '/'
  const p = path.startsWith('/') ? path.slice(1) : path
  return `${base}${p}`
}

type PricesCache = {
  asOf?: string
  prices: Record<string, Record<string, number>>
}

let pricesCachePromise: Promise<PricesCache | null> | null = null

function loadPricesCache() {
  if (!pricesCachePromise) {
    pricesCachePromise = fetch(`${assetUrl('prices_cache.json')}?t=${Date.now()}`)
      .then((r) => (r.ok ? (r.json() as Promise<PricesCache>) : null))
      .catch(() => null)
  }
  return pricesCachePromise
}

function mapFromCache(
  cache: PricesCache | null,
  symbol: string,
): Map<string, number> {
  const src = cache?.prices?.[symbol]
  if (!src) return new Map()
  return new Map(Object.entries(src))
}

function mapExtent(map: Map<string, number>): { first: string; last: string } | null {
  if (!map.size) return null
  let first = ''
  let last = ''
  for (const k of map.keys()) {
    if (!first || k < first) first = k
    if (!last || k > last) last = k
  }
  return { first, last }
}

function mergeMaps(base: Map<string, number>, extra: Map<string, number>) {
  for (const [d, v] of extra) base.set(d, v)
  return base
}

function parseYahooCloses(data: {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: { quote?: Array<{ close?: Array<number | null> }> }
    }>
  }
}): Map<string, number> {
  const result = data.chart?.result?.[0]
  const ts = result?.timestamp
  const close = result?.indicators?.quote?.[0]?.close
  if (!ts?.length || !close?.length) throw new Error('empty yahoo result')
  const map = new Map<string, number>()
  for (let i = 0; i < ts.length; i++) {
    const c = close[i]
    if (c == null || !Number.isFinite(c)) continue
    map.set(isoFromMs(ts[i] * 1000), c)
  }
  if (!map.size) throw new Error('no closes')
  return map
}

/** Live Yahoo via Vite dev proxy (GitHub Pages has no CORS path). */
async function fetchLiveYahooCloses(
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number> | null> {
  if (!import.meta.env.DEV) return null
  const period1 = Math.floor(dayMs(startIso) / 1000) - 86400
  const period2 = Math.floor(dayMs(endIso) / 1000) + 86400
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`
  try {
    return parseYahooCloses(await fetchJson(`/api/yahoo${path}`, 12000))
  } catch {
    return null
  }
}

async function fetchYahooCloses(
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const cached = mapFromCache(await loadPricesCache(), symbol)
  const ext = mapExtent(cached)

  if (ext) {
    if (endIso > ext.last) {
      const gapStart = isoFromMs(dayMs(ext.last) - 2 * 86400000)
      const live = await fetchLiveYahooCloses(symbol, gapStart, endIso)
      if (live) mergeMaps(cached, live)
    }
    if (startIso < ext.first) {
      const live = await fetchLiveYahooCloses(symbol, startIso, ext.first)
      if (live) mergeMaps(cached, live)
    }
  } else {
    const live = await fetchLiveYahooCloses(symbol, startIso, endIso)
    if (live) mergeMaps(cached, live)
  }

  if (!cached.size) {
    throw new Error(
      `No prices for ${symbol} (${startIso}…${endIso}). Add it with: python3 scripts/update_prices_cache.py --symbols ${symbol}`,
    )
  }
  return cached
}

async function fetchEurUsd(
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const cached = mapFromCache(await loadPricesCache(), 'EURUSD=X')
  const ext = mapExtent(cached)

  let fetchStart = startIso
  if (ext) {
    if (endIso <= ext.last && startIso >= ext.first) return cached
    if (endIso > ext.last) {
      fetchStart = isoFromMs(dayMs(ext.last) - 3 * 86400000)
    }
  }

  try {
    const data = await fetchJson<{
      rates: Record<string, { USD: number }>
    }>(
      `https://api.frankfurter.dev/v1/${fetchStart}..${endIso}?from=EUR&to=USD`,
      6000,
    )
    for (const [d, r] of Object.entries(data.rates ?? {})) {
      if (r?.USD) cached.set(d, r.USD)
    }
  } catch {
    /* keep cache */
  }

  if (ext && endIso > ext.last) {
    const live = await fetchLiveYahooCloses(
      'EURUSD=X',
      isoFromMs(dayMs(ext.last) - 2 * 86400000),
      endIso,
    )
    if (live) mergeMaps(cached, live)
  }

  if (cached.size) return cached
  return fetchYahooCloses('EURUSD=X', startIso, endIso)
}

function ffill(map: Map<string, number>, days: string[]): number[] {
  const out: number[] = []
  let last = NaN
  for (const d of [...map.keys()].sort()) {
    if (d <= days[0]) last = map.get(d)!
  }
  if (!Number.isFinite(last)) {
    const first = [...map.values()][0]
    last = first
  }
  for (const d of days) {
    if (map.has(d)) last = map.get(d)!
    out.push(last)
  }
  return out
}

async function pickBaseline(
  tickers: string[],
  startIso: string,
  endIso: string,
): Promise<{ baseline: string; map: Map<string, number> }> {
  // Prefer VOO as the "if all → …" benchmark when prices exist.
  const preferred = ['VOO', ...tickers.filter((t) => t !== 'VOO')]
  for (const sym of preferred) {
    try {
      const map = await fetchYahooCloses(sym, startIso, endIso)
      if (map.size) return { baseline: sym, map }
    } catch {
      /* try next */
    }
  }
  throw new Error(`No benchmark prices for tickers: ${tickers.join(', ')}`)
}

export async function buildChartFromIbkrCsv(
  csvText: string,
  opts?: { endDate?: string },
): Promise<ChartData> {
  const trades = parseIbkrTrades(csvText)
  const tickers = [...new Set(trades.map((t) => t.sym))].sort()
  const tradeDates = trades.map((t) => t.date).sort()
  const start = tradeDates[0]
  const lastTrade = tradeDates[tradeDates.length - 1]
  const today = new Date().toISOString().slice(0, 10)
  const end = opts?.endDate ?? (today > lastTrade ? today : lastTrade)

  const padStart = isoFromMs(dayMs(start) - 2 * 86400000)
  const fxMap = await fetchEurUsd(padStart, end)
  const { baseline, map: baselineMap } = await pickBaseline(
    tickers,
    padStart,
    end,
  )

  const priceMaps = new Map<string, Map<string, number>>()
  priceMaps.set(baseline, baselineMap)
  await Promise.all(
    tickers.map(async (sym) => {
      if (priceMaps.has(sym)) return
      priceMaps.set(sym, await fetchYahooCloses(sym, padStart, end))
    }),
  )

  const days = eachDay(start, end)
  const fx = ffill(fxMap, days)
  const px: Record<string, number[]> = {}
  for (const sym of new Set([...tickers, baseline])) {
    px[sym] = ffill(priceMaps.get(sym)!, days)
  }

  const buysAgg = new Map<string, { usd: number; qty: number }>()
  for (const t of trades) {
    const key = `${t.date}|${t.sym}`
    const cur = buysAgg.get(key) ?? { usd: 0, qty: 0 }
    cur.usd += t.usd
    cur.qty += t.qty
    buysAgg.set(key, cur)
  }

  const hold: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]))
  const inv: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]))
  const costUsd: Record<string, number> = Object.fromEntries(
    tickers.map((t) => [t, 0]),
  )
  const holdFrom: Record<string, string> = {}
  const series: Record<string, number[]> = Object.fromEntries(
    tickers.map((t) => [t, [] as number[]]),
  )
  const buys: BuyPoint[] = []
  const allBase: number[] = []
  let altShares = 0
  let altInvested = 0

  days.forEach((d, i) => {
    const rate = fx[i]
    for (const sym of tickers) {
      const prevHold = hold[sym]
      const b = buysAgg.get(`${d}|${sym}`)
      if (b) {
        const eur = b.usd / rate
        hold[sym] += b.qty
        inv[sym] += eur
        costUsd[sym] += b.usd
        if (!holdFrom[sym]) holdFrom[sym] = d
        const earn =
          prevHold === 0
            ? 0
            : (hold[sym] * px[sym][i]) / rate - inv[sym]
        buys.push({
          id: `${sym}-${d}`,
          date: d,
          sym,
          y: Math.round(earn * 100) / 100,
          eur: Math.round(eur * 100) / 100,
          label: `${sym} €${Math.round(eur)}`,
        })
      }
      let earn = hold[sym]
        ? (hold[sym] * px[sym][i]) / rate - inv[sym]
        : 0
      if (prevHold === 0 && hold[sym] > 0) earn = 0
      series[sym].push(Math.round(earn * 100) / 100)
    }

    // Counterfactual: keep real baseline fills; redirect other cash into baseline.
    const prevAlt = altShares
    const baseBuy = buysAgg.get(`${d}|${baseline}`)
    if (baseBuy) {
      altShares += baseBuy.qty
      altInvested += baseBuy.usd / rate
    }
    let otherUsd = 0
    for (const sym of tickers) {
      if (sym === baseline) continue
      otherUsd += buysAgg.get(`${d}|${sym}`)?.usd ?? 0
    }
    if (otherUsd > 0) {
      altShares += otherUsd / px[baseline][i]
      altInvested += otherUsd / rate
    }
    let altEarn = altShares
      ? (altShares * px[baseline][i]) / rate - altInvested
      : 0
    if (prevAlt === 0 && altShares > 0) altEarn = 0
    allBase.push(Math.round(altEarn * 100) / 100)
  })

  const total = days.map((_, i) =>
    Math.round(tickers.reduce((s, t) => s + series[t][i], 0) * 100) / 100,
  )
  const deltaAllVoo =
    Math.round((allBase[allBase.length - 1] - total[total.length - 1]) * 100) /
    100

  const endDate = new Date(end + 'T00:00:00')
  const titleDay = `${endDate.getUTCDate()} ${endDate.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })} ${endDate.getUTCFullYear()}`
  const startDate = new Date(start + 'T00:00:00')
  const startDay = `${startDate.getUTCDate()} ${startDate.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })} ${startDate.getUTCFullYear()}`

  const colors: Record<string, string> = {
    TOTAL: CHART_COLORS.TOTAL,
    ALL_VOO: CHART_COLORS.ALL_VOO,
  }
  const labels: Record<string, string> = {
    TOTAL: 'TOTAL',
    ALL_VOO: `if all → ${baseline}`,
  }
  tickers.forEach((t, i) => {
    colors[t] = colorFor(t, i)
    labels[t] = t
  })

  const avgCostUsd: Record<string, number> = {}
  for (const t of tickers) {
    if (hold[t] > 0) avgCostUsd[t] = Math.round((costUsd[t] / hold[t]) * 100) / 100
  }

  return {
    asOf: end,
    dates: days,
    tickers,
    baseline,
    series: {
      ...series,
      TOTAL: total,
      ALL_VOO: allBase,
    },
    buys,
    colors,
    labels,
    deltaAllVoo,
    holdFrom,
    avgCostUsd,
    title: `Earnings + buys (${tickers.join(', ')}) · ${startDay} → ${titleDay}`,
    source: 'upload',
  }
}

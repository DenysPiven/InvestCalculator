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
  series: Record<string, number[]>
  buys: BuyPoint[]
  colors: Record<string, string>
  labels: Record<string, string>
  title: string
  source?: string
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
}

export const CHART_LABELS: Record<string, string> = {
  VOO: 'VOO',
  QQQ: 'QQQ',
  SMH: 'SMH',
  TOTAL: 'TOTAL',
}

type Trade = { date: string; sym: string; usd: number; qty: number }

function numCell(v: string | undefined): number {
  if (v == null || v === '') return NaN
  return Number(String(v).replace(/,/g, ''))
}

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
  // Map header names → column index (IBKR inserts optional columns like Account).
  let col: Record<string, number> | null = null

  const idx = (name: string) => (col ? col[name] : -1)
  const cell = (row: string[], name: string) => {
    const i = idx(name)
    return i >= 0 ? row[i] : undefined
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseCsvLine(line)
    if (row[0] !== 'Trades') continue

    if (row[1] === 'Header') {
      col = {}
      row.forEach((h, i) => {
        if (h) col![h] = i
      })
      continue
    }

    if (row[1] !== 'Data' || row[2] !== 'Order' || !col) continue

    // Stocks / Equity; some statements label ETFs as Stocks
    const asset = cell(row, 'Asset Category') ?? row[3]
    if (asset !== 'Stocks' && asset !== 'Equity') continue

    // USD book only for now (Yahoo prices + EURUSD path). EUR-listed names need a
    // separate pipeline; skipping avoids double-converting local-currency proceeds.
    const ccy = (cell(row, 'Currency') ?? 'USD').toUpperCase()
    if (ccy !== 'USD') continue

    const sym = (cell(row, 'Symbol') ?? '').trim().toUpperCase()
    if (!isEquitySymbol(sym)) continue

    const dateRaw = cell(row, 'Date/Time') ?? ''
    const date = dateRaw.split(',')[0].trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

    const qty = numCell(cell(row, 'Quantity'))
    if (!(qty > 0)) continue

    const proceeds = numCell(cell(row, 'Proceeds'))
    const comm = numCell(cell(row, 'Comm/Fee'))
    const basis = numCell(cell(row, 'Basis'))
    // IBKR Basis for opens = cost including commission; else Proceeds+Comm.
    // Proceeds/Comm are negative on buys; Basis is positive cost.
    let usd = NaN
    if (Number.isFinite(basis) && basis > 0) usd = basis
    else if (Number.isFinite(proceeds)) {
      usd = -proceeds + (Number.isFinite(comm) ? -comm : 0)
    }
    if (!(usd > 0) || !Number.isFinite(usd)) continue

    trades.push({ date, sym, usd, qty })
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
  return [...tickers, 'TOTAL']
}

export function colorFor(sym: string, index = 0): string {
  if (sym === 'TOTAL') return CHART_COLORS.TOTAL
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

/** Drop in-memory price cache so the next build reloads prices_cache.json. */
export function invalidatePricesCache() {
  pricesCachePromise = null
}

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

/** Live Yahoo: Vite proxy in dev; direct + CORS relay on Pages. */
async function fetchLiveYahooCloses(
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number> | null> {
  const period1 = Math.floor(dayMs(startIso) / 1000) - 86400
  const period2 = Math.floor(dayMs(endIso) / 1000) + 86400
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`
  const yahooUrl = `https://query1.finance.yahoo.com${path}`
  const urls = import.meta.env.DEV
    ? [`/api/yahoo${path}`, yahooUrl]
    : [
        yahooUrl,
        // Relay so GitHub Pages can fill days past the bundled cache.
        `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`,
      ]
  for (const url of urls) {
    try {
      return parseYahooCloses(await fetchJson(url, 14000))
    } catch {
      /* try next source */
    }
  }
  return null
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

  const priceMaps = new Map<string, Map<string, number>>()
  await Promise.all(
    tickers.map(async (sym) => {
      priceMaps.set(sym, await fetchYahooCloses(sym, padStart, end))
    }),
  )

  const days = eachDay(start, end)
  const fx = ffill(fxMap, days)
  const px: Record<string, number[]> = {}
  for (const sym of tickers) {
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
  const series: Record<string, number[]> = Object.fromEntries(
    tickers.map((t) => [t, [] as number[]]),
  )
  const buys: BuyPoint[] = []

  days.forEach((d, i) => {
    const rate = fx[i]
    for (const sym of tickers) {
      const prevHold = hold[sym]
      const b = buysAgg.get(`${d}|${sym}`)
      if (b) {
        const eur = b.usd / rate
        hold[sym] += b.qty
        inv[sym] += eur
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
  })

  const total = days.map((_, i) =>
    Math.round(tickers.reduce((s, t) => s + series[t][i], 0) * 100) / 100,
  )

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
  }
  const labels: Record<string, string> = {
    TOTAL: 'TOTAL',
  }
  tickers.forEach((t, i) => {
    colors[t] = colorFor(t, i)
    labels[t] = t
  })

  return {
    asOf: end,
    dates: days,
    tickers,
    series: {
      ...series,
      TOTAL: total,
    },
    buys,
    colors,
    labels,
    title: `Earnings + buys (${tickers.join(', ')}) · ${startDay} → ${titleDay}`,
    source: 'upload',
  }
}

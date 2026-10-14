/** Parse IBKR Activity Statement CSV and build EUR earnings series in the browser. */

export type SeriesKey = 'VOO' | 'QQQ' | 'SMH' | 'TOTAL' | 'ALL_VOO'

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
  series: Record<SeriesKey, number[]>
  buys: BuyPoint[]
  colors: Record<SeriesKey, string>
  labels: Record<SeriesKey, string>
  deltaAllVoo: number
  title: string
  source?: string
}

const TICKERS = ['VOO', 'QQQ', 'SMH'] as const

export const CHART_COLORS: Record<SeriesKey, string> = {
  VOO: '#1f77b4',
  QQQ: '#9467bd',
  SMH: '#8c564b',
  TOTAL: '#2ca02c',
  ALL_VOO: '#d62728',
}

export const CHART_LABELS: Record<SeriesKey, string> = {
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
      row[2] !== 'Order' ||
      row[3] !== 'Stocks'
    ) {
      continue
    }
    const sym = row[5]
    if (!(TICKERS as readonly string[]).includes(sym)) continue
    const date = row[6].split(',')[0].trim()
    const qty = Number(String(row[7]).replace(/,/g, ''))
    const proceeds = Number(String(row[10]).replace(/,/g, ''))
    if (!(qty > 0) || !Number.isFinite(proceeds)) continue
    trades.push({ date, sym, usd: -proceeds, qty })
  }
  if (!trades.length) {
    throw new Error(
      'No stock buys found. Upload an IBKR Activity Statement CSV (Trades section).',
    )
  }
  return trades
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

/** Live Yahoo only via Vite dev proxy (GitHub Pages has no CORS path). */
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

/**
 * Daily closes from the 10y bundled cache; only requests the missing gap
 * after (or before) the cache when running in local Vite.
 */
async function fetchYahooCloses(
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const cached = mapFromCache(await loadPricesCache(), symbol)
  const ext = mapExtent(cached)

  if (ext) {
    // Tail gap: only fetch days after the last cached close.
    if (endIso > ext.last) {
      const gapStart = isoFromMs(dayMs(ext.last) - 2 * 86400000)
      const live = await fetchLiveYahooCloses(symbol, gapStart, endIso)
      if (live) mergeMaps(cached, live)
    }
    // Head gap (rare with a 10y cache).
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
      `No prices for ${symbol} (${startIso}…${endIso}). Run: python3 scripts/update_prices_cache.py`,
    )
  }
  return cached
}

/** EUR→USD (USD per EUR): cache first, Frankfurter only for the new tail. */
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
    /* keep cache / Yahoo gap below */
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
  // seed from first known on/before start
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
  const tradeDates = trades.map((t) => t.date).sort()
  const start = tradeDates[0]
  const today = new Date().toISOString().slice(0, 10)
  const end = opts?.endDate ?? (today > tradeDates[tradeDates.length - 1]
    ? today
    : tradeDates[tradeDates.length - 1])

  const padStart = isoFromMs(dayMs(start) - 2 * 86400000)
  const [fxMap, vooMap, qqqMap, smhMap] = await Promise.all([
    fetchEurUsd(padStart, end),
    fetchYahooCloses('VOO', padStart, end),
    fetchYahooCloses('QQQ', padStart, end),
    fetchYahooCloses('SMH', padStart, end),
  ])

  const days = eachDay(start, end)
  const fx = ffill(fxMap, days)
  const px: Record<(typeof TICKERS)[number], number[]> = {
    VOO: ffill(vooMap, days),
    QQQ: ffill(qqqMap, days),
    SMH: ffill(smhMap, days),
  }

  const buysAgg = new Map<string, { usd: number; qty: number }>()
  for (const t of trades) {
    const key = `${t.date}|${t.sym}`
    const cur = buysAgg.get(key) ?? { usd: 0, qty: 0 }
    cur.usd += t.usd
    cur.qty += t.qty
    buysAgg.set(key, cur)
  }
  const hold: Record<string, number> = { VOO: 0, QQQ: 0, SMH: 0 }
  const inv: Record<string, number> = { VOO: 0, QQQ: 0, SMH: 0 }
  const series: Record<(typeof TICKERS)[number], number[]> = {
    VOO: [],
    QQQ: [],
    SMH: [],
  }
  const buys: BuyPoint[] = []
  const allVoo: number[] = []
  let altShares = 0
  let altInvested = 0

  days.forEach((d, i) => {
    const rate = fx[i]
    for (const sym of TICKERS) {
      const prevHold = hold[sym]
      const key = `${d}|${sym}`
      const b = buysAgg.get(key)
      if (b) {
        const eur = b.usd / rate
        hold[sym] += b.qty
        inv[sym] += eur
        // Open day: mark at cost so the series starts at 0 (not EOD vs fill).
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
    // Counterfactual: keep real VOO fills as-is; only redirect non-VOO cash into VOO
    // at that day's VOO price. When the portfolio is VOO-only, ALL_VOO == VOO.
    const prevAlt = altShares
    const vooBuy = buysAgg.get(`${d}|VOO`)
    if (vooBuy) {
      altShares += vooBuy.qty
      altInvested += vooBuy.usd / rate
    }
    let otherUsd = 0
    for (const sym of TICKERS) {
      if (sym === 'VOO') continue
      otherUsd += buysAgg.get(`${d}|${sym}`)?.usd ?? 0
    }
    if (otherUsd > 0) {
      altShares += otherUsd / px.VOO[i]
      altInvested += otherUsd / rate
    }
    let altEarn = altShares
      ? (altShares * px.VOO[i]) / rate - altInvested
      : 0
    if (prevAlt === 0 && altShares > 0) altEarn = 0
    allVoo.push(Math.round(altEarn * 100) / 100)
  })

  const total = days.map((_, i) =>
    Math.round((series.VOO[i] + series.QQQ[i] + series.SMH[i]) * 100) / 100,
  )
  const deltaAllVoo =
    Math.round((allVoo[allVoo.length - 1] - total[total.length - 1]) * 100) /
    100
  const endDate = new Date(end + 'T00:00:00')
  const titleDay = `${endDate.getUTCDate()} ${endDate.toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  })} ${endDate.getUTCFullYear()}`

  return {
    asOf: end,
    dates: days,
    series: {
      VOO: series.VOO,
      QQQ: series.QQQ,
      SMH: series.SMH,
      TOTAL: total,
      ALL_VOO: allVoo,
    },
    buys,
    colors: CHART_COLORS,
    labels: CHART_LABELS,
    deltaAllVoo,
    title: `Earnings + buy points (ticker & amount in €) · through ${titleDay}`,
    source: 'upload',
  }
}

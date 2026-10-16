/** Parse IBKR Activity Statement CSV and build EUR earnings series in the browser. */

export type BuyPoint = {
  id: string
  date: string
  sym: string
  y: number
  eur: number
  label: string
}

/** Cash dividend / withholding event (shown as markers; folded into series). */
export type DivPoint = {
  id: string
  date: string
  sym: string
  y: number
  /** Net EUR for this payment (gross + withholding). */
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
  /** Dividend markers (optional; older saved charts may omit). */
  divs?: DivPoint[]
  /** Cumulative net dividends received per series key (EUR). */
  dividendsEur?: Record<string, number>
  /**
   * Net account funding in EUR (deposits − withdrawals) from the statement.
   * When set, TOTAL “in” and Σ(per-ticker in) both equal this — the real
   * money you put in, including broker FX vs mid-market.
   */
  fundingEur?: number
  /** Counterfactual benchmark symbol (prefer VOO when prices exist). */
  baseline?: string
  /** Last ALL_VOO earnings − TOTAL (same cash, all in baseline). */
  deltaAllVoo?: number
  colors: Record<string, string>
  labels: Record<string, string>
  title: string
  source?: string
}

/** @deprecated use string series keys; kept for older call sites */
export type SeriesKey = string

export type UiTheme = 'dark' | 'light'

const PALETTE_DARK = [
  '#62b0f0',
  '#2dd4bf',
  '#fb923c',
  '#f472b6',
  '#38bdf8',
  '#fbbf24',
  '#a3e635',
  '#94a3b8',
  '#7dd3fc',
  '#5eead4',
]

const PALETTE_LIGHT = [
  '#1f77b4',
  '#0f766e',
  '#c2410c',
  '#be185d',
  '#0284c7',
  '#d97706',
  '#65a30d',
  '#57534e',
  '#38bdf8',
  '#14b8a6',
]

/** Series colors tuned per theme for contrast on the chart stage. */
export const CHART_COLORS_BY_THEME: Record<
  UiTheme,
  Record<string, string>
> = {
  dark: {
    VOO: '#62b0f0',
    QQQ: '#2dd4bf',
    SMH: '#fb923c',
    TOTAL: '#4ade80',
    ALL_VOO: '#f87171',
  },
  light: {
    VOO: '#1f77b4',
    QQQ: '#0f766e',
    SMH: '#c2410c',
    TOTAL: '#15803d',
    ALL_VOO: '#dc2626',
  },
}

/** @deprecated prefer CHART_COLORS_BY_THEME[theme] */
export const CHART_COLORS = CHART_COLORS_BY_THEME.dark

export const CHART_LABELS: Record<string, string> = {
  VOO: 'VOO',
  QQQ: 'QQQ',
  SMH: 'SMH',
  TOTAL: 'TOTAL',
  ALL_VOO: 'if all → VOO',
}

type Trade = { date: string; sym: string; usd: number; qty: number }
type DivCash = { date: string; sym: string; usd: number }

function numCell(v: string | undefined): number {
  if (v == null || v === '') return NaN
  return Number(String(v).replace(/,/g, ''))
}

/** Pull ticker from IBKR dividend description: `VOO(US922…) Cash Dividend…`. */
function symFromDivDescription(desc: string, symbolCol?: string): string | null {
  const fromCol = (symbolCol ?? '').trim().toUpperCase()
  if (fromCol && isEquitySymbol(fromCol)) return fromCol
  const m = /^([A-Z][A-Z0-9./^-]*)\s*\(/i.exec(desc.trim())
  if (!m) return null
  const sym = m[1].toUpperCase()
  return isEquitySymbol(sym) ? sym : null
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

/**
 * Net cash from Dividends + Withholding Tax (+ Payment In Lieu).
 * Amounts are in the statement currency (we keep USD rows only).
 * Withholding is negative, so summing yields net cash received.
 */
/** True for EUR / base-currency summary rows on a EUR-denominated account. */
function isEurBaseCcy(ccy: string, summary = ''): boolean {
  const c = ccy.trim().toUpperCase()
  const s = summary.trim()
  if (!c && !s) return true
  return (
    c === 'EUR' ||
    c === 'BASE CURRENCY SUMMARY' ||
    /^Base Currency Summary$/i.test(s) ||
    /^Base Currency Summary$/i.test(c)
  )
}

function cashReportAmount(
  row: string[],
  col: Record<string, number> | null,
): number {
  const cell = (name: string) => {
    const i = col?.[name] ?? -1
    return i >= 0 ? row[i] : undefined
  }
  let amount = numCell(cell('Total'))
  if (!Number.isFinite(amount)) {
    for (const c of row.slice(2)) {
      const v = numCell(c)
      if (Number.isFinite(v)) {
        amount = v
        break
      }
    }
  }
  return amount
}

/**
 * Net EUR deposits − withdrawals from “Deposits & Withdrawals”.
 * Returns null when the section is missing (keep trade-basis invested).
 */
export function parseIbkrNetDepositsEur(csvText: string): number | null {
  const text = csvText.replace(/^\uFEFF/, '')
  let col: Record<string, number> | null = null
  let sum = 0
  let n = 0

  const cell = (row: string[], name: string) => {
    const i = col?.[name] ?? -1
    return i >= 0 ? row[i] : undefined
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseCsvLine(line)
    const section = row[0] ?? ''
    // IBKR labels vary slightly across statement versions.
    if (
      !/^Deposits\s*(&|and|\/)\s*Withdrawals$/i.test(section) &&
      !/^Deposit\/Withdrawal$/i.test(section)
    ) {
      continue
    }

    if (row[1] === 'Header') {
      col = {}
      row.forEach((h, i) => {
        if (h) col![h] = i
      })
      continue
    }
    if (row[1] !== 'Data' || !col) continue

    const ccy = (cell(row, 'Currency') ?? '').trim().toUpperCase()
    const desc = (cell(row, 'Description') ?? '').trim().toLowerCase()
    if (ccy === 'TOTAL' || desc === 'total' || desc.startsWith('total ')) continue
    if (ccy && !isEurBaseCcy(ccy)) continue

    const amount = numCell(cell(row, 'Amount'))
    if (!Number.isFinite(amount) || amount === 0) continue
    sum += amount
    n++
  }
  if (!n) return null
  return Math.round(sum * 100) / 100
}

/**
 * Net funding from Cash Report “Deposits” − “Withdrawals” (EUR / base).
 * Fallback when the detailed Deposits & Withdrawals section is absent.
 */
export function parseIbkrCashReportFundingEur(
  csvText: string,
): number | null {
  const text = csvText.replace(/^\uFEFF/, '')
  let col: Record<string, number> | null = null
  let deposits: number | null = null
  let withdrawals: number | null = null

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseCsvLine(line)
    if ((row[0] ?? '') !== 'Cash Report') continue

    if (row[1] === 'Header') {
      col = {}
      row.forEach((h, i) => {
        if (h) col![h] = i
      })
      continue
    }
    if (row[1] !== 'Data') continue

    const cell = (name: string) => {
      const i = col?.[name] ?? -1
      return i >= 0 ? row[i] : undefined
    }
    const summary = (
      cell('Currency Summary') ??
      cell('Field Name') ??
      row[2] ??
      ''
    ).trim()
    const ccy = (cell('Currency') ?? row[3] ?? '').trim().toUpperCase()
    if (!isEurBaseCcy(ccy, summary) && !row.some((c) => c === 'EUR')) continue

    const amount = cashReportAmount(row, col)
    if (!Number.isFinite(amount)) continue

    if (/^Deposits$/i.test(summary)) deposits = amount
    else if (/^Withdrawals$/i.test(summary)) withdrawals = amount
  }

  if (deposits == null && withdrawals == null) return null
  // Withdrawals are usually negative already; if positive, subtract.
  const w = withdrawals ?? 0
  const net = (deposits ?? 0) + (w <= 0 ? w : -w)
  if (!Number.isFinite(net) || net === 0) return null
  return Math.round(net * 100) / 100
}

/**
 * Real money funded into the account (EUR): Deposits & Withdrawals, else
 * Cash Report Deposits − Withdrawals.
 */
export function parseIbkrFundingEur(csvText: string): number | null {
  return (
    parseIbkrNetDepositsEur(csvText) ?? parseIbkrCashReportFundingEur(csvText)
  )
}

/**
 * Ending EUR cash from Cash Report (statement date).
 */
export function parseIbkrEndingCashEur(csvText: string): number | null {
  const text = csvText.replace(/^\uFEFF/, '')
  let col: Record<string, number> | null = null
  let found: number | null = null

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseCsvLine(line)
    if ((row[0] ?? '') !== 'Cash Report') continue

    if (row[1] === 'Header') {
      col = {}
      row.forEach((h, i) => {
        if (h) col![h] = i
      })
      continue
    }
    if (row[1] !== 'Data') continue

    const cell = (name: string) => {
      const i = col?.[name] ?? -1
      return i >= 0 ? row[i] : undefined
    }
    const summary = (
      cell('Currency Summary') ??
      cell('Field Name') ??
      row[2] ??
      ''
    ).trim()
    const ccy = (cell('Currency') ?? row[3] ?? '').trim().toUpperCase()
    const isEnding =
      /^Ending Cash$/i.test(summary) ||
      row.some((c) => /^Ending Cash$/i.test(c))
    if (!isEnding) continue
    if (
      !isEurBaseCcy(ccy, summary) &&
      !row.some((c) => c === 'EUR' || /^Base Currency Summary$/i.test(c))
    ) {
      continue
    }

    const amount = cashReportAmount(row, col)
    if (!Number.isFinite(amount)) continue
    found = Math.round(amount * 100) / 100
  }
  return found
}

export function parseIbkrDividendCash(csvText: string): DivCash[] {
  const text = csvText.replace(/^\uFEFF/, '')
  const SECTIONS = new Set([
    'Dividends',
    'Withholding Tax',
    'Payment In Lieu Of Dividends',
  ])
  const out: DivCash[] = []
  let section: string | null = null
  let col: Record<string, number> | null = null

  const cell = (row: string[], name: string) => {
    const i = col?.[name] ?? -1
    return i >= 0 ? row[i] : undefined
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseCsvLine(line)
    const head = row[0]
    if (!head) continue

    if (SECTIONS.has(head) && row[1] === 'Header') {
      section = head
      col = {}
      row.forEach((h, i) => {
        if (h) col![h] = i
      })
      continue
    }

    if (!section || !SECTIONS.has(head) || row[1] !== 'Data' || !col) {
      if (head && !SECTIONS.has(head) && row[1] === 'Header') {
        section = null
        col = null
      }
      continue
    }

    const ccy = (cell(row, 'Currency') ?? '').toUpperCase()
    if (ccy !== 'USD') continue

    const date = (cell(row, 'Date') ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue

    const amount = numCell(cell(row, 'Amount'))
    if (!Number.isFinite(amount) || amount === 0) continue

    const desc = cell(row, 'Description') ?? ''
    const sym = symFromDivDescription(desc, cell(row, 'Symbol'))
    if (!sym) continue

    out.push({ date, sym, usd: amount })
  }
  return out
}

export function seriesKeys(data: ChartData): string[] {
  const tickers = data.tickers?.length
    ? data.tickers
    : Object.keys(data.series).filter((k) => k !== 'TOTAL' && k !== 'ALL_VOO')
  const keys = [...tickers, 'TOTAL']
  if (data.series.ALL_VOO?.length) keys.push('ALL_VOO')
  return keys
}

export function colorFor(
  sym: string,
  index = 0,
  theme: UiTheme = 'dark',
): string {
  const known = CHART_COLORS_BY_THEME[theme]
  if (sym === 'TOTAL') return known.TOTAL
  if (sym === 'ALL_VOO') return known.ALL_VOO
  if (known[sym]) return known[sym]
  const palette = theme === 'light' ? PALETTE_LIGHT : PALETTE_DARK
  return palette[index % palette.length]
}

function dayMs(iso: string) {
  return new Date(iso + 'T00:00:00Z').getTime()
}

function isoFromMs(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Local calendar YYYY-MM-DD (not UTC — Europe evening can already be “tomorrow” in UTC). */
export function calendarTodayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Yahoo daily bar date in the exchange timezone (UTC keys are a day early for FX). */
function isoFromYahooBar(tsSec: number, gmtOffsetSec: number): string {
  return new Date((tsSec + gmtOffsetSec) * 1000).toISOString().slice(0, 10)
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
  // Must be a *static* `.BASE_URL` access so Vite inlines `/InvestCalculator/`
  // for GitHub Pages. Dynamic `env['BASE_URL']` breaks and 404s JSON assets.
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

type YahooLive = {
  closes: Map<string, number>
  /** Current/last trade price from chart meta (intraday “now”). */
  livePrice: number | null
}

function parseYahooChart(data: {
  chart?: {
    result?: Array<{
      meta?: { gmtoffset?: number; regularMarketPrice?: number }
      timestamp?: number[]
      indicators?: { quote?: Array<{ close?: Array<number | null> }> }
    }>
  }
}): YahooLive {
  const result = data.chart?.result?.[0]
  const ts = result?.timestamp
  const close = result?.indicators?.quote?.[0]?.close
  if (!ts?.length || !close?.length) throw new Error('empty yahoo result')
  const gmtOffset =
    typeof result?.meta?.gmtoffset === 'number' ? result.meta.gmtoffset : 0
  const map = new Map<string, number>()
  for (let i = 0; i < ts.length; i++) {
    const c = close[i]
    if (c == null || !Number.isFinite(c)) continue
    map.set(isoFromYahooBar(ts[i], gmtOffset), c)
  }
  if (!map.size) throw new Error('no closes')
  const liveRaw = result?.meta?.regularMarketPrice
  const livePrice =
    typeof liveRaw === 'number' && Number.isFinite(liveRaw) ? liveRaw : null
  return { closes: map, livePrice }
}

function applyLiveTip(
  map: Map<string, number>,
  endIso: string,
  live: YahooLive | null,
) {
  if (!live) return
  mergeMaps(map, live.closes)
  if (live.livePrice != null) map.set(endIso, live.livePrice)
}

/**
 * Live Yahoo closes + current quote for days past the bundled cache.
 * Never hit query1 from the browser — GitHub Pages gets CORS errors in the console
 * even when the failure is caught. Dev uses the Vite proxy; Pages uses a CORS relay.
 */
async function fetchLiveYahooCloses(
  symbol: string,
  startIso: string,
  endIso: string,
): Promise<YahooLive | null> {
  const period1 = Math.floor(dayMs(startIso) / 1000) - 86400
  // Include the full end calendar day; Yahoo period2 is exclusive.
  const period2 = Math.floor(dayMs(endIso) / 1000) + 2 * 86400
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`
  const yahooUrl = `https://query1.finance.yahoo.com${path}`
  const urls = import.meta.env.DEV
    ? [`/api/yahoo${path}`]
    : [`https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`]
  for (const url of urls) {
    try {
      return parseYahooChart(await fetchJson(url, 14000))
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

  if (ext && startIso < ext.first) {
    const live = await fetchLiveYahooCloses(symbol, startIso, ext.first)
    if (live) mergeMaps(cached, live.closes)
  }

  // Always refresh the tip through endIso and stamp regularMarketPrice on
  // “today” so valuation is now — not last cache / previous session close.
  const tipStart = ext
    ? isoFromMs(dayMs(ext.last) - 2 * 86400000)
    : startIso
  applyLiveTip(
    cached,
    endIso,
    await fetchLiveYahooCloses(symbol, tipStart, endIso),
  )

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
  if (ext && endIso > ext.last) {
    fetchStart = isoFromMs(dayMs(ext.last) - 3 * 86400000)
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

  const tipStart = ext
    ? isoFromMs(dayMs(ext.last) - 2 * 86400000)
    : startIso
  applyLiveTip(
    cached,
    endIso,
    await fetchLiveYahooCloses('EURUSD=X', tipStart, endIso),
  )

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
  const tickerSet = new Set(tickers)
  const tradeDates = trades.map((t) => t.date).sort()
  const start = tradeDates[0]
  const lastTrade = tradeDates[tradeDates.length - 1]
  const today = calendarTodayIso()
  const end = opts?.endDate ?? (today > lastTrade ? today : lastTrade)

  // Total return (modern portfolio charts): price P&L + net cash dividends.
  const divCash = parseIbkrDividendCash(csvText).filter((d) =>
    tickerSet.has(d.sym),
  )
  const divAgg = new Map<string, number>()
  for (const d of divCash) {
    const key = `${d.date}|${d.sym}`
    divAgg.set(key, (divAgg.get(key) ?? 0) + d.usd)
  }

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

  // Mid-market EUR cost of buys (Basis already includes IBKR commission).
  let autoInvEur = 0
  for (const [key, b] of buysAgg) {
    const date = key.split('|')[0]
    const di = days.indexOf(date)
    const rate = (di >= 0 ? fx[di] : fx[0]) || 1
    autoInvEur += b.usd / rate
  }

  // Real money in: statement deposits (full funding). Scale every ticker’s
  // “in” so QQQ+SMH+VOO+… = TOTAL = fundingEur — includes FX conversion
  // cost vs Yahoo/Frankfurter mid rates (trade Basis alone understates it).
  const fundingEur = parseIbkrFundingEur(csvText)
  let fundingScale = 1
  if (fundingEur != null && fundingEur > 0 && autoInvEur > 0) {
    fundingScale = fundingEur / autoInvEur
  }

  const hold: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]))
  const inv: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]))
  const divEur: Record<string, number> = Object.fromEntries(
    tickers.map((t) => [t, 0]),
  )
  const series: Record<string, number[]> = Object.fromEntries(
    tickers.map((t) => [t, [] as number[]]),
  )
  const buys: BuyPoint[] = []
  const divs: DivPoint[] = []
  const allBase: number[] = []
  let altShares = 0
  let altInvested = 0

  // Dividends dated before the chart window still count toward total return.
  for (const [key, usd] of divAgg) {
    const [d, sym] = key.split('|')
    if (d >= start) continue
    const rate0 = fx[0] || 1
    divEur[sym] += usd / rate0
  }

  days.forEach((d, i) => {
    const rate = fx[i]
    for (const sym of tickers) {
      const prevHold = hold[sym]
      const b = buysAgg.get(`${d}|${sym}`)
      if (b) {
        const eur = (b.usd / rate) * fundingScale
        hold[sym] += b.qty
        inv[sym] += eur
      }

      const divUsd = divAgg.get(`${d}|${sym}`) ?? 0
      if (divUsd !== 0) {
        divEur[sym] += divUsd / rate
      }

      // Total return = price P&L + cumulative net dividends (cash).
      let pricePnl = hold[sym]
        ? (hold[sym] * px[sym][i]) / rate - inv[sym]
        : 0
      if (prevHold === 0 && hold[sym] > 0) pricePnl = 0
      const y = Math.round((pricePnl + divEur[sym]) * 100) / 100
      series[sym].push(y)

      if (b) {
        const eur = Math.round((b.usd / rate) * fundingScale * 100) / 100
        buys.push({
          id: `${sym}-${d}`,
          date: d,
          sym,
          y,
          eur,
          label: `${sym} €${Math.round(eur)}`,
        })
      }
      if (divUsd !== 0) {
        const dEur = Math.round((divUsd / rate) * 100) / 100
        divs.push({
          id: `div-${sym}-${d}`,
          date: d,
          sym,
          y,
          eur: dEur,
          label: `${sym} div €${Math.round(dEur)}`,
        })
      }
    }

    // Counterfactual: keep real baseline fills; redirect other cash into baseline.
    const prevAlt = altShares
    const baseBuy = buysAgg.get(`${d}|${baseline}`)
    if (baseBuy) {
      altShares += baseBuy.qty
      altInvested += (baseBuy.usd / rate) * fundingScale
    }
    let otherUsd = 0
    for (const sym of tickers) {
      if (sym === baseline) continue
      otherUsd += buysAgg.get(`${d}|${sym}`)?.usd ?? 0
    }
    if (otherUsd > 0) {
      const basePx = px[baseline][i]
      if (basePx > 0) altShares += otherUsd / basePx
      altInvested += (otherUsd / rate) * fundingScale
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
    Math.round((allBase[allBase.length - 1]! - total[total.length - 1]!) * 100) /
    100

  const dividendsEur: Record<string, number> = {}
  let divTotal = 0
  for (const t of tickers) {
    const v = Math.round(divEur[t] * 100) / 100
    dividendsEur[t] = v
    divTotal += v
  }
  dividendsEur.TOTAL = Math.round(divTotal * 100) / 100

  const colors: Record<string, string> = {
    TOTAL: CHART_COLORS_BY_THEME.dark.TOTAL,
    ALL_VOO: CHART_COLORS_BY_THEME.dark.ALL_VOO,
  }
  const labels: Record<string, string> = {
    TOTAL: 'TOTAL',
    ALL_VOO: `if all → ${baseline}`,
  }
  tickers.forEach((t, i) => {
    colors[t] = colorFor(t, i, 'dark')
    labels[t] = t
  })

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
    divs,
    dividendsEur,
    fundingEur:
      fundingEur != null && fundingEur > 0 ? fundingEur : undefined,
    deltaAllVoo,
    colors,
    labels,
    title: 'Earnings',
    source: 'upload',
  }
}

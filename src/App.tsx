import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  assetUrl,
  buildChartFromIbkrCsv,
  calendarTodayIso,
  CHART_COLORS_BY_THEME,
  CHART_LABELS,
  colorFor,
  invalidatePricesCache,
  seriesKeys,
  type ChartData,
  type UiTheme,
} from './ibkr'
import {
  CLASSIC_ID,
  deletePortfolio,
  ensureClassic,
  fingerprintFromChart,
  layoutFor,
  loadStore,
  nameFromFile,
  saveStore,
  setActive,
  updateDraftPositions,
  updatePortfolioChart,
  updateSavedPositions,
  upsertUpload,
  type PortfolioStore,
  type PosMap,
  type StoredPortfolio,
} from './portfolios'

type Buy = {
  id: string
  date: string
  sym: string
  y: number
  eur: number
  label: string
  lx: number
  ly: number
}

const DEFAULT_LABELS = CHART_LABELS
const THEME_KEY = 'ic-theme'

/** Chart / export palettes — keep in sync with index.css theme tokens */
const CHART_UI_BY_THEME = {
  dark: {
    bg: '#0e141c',
    fg: '#e9eef5',
    muted: '#93a1b3',
    grid: '#243142',
    zero: '#5c6b7e',
    chip: '#18212c',
    markerStroke: '#0e141c',
  },
  light: {
    bg: '#f7f3ea',
    fg: '#1c1917',
    muted: '#57534e',
    grid: '#cfc8bb',
    zero: '#888888',
    chip: '#ffffff',
    markerStroke: '#ffffff',
  },
} as const

function readStoredTheme(): UiTheme {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'light' || t === 'dark') return t
  } catch {
    /* ignore */
  }
  return 'dark'
}

/** Factory layout for the synthetic Classic demo (not a real portfolio). */
const FACTORY_POS: PosMap = {
  'VOO-2026-02-27': { lx: 1772219520000, ly: 14 },
  'VOO-2026-03-16': { lx: 1773688320000, ly: 20.25 },
  'QQQ-2026-04-13': { lx: 1776107520000, ly: 14 },
  'VOO-2026-05-07': { lx: 1778181120000, ly: 138.83 },
  'SMH-2026-06-01': { lx: 1780341120000, ly: 14 },
  'VOO-2026-06-26': { lx: 1782501120000, ly: 241.67 },
  'QQQ-2026-07-20': { lx: 1784574720000, ly: 105.86 },
  'SMH-2026-08-13': { lx: 1786648320000, ly: 3.62 },
  'VOO-2026-08-31': { lx: 1788203520000, ly: 368.25 },
  'QQQ-2026-09-17': { lx: 1789672320000, ly: 144.92 },
  'SMH-2026-10-01': { lx: 1790881920000, ly: 80.52 },
}

function labelsToPosMap(...groups: Buy[][]): PosMap {
  const out: PosMap = {}
  for (const group of groups) {
    for (const b of group) out[b.id] = { lx: b.lx, ly: b.ly }
  }
  return out
}

const W = 1100
const H = 640
const M = { top: 48, right: 130, bottom: 48, left: 56 }
const PLOT_W = W - M.left - M.right
const PLOT_H = H - M.top - M.bottom
const EXPORT_SCALE = 3
const VIEW_MIN = 0.4
const VIEW_MAX = 4

type ViewTransform = { scale: number; x: number; y: number }

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

function clampView(
  v: ViewTransform,
  vpW: number,
  vpH: number,
): ViewTransform {
  const scale = clamp(v.scale, VIEW_MIN, VIEW_MAX)
  const contentW = W * scale
  const contentH = H * scale
  let x = v.x
  let y = v.y
  if (contentW <= vpW) x = (vpW - contentW) / 2
  else x = clamp(x, vpW - contentW, 0)
  if (contentH <= vpH) y = (vpH - contentH) / 2
  else y = clamp(y, vpH - contentH, 0)
  return { scale, x, y }
}

function parseDay(s: string) {
  return new Date(s + 'T00:00:00').getTime()
}

const DAY_MS = 86400000

/** Short leader-line label layout with light collision avoidance. */
function fallbackBuys(raw: ChartData['buys']): Buy[] {
  if (!raw.length) return []

  const yGap = 24
  const placed: { lx: number; ly: number; w: number }[] = []

  const labelHalfWidthMs = (label: string) =>
    Math.max(label.length * 0.28, 3.2) * DAY_MS

  const overlaps = (lx: number, ly: number, label: string) => {
    const w = labelHalfWidthMs(label)
    return placed.some(
      (p) => Math.abs(lx - p.lx) < (w + p.w) * 0.7 && Math.abs(ly - p.ly) < yGap,
    )
  }

  // Prefer nearby slots so leader lines stay short (~1–2 days, ~12–28€).
  const slotsFor = (t: number, y: number, preferUp: boolean): [number, number][] => {
    const xs = [0.8, 1.3, 1.8, -0.8, 2.2, -1.3]
    const primary = preferUp ? [14, 22, 30] : [-14, -22, -30]
    const secondary = preferUp ? [-14, -22, -30] : [14, 22, 30]
    const ys = [...primary, ...secondary, preferUp ? 40 : -40, preferUp ? -40 : 40]
    const out: [number, number][] = []
    for (const dy of ys) {
      for (const dx of xs) {
        out.push([t + dx * DAY_MS, y + dy])
      }
    }
    return out
  }

  const ordered = [...raw].sort(
    (a, b) => a.date.localeCompare(b.date) || a.sym.localeCompare(b.sym),
  )
  const byId = new Map<string, Buy>()

  for (let i = 0; i < ordered.length; i++) {
    const b = ordered[i]
    const t = parseDay(b.date)
    // Alternate side among buys close in time so clusters don't stack one way
    const nearIdx = ordered
      .slice(0, i)
      .filter((o) => Math.abs(parseDay(o.date) - t) < 12 * DAY_MS).length
    const preferUp = nearIdx % 2 === 0
    const slots = slotsFor(t, b.y, preferUp)
    let chosen = slots[0]
    for (const s of slots) {
      if (!overlaps(s[0], s[1], b.label)) {
        chosen = s
        break
      }
    }
    // Last resort: keep it close, nudge vertically in small steps
    if (overlaps(chosen[0], chosen[1], b.label)) {
      for (let k = 1; k <= 10; k++) {
        const ly = b.y + (k % 2 === 0 ? 1 : -1) * (16 + k * 10)
        const lx = t + 1.2 * DAY_MS
        if (!overlaps(lx, ly, b.label)) {
          chosen = [lx, ly]
          break
        }
      }
    }
    placed.push({
      lx: chosen[0],
      ly: chosen[1],
      w: labelHalfWidthMs(b.label),
    })
    byId.set(b.id, { ...b, lx: chosen[0], ly: chosen[1] })
  }

  return raw.map((b) => byId.get(b.id)!)
}

function applyPositions(raw: ChartData['buys'], pos: PosMap | null): Buy[] {
  const base = fallbackBuys(raw)
  if (!pos || !Object.keys(pos).length) return base
  return base.map((b) => {
    const p = pos[b.id]
    return p ? { ...b, lx: p.lx, ly: p.ly } : b
  })
}

function fmtEnd(v: number) {
  const sign = v >= 0 ? '+' : ''
  return `${sign}${Math.round(v)}€`
}

function fmtPct(earn: number, invested: number) {
  if (!(invested > 0) || !Number.isFinite(earn)) return ''
  const pct = (earn / invested) * 100
  const sign = pct >= 0 ? '+' : '-'
  const abs = Math.abs(pct)
  const body = abs >= 10 ? abs.toFixed(0) : abs.toFixed(1)
  return `${sign}${body}%`
}

function fmtEur(v: number) {
  return `€${Math.round(v)}`
}

/** Total EUR invested per series key (from buy points). */
function investedBySeries(data: ChartData): Record<string, number> {
  const bySym: Record<string, number> = {}
  for (const b of data.buys ?? []) {
    bySym[b.sym] = (bySym[b.sym] ?? 0) + b.eur
  }
  const total = Object.values(bySym).reduce((s, v) => s + v, 0)
  return {
    ...bySym,
    TOTAL: total,
  }
}

function normalizeChart(d: ChartData): ChartData {
  const tickers =
    d.tickers?.length
      ? d.tickers
      : Object.keys(d.series).filter((k) => k !== 'TOTAL' && k !== 'ALL_VOO')
  const colors: Record<string, string> = { ...d.colors }
  const labels: Record<string, string> = {
    ...d.labels,
    ...CHART_LABELS,
    TOTAL: d.labels?.TOTAL ?? CHART_LABELS.TOTAL ?? 'TOTAL',
  }
  delete colors.ALL_VOO
  delete labels.ALL_VOO
  tickers.forEach((t, i) => {
    colors[t] = colors[t] ?? colorFor(t, i, 'dark')
    labels[t] = labels[t] ?? t
  })
  colors.TOTAL = colors.TOTAL ?? colorFor('TOTAL', 0, 'dark')
  const series = { ...d.series }
  delete series.ALL_VOO
  return {
    ...d,
    tickers,
    series,
    colors,
    labels,
  }
}

export default function App() {
  const [data, setData] = useState<ChartData | null>(null)
  const [classicChart, setClassicChart] = useState<ChartData | null>(null)
  const [buys, setBuys] = useState<Buy[]>([])
  const [divLabels, setDivLabels] = useState<Buy[]>([])
  const [active, setActiveLabel] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [incognito, setIncognito] = useState(false)
  const [theme, setTheme] = useState<UiTheme>(() => readStoredTheme())
  const [saveFlash, setSaveFlash] = useState(false)
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [store, setStore] = useState<PortfolioStore>(() => loadStore())
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const buysRef = useRef<Buy[]>([])
  const divsRef = useRef<Buy[]>([])
  const storeRef = useRef(store)
  const saveGen = useRef(0)
  const didAutoRefresh = useRef(false)
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    origLx: number
    origLy: number
  } | null>(null)
  const [view, setView] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  const pointersRef = useRef(
    new Map<number, { x: number; y: number }>(),
  )
  const panRef = useRef<{
    x: number
    y: number
    vx: number
    vy: number
  } | null>(null)
  const pinchRef = useRef<{
    dist: number
    scale: number
    x: number
    y: number
    midX: number
    midY: number
  } | null>(null)
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const [panning, setPanning] = useState(false)
  const chartUi = CHART_UI_BY_THEME[theme]
  const themeColors = CHART_COLORS_BY_THEME[theme]

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) {
      themeColor.setAttribute(
        'content',
        theme === 'dark' ? '#0b0e12' : '#e8e2d6',
      )
    }
    const scheme = document.querySelector('meta[name="color-scheme"]')
    if (scheme) scheme.setAttribute('content', theme)
  }, [theme])

  const seriesColor = useCallback(
    (sym: string, index = 0) =>
      themeColors[sym] ?? colorFor(sym, index, theme),
    [theme, themeColors],
  )

  useEffect(() => {
    storeRef.current = store
  }, [store])

  useEffect(() => {
    viewRef.current = view
  }, [view])

  useEffect(() => {
    buysRef.current = buys
  }, [buys])

  useEffect(() => {
    divsRef.current = divLabels
  }, [divLabels])

  const commitStore = useCallback((next: PortfolioStore) => {
    storeRef.current = next
    saveStore(next)
    setStore(next)
  }, [])

  const showPortfolio = useCallback(
    (chart: ChartData, positions: PosMap | null) => {
      const normalized = normalizeChart(chart)
      setData(normalized)
      setVisible((prev) => {
        const next: Record<string, boolean> = {}
        for (const k of seriesKeys(normalized)) {
          next[k] = prev[k] ?? true
        }
        return next
      })
      const pos =
        positions && Object.keys(positions).length ? positions : null
      // Layout buys + div labels together so they don't overlap by default
      const buyIds = new Set(normalized.buys.map((b) => b.id))
      const laid = applyPositions(
        [...normalized.buys, ...(normalized.divs ?? [])],
        pos,
      )
      const nextBuys = laid.filter((b) => buyIds.has(b.id))
      const nextDivs = laid.filter((b) => !buyIds.has(b.id))
      buysRef.current = nextBuys
      divsRef.current = nextDivs
      setBuys(nextBuys)
      setDivLabels(nextDivs)
    },
    [],
  )

  const toggleSeries = (sym: string) => {
    setVisible((v) => ({ ...v, [sym]: !v[sym] }))
  }

  useEffect(() => {
    const bust = `?t=${Date.now()}`
    Promise.all([
      fetch(`${assetUrl('chart_data.json')}${bust}`).then(
        (r) => r.json() as Promise<ChartData>,
      ),
      fetch(`${assetUrl('default_positions.json')}${bust}`)
        .then((r) => r.json() as Promise<{ buys: PosMap }>)
        .catch(() => ({ buys: {} as PosMap })),
    ])
      .then(([d, def]) => {
        const classic = normalizeChart(d)
        setClassicChart(classic)
        const factoryOrDefault =
          def.buys && Object.keys(def.buys).length ? def.buys : FACTORY_POS
        const initial = loadStore()
        const savedClassic = initial.items.find((i) => i.id === CLASSIC_ID)
        const classicSeed =
          savedClassic && Object.keys(savedClassic.positions).length
            ? savedClassic.positions
            : factoryOrDefault
        const withClassic = ensureClassic(initial, fingerprintFromChart(classic), {
          asOf: classic.asOf,
          buysCount: classic.buys.length,
          positions: classicSeed,
        })
        // First-time classic: seed Save snapshot to factory layout
        const classicItem = withClassic.items.find((i) => i.id === CLASSIC_ID)!
        const seeded =
          Object.keys(classicItem.positions).length === 0
            ? {
                ...withClassic,
                items: withClassic.items.map((i) =>
                  i.id === CLASSIC_ID
                    ? {
                        ...i,
                        positions: factoryOrDefault,
                        draftPositions: factoryOrDefault,
                      }
                    : i,
                ),
              }
            : withClassic
        saveStore(seeded)
        setStore(seeded)
        storeRef.current = seeded

        const activeItem =
          seeded.items.find((i) => i.id === seeded.activeId) ??
          seeded.items.find((i) => i.id === CLASSIC_ID)!

        if (activeItem.kind === 'upload' && activeItem.chart) {
          showPortfolio(activeItem.chart, layoutFor(activeItem))
        } else {
          showPortfolio(classic, layoutFor(activeItem))
        }
        localStorage.removeItem('ibkr-label-positions-v1')
        localStorage.removeItem('ibkr-label-positions-v2')
        localStorage.removeItem('ibkr-portfolios-v2')
      })
      .catch((e) => setStatusMsg(`Failed to load demo data: ${e}`))
  }, [showPortfolio])

  const onUpload = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setStatusMsg(`Reading ${file.name}…`)
    try {
      const text = await file.text()
      setStatusMsg('Building chart from prices…')
      invalidatePricesCache()
      const chart = await buildChartFromIbkrCsv(text)
      const normalized = normalizeChart(chart)
      const laid = applyPositions(
        [...normalized.buys, ...(normalized.divs ?? [])],
        null,
      )
      const positions = labelsToPosMap(laid)
      const { store: next, id } = upsertUpload(storeRef.current, {
        name: nameFromFile(file.name),
        chart: normalized,
        positions,
        csvText: text,
      })
      commitStore(next)
      const item = next.items.find((i) => i.id === id)!
      if (item.kind === 'classic' && classicChart) {
        showPortfolio(classicChart, layoutFor(item))
      } else if (item.chart) {
        showPortfolio(item.chart, layoutFor(item))
      } else {
        showPortfolio(normalized, layoutFor(item))
      }
      setStatusMsg('')
    } catch (e) {
      setStatusMsg(`Upload failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const refreshToToday = useCallback(async () => {
    const item = storeRef.current.items.find(
      (i) => i.id === storeRef.current.activeId,
    )
    if (!item) return
    setBusy(true)
    setStatusMsg('Updating prices to today…')
    try {
      invalidatePricesCache()
      // Keep current label layout across rebuild
      const draft = updateDraftPositions(
        storeRef.current,
        item.id,
        labelsToPosMap(buysRef.current, divsRef.current),
      )
      commitStore(draft)

      if (item.kind === 'classic') {
        const bust = `?t=${Date.now()}`
        const raw = (await fetch(
          `${assetUrl('chart_data.json')}${bust}`,
        ).then((r) => r.json())) as ChartData
        const classic = normalizeChart(raw)
        setClassicChart(classic)
        const withMeta = {
          ...storeRef.current,
          items: storeRef.current.items.map((i) =>
            i.id === CLASSIC_ID
              ? {
                  ...i,
                  asOf: classic.asOf,
                  buysCount: classic.buys.length,
                  fingerprint: fingerprintFromChart(classic),
                }
              : i,
          ),
        }
        commitStore(withMeta)
        const classicItem = withMeta.items.find((i) => i.id === CLASSIC_ID)
        showPortfolio(classic, layoutFor(classicItem) || FACTORY_POS)
        setStatusMsg('')
        return
      }

      if (!item.csvText) {
        setStatusMsg(
          'Re-upload this CSV once — then Refresh can rebuild to today.',
        )
        return
      }

      const chart = normalizeChart(await buildChartFromIbkrCsv(item.csvText))
      const next = updatePortfolioChart(storeRef.current, item.id, chart)
      commitStore(next)
      const fresh = next.items.find((i) => i.id === item.id)
      showPortfolio(chart, layoutFor(fresh))
      setStatusMsg('')
    } catch (e) {
      setStatusMsg(`Refresh failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
    }
  }, [commitStore, showPortfolio])

  // One-shot: if asOf is before local today and we still have the CSV, rebuild.
  useEffect(() => {
    if (didAutoRefresh.current || !data || busy) return
    const item = store.items.find((i) => i.id === store.activeId)
    if (!item || item.kind !== 'upload' || !item.csvText) return
    const today = calendarTodayIso()
    if (item.asOf && item.asOf >= today) return
    didAutoRefresh.current = true
    void refreshToToday()
  }, [data, store, busy, refreshToToday])

  const selectPortfolio = (item: StoredPortfolio) => {
    if (item.id === storeRef.current.activeId) return
    // Keep current draft when switching away
    const cur = storeRef.current
    const withDraft = updateDraftPositions(
      cur,
      cur.activeId,
      labelsToPosMap(buysRef.current, divsRef.current),
    )
    const next = setActive(withDraft, item.id)
    commitStore(next)
    const fresh = next.items.find((i) => i.id === item.id)
    if (item.kind === 'classic') {
      if (!classicChart) return
      showPortfolio(classicChart, layoutFor(fresh) || FACTORY_POS)
    } else if (item.chart) {
      showPortfolio(item.chart, layoutFor(fresh))
    }
  }

  const onDeletePortfolio = (id: string) => {
    if (id === CLASSIC_ID) return
    const item = storeRef.current.items.find((i) => i.id === id)
    if (!item) return
    if (!confirm(`Delete “${item.name}”?`)) return
    const wasActive = storeRef.current.activeId === id
    const next = deletePortfolio(storeRef.current, id)
    commitStore(next)
    if (wasActive && classicChart) {
      const classicItem = next.items.find((i) => i.id === CLASSIC_ID)
      showPortfolio(classicChart, layoutFor(classicItem) || FACTORY_POS)
    }
  }

  const scales = useMemo(() => {
    if (!data) return null
    const keys = seriesKeys(data)
    const xs = data.dates.map(parseDay)
    // Pad time axis from data span (auto: a few days before / after)
    const span = Math.max(xs[xs.length - 1] - xs[0], 7 * 86400000)
    const pad = Math.min(Math.max(span * 0.04, 2 * 86400000), 21 * 86400000)
    const xMin = xs[0] - pad
    const xMax = xs[xs.length - 1] + pad * 2.2
    const endYs = keys
      .filter((s) => data.series[s]?.length)
      .map((s) => data.series[s][data.series[s].length - 1])
    const allY = [
      ...Object.values(data.series).flat(),
      ...buys.map((b) => b.ly),
      ...divLabels.map((d) => d.ly),
      ...endYs,
      0,
    ]
    const rawMin = Math.min(...allY)
    const rawMax = Math.max(...allY)
    const padY = Math.max((rawMax - rawMin) * 0.12, 40)
    const yMin = rawMin - padY
    const yMax = rawMax + padY
    const xScale = (t: number) => M.left + ((t - xMin) / (xMax - xMin)) * PLOT_W
    const yScale = (v: number) => M.top + ((yMax - v) / (yMax - yMin)) * PLOT_H
    return { xs, xMin, xMax, yMin, yMax, xScale, yScale, keys }
  }, [data, buys, divLabels])

  const clientToSvg = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }, [])

  const applyView = useCallback((next: ViewTransform) => {
    const vp = viewportRef.current
    if (!vp) {
      viewRef.current = next
      setView(next)
      return
    }
    const clamped = clampView(next, vp.clientWidth, vp.clientHeight)
    viewRef.current = clamped
    setView(clamped)
  }, [])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, nextScale: number) => {
      const vp = viewportRef.current
      if (!vp) return
      const rect = vp.getBoundingClientRect()
      const cur = viewRef.current
      const scale = clamp(nextScale, VIEW_MIN, VIEW_MAX)
      const localX = clientX - rect.left
      const localY = clientY - rect.top
      const contentX = (localX - cur.x) / cur.scale
      const contentY = (localY - cur.y) / cur.scale
      applyView({
        scale,
        x: localX - contentX * scale,
        y: localY - contentY * scale,
      })
    },
    [applyView],
  )

  const fitView = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    const s = Math.min(vp.clientWidth / W, vp.clientHeight / H)
    applyView({ scale: clamp(s, VIEW_MIN, VIEW_MAX), x: 0, y: 0 })
  }, [applyView])

  const zoomBy = useCallback(
    (factor: number) => {
      const vp = viewportRef.current
      if (!vp) return
      const rect = vp.getBoundingClientRect()
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewRef.current.scale * factor)
    },
    [zoomAt],
  )

  // Keep pan bounds correct when the phone rotates / chrome shows.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      applyView(viewRef.current)
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [applyView])

  const onPointerDown = (e: ReactPointerEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    panRef.current = null
    pinchRef.current = null
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const item =
      buys.find((b) => b.id === id) ?? divLabels.find((d) => d.id === id)
    if (!item || !scales) return
    const p = clientToSvg(e.clientX, e.clientY)
    dragRef.current = {
      id,
      startX: p.x,
      startY: p.y,
      origLx: item.lx,
      origLy: item.ly,
    }
    setActiveLabel(id)
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current
    if (!drag || !scales) return
    const p = clientToSvg(e.clientX, e.clientY)
    const dxPx = p.x - drag.startX
    const dyPx = p.y - drag.startY
    const newLx = drag.origLx + (dxPx / PLOT_W) * (scales.xMax - scales.xMin)
    const newLy = drag.origLy - (dyPx / PLOT_H) * (scales.yMax - scales.yMin)
    const patch = (prev: Buy[]) =>
      prev.map((b) => (b.id === drag.id ? { ...b, lx: newLx, ly: newLy } : b))
    setBuys(patch)
    setDivLabels(patch)
  }

  const onViewportPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return
    if ((e.target as Element).closest?.('.label-hit')) return
    // Don't steal clicks from zoom buttons / chrome.
    if ((e.target as Element).closest?.('.stage-bar')) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size >= 2) {
      const pts = [...pointersRef.current.values()]
      const a = pts[0]
      const b = pts[1]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const cur = viewRef.current
      pinchRef.current = {
        dist,
        scale: cur.scale,
        x: cur.x,
        y: cur.y,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
      }
      panRef.current = null
      setPanning(true)
      return
    }

    // Double-tap to toggle fit ↔ 1.6× at tap point (phone-friendly).
    const now = Date.now()
    const prev = lastTapRef.current
    if (
      prev &&
      now - prev.t < 320 &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 36
    ) {
      lastTapRef.current = null
      const cur = viewRef.current.scale
      const vp = viewportRef.current
      const fitScale = vp
        ? Math.min(vp.clientWidth / W, vp.clientHeight / H)
        : 1
      if (cur > fitScale * 1.15) fitView()
      else zoomAt(e.clientX, e.clientY, Math.min(VIEW_MAX, 1.75))
      return
    }
    lastTapRef.current = { t: now, x: e.clientX, y: e.clientY }

    const cur = viewRef.current
    panRef.current = {
      x: e.clientX,
      y: e.clientY,
      vx: cur.x,
      vy: cur.y,
    }
    setPanning(true)
  }

  const onViewportPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return
    if (!pointersRef.current.has(e.pointerId)) return
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()]
      const a = pts[0]
      const b = pts[1]
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      const start = pinchRef.current
      const nextScale = clamp(
        start.scale * (dist / start.dist),
        VIEW_MIN,
        VIEW_MAX,
      )
      const vp = viewportRef.current
      if (!vp) return
      const rect = vp.getBoundingClientRect()
      const localX = start.midX - rect.left
      const localY = start.midY - rect.top
      const contentX = (localX - start.x) / start.scale
      const contentY = (localY - start.y) / start.scale
      const newLocalX = midX - rect.left
      const newLocalY = midY - rect.top
      applyView({
        scale: nextScale,
        x: newLocalX - contentX * nextScale,
        y: newLocalY - contentY * nextScale,
      })
      return
    }

    const pan = panRef.current
    if (!pan) return
    applyView({
      scale: viewRef.current.scale,
      x: pan.vx + (e.clientX - pan.x),
      y: pan.vy + (e.clientY - pan.y),
    })
  }

  const onViewportPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 0) {
      panRef.current = null
      setPanning(false)
    } else if (pointersRef.current.size === 1) {
      const [pt] = pointersRef.current.values()
      const cur = viewRef.current
      panRef.current = { x: pt.x, y: pt.y, vx: cur.x, vy: cur.y }
      pinchRef.current = null
    }
  }

  // Non-passive wheel listener so preventDefault works for trackpad pinch/zoom.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(e.clientX, e.clientY, viewRef.current.scale * factor)
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const flashSaved = useCallback(() => {
    setSaveFlash(true)
    if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current)
    saveFlashTimer.current = setTimeout(() => setSaveFlash(false), 1600)
  }, [])

  const saveLayout = useCallback(
    async (reason: string) => {
      const map = labelsToPosMap(buysRef.current, divsRef.current)
      if (!Object.keys(map).length) return
      const gen = ++saveGen.current
      const id = storeRef.current.activeId
      const next =
        reason === 'manual'
          ? updateSavedPositions(storeRef.current, id, map)
          : updateDraftPositions(storeRef.current, id, map)
      commitStore(next)

      if (
        reason === 'manual' &&
        import.meta.env.DEV &&
        id === CLASSIC_ID
      ) {
        try {
          await fetch('/api/save-positions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buys: map }),
          })
        } catch {
          /* ignore */
        }
      }
      if (gen !== saveGen.current) return
      if (reason === 'manual') flashSaved()
    },
    [commitStore, flashSaved],
  )

  const onPointerUp = () => {
    const wasDragging = !!dragRef.current
    dragRef.current = null
    setActiveLabel(null)
    if (wasDragging) void saveLayout('drag')
  }

  const reset = () => {
    if (!data) return
    saveGen.current += 1
    dragRef.current = null
    const item = storeRef.current.items.find(
      (i) => i.id === storeRef.current.activeId,
    )
    const saved = item?.positions
    const fallback =
      item?.kind === 'classic' || storeRef.current.activeId === CLASSIC_ID
        ? FACTORY_POS
        : null
    const restore =
      saved && Object.keys(saved).length ? saved : fallback
    const buyIds = new Set(data.buys.map((b) => b.id))
    const laid = applyPositions([...data.buys, ...(data.divs ?? [])], restore)
    const nextBuys = laid.filter((b) => buyIds.has(b.id))
    const nextDivs = laid.filter((b) => !buyIds.has(b.id))
    buysRef.current = nextBuys
    divsRef.current = nextDivs
    setBuys(nextBuys)
    setDivLabels(nextDivs)
    // Sync draft back to the Save snapshot (do not overwrite Save)
    commitStore(
      updateDraftPositions(
        storeRef.current,
        storeRef.current.activeId,
        labelsToPosMap(nextBuys, nextDivs),
      ),
    )
  }

  const exportPng = async () => {
    const svg = svgRef.current
    if (!svg) return

    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(W))
    clone.setAttribute('height', String(H))
    clone.setAttribute('viewBox', `0 0 ${W} ${H}`)
    clone.setAttribute(
      'style',
      `font-family: "IBM Plex Sans", "Segoe UI", Arial, sans-serif; background:${chartUi.bg};`,
    )

    const xml = new XMLSerializer().serializeToString(clone)
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)

    const img = new Image()
    img.decoding = 'sync'
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg image load failed'))
      img.src = url
    })

    const canvas = document.createElement('canvas')
    canvas.width = W * EXPORT_SCALE
    canvas.height = H * EXPORT_SCALE
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = chartUi.bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = 'investcalculator_chart.png'
    a.click()
  }

  if (!data || !scales) {
    return (
      <div className="app">
        <div className="toolbar">
          <h1>Invest Calculator</h1>
          <p>Loading chart data…</p>
        </div>
      </div>
    )
  }

  const { xScale, yScale, yMin, yMax, keys: seriesOrder } = scales
  const zeroY = yScale(0)
  const endX = M.left + PLOT_W + 8
  const nameOf = (sym: string) =>
    data.labels?.[sym] ?? DEFAULT_LABELS[sym] ?? sym
  const invested = investedBySeries(data)

  const paths = seriesOrder
    .filter((sym) => visible[sym] !== false && data.series[sym])
    .map((sym) => {
      const pts = data.dates
        .map(
          (d, i) =>
            `${xScale(parseDay(d)).toFixed(1)},${yScale(data.series[sym][i]).toFixed(1)}`,
        )
        .join(' ')
      return { sym, pts }
    })

  const months: { t: number; label: string }[] = []
  {
    const start = new Date(data.dates[0] + 'T00:00:00')
    const end = new Date(data.dates[data.dates.length - 1] + 'T00:00:00')
    const cur = new Date(start.getFullYear(), start.getMonth(), 1)
    while (cur <= end) {
      months.push({
        t: cur.getTime(),
        label: cur.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
      })
      cur.setMonth(cur.getMonth() + 1)
    }
  }

  const yTicks = []
  {
    const span = yMax - yMin
    const step =
      span > 2000 ? 500 : span > 800 ? 200 : span > 300 ? 100 : span > 120 ? 50 : 25
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push(v)
  }

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Saved statements">
        <div className="sidebar-head">
          <h2>Portfolios</h2>
          <button
            type="button"
            className="sidebar-upload"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? '…' : '+ CSV'}
          </button>
        </div>
        <ul className="portfolio-list">
          {store.items.map((item) => {
            const selected = item.id === store.activeId
            return (
              <li key={item.id} className={selected ? 'selected' : ''}>
                <button
                  type="button"
                  className="portfolio-item"
                  onClick={() => selectPortfolio(item)}
                >
                  <span className="portfolio-name">{item.name}</span>
                  <span className="portfolio-meta">
                    {item.buysCount} buys
                    {item.asOf ? ` · ${item.asOf}` : ''}
                  </span>
                </button>
                {item.kind === 'upload' ? (
                  <button
                    type="button"
                    className="portfolio-delete"
                    title={`Delete ${item.name}`}
                    aria-label={`Delete ${item.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeletePortfolio(item.id)
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="M19 6l-1 14H6L5 6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                ) : (
                  <span className="portfolio-badge" title="Built-in demo">
                    demo
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </aside>

      <div className="main">
        <div className="toolbar">
          <h1>Invest Calculator</h1>
          <button type="button" onClick={reset}>
            Reset layout
          </button>
          <button
            type="button"
            className={saveFlash ? 'saved' : undefined}
            onClick={() => void saveLayout('manual')}
          >
            {saveFlash ? 'Saved' : 'Save layout'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Loading…' : 'Upload CSV'}
          </button>
          <button
            type="button"
            disabled={busy}
            title="Rebuild chart with latest prices through today"
            onClick={() => void refreshToToday()}
          >
            {busy ? 'Updating…' : 'Refresh to today'}
          </button>
          <button type="button" className="primary" onClick={exportPng}>
            Export PNG
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => void onUpload(e.target.files?.[0] ?? null)}
          />
          {statusMsg.startsWith('Upload failed') ||
          statusMsg.startsWith('Failed to load') ||
          statusMsg.startsWith('Refresh failed') ||
          statusMsg.startsWith('Re-upload') ? (
            <p className="error-msg">{statusMsg}</p>
          ) : null}
        </div>

        <div className="toggles" role="group" aria-label="Series visibility">
          {seriesOrder.map((sym) => (
            <button
              key={sym}
              type="button"
              className={`toggle${visible[sym] !== false ? ' on' : ''}`}
              style={
                {
                  '--c': seriesColor(sym),
                } as CSSProperties
              }
              onClick={() => toggleSeries(sym)}
              aria-pressed={visible[sym] !== false}
            >
              <span className="swatch" />
              {nameOf(sym)}
            </button>
          ))}
          <div className="switch-group">
            <label className="switch" title="Buy labels on the chart">
              <input
                type="checkbox"
                checked={showLabels}
                onChange={(e) => setShowLabels(e.target.checked)}
              />
              <span className="switch-track" aria-hidden />
              <span className="switch-text">Buy labels</span>
            </label>
            <label
              className="switch"
              title="Hide all amounts and axis numbers — curves only"
            >
              <input
                type="checkbox"
                checked={incognito}
                onChange={(e) => setIncognito(e.target.checked)}
              />
              <span className="switch-track" aria-hidden />
              <span className="switch-text">Incognito</span>
            </label>
            <label className="switch" title="Switch light / dark theme">
              <input
                type="checkbox"
                checked={theme === 'dark'}
                onChange={(e) =>
                  setTheme(e.target.checked ? 'dark' : 'light')
                }
              />
              <span className="switch-track" aria-hidden />
              <span className="switch-text">
                {theme === 'dark' ? 'Dark' : 'Light'}
              </span>
            </label>
          </div>
        </div>

        <div className="stage">
          <div className="stage-bar" aria-label="Chart zoom">
            <span className="stage-hint">Pinch or scroll to zoom · drag to pan</span>
            <div className="stage-zoom">
              <button
                type="button"
                className="stage-zoom-btn"
                title="Zoom out"
                aria-label="Zoom out"
                onClick={() => zoomBy(1 / 1.25)}
              >
                −
              </button>
              <button
                type="button"
                className="stage-zoom-btn stage-zoom-pct"
                title="Fit chart to screen"
                aria-label={`Zoom ${Math.round(view.scale * 100)} percent. Tap to fit`}
                onClick={() => fitView()}
              >
                Fit
              </button>
              <span className="stage-zoom-readout" aria-live="polite">
                {Math.round(view.scale * 100)}%
              </span>
              <button
                type="button"
                className="stage-zoom-btn"
                title="Zoom in"
                aria-label="Zoom in"
                onClick={() => zoomBy(1.25)}
              >
                +
              </button>
            </div>
          </div>
          <div
            ref={viewportRef}
            className={`stage-viewport${panning ? ' panning' : ''}`}
            onPointerDown={onViewportPointerDown}
            onPointerMove={onViewportPointerMove}
            onPointerUp={onViewportPointerUp}
            onPointerCancel={onViewportPointerUp}
          >
            <div
              className="stage-canvas"
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              }}
            >
          <svg
            ref={svgRef}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            style={{
              fontFamily: '"IBM Plex Sans", "Segoe UI", Arial, sans-serif',
            }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <rect x={0} y={0} width={W} height={H} fill={chartUi.bg} />
            <text
              x={W / 2}
              y={26}
              textAnchor="middle"
              fontSize={15}
              fontWeight={650}
              fill={chartUi.fg}
            >
              Earnings
            </text>

            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={M.left}
                  x2={M.left + PLOT_W}
                  y1={yScale(v)}
                  y2={yScale(v)}
                  stroke={chartUi.grid}
                  strokeWidth={0.8}
                />
                {!incognito && (
                  <text
                    x={M.left - 8}
                    y={yScale(v) + 4}
                    textAnchor="end"
                    fontSize={11}
                    fill={chartUi.muted}
                  >
                    {v}
                  </text>
                )}
              </g>
            ))}
            {months.map((m) => (
              <g key={m.t}>
                <line
                  x1={xScale(m.t)}
                  x2={xScale(m.t)}
                  y1={M.top}
                  y2={M.top + PLOT_H}
                  stroke={chartUi.grid}
                  strokeWidth={0.6}
                />
                {!incognito && (
                  <text
                    x={xScale(m.t)}
                    y={H - 16}
                    textAnchor="middle"
                    fontSize={11}
                    fill={chartUi.muted}
                  >
                    {m.label}
                  </text>
                )}
              </g>
            ))}

            <line
              x1={M.left}
              x2={M.left + PLOT_W}
              y1={zeroY}
              y2={zeroY}
              stroke={chartUi.zero}
              strokeWidth={1}
              strokeDasharray="4 3"
            />

            {paths.map(({ sym, pts }) => (
              <polyline
                key={sym}
                fill="none"
                points={pts}
                stroke={seriesColor(sym)}
                strokeWidth={sym === 'TOTAL' ? 2.4 : 1.8}
              />
            ))}

            {seriesOrder
              .filter((sym) => visible[sym] !== false && data.series[sym])
              .map((sym, i) => {
                const put = invested[sym] ?? 0
                const earn = data.series[sym]?.[data.series[sym].length - 1] ?? 0
                const now = put + earn
                const div = data.dividendsEur?.[sym] ?? 0
                const divText =
                  div >= 0.5 ? ` · div ${fmtEur(div)}` : div <= -0.5 ? ` · div ${fmtEur(div)}` : ''
                const putText = incognito
                  ? ''
                  : put > 0
                    ? ` · in ${fmtEur(put)} → ${fmtEur(now)}${divText}`
                    : divText
                return (
                  <g
                    key={sym}
                    transform={`translate(${M.left + 8}, ${M.top + 14 + i * 18})`}
                  >
                    <line
                      x1={0}
                      x2={18}
                      y1={0}
                      y2={0}
                      stroke={seriesColor(sym)}
                      strokeWidth={sym === 'TOTAL' ? 2.4 : 1.8}
                    />
                    <text x={24} y={4} fontSize={12} fill={chartUi.fg}>
                      {nameOf(sym)}
                      {putText ? (
                        <tspan fill={chartUi.muted} fontWeight={500}>
                          {putText}
                        </tspan>
                      ) : null}
                    </text>
                  </g>
                )
              })}

            {!incognito && (
              <text
                x={18}
                y={M.top + PLOT_H / 2}
                transform={`rotate(-90 18 ${M.top + PLOT_H / 2})`}
                textAnchor="middle"
                fontSize={12}
                fill={chartUi.muted}
              >
                €
              </text>
            )}

            {buys.filter((b) => visible[b.sym] !== false).map((b) => {
              const sym = b.sym
              const px = xScale(parseDay(b.date))
              const py = yScale(b.y)
              const lx = xScale(b.lx)
              const ly = yScale(b.ly)
              const color = seriesColor(sym)
              const padX = 6
              const tw = b.label.length * 6.4 + padX * 2
              const th = 18
              const dist = Math.hypot(lx - px, ly - py)
              const labelsOn = showLabels && !incognito
              return (
                <g key={b.id}>
                  {labelsOn && dist > 10 && (
                    <line
                      x1={px}
                      y1={py}
                      x2={lx}
                      y2={ly}
                      stroke={color}
                      strokeWidth={0.9}
                    />
                  )}
                  <circle
                    cx={px}
                    cy={py}
                    r={4.5}
                    fill={color}
                    stroke={chartUi.markerStroke}
                    strokeWidth={1}
                  />
                  {labelsOn && (
                    <g
                      className="label-hit"
                      transform={`translate(${lx - tw / 2}, ${ly - th / 2})`}
                      onPointerDown={(e) => onPointerDown(e, b.id)}
                    >
                      {/* Larger invisible hit target for fingers */}
                      <rect
                        x={-10}
                        y={-10}
                        width={tw + 20}
                        height={th + 20}
                        fill="transparent"
                      />
                      <rect
                        width={tw}
                        height={th}
                        rx={4}
                        fill={chartUi.chip}
                        stroke={color}
                        strokeWidth={active === b.id ? 1.6 : 0.9}
                        opacity={0.96}
                      />
                      <text
                        x={tw / 2}
                        y={th / 2 + 4}
                        textAnchor="middle"
                        fontSize={11}
                        fontWeight={700}
                        fill={color}
                        style={{ pointerEvents: 'none' }}
                      >
                        {b.label}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}

            {divLabels
              .filter((d) => visible[d.sym] !== false)
              .map((d) => {
                const color = seriesColor(d.sym)
                const cx = xScale(parseDay(d.date))
                const cy = yScale(d.y)
                const lx = xScale(d.lx)
                const ly = yScale(d.ly)
                const s = 5
                const padX = 5
                const tw = d.label.length * 6.2 + padX * 2
                const th = 16
                const dist = Math.hypot(lx - cx, ly - cy)
                const labelsOn = showLabels && !incognito
                return (
                  <g key={d.id}>
                    {!incognito && <title>{d.label}</title>}
                    {labelsOn && dist > 10 && (
                      <line
                        x1={cx}
                        y1={cy}
                        x2={lx}
                        y2={ly}
                        stroke={color}
                        strokeWidth={0.8}
                        strokeDasharray="2 2"
                      />
                    )}
                    <polygon
                      points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
                      fill={chartUi.chip}
                      stroke={color}
                      strokeWidth={1.4}
                    />
                    {labelsOn && (
                      <g
                        className="label-hit"
                        transform={`translate(${lx - tw / 2}, ${ly - th / 2})`}
                        onPointerDown={(e) => onPointerDown(e, d.id)}
                      >
                        <rect
                          x={-10}
                          y={-10}
                          width={tw + 20}
                          height={th + 20}
                          fill="transparent"
                        />
                        <rect
                          width={tw}
                          height={th}
                          rx={3}
                          fill={chartUi.chip}
                          stroke={color}
                          strokeWidth={active === d.id ? 1.6 : 0.9}
                          strokeDasharray="3 2"
                          opacity={0.96}
                        />
                        <text
                          x={tw / 2}
                          y={th / 2 + 3.5}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight={700}
                          fill={color}
                          style={{ pointerEvents: 'none' }}
                        >
                          {d.label}
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}

            {seriesOrder
              .filter((sym) => visible[sym] !== false && data.series[sym])
              .map((sym) => {
                const val = data.series[sym][data.series[sym].length - 1]
                const color = seriesColor(sym)
                const pct = fmtPct(val, invested[sym] ?? 0)
                const text = incognito
                  ? nameOf(sym)
                  : pct
                    ? `${nameOf(sym)} ${fmtEnd(val)} (${pct})`
                    : `${nameOf(sym)} ${fmtEnd(val)}`
                return (
                  <text
                    key={`end-${sym}`}
                    x={endX}
                    y={yScale(val) + 4}
                    fontSize={12}
                    fontWeight={700}
                    fill={color}
                    textAnchor="start"
                  >
                    {text}
                  </text>
                )
              })}

          </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

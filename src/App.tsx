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
  CHART_COLORS,
  CHART_LABELS,
  colorFor,
  seriesKeys,
  type ChartData,
} from './ibkr'
import {
  CLASSIC_ID,
  deletePortfolio,
  ensureClassic,
  fingerprintFromChart,
  loadStore,
  nameFromFile,
  saveStore,
  setActive,
  updatePositions,
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

/** Factory layout for the synthetic Classic demo (not a real portfolio). */
const FACTORY_POS: PosMap = {
  'VOO-2026-02-26': { lx: 1772323200000, ly: 40 },
  'VOO-2026-03-16': { lx: 1773878400000, ly: -65.34 },
  'QQQ-2026-04-13': { lx: 1776297600000, ly: 96 },
  'VOO-2026-05-06': { lx: 1778284800000, ly: 91.96 },
  'SMH-2026-06-01': { lx: 1780531200000, ly: 68 },
  'VOO-2026-06-25': { lx: 1782604800000, ly: 139.05 },
  'QQQ-2026-07-20': { lx: 1784764800000, ly: 131.86 },
  'SMH-2026-08-12': { lx: 1786752000000, ly: -82.52 },
  'VOO-2026-08-28': { lx: 1788134400000, ly: 422.97 },
  'QQQ-2026-09-16': { lx: 1789776000000, ly: 56.03 },
  'SMH-2026-09-30': { lx: 1790985600000, ly: 121.56 },
}

function buysToPosMap(buys: Buy[]): PosMap {
  return Object.fromEntries(buys.map((b) => [b.id, { lx: b.lx, ly: b.ly }]))
}

const W = 1100
const H = 640
const M = { top: 48, right: 130, bottom: 48, left: 56 }
const PLOT_W = W - M.left - M.right
const PLOT_H = H - M.top - M.bottom
const EXPORT_SCALE = 3

function parseDay(s: string) {
  return new Date(s + 'T00:00:00').getTime()
}

/** Auto-place buy labels from whatever tickers/dates the statement has. */
function fallbackBuys(raw: ChartData['buys']): Buy[] {
  if (!raw.length) return []
  const bySym = new Map<string, ChartData['buys']>()
  for (const b of raw) {
    const list = bySym.get(b.sym) ?? []
    list.push(b)
    bySym.set(b.sym, list)
  }
  const symOffset = new Map<string, number>()
  ;[...bySym.keys()].sort().forEach((sym, i) => {
    symOffset.set(sym, (i % 5) * 22)
  })
  const counters = new Map<string, number>()

  return raw.map((b) => {
    const n = counters.get(b.sym) ?? 0
    counters.set(b.sym, n + 1)
    const side = n % 2 === 0 ? 1 : -1
    const stack = Math.floor(n / 2)
    const base = symOffset.get(b.sym) ?? 0
    return {
      ...b,
      lx: parseDay(b.date) + (2 + stack) * 86400000,
      ly: b.y + side * (36 + stack * 28 + base),
    }
  })
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

function normalizeChart(d: ChartData): ChartData {
  const tickers =
    d.tickers?.length
      ? d.tickers
      : Object.keys(d.series).filter((k) => k !== 'TOTAL' && k !== 'ALL_VOO')
  const baseline = d.baseline || (tickers.includes('VOO') ? 'VOO' : tickers[0] || 'VOO')
  const colors: Record<string, string> = {
    ...CHART_COLORS,
    ...d.colors,
    TOTAL: d.colors?.TOTAL ?? CHART_COLORS.TOTAL,
    ALL_VOO: d.colors?.ALL_VOO ?? CHART_COLORS.ALL_VOO,
  }
  const labels: Record<string, string> = {
    ...CHART_LABELS,
    ...d.labels,
    TOTAL: d.labels?.TOTAL ?? 'TOTAL',
    ALL_VOO: d.labels?.ALL_VOO ?? `if all → ${baseline}`,
  }
  tickers.forEach((t, i) => {
    colors[t] = colors[t] ?? colorFor(t, i)
    labels[t] = labels[t] ?? t
  })
  return {
    ...d,
    tickers,
    baseline,
    colors,
    labels,
    deltaAllVoo:
      d.deltaAllVoo ??
      (d.series.ALL_VOO && d.series.TOTAL
        ? d.series.ALL_VOO[d.series.ALL_VOO.length - 1] -
          d.series.TOTAL[d.series.TOTAL.length - 1]
        : 0),
  }
}

export default function App() {
  const [data, setData] = useState<ChartData | null>(null)
  const [classicChart, setClassicChart] = useState<ChartData | null>(null)
  const [buys, setBuys] = useState<Buy[]>([])
  const [active, setActiveLabel] = useState<string | null>(null)
  const [saveMsg, setSaveMsg] = useState('')
  const [statusMsg, setStatusMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [store, setStore] = useState<PortfolioStore>(() => loadStore())
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const buysRef = useRef<Buy[]>([])
  const storeRef = useRef(store)
  const saveGen = useRef(0)
  const dragRef = useRef<{
    id: string
    startX: number
    startY: number
    origLx: number
    origLy: number
  } | null>(null)

  useEffect(() => {
    storeRef.current = store
  }, [store])

  useEffect(() => {
    buysRef.current = buys
  }, [buys])

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
      const nextBuys = applyPositions(
        normalized.buys,
        positions && Object.keys(positions).length ? positions : null,
      )
      buysRef.current = nextBuys
      setBuys(nextBuys)
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
        const classicPositions =
          savedClassic && Object.keys(savedClassic.positions).length
            ? savedClassic.positions
            : factoryOrDefault
        const withClassic = ensureClassic(initial, fingerprintFromChart(classic), {
          asOf: classic.asOf,
          buysCount: classic.buys.length,
          positions: classicPositions,
        })
        saveStore(withClassic)
        setStore(withClassic)
        storeRef.current = withClassic

        const activeItem =
          withClassic.items.find((i) => i.id === withClassic.activeId) ??
          withClassic.items.find((i) => i.id === CLASSIC_ID)!

        if (activeItem.kind === 'upload' && activeItem.chart) {
          showPortfolio(activeItem.chart, activeItem.positions)
          setStatusMsg(
            `Restored “${activeItem.name}” · ${activeItem.buysCount} buys`,
          )
        } else {
          showPortfolio(classic, activeItem.positions)
        }
        localStorage.removeItem('ibkr-label-positions-v1')
        localStorage.removeItem('ibkr-label-positions-v2')
        localStorage.removeItem('ibkr-label-positions-v3')
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
      const chart = await buildChartFromIbkrCsv(text)
      const normalized = normalizeChart(chart)
      const positions = buysToPosMap(applyPositions(normalized.buys, null))
      const { store: next, id, reused } = upsertUpload(storeRef.current, {
        name: nameFromFile(file.name),
        chart: normalized,
        positions,
      })
      commitStore(next)
      const item = next.items.find((i) => i.id === id)!
      if (item.kind === 'classic' && classicChart) {
        showPortfolio(classicChart, item.positions)
      } else if (item.chart) {
        showPortfolio(item.chart, item.positions)
      } else {
        showPortfolio(normalized, item.positions)
      }
      setStatusMsg(
        reused
          ? `Same statement as “${item.name}” — switched · ${normalized.tickers.join(', ')} · ${item.buysCount} buys`
          : `Saved “${item.name}” · ${normalized.tickers.join(', ')} · ${normalized.buys.length} buys · ${normalized.dates[0]} → ${normalized.asOf}`,
      )
    } catch (e) {
      setStatusMsg(`Upload failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const selectPortfolio = (item: StoredPortfolio) => {
    if (item.id === storeRef.current.activeId) return
    // Persist current label layout before switching
    const cur = storeRef.current
    const withPos = updatePositions(
      cur,
      cur.activeId,
      buysToPosMap(buysRef.current),
    )
    const next = setActive(withPos, item.id)
    commitStore(next)
    if (item.kind === 'classic') {
      if (!classicChart) return
      const classicItem = next.items.find((i) => i.id === CLASSIC_ID)
      showPortfolio(classicChart, classicItem?.positions ?? FACTORY_POS)
      setStatusMsg('Classic (demo)')
    } else if (item.chart) {
      showPortfolio(item.chart, item.positions)
      setStatusMsg(`“${item.name}” · ${item.buysCount} buys`)
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
      showPortfolio(classicChart, classicItem?.positions ?? FACTORY_POS)
      setStatusMsg('Deleted · back to Classic (demo)')
    } else {
      setStatusMsg(`Deleted “${item.name}”`)
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
  }, [data, buys])

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

  const onPointerDown = (e: ReactPointerEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    const item = buys.find((b) => b.id === id)
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
    setBuys((prev) =>
      prev.map((b) => (b.id === drag.id ? { ...b, lx: newLx, ly: newLy } : b)),
    )
  }

  const saveLayout = useCallback(
    async (reason: string, snapshot?: Buy[]) => {
      const current = snapshot ?? buysRef.current
      if (!current.length) return
      const gen = ++saveGen.current
      const map = buysToPosMap(current)
      const next = updatePositions(
        storeRef.current,
        storeRef.current.activeId,
        map,
      )
      commitStore(next)

      if (import.meta.env.DEV && storeRef.current.activeId === CLASSIC_ID) {
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
      setSaveMsg(`Saved ${Object.keys(map).length} labels (${reason})`)
    },
    [commitStore],
  )

  const onPointerUp = () => {
    const wasDragging = !!dragRef.current
    dragRef.current = null
    setActiveLabel(null)
    if (wasDragging) {
      void saveLayout(
        'drag',
        buysRef.current.map((b) => ({ ...b })),
      )
    }
  }

  const reset = () => {
    if (!data) return
    saveGen.current += 1
    dragRef.current = null
    const nextBuys = applyPositions(
      data.buys,
      storeRef.current.activeId === CLASSIC_ID ? FACTORY_POS : null,
    )
    buysRef.current = nextBuys
    setBuys(nextBuys)
    void saveLayout('reset', nextBuys)
    setSaveMsg('Reset label layout')
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
      'font-family: "IBM Plex Sans", "Segoe UI", Arial, sans-serif; background:#f7f3ea;',
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
    ctx.fillStyle = '#f7f3ea'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = 'ibkr_earnings_with_buys.png'
    a.click()
  }

  const activePortfolio =
    store.items.find((i) => i.id === store.activeId) ??
    store.items.find((i) => i.id === CLASSIC_ID)

  if (!data || !scales) {
    return (
      <div className="app">
        <div className="toolbar">
          <h1>IBKR Label Editor</h1>
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
  const delta =
    data.deltaAllVoo ??
    (data.series.ALL_VOO
      ? data.series.ALL_VOO[data.series.ALL_VOO.length - 1] -
        data.series.TOTAL[data.series.TOTAL.length - 1]
      : 0)

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
        <p className="sidebar-hint">
          Uploads stay in this browser. Identical statements reuse the same
          entry.
        </p>
      </aside>

      <div className="main">
        <div className="toolbar">
          <h1>IBKR Label Editor</h1>
          <button type="button" onClick={reset}>
            Reset positions
          </button>
          <button type="button" onClick={() => void saveLayout('manual')}>
            Save layout
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Loading…' : 'Upload IBKR CSV'}
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
          <p>
            {activePortfolio
              ? `Active: ${activePortfolio.name}. `
              : ''}
            Tickers & dates follow the uploaded statement.
            Drag labels · toggle series · dashed = if all → {data.baseline}
            {data.deltaAllVoo != null ? ` (${fmtEnd(delta)} vs TOTAL)` : ''}.
            {statusMsg ? ` · ${statusMsg}` : ''}
            {saveMsg ? ` · ${saveMsg}` : ''}
          </p>
        </div>

        <div className="toggles" role="group" aria-label="Series visibility">
          {seriesOrder.map((sym) => (
            <button
              key={sym}
              type="button"
              className={`toggle${visible[sym] !== false ? ' on' : ''}`}
              style={
                {
                  '--c': data.colors[sym] ?? colorFor(sym),
                } as CSSProperties
              }
              onClick={() => toggleSeries(sym)}
              aria-pressed={visible[sym] !== false}
            >
              <span className="swatch" />
              {nameOf(sym)}
            </button>
          ))}
        </div>

        <div className="stage">
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
            <rect x={0} y={0} width={W} height={H} fill="#f7f3ea" />
            <text
              x={W / 2}
              y={26}
              textAnchor="middle"
              fontSize={15}
              fontWeight={650}
              fill="#1c1917"
            >
              {data.title}
            </text>

            {yTicks.map((v) => (
              <g key={v}>
                <line
                  x1={M.left}
                  x2={M.left + PLOT_W}
                  y1={yScale(v)}
                  y2={yScale(v)}
                  stroke="#cfc8bb"
                  strokeWidth={0.8}
                />
                <text
                  x={M.left - 8}
                  y={yScale(v) + 4}
                  textAnchor="end"
                  fontSize={11}
                  fill="#57534e"
                >
                  {v}
                </text>
              </g>
            ))}
            {months.map((m) => (
              <g key={m.t}>
                <line
                  x1={xScale(m.t)}
                  x2={xScale(m.t)}
                  y1={M.top}
                  y2={M.top + PLOT_H}
                  stroke="#cfc8bb"
                  strokeWidth={0.6}
                />
                <text
                  x={xScale(m.t)}
                  y={H - 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#57534e"
                >
                  {m.label}
                </text>
              </g>
            ))}

            <line
              x1={M.left}
              x2={M.left + PLOT_W}
              y1={zeroY}
              y2={zeroY}
              stroke="#888"
              strokeWidth={1}
              strokeDasharray="4 3"
            />

            {paths.map(({ sym, pts }) => (
              <polyline
                key={sym}
                fill="none"
                points={pts}
                stroke={data.colors[sym]}
                strokeWidth={sym === 'TOTAL' || sym === 'ALL_VOO' ? 2.4 : 1.8}
                strokeDasharray={sym === 'ALL_VOO' ? '7 4' : undefined}
              />
            ))}

            {seriesOrder
              .filter((sym) => visible[sym] !== false && data.series[sym])
              .map((sym, i) => (
                <g
                  key={sym}
                  transform={`translate(${M.left + 8}, ${M.top + 14 + i * 18})`}
                >
                  <line
                    x1={0}
                    x2={18}
                    y1={0}
                    y2={0}
                    stroke={data.colors[sym]}
                    strokeWidth={sym === 'TOTAL' || sym === 'ALL_VOO' ? 2.4 : 1.8}
                    strokeDasharray={sym === 'ALL_VOO' ? '7 4' : undefined}
                  />
                  <text x={24} y={4} fontSize={12} fill="#1c1917">
                    {nameOf(sym)}
                  </text>
                </g>
              ))}

            <text
              x={18}
              y={M.top + PLOT_H / 2}
              transform={`rotate(-90 18 ${M.top + PLOT_H / 2})`}
              textAnchor="middle"
              fontSize={12}
              fill="#57534e"
            >
              €
            </text>

            {buys.filter((b) => visible[b.sym] !== false).map((b) => {
              const sym = b.sym
              const px = xScale(parseDay(b.date))
              const py = yScale(b.y)
              const lx = xScale(b.lx)
              const ly = yScale(b.ly)
              const color = data.colors[sym] ?? colorFor(sym)
              const padX = 6
              const tw = b.label.length * 6.4 + padX * 2
              const th = 18
              const dist = Math.hypot(lx - px, ly - py)
              return (
                <g key={b.id}>
                  {dist > 22 && (
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
                    stroke="#fff"
                    strokeWidth={1}
                  />
                  <g
                    className="label-hit"
                    transform={`translate(${lx - tw / 2}, ${ly - th / 2})`}
                    onPointerDown={(e) => onPointerDown(e, b.id)}
                  >
                    <rect
                      width={tw}
                      height={th}
                      rx={4}
                      fill="#fff"
                      stroke={color}
                      strokeWidth={active === b.id ? 1.6 : 0.9}
                      opacity={0.95}
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
                </g>
              )
            })}

            {seriesOrder
              .filter((sym) => visible[sym] !== false && data.series[sym])
              .map((sym) => {
                const val = data.series[sym][data.series[sym].length - 1]
                const color = data.colors[sym] ?? colorFor(sym)
                const text = `${nameOf(sym)} ${fmtEnd(val)}`
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

            {visible.TOTAL !== false &&
              visible.ALL_VOO !== false &&
              data.series.ALL_VOO &&
              Math.abs(delta) >= 1 && (
                <g>
                  <rect
                    x={M.left + PLOT_W - 168}
                    y={M.top + 8}
                    width={156}
                    height={28}
                    rx={6}
                    fill="#fff5f5"
                    stroke={data.colors.ALL_VOO}
                    strokeWidth={1.2}
                  />
                  <text
                    x={M.left + PLOT_W - 90}
                    y={M.top + 27}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={700}
                    fill={data.colors.ALL_VOO}
                  >
                    {`diff vs TOTAL: ${fmtEnd(delta)}`}
                  </text>
                </g>
              )}
          </svg>
        </div>
        <p className="status">
          Tip: switch portfolios in the left list. Trash icon deletes an upload.
          Label positions are saved per portfolio in this browser.
        </p>
      </div>
    </div>
  )
}

import type { ChartData } from './ibkr'

export type PosMap = Record<string, { lx: number; ly: number }>

export type PortfolioKind = 'classic' | 'upload'

export type StoredPortfolio = {
  id: string
  name: string
  kind: PortfolioKind
  fingerprint: string
  createdAt: string
  asOf?: string
  buysCount: number
  /** Last explicit Save — what Reset restores. */
  positions: PosMap
  /** Working layout after drags (survives refresh). */
  draftPositions?: PosMap
  /** Full chart for uploads; classic reloads from chart_data.json */
  chart?: ChartData
  /** Original Activity Statement CSV — needed to rebuild to today. */
  csvText?: string
}

export type PortfolioStore = {
  activeId: string
  items: StoredPortfolio[]
}

export const CLASSIC_ID = 'classic'
export const PORTFOLIOS_KEY = 'ibkr-portfolios-v3'

export function fingerprintFromChart(chart: ChartData): string {
  return chart.buys
    .map((b) => `${b.date}|${b.sym}|${Math.round(b.eur * 100)}`)
    .sort()
    .join(';')
}

export function loadStore(): PortfolioStore {
  try {
    const raw =
      localStorage.getItem(PORTFOLIOS_KEY) ??
      localStorage.getItem('ibkr-portfolios-v2')
    if (!raw) {
      return { activeId: CLASSIC_ID, items: [] }
    }
    const parsed = JSON.parse(raw) as PortfolioStore
    if (!parsed || !Array.isArray(parsed.items)) {
      return { activeId: CLASSIC_ID, items: [] }
    }
    return {
      activeId: parsed.activeId || CLASSIC_ID,
      items: parsed.items.filter((i) => i && i.id && i.kind),
    }
  } catch {
    return { activeId: CLASSIC_ID, items: [] }
  }
}

export function saveStore(store: PortfolioStore) {
  localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(store))
}

export function layoutFor(item: StoredPortfolio | undefined): PosMap {
  if (!item) return {}
  if (item.draftPositions && Object.keys(item.draftPositions).length) {
    return item.draftPositions
  }
  return item.positions ?? {}
}

export function ensureClassic(
  store: PortfolioStore,
  fingerprint: string,
  meta: { asOf?: string; buysCount: number; positions: PosMap },
): PortfolioStore {
  const existing = store.items.find((i) => i.id === CLASSIC_ID)
  const sameDemo = existing?.fingerprint === fingerprint
  const classic: StoredPortfolio = {
    id: CLASSIC_ID,
    name: 'Classic (demo)',
    kind: 'classic',
    fingerprint,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    asOf: meta.asOf,
    buysCount: meta.buysCount,
    positions:
      sameDemo && Object.keys(existing?.positions ?? {}).length
        ? existing!.positions
        : meta.positions,
    draftPositions: sameDemo ? existing?.draftPositions : undefined,
  }
  const others = store.items.filter((i) => i.id !== CLASSIC_ID)
  return {
    activeId: store.activeId || CLASSIC_ID,
    items: [classic, ...others],
  }
}

export function upsertUpload(
  store: PortfolioStore,
  input: {
    name: string
    chart: ChartData
    positions: PosMap
    csvText?: string
  },
): { store: PortfolioStore; id: string; reused: boolean } {
  const fingerprint = fingerprintFromChart(input.chart)
  const classic = store.items.find((i) => i.id === CLASSIC_ID)
  if (classic && classic.fingerprint === fingerprint) {
    return {
      store: { ...store, activeId: CLASSIC_ID },
      id: CLASSIC_ID,
      reused: true,
    }
  }
  const existing = store.items.find(
    (i) => i.kind === 'upload' && i.fingerprint === fingerprint,
  )
  if (existing) {
    const updated: StoredPortfolio = {
      ...existing,
      name: existing.name,
      asOf: input.chart.asOf,
      buysCount: input.chart.buys.length,
      chart: input.chart,
      csvText: input.csvText ?? existing.csvText,
      // Keep last Save; only seed positions if somehow empty
      positions: Object.keys(existing.positions).length
        ? existing.positions
        : input.positions,
    }
    return {
      store: {
        activeId: existing.id,
        items: store.items.map((i) => (i.id === existing.id ? updated : i)),
      },
      id: existing.id,
      reused: true,
    }
  }

  const id = `upload-${Date.now().toString(36)}`
  const item: StoredPortfolio = {
    id,
    name: input.name,
    kind: 'upload',
    fingerprint,
    createdAt: new Date().toISOString(),
    asOf: input.chart.asOf,
    buysCount: input.chart.buys.length,
    positions: input.positions,
    draftPositions: input.positions,
    chart: input.chart,
    csvText: input.csvText,
  }
  return {
    store: {
      activeId: id,
      items: [...store.items, item],
    },
    id,
    reused: false,
  }
}

/** Replace chart data after a “Refresh to today” rebuild. */
export function updatePortfolioChart(
  store: PortfolioStore,
  id: string,
  chart: ChartData,
): PortfolioStore {
  return {
    ...store,
    items: store.items.map((i) =>
      i.id === id
        ? {
            ...i,
            chart,
            asOf: chart.asOf,
            buysCount: chart.buys.length,
            fingerprint: fingerprintFromChart(chart),
          }
        : i,
    ),
  }
}

export function deletePortfolio(
  store: PortfolioStore,
  id: string,
): PortfolioStore {
  if (id === CLASSIC_ID) return store
  const items = store.items.filter((i) => i.id !== id)
  const activeId =
    store.activeId === id ? CLASSIC_ID : store.activeId
  return { activeId, items }
}

export function setActive(store: PortfolioStore, id: string): PortfolioStore {
  if (!store.items.some((i) => i.id === id)) return store
  return { ...store, activeId: id }
}

/** Explicit Save — Reset target. */
export function updateSavedPositions(
  store: PortfolioStore,
  id: string,
  positions: PosMap,
): PortfolioStore {
  return {
    ...store,
    items: store.items.map((i) =>
      i.id === id ? { ...i, positions, draftPositions: positions } : i,
    ),
  }
}

/** Drag / working layout only. */
export function updateDraftPositions(
  store: PortfolioStore,
  id: string,
  draftPositions: PosMap,
): PortfolioStore {
  return {
    ...store,
    items: store.items.map((i) =>
      i.id === id ? { ...i, draftPositions } : i,
    ),
  }
}

export function nameFromFile(fileName: string): string {
  const base = fileName.replace(/\.csv$/i, '').trim()
  if (!base) return 'Uploaded statement'
  return base.length > 42 ? `${base.slice(0, 40)}…` : base
}

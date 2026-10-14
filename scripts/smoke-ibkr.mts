import { readFileSync } from 'fs'
import { buildChartFromIbkrCsv } from '../src/ibkr'

const cache = readFileSync('public/prices_cache.json', 'utf8')
const orig = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('prices_cache.json')) {
    return new Response(cache, { status: 200 })
  }
  if (url.includes('frankfurter')) {
    return new Response('{}', { status: 500 })
  }
  return orig(input, init)
}) as typeof fetch

const csv = `Trades,Data,Order,Stocks,USD,VOO,"2026-06-06, 12:00:00",2.5,600.0,600.0,-1500.0,-1.0,1501.0,0,0,O`
const chart = await buildChartFromIbkrCsv(csv, { endDate: '2026-10-14' })
const out = {
  firstVOO: chart.series.VOO[0],
  buyY: chart.buys[0]?.y,
  last: chart.series.VOO.at(-1),
  n: chart.dates.length,
}
console.log(out)
if (chart.series.VOO[0] !== 0 || chart.buys[0]?.y !== 0) {
  throw new Error('expected open-day earnings to be 0')
}

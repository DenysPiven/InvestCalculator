import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const base = process.env.VITE_BASE || '/'

function savePositionsPlugin(): Plugin {
  const file = path.resolve(rootDir, 'public/default_positions.json')
  const mirror = path.resolve(rootDir, 'saved_positions.json')

  return {
    name: 'save-positions',
    configureServer(server) {
      server.middlewares.use('/api/save-positions', (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(body) as {
              buys: Record<string, { lx: number; ly: number }>
            }
            if (!parsed?.buys || typeof parsed.buys !== 'object') {
              res.statusCode = 400
              res.end('invalid body')
              return
            }
            const text = JSON.stringify({ buys: parsed.buys }, null, 2) + '\n'
            fs.writeFileSync(file, text)
            fs.writeFileSync(mirror, text)
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({ ok: true, count: Object.keys(parsed.buys).length }),
            )
          } catch (e) {
            res.statusCode = 500
            res.end(String(e))
          }
        })
      })
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), savePositionsPlugin()],
  server: {
    host: '0.0.0.0',
    port: 43127,
    strictPort: true,
    proxy: {
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/yahoo/, ''),
      },
    },
    watch: {
      ignored: [
        '**/public/default_positions.json',
        '**/saved_positions.json',
      ],
    },
  },
})

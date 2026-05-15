// Entry point. Env vars are loaded by `tsx watch --env-file=../.env` (see
// package.json) — DO NOT add `dotenv.config()` here. The native --env-file
// loads .env BEFORE any module evaluates, which is the only reliable way to
// avoid the "env undefined at module top-level" bug.
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import authRouter from './routes/auth.js'

// Fail-fast on missing creds. Without this, missing env surfaces as cryptic
// "API key not valid" errors from Identity Toolkit several layers downstream.
const REQUIRED = ['GIP_FIREBASE_API_KEY', 'GIP_TENANT_ID', 'GCP_PROJECT_ID'] as const
const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length > 0) {
  console.error(`[server] Missing env: ${missing.join(', ')}`)
  console.error('[server] Did `provision_auth` run? .env should live at the project root.')
  console.error('[server] If you ran the server directly (not via npm run dev), the --env-file flag may have missed.')
  process.exit(1)
}

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '2mb' }))
app.use(morgan('dev'))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/auth', authRouter)

// 404 — must return JSON (not HTML) so the frontend's auth client can parse it.
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Generic error handler.
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server] Unhandled error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://localhost:${PORT}`)
})

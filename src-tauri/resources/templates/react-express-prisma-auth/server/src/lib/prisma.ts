// Singleton Prisma client.
//
// DATABASE_URL resolution: scripts/db-setup.mjs sets DATABASE_URL only inside
// its own spawned `npx prisma migrate` child — it never propagates to the
// server runtime. If the user's .env also doesn't define DATABASE_URL (the
// default after provision_auth, since provision_auth doesn't write DB keys),
// PrismaClient instantiates without a URL and the first query crashes.
//
// Worse: if .env has a RELATIVE DATABASE_URL (e.g. `file:./prisma/dev.db`),
// Prisma resolves it from the server's CWD (`server/`) — pointing at a
// different file than the one db-setup.mjs migrated (which used the project
// root). Prisma creates the missing file empty, then every query throws
// P2021 "table users does not exist". This is the recurring 500 on /auth/sync.
//
// Fix: locate <project>/prisma/schema.prisma by walking up from __dirname,
// then force DATABASE_URL to an absolute file:// of <project>/prisma/dev.db
// before instantiating the client. Same algorithm as db-setup.mjs so both
// processes always agree on the file location. Respects an existing absolute
// DATABASE_URL (e.g. Postgres on a deployed environment).
import { PrismaClient } from '@prisma/client'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function isAbsoluteFileUrl(url: string | undefined): boolean {
  if (!url) return false
  // Postgres / MySQL / etc. — leave alone, the user opted into a non-SQLite engine.
  if (!url.startsWith('file:')) return true
  const path = url.slice(5).replace(/^\/+/, '/')
  return path.startsWith('/')
}

function resolveDatabaseUrl(): string {
  const existing = process.env.DATABASE_URL
  if (isAbsoluteFileUrl(existing)) return existing!

  // Walk up from this file until we find prisma/schema.prisma. That marks the
  // project root regardless of whether the server was started from server/ or
  // project root, and regardless of bundler/dist layouts (tsx, ts-node, etc.).
  const __filename = fileURLToPath(import.meta.url)
  let cur = dirname(__filename)
  const root = dirname(cur)
  while (cur !== dirname(cur)) {
    if (existsSync(resolve(cur, 'prisma/schema.prisma'))) {
      return `file:${resolve(cur, 'prisma/dev.db')}`
    }
    cur = dirname(cur)
  }
  // Last-resort: assume two levels up from this file (server/src/lib → server → root).
  return `file:${resolve(root, '../prisma/dev.db')}`
}

process.env.DATABASE_URL = resolveDatabaseUrl()

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

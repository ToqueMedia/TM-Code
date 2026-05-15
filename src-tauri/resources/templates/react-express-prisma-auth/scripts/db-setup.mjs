#!/usr/bin/env node
/**
 * Idempotent DB bootstrap.
 *
 * Runs as `predev` so the dev server never starts against an unmigrated
 * database. The whole point of having this file (instead of inline npm scripts)
 * is that we can fail loudly with a useful message instead of letting Prisma
 * crash with the cryptic "table does not exist" / P2021 error mid-request.
 *
 * Behaviour:
 *  - resolves DATABASE_URL to an absolute path so the SQLite file lives at
 *    <project-root>/prisma/dev.db regardless of which cwd Prisma is invoked
 *    from (server/ vs root/ — the source of the original "Unable to open
 *    the database file" bug).
 *  - if no migrations exist, runs `prisma migrate dev --name init` to create
 *    the schema.
 *  - if migrations exist, runs `prisma migrate deploy` to apply pending ones.
 *  - on any failure, exits with code 1 so `npm run dev` aborts before
 *    concurrently spawns the workers.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = resolve(dirname(__filename), '..')
const prismaDir = resolve(projectRoot, 'prisma')
const migrationsDir = resolve(prismaDir, 'migrations')
const dbFile = resolve(prismaDir, 'dev.db')

if (!existsSync(prismaDir)) {
  mkdirSync(prismaDir, { recursive: true })
}

// Force absolute DATABASE_URL so Prisma never resolves relative to the wrong cwd.
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || `file:${dbFile}`,
}

const hasMigrations =
  existsSync(migrationsDir) &&
  readdirSync(migrationsDir).some((name) => /^\d{14}_/.test(name))

const args = hasMigrations
  ? ['prisma', 'migrate', 'deploy']
  : ['prisma', 'migrate', 'dev', '--name', 'init', '--skip-seed']

console.log(`[db-setup] ${hasMigrations ? 'Applying pending migrations' : 'Creating initial schema'}`)
console.log(`[db-setup] DATABASE_URL=${env.DATABASE_URL}`)

const result = spawnSync('npx', args, {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
})

if (result.status !== 0) {
  console.error('[db-setup] FAILED. Dev server will not start.')
  console.error('[db-setup] Try: npm run db:reset (destructive — drops all data)')
  process.exit(1)
}

console.log('[db-setup] OK')

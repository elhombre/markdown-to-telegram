import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DEFAULT_MIN_POST_INTERVAL_MS = 1000
const LOCK_POLL_INTERVAL_MS = 100
const LOCK_STALE_AFTER_MS = 60 * 60 * 1000

interface PublishStateEntry {
  lastPublishedAt: string
}

interface PublishStateFile {
  entries: Record<string, PublishStateEntry>
}

export interface PublishGuardConfig {
  scopeKey: string
  minPostIntervalMs?: number
  stateFile?: string
  lockFile?: string
}

export async function withPublishGuard<T>(config: PublishGuardConfig, publish: () => Promise<T>): Promise<T> {
  const minPostIntervalMs = normalizeMinPostInterval(config.minPostIntervalMs)

  if (minPostIntervalMs === 0) {
    return publish()
  }

  const stateFile = resolve(config.stateFile ?? '.md2tg/publish-state.json')
  const lockFile = resolve(config.lockFile ?? deriveDefaultLockFile(stateFile))
  await mkdir(dirname(stateFile), { recursive: true })
  await mkdir(dirname(lockFile), { recursive: true })

  const lockHandle = await acquireLock(lockFile)

  try {
    const state = await readStateFile(stateFile)
    const lastPublishedAt = state.entries[config.scopeKey]?.lastPublishedAt

    if (lastPublishedAt) {
      const waitMs = minPostIntervalMs - (Date.now() - Date.parse(lastPublishedAt))
      if (waitMs > 0) {
        await sleep(waitMs)
      }
    }

    const result = await publish()
    state.entries[config.scopeKey] = {
      lastPublishedAt: new Date().toISOString(),
    }
    await writeStateFile(stateFile, state)
    return result
  } finally {
    await releaseLock(lockFile, lockHandle)
  }
}

function normalizeMinPostInterval(minPostIntervalMs: number | undefined): number {
  if (minPostIntervalMs === undefined) {
    return DEFAULT_MIN_POST_INTERVAL_MS
  }

  if (!Number.isInteger(minPostIntervalMs) || minPostIntervalMs < 0) {
    throw new Error('Invalid publish.minPostIntervalMs value. Expected an integer greater than or equal to 0.')
  }

  return minPostIntervalMs
}

function deriveDefaultLockFile(stateFile: string): string {
  return stateFile.endsWith('.json') ? `${stateFile.slice(0, -'.json'.length)}.lock` : `${stateFile}.lock`
}

async function acquireLock(lockFile: string) {
  while (true) {
    try {
      const handle = await open(lockFile, 'wx')
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8')
      return handle
    } catch (error: unknown) {
      if (!isFileExistsError(error)) {
        throw error
      }

      if (await isStaleLock(lockFile)) {
        await rm(lockFile, { force: true })
        continue
      }

      await sleep(LOCK_POLL_INTERVAL_MS)
    }
  }
}

async function releaseLock(lockFile: string, handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.close()
  } finally {
    await rm(lockFile, { force: true })
  }
}

async function readStateFile(stateFile: string): Promise<PublishStateFile> {
  try {
    const raw = await readFile(stateFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PublishStateFile>

    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error('Missing "entries" object.')
    }

    return {
      entries: Object.fromEntries(
        Object.entries(parsed.entries).flatMap(([scopeKey, entry]) => {
          if (!entry || typeof entry !== 'object' || typeof entry.lastPublishedAt !== 'string') {
            return []
          }

          return [[scopeKey, { lastPublishedAt: entry.lastPublishedAt }]]
        }),
      ),
    }
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return { entries: {} }
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid publish state JSON at ${stateFile}: ${error.message}`)
    }

    if (error instanceof Error && error.message === 'Missing "entries" object.') {
      throw new Error(`Invalid publish state file at ${stateFile}: ${error.message}`)
    }

    throw error
  }
}

async function writeStateFile(stateFile: string, state: PublishStateFile): Promise<void> {
  const tempFile = `${stateFile}.tmp-${process.pid}`
  await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tempFile, stateFile)
}

async function isStaleLock(lockFile: string): Promise<boolean> {
  try {
    const lockStats = await stat(lockFile)
    return Date.now() - lockStats.mtimeMs > LOCK_STALE_AFTER_MS
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return false
    }

    throw error
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, ms)
  })
}

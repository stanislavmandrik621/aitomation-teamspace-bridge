/** Async, bounded facade: all SQLite and credential cryptography run in a dedicated worker. */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { AtRestKey } from './at-rest.js'

export interface MailStoreRecord<T = unknown> { id: string; revision: number; value: T }
export interface MailStoreQuery { owner?: string; account?: string; status?: string; dueBefore?: number; after?: string; limit: number; metadataOnly?: boolean }
export interface MailStoreWrite { collection: string; id: string; value?: unknown; owner?: string; account?: string; status?: string; due?: number; delete?: boolean }
export interface MailStoreToken { accessToken: string; refreshToken: string; expiresAt: number }
export interface MailStoreCredentialSnapshot { registration: string; readInbox: boolean; mailboxAccess?: boolean; token: MailStoreToken }
export type MailStoreRotation<T> = { kind: 'updated' | 'changed'; value: T } | { kind: 'missing' }
export interface MailStoreBatchOptions {
  checks?: Array<{ collection: string; id: string; revision: number | null }>
  limits?: Array<{ collection: string; owner?: string; account?: string; max: number }>
}
export class MailStoreError extends Error {
  constructor(public readonly code: string) {
    super(code === 'queue_full' ? 'Encrypted mailbox storage is busy. Try again later.'
      : code === 'invalid' ? 'Invalid encrypted mailbox storage request.'
        : code === 'capacity' ? 'Encrypted mailbox storage limit reached.'
          : code === 'key' ? 'Encrypted mailbox storage key or integrity check failed.'
            : code === 'closed' ? 'Encrypted mailbox storage is closed.'
              : 'Encrypted mailbox storage is unavailable.')
    this.name = 'MailStoreError'
  }
}

export class MailStore {
  private readonly worker: Worker
  private readonly initialization: Promise<void>
  private initializeOk!: () => void
  private initializeFail!: (reason: unknown) => void
  private sequence = 0
  private closed = false
  private failed: MailStoreError | null = null
  private closing: Promise<void> | null = null
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()

  constructor(options: { dataDir: string; key: AtRestKey; maxBytes?: number }) {
    if (!Buffer.isBuffer(options.key?.key) || options.key.key.length !== 32 || typeof options.dataDir !== 'string' || !options.dataDir.trim()) throw new MailStoreError('invalid')
    const maxBytes = options.maxBytes ?? Number(process.env.TEAMSPACE_MAIL_STORE_MAX_BYTES ?? 1024 * 1024 * 1024)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 * 1024 * 1024 || maxBytes > 1024 ** 4) throw new MailStoreError('invalid')
    this.initialization = new Promise<void>((resolve, reject) => { this.initializeOk = resolve; this.initializeFail = reject })
    // Callers may construct first and await readiness later; errors still remain
    // observable via ready()/operations without a process-level unhandled rejection.
    void this.initialization.catch(() => undefined)
    const compiled = new URL('./mail-store-worker.js', import.meta.url)
    const workerData = { dataDir: options.dataDir, key: Buffer.from(options.key.key), maxBytes }
    if (existsSync(fileURLToPath(compiled))) {
      // --input-type belongs to an eval/stdin parent, never a file worker.
      const execArgv = process.execArgv.filter(argument => !argument.startsWith('--input-type'))
      this.worker = new Worker(compiled, { workerData, execArgv })
    } else {
      // Source-mode tsx register must run *inside* the worker. Parent loader
      // hooks do not automatically teach worker entrypoints how to load TS.
      const source = new URL('./mail-store-worker.ts', import.meta.url)
      const require = createRequire(import.meta.url)
      const loader = pathToFileURL(require.resolve('tsx/esm/api')).href
      const bootstrap = `import(${JSON.stringify(loader)}).then(({tsImport}) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)})).catch(() => { process.exitCode = 1 })`
      this.worker = new Worker(bootstrap, { eval: true, workerData })
    }
    this.worker.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return this.fail()
      const reply = message as { ready?: boolean; id?: number; value?: unknown; error?: string }
      if (reply.ready === true) { this.initializeOk(); return }
      if (reply.id === 0) { this.fail(reply.error === 'key' ? 'key' : 'storage'); return }
      const item = typeof reply.id === 'number' ? this.pending.get(reply.id) : undefined
      if (!item || reply.id === undefined) return
      this.pending.delete(reply.id)
      if (reply.error) item.reject(new MailStoreError(['invalid', 'capacity', 'key', 'closed'].includes(reply.error) ? reply.error : 'storage'))
      else item.resolve(reply.value)
    })
    this.worker.on('error', () => this.fail())
    this.worker.on('exit', () => { if (!this.closed || this.pending.size) this.fail() })
  }

  private fail(code = 'storage'): void {
    if (this.failed) return
    this.failed = new MailStoreError(code)
    this.initializeFail(this.failed)
    for (const item of this.pending.values()) item.reject(this.failed)
    this.pending.clear()
    void this.worker.terminate().catch(() => undefined)
  }
  ready(): Promise<void> { return this.failed ? Promise.reject(this.failed) : this.initialization }
  private request<T>(operation: string, args: unknown): Promise<T> {
    if (this.failed) return Promise.reject(this.failed)
    if (this.closed) return Promise.reject(new MailStoreError('closed'))
    // Reserve the final bounded IPC slot for orderly shutdown. Closing a full
    // data queue must not force termination before accepted writes commit.
    if (this.pending.size >= (operation === 'close' ? 1024 : 1023)) return Promise.reject(new MailStoreError('queue_full'))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      void this.initialization.then(() => {
        if (!this.pending.has(id)) return
        try { this.worker.postMessage({ id, operation, args }) }
        catch { this.pending.delete(id); reject(new MailStoreError('invalid')) }
      }, error => { this.pending.delete(id); reject(error) })
    })
  }
  get<T = unknown>(collection: string, id: string): Promise<MailStoreRecord<T> | null> { return this.request('get', { collection, id }) }
  list<T = unknown>(collection: string, query: MailStoreQuery): Promise<Array<MailStoreRecord<T>>> { return this.request('list', { collection, query }) }
  count(collection: string, query?: Pick<MailStoreQuery, 'owner' | 'account' | 'status'>): Promise<number> { return this.request('count', { collection, query: query ?? {} }) }
  batch(writes: MailStoreWrite[], options?: MailStoreBatchOptions): Promise<boolean> {
    if (!Array.isArray(writes) || writes.length > 500) return Promise.reject(new MailStoreError('invalid'))
    return this.request('batch', { writes, options: options ?? {} })
  }
  /** Atomic credential-only merge; never replaces a newer consent or revives a deleted connection. */
  rotateConnection<T = unknown>(id: string, expected: MailStoreCredentialSnapshot, replacementToken: MailStoreToken): Promise<MailStoreRotation<T>> {
    return this.request('rotateConnection', { id, expected, replacementToken })
  }
  /** Physical expiration is deliberately restricted to terminal outbox jobs. */
  purge(collection: string, query: { status?: string; dueBefore: number; limit: number }): Promise<number> { return this.request('purge', { collection, query }) }
  close(): Promise<void> {
    if (this.closing) return this.closing
    if (this.failed) return this.worker.terminate().then(() => undefined)
    const finished = this.request<void>('close', {})
    this.closed = true
    this.closing = finished.finally(async () => { await this.worker.terminate() })
    return this.closing
  }
}

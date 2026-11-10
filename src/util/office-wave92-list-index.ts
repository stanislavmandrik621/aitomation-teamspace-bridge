import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'

type Row = { teamId: string; kind: string; sourceId: string }
type Check = () => void
type Io = { mkdtemp: typeof mkdtemp; chmod: typeof chmod; open: typeof open; rm: typeof rm }
const filesystem: Io = { mkdtemp, chmod, open, rm }
const RUN = 2048, BLOCK = 4096
const invalid = (): never => { throw Error('Invalid private Office position index') }
class Resources {
  private pending = new Set<() => Promise<void>>()
  own(action: () => Promise<void>) {
    const release = async () => { if (!this.pending.has(release)) return; await action(); this.pending.delete(release) }
    this.pending.add(release); return release
  }
  async clean(primary?: unknown) { await clean([...this.pending].reverse(), primary) }
}
// Keep idle cleanup closures outside the builder's lexical environment: an
// owned directory must not retain the builder's complete source array.
const ownDirectory = (resources: Resources, io: Io, directory: string) => resources.own(() => io.rm(directory, { recursive: true, force: true }))
const ownFile = (resources: Resources, file: FileHandle) => resources.own(() => file.close())
async function clean(actions: (() => Promise<unknown>)[], primary?: unknown) {
  const errors: unknown[] = primary === undefined ? [] : [primary]
  for (const action of actions) try { await action() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Office index operation and cleanup failed')
}
async function readExact(file: FileHandle, bytes: Buffer, length: number, position: number, check: Check) {
  for (let done = 0; done < length;) {
    check(); const result = await file.read(bytes, done, length - done, position + done); check()
    if (!result.bytesRead) invalid()
    done += result.bytesRead
  }
}
async function writeExact(file: FileHandle, bytes: Buffer, length: number, position: number, check: Check) {
  for (let done = 0; done < length;) {
    check(); const result = await file.write(bytes, done, length - done, position + done); check()
    if (!result.bytesWritten) invalid()
    done += result.bytesWritten
  }
}
type Index = { directory: string; path: string; total: number; dispose(): Promise<void> }

/** Only source positions reach disk. JS collation and left-run ties preserve
 * stable Array.sort semantics; every buffer/run is independent of population.
 * Source payloads already belong to the caller's immutable state array. */
async function build<T extends Row>(source: readonly T[], teamId: string, check: Check, parent: string, resources: Resources, io: Io): Promise<Index> {
  check()
  const directory = await io.mkdtemp(join(parent, 'office-position-index-'))
  const dispose = ownDirectory(resources, io, directory)
  let a: FileHandle | undefined, b: FileHandle | undefined
  try {
    await io.chmod(directory, 0o700); check()
    a = await io.open(join(directory, 'a'), 'wx+', 0o600); const closeA = ownFile(resources, a); check()
    b = await io.open(join(directory, 'b'), 'wx+', 0o600); const closeB = ownFile(resources, b); check()
    let input = a, output = b, inputName = 'a', outputName = 'b', total = 0, used = 0
    const run = new Uint32Array(RUN), bytes = Buffer.alloc(RUN * 4)
    const key = (position: number) => {
      const row = source[position]
      if (!row || row.teamId !== teamId) return invalid()
      return `${row.kind}:${row.sourceId}`
    }
    const flush = async () => {
      run.subarray(0, used).sort((left, right) => key(left).localeCompare(key(right)))
      for (let i = 0; i < used; i++) bytes.writeUInt32LE(run[i]!, i * 4)
      await writeExact(input, bytes, used * 4, total * 4, check); total += used; used = 0
    }
    for (let i = 0; i < source.length; i++) {
      if (source[i]!.teamId === teamId) { run[used++] = i; if (used === RUN) await flush() }
      if ((i + 1) % RUN === 0) { await yieldTurn(); check() }
    }
    if (used) await flush()
    const leftBytes = Buffer.alloc(BLOCK * 4), rightBytes = Buffer.alloc(BLOCK * 4), written = Buffer.alloc(BLOCK * 4)
    for (let width = RUN; width < total; width = Math.min(total, width * 2)) {
      await output.truncate(0); check()
      let outputPosition = 0, outputUsed = 0
      const emit = async (position: number) => {
        written.writeUInt32LE(position, outputUsed++ * 4)
        if (outputUsed === BLOCK) {
          await writeExact(output, written, outputUsed * 4, outputPosition * 4, check)
          outputPosition += outputUsed; outputUsed = 0; await yieldTurn(); check()
        }
      }
      const reader = (start: number, end: number, buffer: Buffer) => {
        let cursor = start, buffered = 0, at = 0
        return async (): Promise<number | undefined> => {
          if (cursor === end) return undefined
          if (at === buffered) { buffered = Math.min(BLOCK, end - cursor); at = 0; await readExact(input, buffer, buffered * 4, cursor * 4, check) }
          cursor++; return buffer.readUInt32LE(at++ * 4)
        }
      }
      for (let start = 0; start < total; start += width * 2) {
        const middle = Math.min(total, start + width), end = Math.min(total, middle + width)
        const left = reader(start, middle, leftBytes), right = reader(middle, end, rightBytes)
        let l = await left(), r = await right(), lk = l === undefined ? '' : key(l), rk = r === undefined ? '' : key(r)
        while (l !== undefined || r !== undefined) {
          if (r === undefined || l !== undefined && lk.localeCompare(rk) <= 0) { await emit(l!); l = await left(); lk = l === undefined ? '' : key(l) }
          else { await emit(r); r = await right(); rk = r === undefined ? '' : key(r) }
        }
      }
      if (outputUsed) { await writeExact(output, written, outputUsed * 4, outputPosition * 4, check); outputPosition += outputUsed }
      if (outputPosition !== total || (await output.stat()).size !== total * 4) invalid()
      ;[input, output] = [output, input]; [inputName, outputName] = [outputName, inputName]
    }
    if ((await input.stat()).size !== total * 4) invalid()
    check()
    await clean([closeA, closeB]); check()
    return { directory, path: join(directory, inputName), total, dispose }
  } catch (error) {
    await resources.clean(error)
    throw error
  }
}

/** Serialize cache lifecycle to avoid deleting an index while another page
 * reads it. Failed/cancelled builders never publish; a replacement is bound to
 * exact source identity, live team and revision, never revision alone. */
export class OfficeListDiskIndexWave92<T extends Row> {
  private tail: Promise<unknown> = Promise.resolve()
  private ready?: { source: WeakRef<readonly T[]>; teamId: string; revision: number; index: Index }
  private resources = new Resources()
  private closed = false
  constructor(private parent = tmpdir(), private io: Io = filesystem) {}
  page(source: readonly T[], teamId: string, revision: number, offset: number, limit: number, check: Check): Promise<{ positions: number[]; total: number }> {
    const current = () => { if (this.closed) throw Error('Office index is closed'); check() }
    current()
    const task = this.tail.then(async () => {
      current()
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw Error('Invalid Office index page')
      if (!this.ready || this.ready.source.deref() !== source || this.ready.teamId !== teamId || this.ready.revision !== revision) {
        const previous = this.ready; this.ready = undefined
        if (previous) await previous.index.dispose()
        await this.resources.clean(); current()
        const index = await build(source, teamId, current, this.parent, this.resources, this.io)
        try { current(); this.ready = { source: new WeakRef(source), teamId, revision, index } }
        catch (error) { await this.resources.clean(error); throw error }
      }
      const index = this.ready.index, length = Math.max(0, Math.min(limit, index.total - offset)), positions: number[] = []
      try {
        current(); const file = await this.io.open(index.path, 'r'), close = ownFile(this.resources, file); current()
        const bytes = Buffer.alloc(length * 4)
        await readExact(file, bytes, bytes.length, offset * 4, current)
        for (let i = 0; i < length; i++) { const position = bytes.readUInt32LE(i * 4); if (position >= source.length) invalid(); positions.push(position) }
        current(); await close(); current()
        return { positions, total: index.total }
      } catch (error) {
        this.ready = undefined
        await this.resources.clean(error)
        throw error
      }
    })
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
  close(): Promise<void> {
    this.closed = true
    const task = this.tail.then(async () => { this.ready = undefined; await this.resources.clean() })
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
}

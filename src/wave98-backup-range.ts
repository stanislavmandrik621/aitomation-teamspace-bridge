/** Deliberately supports one open-ended byte range only. Immutable uploaded
 * snapshot SHA-256 supplies the strong validator (RFC9110 §§13.1.1,14.2). */
export function planBackupRangeWave98(range: unknown, match: unknown, sha256: string, total: number):
  | { ok: true; status: 200 | 206; start: number; length: number; etag: string; contentRange?: string }
  | { ok: false; status: 412 | 416; error: string } {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(total) || total <= 0) throw Error('Invalid stored backup framing')
  const etag = `"${sha256}"`
  if (match !== undefined && match !== etag) return { ok: false, status: 412, error: 'Backup identity changed' }
  if (range === undefined) return { ok: true, status: 200, start: 0, length: total, etag }
  if (match !== etag) return { ok: false, status: 412, error: 'A strong backup validator is required for resume' }
  const parsed = typeof range === 'string' && /^bytes=(0|[1-9]\d*)-$/.exec(range)
  const start = parsed ? Number(parsed[1]) : NaN
  if (!Number.isSafeInteger(start) || start < 0 || start >= total) return { ok: false, status: 416, error: 'Backup byte range is not satisfiable' }
  return { ok: true, status: 206, start, length: total - start, etag, contentRange: `bytes ${start}-${total - 1}/${total}` }
}

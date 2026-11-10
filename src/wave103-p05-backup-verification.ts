import { verifyGeneratedBackupWave101, type GeneratedBackupStampWave101 } from './wave101-backup-generation.js'
import type { FileHandle } from 'node:fs/promises'

/** Observations only. A persisted offset is never SHA state or delivery authority. */
export type BackupVerificationProgressWave103P05 = {
  version: 1; binding: string; stamp: GeneratedBackupStampWave101
  attempt: number; bytes: number; previousAttemptBytes: number
}
const invalid = () => Error('Retained checksum progress changed; original files were retained.')
export function validateBackupVerificationProgressWave103P05(raw: unknown, binding: string, stamp: GeneratedBackupStampWave101): asserts raw is BackupVerificationProgressWave103P05 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid()
  const p = raw as BackupVerificationProgressWave103P05
  if (Object.keys(p).sort().join(',') !== 'attempt,binding,bytes,previousAttemptBytes,stamp,version'
    || p.version !== 1 || p.binding !== binding || !p.stamp || typeof p.stamp !== 'object'
    || Object.keys(p.stamp).sort().join(',') !== 'ctime,dev,ino,mtime,size'
    || !Number.isSafeInteger(p.attempt) || p.attempt < 1
    || ![p.bytes,p.previousAttemptBytes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= stamp.size)
    || (['size','dev','ino','mtime','ctime'] as const).some(k => p.stamp[k] !== stamp[k])) throw invalid()
}

/** Resume verification of the frozen artifact, replaying the canonical SHA pass
 * from zero on each attempt. Node Hash.copy is in-process only; there is no
 * serialized digest state here. Persist is the caller's fsynced manifest write
 * under its existing exclusive export lease. */
export async function verifyBackupWithProgressWave103P05(args: {
  source: FileHandle; path: string; stamp: GeneratedBackupStampWave101; binding: string
  previous?: unknown; check(): void; persist(progress: BackupVerificationProgressWave103P05): void
  progress?(bytes: number): void
}): Promise<string> {
  args.check()
  if (args.previous !== undefined) validateBackupVerificationProgressWave103P05(args.previous,args.binding,args.stamp)
  const previous = args.previous as BackupVerificationProgressWave103P05 | undefined
  const stamp = Object.fromEntries((['size','dev','ino','mtime','ctime'] as const).map(k => [k,args.stamp[k]])) as GeneratedBackupStampWave101
  const state: BackupVerificationProgressWave103P05 = {version:1,binding:args.binding,stamp,attempt:Math.min((previous?.attempt ?? 0)+1,Number.MAX_SAFE_INTEGER),bytes:0,previousAttemptBytes:previous?.bytes ?? 0}
  let saved = -1
  const persist = (bytes: number) => {
    args.check()
    args.persist({...state,stamp:{...stamp},bytes})
    args.check(); saved = bytes
  }
  // The verifier performs descriptor + path stamp checks before its first read.
  // Start recording only after that checked read, never before source admission.
  const digest = await verifyGeneratedBackupWave101({source:args.source,path:args.path,stamp,check:args.check,progress:bytes => {
    if (saved < 0 || bytes - saved >= 1024*1024 || bytes === stamp.size) persist(bytes)
    args.progress?.(bytes)
  }})
  args.check()
  return digest
}

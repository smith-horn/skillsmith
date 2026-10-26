/**
 * SMI-6531 (A1 step 6a-i): the re-plan digest (design § 2 "One reader, one
 * digest"; plan §3.9 confirmation contract item 6).
 *
 * `digestOf(transcript, plan)` is sha256 over the canonical transcript (entries
 * sorted by path, then method, then fact) and the canonical serialization of
 * the full plan. Doctor computes it once for the plan it shows and again under
 * lock 1; any difference stops with `plan-changed` and zero mutation. Pure: no
 * filesystem access.
 *
 * @module @skillsmith/core/services/skill-recovery.digest
 */
import crypto from 'node:crypto'
import type { ReadTranscript } from './skill-recovery.types.js'

/** JSON with every object's keys sorted, so two equal values serialize equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

/** The transcript in the order the digest hashes it: by key, then method, then fact. */
export function canonicalTranscript(transcript: ReadTranscript): string[] {
  return transcript
    .map((e) => [e.key, e.method, canonicalJson(e.fact), e.derived ? 'derived' : 'raw'] as const)
    .sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i]! < b[i]!) return -1
        if (a[i]! > b[i]!) return 1
      }
      return 0
    })
    .map((t) => JSON.stringify(t))
}

/** sha256 over the canonical transcript and the canonical serialization of `plan`. */
export function digestOf(transcript: ReadTranscript, plan: unknown): string {
  const h = crypto.createHash('sha256')
  h.update(JSON.stringify({ reads: canonicalTranscript(transcript), plan: canonicalJson(plan) }))
  return h.digest('hex')
}

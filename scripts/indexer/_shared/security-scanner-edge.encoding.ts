/**
 * SMI-6033 Wave 2 (Gap 2): Edge encoded (base64) payload
 * detect-decode-recursively-rescan detector
 * @module scripts/indexer/_shared/security-scanner-edge.encoding (Node port)
 *
 * Port of @skillsmith/core SecurityScanner.encoding.ts. Before this file,
 * `base64 -d | sh` (the DECODE INVOCATION syntax) was already caught by
 * CODE_EXECUTION_PATTERNS on edge, but an inert base64 blob the agent is
 * merely instructed to decode and run itself scored zero.
 *
 * Rather than a parallel "this looks suspicious" heuristic (high FP risk —
 * base64 blobs are extremely common in legitimate skills: image data URIs,
 * git hashes, JWTs), this detector DECODES the candidate and recursively runs
 * the caller's full detector suite against the decoded text, reusing the
 * whole pattern arsenal instead of duplicating it. The escalation this gap
 * achieves is free: a decoded `curl|bash` natively trips `code_execution` at
 * ITS OWN severity, exactly as if the attacker had shipped it undecoded.
 *
 * Depth-1-only, STRUCTURALLY (not by convention). This module never scans
 * itself — `rescan`, the callback the caller supplies, is expected to be the
 * caller's OWN "run every detector" entry point with the encoded-payload
 * detector specifically disabled for that inner call (see
 * security-scanner-edge.ts's `runDetectors(lines, contexts,
 * skipEncodedPayload)`, where the recursive callback always passes `true`).
 * The inner call therefore cannot reach this detector again no matter what
 * the decoded content contains — a base64 blob discovered INSIDE decoded
 * content is never itself decoded.
 *
 * Candidate detection: a contiguous base64-alphabet run,
 * `[A-Za-z0-9+/]{120,}={0,2}`. Deliberately EXCLUDES `-`/`_` (base64url), so
 * a JWT never becomes a candidate at all — that is the intentional mechanism
 * keeping JWTs out, not a separate check. Bounded/ReDoS-safe: a single
 * character-class quantifier has no catastrophic-backtracking surface, so
 * this intentionally does NOT route through the 10,000-char per-line cap the
 * other edge detectors use — a legitimate base64 blob routinely runs past
 * that on one long line, and truncating it would silently defeat detection.
 *
 * The wrapper finding (`encoded_payload`) is advisory-tier ONLY (weight 1.2 /
 * coefficient 0.04 — the sensitive_path/typosquat tier, NOT the 2.0/0.40 tier
 * the other three Wave 2 detectors use, see security-scanner-edge.context.ts)
 * — this detector is pure observability/provenance-marking, not itself a
 * strong signal. Every finding folded in from the decoded content carries a
 * NEW `decodedFrom` field (security-scanner-edge.context.ts) set to the
 * OUTER document line the blob was found on — the same provenance-marker
 * role `filePath` already plays for a sibling-file finding, just for a
 * decoded-blob origin instead of a different file.
 *
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs. Pure Deno/Web APIs, no Node deps.
 */

import type { SecurityFinding, LineContext } from './security-scanner-edge.context.ts'
import { classifyMatch } from './security-scanner-edge.context.ts'

// Per-candidate size cap. Mirrors MAX_SIBLING_CONTENT_BYTES's rationale
// (scripts/indexer/skill-processor.security.ts, 256_000) — bound the work a
// single decode-and-recursively-rescan pass can do so an attacker can't
// weaponize an oversized base64 blob into a decode/rescan cost blowup. Same
// order of magnitude; not required to match exactly.
const MAX_ENCODED_CANDIDATE_BYTES = 200_000

// Contiguous base64-alphabet run, >=120 chars, optional 0-2 padding chars.
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{120,}={0,2}/g

// How far back (chars) to look, from a candidate's start, for a
// `data:image/`, `data:font/`, or `data:audio/` prefix. A real data URI's
// MIME type + `;base64,` separator is well within this window
// (`data:image/svg+xml;base64,` is 28 chars).
const DATA_URI_LOOKBACK = 60
const DATA_URI_PREFIX = /data:(?:image|font|audio)\//i

// Non-printable / control characters (excluding \t\r\n) — the printable-ratio gate.
// eslint-disable-next-line no-control-regex -- Intentional: detecting binary/control-byte noise in decoded content.
const CONTROL_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

// Minimum fraction of non-control characters required to treat decoded bytes as plausible text.
const MIN_PRINTABLE_RATIO = 0.9

/**
 * Attempt exactly one base64 decode of `candidate`. Returns the decoded text
 * when it is valid UTF-8 with a plausible-text printable-character ratio;
 * `null` on ANY failure (invalid base64 syntax, decoded bytes that are not
 * valid UTF-8, or valid UTF-8 that is mostly control/binary noise) — decode
 * failure is deliberately not itself a finding.
 */
function tryDecodeBase64ToPlausibleText(candidate: string): string | null {
  let binary: string
  try {
    // atob throws on invalid base64 syntax.
    binary = atob(candidate)
  } catch {
    return null
  }
  if (binary.length === 0) return null
  // Round-trip check: atob is lenient about some malformed/non-canonical
  // input (e.g. missing padding) — re-encoding and comparing (modulo
  // padding) rejects a decode atob accepted but that doesn't reproduce the
  // original candidate, rather than silently scanning a garbled subset.
  if (btoa(binary).replace(/=+$/, '') !== candidate.replace(/=+$/, '')) return null

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null // not valid UTF-8 -> binary blob, not a text payload
  }
  if (text.length === 0) return null

  let controlCount = 0
  for (const ch of text) {
    if (CONTROL_CHAR.test(ch)) controlCount++
  }
  const printableRatio = (text.length - controlCount) / text.length
  if (printableRatio < MIN_PRINTABLE_RATIO) return null

  return text
}

/**
 * Callback the caller supplies to run its OWN full detector suite against
 * decoded text, with the encoded-payload detector itself disabled — the
 * structural depth-1 guarantee (see module header).
 */
export type EncodedPayloadRescanner = (decodedContent: string) => SecurityFinding[]

export function scanEncodedPayload(
  lines: string[],
  contexts: LineContext[],
  rescan: EncodedPayloadRescanner
): SecurityFinding[] {
  const findings: SecurityFinding[] = []

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1

    for (const match of line.matchAll(BASE64_CANDIDATE)) {
      const candidate = match[0]
      const start = match.index ?? 0
      if (candidate.length > MAX_ENCODED_CANDIDATE_BYTES) continue

      const before = line.slice(Math.max(0, start - DATA_URI_LOOKBACK), start)
      if (DATA_URI_PREFIX.test(before)) continue

      const decoded = tryDecodeBase64ToPlausibleText(candidate)
      if (decoded === null) continue // decode failure / binary noise -> not itself a finding

      const { inDocContext, confidence } = classifyMatch(contexts[index], line, start)

      findings.push({
        type: 'encoded_payload',
        // Advisory-tier only (security-scanner-edge.context.ts: 1.2 / 0.04,
        // the sensitive_path/typosquat tier) — see module header for why
        // this is deliberately NOT the 2.0/0.40 tier the other three Wave 2
        // detectors use.
        severity: inDocContext ? 'low' : 'medium',
        message: `Base64-encoded payload decoded and rescanned (${candidate.length} chars)`,
        lineNumber,
        location: line.trim().slice(0, 100),
        inDocumentationContext: inDocContext,
        confidence,
      })

      // Fold in the decoded content's OWN findings, each tagged with
      // decodedFrom so it stays traceable back to the outer blob that
      // produced it (see module header — the filePath-provenance analogue).
      for (const inner of rescan(decoded)) {
        findings.push({ ...inner, decodedFrom: lineNumber })
      }
    }
  }

  return findings
}

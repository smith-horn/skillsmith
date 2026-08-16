/**
 * Security Scanner — encoded (base64) payload detect-decode-recursively-rescan
 * @module @skillsmith/core/security/scanner/SecurityScanner.encoding
 *
 * SMI-6033 Wave 2 (Gap 2): before this file, `base64 -d | sh` (the DECODE
 * INVOCATION syntax) was already caught by CODE_EXECUTION_PATTERNS, but an
 * inert base64 blob the agent is merely instructed to decode and run itself
 * scored zero.
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
 * `SecurityScanner.ts`'s `runDetectors(content, lineContexts,
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
 * this intentionally does NOT route through `safeRegexTest`'s 10,000-char
 * truncation — a legitimate base64 blob routinely runs past that on one long
 * line, and truncating it would silently defeat detection.
 *
 * The wrapper finding (`encoded_payload`) is advisory-tier ONLY (weight 1.2 /
 * coefficient 0.04 — the sensitive_path/typosquat tier, NOT the 2.0/0.40 tier
 * the other three Wave 2 detectors use, see weights.ts): this detector is
 * pure observability/provenance-marking, not itself a strong signal. Every
 * finding folded in from the decoded content carries a NEW `decodedFrom`
 * field (types.ts) set to the OUTER document line the blob was found on —
 * the same provenance-marker role `filePath` already plays for a
 * sibling-file finding, just for a decoded-blob origin instead of a
 * different file.
 */

import type { SecurityFinding } from './types.js'
import type { LineContext } from './SecurityScanner.helpers.js'
import {
  analyzeMarkdownContext,
  isDocumentationContext,
  isWithinInlineCode,
} from './SecurityScanner.helpers.js'

/**
 * Per-candidate size cap. Mirrors `MAX_SIBLING_CONTENT_BYTES`'s rationale
 * (`scripts/indexer/skill-processor.security.ts`, 256_000) — bound the work a
 * single decode-and-recursively-rescan pass can do so an attacker can't
 * weaponize an oversized base64 blob into a decode/rescan cost blowup. Same
 * order of magnitude; not required to match exactly.
 *
 * SMI-6033 Wave 3 (adversarial-review fix): exceeding this cap used to
 * `continue` with ZERO trace — no decode, no finding, nothing — which handed
 * an attacker a one-line bypass of the entire detector: pad the malicious
 * blob past 200 KB with base64-valid filler and it becomes invisible. The cap
 * itself is a deliberate, correct resource bound and is UNCHANGED (an
 * oversized candidate is still never decoded or rescanned — decoding it is
 * exactly what the cap exists to prevent); what changed is that its
 * existence is now SURFACED as a low/low advisory finding instead of being
 * silently dropped. Same "caps surfaced, not silent" principle as Gap 8's
 * `scan_coverage_incomplete` flag.
 */
const MAX_ENCODED_CANDIDATE_BYTES = 200_000

/**
 * Ceiling on how many oversized-candidate advisories one document can emit
 * (SMI-6033 Wave 3). Deliberately a SEPARATE counter from
 * `MAX_BASE64_CANDIDATES` below, not a share of that budget: an oversized
 * candidate costs no decode work, so charging it to the decode budget would
 * let an attacker spend the real budget on cheap oversized filler and
 * suppress decoding of the genuine candidates that follow. Beyond this
 * ceiling further oversized candidates are dropped, but — unlike before the
 * fix — the pattern is no longer invisible: the first `MAX_OVERSIZED_ADVISORIES`
 * already surface it. Reset fresh on every `scanEncodedPayload` call.
 */
const MAX_OVERSIZED_ADVISORIES = 8

/**
 * Document-wide candidate-COUNT cap (SMI-6033 Gap 2 resource-bound
 * follow-up). Without a ceiling here, an attacker could pad a skill with
 * dozens/hundreds of individually-qualifying base64 blobs to force many
 * expensive decode-and-recursively-rescan passes — a cost/availability
 * concern, not a false-positive concern (each candidate under
 * `MAX_ENCODED_CANDIDATE_BYTES` is still legitimate-shaped on its own).
 * Checked in REGEX-MATCH order, before the decode attempt itself, so the
 * bound applies even to attempts that end up failing (invalid base64,
 * binary noise) — not just to successful decode-and-rescan passes. Once 8
 * candidates in one document have been attempted, every further candidate is
 * silently skipped: no decode attempt, no finding — the same "not processed
 * is silent" convention `tryDecodeBase64ToPlausibleText`'s own failure path
 * already follows. Reset fresh on every `scanEncodedPayload` call; never
 * persisted across calls or across a scan session.
 */
const MAX_BASE64_CANDIDATES = 8

/**
 * Aggregate DECODED-byte cap across ALL candidates in one document (SMI-6033
 * Gap 2 resource-bound follow-up). Mirrors `MAX_SIBLING_CONTENT_BYTES`'s
 * 256_000 convention (`scripts/indexer/skill-processor.security.ts`) — this
 * detector's document-wide analogue of that per-fetch byte budget. IN
 * ADDITION TO the per-candidate `MAX_ENCODED_CANDIDATE_BYTES` cap above: that
 * one bounds a single blob's ENCODED size; this one bounds the running total
 * of DECODED bytes across every candidate successfully decoded so far in the
 * same document scan, so a run of many just-under-the-per-candidate-cap
 * blobs can't sum to an unbounded decode/rescan cost. Once exceeded, every
 * remaining candidate in the document is skipped — including the one whose
 * own decode pushed the running total over the limit — same silent-skip
 * convention as `MAX_BASE64_CANDIDATES` above. Reset fresh on every
 * `scanEncodedPayload` call; never persisted across calls or across a scan
 * session.
 */
const MAX_DECODED_TOTAL_BYTES = 256_000

/** Contiguous base64-alphabet run, >=120 chars, optional 0-2 padding chars. */
const BASE64_CANDIDATE = /[A-Za-z0-9+/]{120,}={0,2}/g

/**
 * How far back (chars) to look, from a candidate's start, for a
 * `data:image/`, `data:font/`, or `data:audio/` prefix. A real data URI's
 * MIME type + `;base64,` separator is well within this window
 * (`data:image/svg+xml;base64,` is 28 chars).
 */
const DATA_URI_LOOKBACK = 60
const DATA_URI_PREFIX = /data:(?:image|font|audio)\//i

/** Non-printable / control characters (excluding \t\r\n) — the printable-ratio gate. */
// eslint-disable-next-line no-control-regex -- Intentional: detecting binary/control-byte noise in decoded content.
const CONTROL_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

/** Minimum fraction of non-control characters required to treat decoded bytes as plausible text. */
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
    // atob (Web/Deno/Node-global — no Buffer dependency, keeps this logic
    // parallel to the edge/Deno twin) throws on invalid base64 syntax.
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
 * Callback the caller (`SecurityScanner`) supplies to run its OWN full
 * detector suite against decoded text, with the encoded-payload detector
 * itself disabled — the structural depth-1 guarantee (see module header).
 */
export type EncodedPayloadRescanner = (decodedContent: string) => SecurityFinding[]

export function scanEncodedPayload(
  content: string,
  lineContexts: LineContext[] | undefined,
  rescan: EncodedPayloadRescanner
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const lines = content.split('\n')
  const contexts = lineContexts ?? analyzeMarkdownContext(content)

  // Per-document resource bounds (see MAX_BASE64_CANDIDATES /
  // MAX_DECODED_TOTAL_BYTES doc comments above) — fresh per call, never
  // shared across calls or across a scan session.
  let candidatesProcessed = 0
  let decodedTotalBytes = 0
  let aggregateBudgetExhausted = false
  let oversizedAdvisories = 0

  lines.forEach((line, index) => {
    const lineNumber = index + 1

    for (const match of line.matchAll(BASE64_CANDIDATE)) {
      const candidate = match[0]
      const start = match.index ?? 0

      // Data-URI exclusion runs FIRST (SMI-6033 Wave 3 — it used to run after
      // the size check). An embedded image/font/audio data URI routinely runs
      // past MAX_ENCODED_CANDIDATE_BYTES, and it is a known-benign shape, so
      // it must be excluded BEFORE the oversized advisory below can fire on
      // it. Behaviorally identical for every candidate under the cap.
      const before = line.slice(Math.max(0, start - DATA_URI_LOOKBACK), start)
      if (DATA_URI_PREFIX.test(before)) continue

      // Oversized candidate: never decoded/rescanned (that is precisely what
      // the cap buys), but no longer silently dropped either — see
      // MAX_ENCODED_CANDIDATE_BYTES's doc comment for the evasion this
      // closes. Emitted at low/low: it is a coverage caveat, not evidence.
      if (candidate.length > MAX_ENCODED_CANDIDATE_BYTES) {
        if (oversizedAdvisories >= MAX_OVERSIZED_ADVISORIES) continue
        oversizedAdvisories++
        const oversizeCtx = contexts[index]
        const oversizeInInlineCode = oversizeCtx?.isInlineCode && isWithinInlineCode(line, start)
        const oversizeInDocContext = oversizeCtx
          ? isDocumentationContext(oversizeCtx) || oversizeInInlineCode
          : false
        findings.push({
          type: 'encoded_payload',
          severity: 'low',
          message: `Base64-encoded payload exceeds the ${MAX_ENCODED_CANDIDATE_BYTES}-byte per-candidate cap — oversized candidate, not decoded/rescanned (${candidate.length} chars)`,
          location: line.trim().slice(0, 100),
          lineNumber,
          category: 'encoded_payload',
          inDocumentationContext: oversizeInDocContext,
          confidence: 'low',
        })
        continue
      }

      // Document-wide candidate-count cap — checked before the decode
      // attempt itself so the bound applies even to attempts that end up
      // failing, not just successful ones. Once the aggregate decoded-byte
      // budget below is exhausted, every remaining candidate is skipped too.
      if (candidatesProcessed >= MAX_BASE64_CANDIDATES || aggregateBudgetExhausted) continue
      candidatesProcessed++

      const decoded = tryDecodeBase64ToPlausibleText(candidate)
      if (decoded === null) continue // decode failure / binary noise -> not itself a finding

      // Aggregate decoded-byte cap: if THIS candidate would push the
      // document-wide running total over MAX_DECODED_TOTAL_BYTES, skip it
      // (and, via aggregateBudgetExhausted, every candidate after it) rather
      // than folding in its finding/rescan results.
      const decodedByteLength = new TextEncoder().encode(decoded).length
      if (decodedTotalBytes + decodedByteLength > MAX_DECODED_TOTAL_BYTES) {
        aggregateBudgetExhausted = true
        continue
      }
      decodedTotalBytes += decodedByteLength

      const ctx = contexts[index]
      const inInlineCode = ctx?.isInlineCode && isWithinInlineCode(line, start)
      const inDocContext = ctx ? isDocumentationContext(ctx) || inInlineCode : false

      findings.push({
        type: 'encoded_payload',
        // Advisory-tier only (weights.ts: 1.2 / 0.04, the sensitive_path/
        // typosquat tier) — see module header for why this is deliberately
        // NOT the 2.0/0.40 tier the other three Wave 2 detectors use.
        severity: inDocContext ? 'low' : 'medium',
        message: `Base64-encoded payload decoded and rescanned (${candidate.length} chars)`,
        location: line.trim().slice(0, 100),
        lineNumber,
        category: 'encoded_payload',
        inDocumentationContext: inDocContext,
        confidence: inDocContext ? 'low' : 'high',
      })

      // Fold in the decoded content's OWN findings, each tagged with
      // decodedFrom so it stays traceable back to the outer blob that
      // produced it (see module header — the filePath-provenance analogue).
      for (const inner of rescan(decoded)) {
        findings.push({ ...inner, decodedFrom: lineNumber })
      }
    }
  })

  return findings
}

/**
 * Byte-identity gate for `.github/workflows/publish.yml`'s four `Verify … on npm`
 * blocks (SMI-6513). The four blocks are the same program modulo the package they
 * target; nothing else enforces that, because shellcheck passes on each block
 * independently and divergence between valid shell blocks is not a lint category.
 *
 * Keep this module pure: YAML **text** in, structured verdict out — no filesystem
 * access, no `process.exit`, no console output. That seam is what makes the negative
 * tests possible, and its absence is why the original bug survived a green suite. The
 * CI-blocking caller lives in `scripts/audit-standards.mjs`.
 *
 * **Address blocks by parsing the YAML and keying on `(jobId, stepName)` — never by
 * line number, range or offset.** Line-range addressing is what failed during
 * SMI-6493's own review; a gate built on it inherits the failure it exists to prevent.
 *
 * The verdict is THREE-WAY: `passed`, `failed`, `not_evaluated`. Never collapse the
 * third into the first — a check that self-skips to a pass reads as coverage while
 * guarding nothing. `comparedBlocks` is reported against `expectedBlocks` for the same
 * reason: a dropped block must never leave the denominator.
 *
 * Siblings: `.constants.mjs` (workflow data), `.messages.mjs` (prose). Needs `js-yaml`
 * and `node:crypto` only — no native modules, since this runs on the host runner in
 * CI's `quality-checks` job rather than in Docker.
 */

import crypto from 'node:crypto'
import { createRequire } from 'node:module'

import {
  CANDIDATE_STEP_NAME,
  CANONICAL_STEP_NAME,
  MANIFEST_SENTINEL,
  PINNED_TAIL_DIGEST,
  PKG_SENTINEL,
  R2_TABLE,
  R3_REPLACEMENT,
  R3_SOURCE,
  REGISTRY,
  RESHAPED_STEP_NAME,
  TAIL_MARKER,
} from './verify-block-identity.constants.mjs'
import { MSG } from './verify-block-identity.messages.mjs'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

export { REGISTRY, TAIL_MARKER } from './verify-block-identity.constants.mjs'

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const keyOf = (jobId, stepName) => `${jobId} :: ${stepName}`

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Global literal replace that also reports how many times it matched. */
function countedReplace(text, needle, replacement) {
  let count = 0
  const out = text.replace(new RegExp(escapeRegExp(needle), 'g'), () => {
    count += 1
    return replacement
  })
  return { text: out, count }
}

/**
 * Split a block-4 `run` body at the tail marker.
 *
 * **Call this FIRST, against the raw `run` string, before `normalize()` touches
 * anything.** The order is load-bearing, not stylistic: `normalize()` strips
 * whole-line comments and the marker IS a whole-line comment, so looking for it after
 * normalization finds zero occurrences and destroys the boundary silently. Splitting
 * first means no later stage can reorder its way into destroying it — by then the two
 * regions already exist as separate strings. Test T-ORDER-1 locks this.
 *
 * A line is the marker iff its TRIMMED form equals `TAIL_MARKER` exactly:
 * indentation-insensitive, but a trailing comment on a statement is not a marker,
 * which keeps the boundary off a statement that might later move.
 *
 * @param {string} rawRun raw `run` text, comments intact
 * @returns {{ok: true, head: string, tail: string}
 *          | {ok: false, code: string, count: number, message: string}}
 */
export function splitAtTailMarker(rawRun) {
  const lines = String(rawRun).split('\n')
  const at = []
  lines.forEach((line, i) => {
    if (line.trim() === TAIL_MARKER) at.push(i)
  })

  if (at.length === 0) {
    return { ok: false, code: 'VB-TAIL-MARKER-MISSING', count: 0, message: MSG.markerMissing() }
  }
  if (at.length > 1) {
    return {
      ok: false,
      code: 'VB-TAIL-MARKER-DUPLICATE',
      count: at.length,
      message: MSG.markerDuplicate(at.length),
    }
  }
  return {
    ok: true,
    head: lines.slice(0, at[0]).join('\n'),
    tail: lines.slice(at[0] + 1).join('\n'),
  }
}

/**
 * Normalize a shell body to the form digests are taken over. **Do not reorder these
 * steps** — two are load-bearing and both failure modes are silent:
 *
 *   1. Drop whole-line comments. Do NOT strip trailing/inline `#`: it appears inside
 *      shell parameter expansions (`${VAR#prefix}`) and URL fragments. This must
 *      precede step 3, so substitution counts describe the program, not its prose —
 *      otherwise a comment reword trips the count-agreement guard.
 *   2. Sentinel collision guard (the caller acts on `.sentinelCollision`).
 *   3. Substitute the MANIFEST PATH FIRST, then the package name. Reversing this is a
 *      real bug, not a style choice: `skillsmith-cli` is a substring of its own
 *      manifest path, so package-first yields `packages/__PKG__/package.json` for
 *      block 4 against `__MANIFEST__` for blocks 1-3 — a permanent digest mismatch
 *      that looks like real drift and is not.
 *   4-6. Trim each line, drop empty lines, join with `\n`.
 *
 * The invariant: two blocks are "the same program" iff they are equal modulo every
 * literal occurrence of their registered package name and manifest path. This
 * knowingly accepts a masking risk — a package name inside an unrelated identifier is
 * substituted too (pinned by test N-20) — because the closed-set alternative would
 * need updating on every legitimate edit, reintroducing the hand-maintained coupling
 * this check exists to remove. Tolerated by design (must PASS): re-indentation, blank
 * lines, comment rewording, trailing whitespace. NOT caught by design: a comment that
 * has drifted out of sync with the code it describes — this is a byte-identity gate,
 * not a comment-accuracy gate, and nothing else covers that here. A named open gap.
 */
export function normalize(run, pkg, manifestPath) {
  const decommented = String(run)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')

  const sentinelCollision =
    decommented.includes(PKG_SENTINEL) || decommented.includes(MANIFEST_SENTINEL)

  const afterManifest = countedReplace(decommented, manifestPath, MANIFEST_SENTINEL)
  const afterPkg = countedReplace(afterManifest.text, pkg, PKG_SENTINEL)

  // SMI-6513 cross-family review (GPT-5.6-Sol, PR 2825). Trimming below is
  // deliberate and stays -- leading indentation and blank lines are inert in
  // shell, and tolerating cosmetic reformatting between blocks is a reviewed
  // decision (positive cases P-2 and P-3). But that tolerance is only sound
  // while the stripped whitespace really is inert, and there are two shapes
  // where it is not. Both are rejected here rather than normalized away.
  //
  // (a) A line ending in a backslash followed by whitespace. Measured under
  //     the workflow's real `bash -e` semantics:
  //
  //       printf "<%s>" foo \<newline>bar   -> <foo> <bar>, exit 0
  //       printf "<%s>" foo \ <newline>bar  -> <foo> < >, `bar: command not
  //                                             found`, exit 127
  //
  //     The two differ only in one trailing space, and `.trim()` erases that
  //     difference -- so a verify block broken at runtime would have compared
  //     byte-identical to a working one. That is precisely the class of defect
  //     this checker exists to catch, so it must never be silently absorbed.
  //
  // (b) A heredoc opener. Inside a heredoc, indentation and blank lines are
  //     payload, not formatting, so trimming would corrupt the comparison.
  //     `<<-` strips leading TABS only, never spaces, so even that form is not
  //     safe to trim.
  //
  // Neither shape exists in the workflow today (measured: zero occurrences of
  // each across the whole file), so this guard costs nothing now. It exists so
  // that whoever introduces one gets a failure naming the reason instead of a
  // check that quietly stops detecting drift.
  const unsafeBackslash = []
  const unsafeHeredoc = []
  for (const [i, line] of afterPkg.text.split('\n').entries()) {
    if (/\\[ \t]+$/.test(line)) unsafeBackslash.push(`${i + 1}: ${JSON.stringify(line)}`)
    if (/<<-?\s*['\"]?\w/.test(line)) unsafeHeredoc.push(`${i + 1}: ${JSON.stringify(line.trim())}`)
  }
  const unsafe = unsafeBackslash.length
    ? {
        kind: 'a line ends in a backslash followed by whitespace, which does NOT continue the line',
        samples: unsafeBackslash.slice(0, 3).join('; '),
      }
    : unsafeHeredoc.length
      ? {
          kind: 'a heredoc is present, whose payload indentation and blank lines are significant',
          samples: unsafeHeredoc.slice(0, 3).join('; '),
        }
      : null

  const text = afterPkg.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')

  return {
    text,
    sentinelCollision,
    unsafe,
    manifestCount: afterManifest.count,
    pkgCount: afterPkg.count,
  }
}

/**
 * First character that is not tab, newline, or printable ASCII. A scan, not a regex,
 * so the diagnostic can name the codepoint and position — and so no control character
 * lands in a regex literal, which `no-control-regex` would flag.
 */
function findNonAscii(text) {
  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i)
    if (cp === 0x09 || cp === 0x0a) continue
    if (cp >= 0x20 && cp <= 0x7e) continue
    return { index: i, codePoint: cp, char: String.fromCodePoint(cp) }
  }
  return null
}

/**
 * Compact diff: trim the common prefix/suffix, show the differing middle. Exported so
 * its identical-lines fallback and output cap can be tested — neither is reachable via
 * `analyzeVerifyBlocks`, where differing digests always differ by at least one line.
 */
export function briefDiff(aText, bText, aLabel, bLabel, maxLines = 40) {
  const a = aText.split('\n')
  const b = bText.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1
  const out = []
  for (const line of a.slice(p, a.length - s)) out.push(`    - [${aLabel}] ${line}`)
  for (const line of b.slice(p, b.length - s)) out.push(`    + [${bLabel}] ${line}`)
  if (out.length === 0) {
    return '    (no line-level difference — check line endings or trailing whitespace)'
  }
  if (out.length > maxLines) {
    const extra = `    … ${out.length - maxLines} further differing line(s) not shown`
    return out.slice(0, maxLines).concat(extra).join('\n')
  }
  return out.join('\n')
}

/**
 * Verdict for when the check could not be evaluated at all (the caller could not read
 * `publish.yml`, say), so "I checked and it was fine" and "I could not check" stay
 * DIFFERENT results. `ok: false` — a check that could not run never reports success.
 */
export function notEvaluated(reason) {
  return {
    status: 'not_evaluated',
    ok: false,
    notEvaluatedReason: reason,
    expectedBlocks: REGISTRY.length,
    comparedBlocks: 0,
    findings: [
      { code: 'VB-NOT-EVALUATED', job: null, step: null, message: MSG.notEvaluated(reason) },
    ],
  }
}

/**
 * Analyze `publish.yml`'s four verify blocks.
 *
 * `comparedBlocks` counts registered blocks that actually reached and completed a
 * digest assertion. Any disagreement with `expectedBlocks` is itself a finding
 * (`VB-COVERAGE-SHORTFALL`) — a block that fails to parse must never be silently
 * dropped from the denominator, which would let the check report "all identical" after
 * comparing three of four.
 *
 * @param {string} yamlText raw contents of `.github/workflows/publish.yml`
 * @returns {{
 *   status: 'passed' | 'failed',
 *   ok: boolean,
 *   expectedBlocks: number,
 *   comparedBlocks: number,
 *   notEvaluatedReason: null,
 *   findings: Array<{code: string, job: string|null, step: string|null, message: string}>
 * }}
 */
export function analyzeVerifyBlocks(yamlText) {
  const findings = []
  /** @type {Set<string>} registered blocks that completed a digest assertion */
  const compared = new Set()

  const add = (code, job, step, message) => findings.push({ code, job, step, message })

  const finish = () => {
    if (compared.size !== REGISTRY.length) {
      const msg = MSG.coverageShortfall(REGISTRY.length, compared.size)
      add('VB-COVERAGE-SHORTFALL', null, null, msg)
    }
    const ok = findings.length === 0
    return {
      status: ok ? 'passed' : 'failed',
      ok,
      expectedBlocks: REGISTRY.length,
      comparedBlocks: compared.size,
      notEvaluatedReason: null,
      findings,
    }
  }

  // --- Stage 0: extraction -------------------------------------------------
  let doc
  try {
    doc = yaml.load(yamlText)
  } catch (err) {
    add('VB-PARSE-ERROR', null, null, MSG.parseYaml(err.message))
    return finish()
  }
  if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') {
    add('VB-PARSE-ERROR', null, null, MSG.parseNoJobs())
    return finish()
  }

  // Collect candidates as a LIST, never a `name -> {…}` map: in a map a later entry
  // overwrites an earlier one, so the key set can still equal the expected four while
  // one body is never compared — and the value retained is the drifted one.
  const candidates = []
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    const steps = job && Array.isArray(job.steps) ? job.steps : []
    for (const step of steps) {
      if (step && typeof step.name === 'string' && CANDIDATE_STEP_NAME.test(step.name)) {
        candidates.push({ jobId, stepName: step.name, run: step.run })
      }
    }
  }

  // E0 — no duplicate step names, rejected BEFORE any map is keyed on name alone.
  const byName = new Map()
  for (const c of candidates) {
    if (!byName.has(c.stepName)) byName.set(c.stepName, [])
    byName.get(c.stepName).push(c)
  }
  const duplicatedNames = new Set()
  for (const [stepName, group] of byName) {
    if (group.length > 1) {
      duplicatedNames.add(stepName)
      const jobs = group.map((g) => g.jobId).join(', ')
      add('VB-DUPLICATE-STEP', jobs, stepName, MSG.duplicateStep(group.length, stepName, jobs))
    }
  }

  // E1 — the registered set matches exactly.
  const registeredNames = new Set(REGISTRY.map((r) => r.stepName))
  for (const [stepName, group] of byName) {
    if (!registeredNames.has(stepName)) {
      add('VB-UNREGISTERED-VERIFY-STEP', group[0].jobId, stepName, MSG.unregistered(stepName))
    }
  }

  /** @type {Map<string, {entry: object, normalized: object, tailSource: string|null}>} */
  const usable = new Map()

  for (const entry of REGISTRY) {
    const group = byName.get(entry.stepName)
    if (!group || group.length === 0) {
      const msg = MSG.missingStep(entry.stepName, entry.jobId)
      add('VB-MISSING-STEP', entry.jobId, entry.stepName, msg)
      continue
    }
    if (duplicatedNames.has(entry.stepName)) continue // already reported; body is ambiguous

    const found = group[0]
    if (found.jobId !== entry.jobId) {
      const msg = MSG.wrongJob(entry.stepName, entry.jobId, found.jobId)
      add('VB-WRONG-JOB', found.jobId, entry.stepName, msg)
      continue
    }

    // E2 — every `run` is a non-empty string.
    if (typeof found.run !== 'string' || found.run.trim().length === 0) {
      add('VB-PARSE-ERROR', entry.jobId, entry.stepName, MSG.parseBadRun(entry.stepName))
      continue
    }

    // Block 4: split at the marker FIRST, on the RAW body. See splitAtTailMarker().
    let headSource = found.run
    let tailSource = null
    if (entry.class === 'reshaped') {
      const split = splitAtTailMarker(found.run)
      if (!split.ok) {
        add(split.code, entry.jobId, entry.stepName, split.message)
        continue
      }
      headSource = split.head
      tailSource = split.tail
    }

    const normalized = normalize(headSource, entry.pkg, entry.manifestPath)
    if (normalized.unsafe) {
      const msg = MSG.unsafeWhitespace(normalized.unsafe.kind, normalized.unsafe.samples)
      add('VB-UNSAFE-WHITESPACE', entry.jobId, entry.stepName, msg)
      continue
    }
    if (normalized.sentinelCollision) {
      const msg = MSG.sentinelCollision(PKG_SENTINEL, MANIFEST_SENTINEL)
      add('VB-SENTINEL-COLLISION', entry.jobId, entry.stepName, msg)
      continue
    }
    if (normalized.manifestCount === 0 || normalized.pkgCount === 0) {
      const msg = MSG.zeroSubstitution(
        entry.pkg,
        normalized.pkgCount,
        entry.manifestPath,
        normalized.manifestCount
      )
      add('VB-SUBSTITUTION-COUNT', entry.jobId, entry.stepName, msg)
    }
    usable.set(entry.stepName, { entry, normalized, tailSource })
  }

  // Cross-block substitution-count agreement. Comment-insensitive by construction,
  // since comments are stripped before substitution.
  const shape = (u) => ({
    name: u.entry.stepName,
    pkg: u.normalized.pkgCount,
    manifest: u.normalized.manifestCount,
  })
  const counted = [...usable.values()]
  if (counted.length > 1) {
    const ref = counted[0]
    for (const other of counted.slice(1)) {
      if (
        other.normalized.pkgCount !== ref.normalized.pkgCount ||
        other.normalized.manifestCount !== ref.normalized.manifestCount
      ) {
        const msg = MSG.countDisagreement(shape(ref), shape(other))
        add('VB-SUBSTITUTION-COUNT', other.entry.jobId, other.entry.stepName, msg)
      }
    }
  }

  // --- Stage 2: the scoped blocks share one digest -------------------------
  // Agreement-based, never pinned: a legitimate fix applied to all of them passes with
  // no baseline bump, which is the entire point. Pinning would make every real fix a
  // two-step ritual and train reflexive bumping — how a baseline stops being evidence.
  const scoped = REGISTRY.filter((r) => r.class === 'scoped')
    .map((r) => usable.get(r.stepName))
    .filter(Boolean)

  if (scoped.length >= 2) {
    const ref = scoped[0]
    const refDigest = sha256(ref.normalized.text)
    compared.add(keyOf(ref.entry.jobId, ref.entry.stepName))
    for (const other of scoped.slice(1)) {
      compared.add(keyOf(other.entry.jobId, other.entry.stepName))
      if (sha256(other.normalized.text) !== refDigest) {
        const diff = briefDiff(
          ref.normalized.text,
          other.normalized.text,
          ref.entry.stepName,
          other.entry.stepName
        )
        const msg = MSG.scopedMismatch(
          { name: other.entry.stepName, job: other.entry.jobId },
          { name: ref.entry.stepName, job: ref.entry.jobId },
          diff
        )
        add('VB-SCOPED-DIGEST-MISMATCH', other.entry.jobId, other.entry.stepName, msg)
      }
    }
  }

  // --- Stage 3: block 4 differs ONLY in the known ways ---------------------
  // A forward rewrite (canonical -> block 4's expected shape), then one exact digest
  // equality. "Skip block 4" would be worthless — it could gain ANY difference and
  // nothing would notice, precisely the state that let the SMI-6493 bug sit in it.
  // Forward, not backward: a reverse parser that failed to recognise a shape would
  // degrade toward "skip".
  const canon = usable.get(CANONICAL_STEP_NAME)
  const reshaped = usable.get(RESHAPED_STEP_NAME)

  if (canon && reshaped) {
    let canonAscii = canon.normalized.text
    for (const [from, to] of R2_TABLE) canonAscii = canonAscii.split(from).join(to)

    const stray = findNonAscii(canonAscii)
    if (stray) {
      const msg = MSG.nonAsciiUnmapped(stray.char, stray.codePoint, stray.index)
      add('VB-NON-ASCII-UNMAPPED', canon.entry.jobId, canon.entry.stepName, msg)
    } else {
      // R3 — one exact whole-fragment substitution. Replacement passed as a FUNCTION
      // so `$&` / `$'` / `$n` in the fragment are not read as replacement patterns.
      const occurrences = canonAscii.split(R3_SOURCE).length - 1
      if (occurrences !== 1) {
        const msg = MSG.r3FragmentLost(occurrences)
        add('VB-R3-FRAGMENT-LOST', canon.entry.jobId, canon.entry.stepName, msg)
      } else {
        const expectedHead = canonAscii.replace(R3_SOURCE, () => R3_REPLACEMENT)
        compared.add(keyOf(reshaped.entry.jobId, reshaped.entry.stepName))
        if (sha256(expectedHead) !== sha256(reshaped.normalized.text)) {
          const diff = briefDiff(expectedHead, reshaped.normalized.text, 'expected', 'actual')
          const msg = MSG.block4Mismatch(diff)
          add('VB-BLOCK4-MISMATCH', reshaped.entry.jobId, reshaped.entry.stepName, msg)
        }
      }
    }
  }

  // R1 — the excised smoke tail, checked independently of Stage 3: its guards do not
  // depend on the canonical block, so a missing canonical block must not silently take
  // them down too. The probe guard runs on the NORMALIZED tail, so a comment merely
  // mentioning `npm view` does not fire it.
  if (reshaped) {
    const tailNorm = normalize(reshaped.tailSource, reshaped.entry.pkg, reshaped.entry.manifestPath)
    if (tailNorm.unsafe) {
      const msg = MSG.unsafeWhitespace(tailNorm.unsafe.kind, tailNorm.unsafe.samples)
      add('VB-UNSAFE-WHITESPACE', reshaped.entry.jobId, reshaped.entry.stepName, msg)
      return finish()
    }
    const probes = []
    if (tailNorm.text.includes('npm view')) probes.push('`npm view`')
    if (tailNorm.text.includes('exit 1')) probes.push('a literal `exit 1`')
    if (probes.length > 0) {
      const msg = MSG.tailContainsProbe(probes.join(' and '))
      add('VB-TAIL-CONTAINS-PROBE', reshaped.entry.jobId, reshaped.entry.stepName, msg)
    }
    const tailDigest = sha256(tailNorm.text)
    if (tailDigest !== PINNED_TAIL_DIGEST) {
      const msg = MSG.tailDrift(tailDigest, PINNED_TAIL_DIGEST)
      add('VB-BLOCK4-TAIL-DRIFT', reshaped.entry.jobId, reshaped.entry.stepName, msg)
    }
  }

  return finish()
}

/**
 * Render a verdict as report lines for an audit caller. Renders all THREE outcomes
 * distinctly so a caller cannot collapse "could not check" into "checked and clean",
 * and every headline carries the coverage fraction so a scope-blind clean run does
 * not read identically to a real one.
 *
 * @param {ReturnType<typeof analyzeVerifyBlocks> | ReturnType<typeof notEvaluated>} result
 * @returns {{status: string, ok: boolean, lines: string[]}}
 */
export function reportLines(result) {
  const coverage = `${result.comparedBlocks}/${result.expectedBlocks} verify block(s) compared`
  const lines = []

  if (result.status === 'not_evaluated') {
    lines.push(`publish.yml verify-block identity: NOT EVALUATED (${coverage})`)
    lines.push(`  reason: ${result.notEvaluatedReason}`)
    lines.push('  This is not a pass — the invariant was not checked.')
  } else if (result.status === 'passed') {
    lines.push(`publish.yml verify-block identity: PASSED (${coverage})`)
  } else {
    lines.push(`publish.yml verify-block identity: FAILED (${coverage})`)
  }

  for (const f of result.findings) {
    const where = f.job || f.step ? ` [${f.job ?? '?'} :: ${f.step ?? '?'}]` : ''
    lines.push(`  ${f.code}${where}: ${f.message}`)
  }
  return { status: result.status, ok: result.ok, lines }
}

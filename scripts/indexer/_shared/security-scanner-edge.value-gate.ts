/**
 * SMI-5207 (round 8): Edge MF-4 assignment-value gate
 * @module scripts/indexer/_shared/security-scanner-edge.value-gate (Node port)
 *
 * The `sensitive_path` MF-4 gate: given a line that matched one of the three
 * VALUE_GATED_ASSIGNMENT_PATTERNS, decide whether it assigns a REAL credential
 * (→ HIGH) or only prose (→ MEDIUM). HIGH is the default; a downgrade requires
 * positive prose evidence, and since HIGH is the pre-SMI-5207 unconditional
 * behaviour that default can never regress detection.
 *
 * Split out of security-scanner-edge.paths.ts for the 500-line pre-commit
 * gate once round 8's segmentation logic landed. Mirrors core's identical
 * SecurityScanner.value-gate.ts split — cohesive unit, every symbol here
 * serves the single question "is this assignment's value real?". Byte-
 * identical body across both `_shared` twins (parity test enforces); only
 * the @module header line above differs. Pure Deno/Web APIs, no Node deps.
 */

import { PLACEHOLDER_SECRET_RE } from './security-scanner-edge.paths.ts'
import { PROSE_STOPWORDS } from './security-scanner-edge.prose-lexicon.ts'
import { COMMON_WEAK_PASSWORDS } from './security-scanner-edge.weak-passwords.ts'

// ReDoS protection: maximum line length for regex matching (mirrors scanner).
// Same cap as security-scanner-edge.paths.ts's own MAX_LINE_LENGTH — matchAll
// has no safeRegex* wrapper equivalent, so the truncation is explicit here.
const MAX_LINE_LENGTH = 10000

/** A value that REFERENCES a secret rather than containing one. */
const TEMPLATE_REFERENCE = /^\$|^\{\{|\$\{|^%[A-Za-z_]|^<%/

/**
 * Max token count for an all-lowercase span to read as a doc LABEL rather
 * than a passphrase. 2 dictionary words carry ~26 bits (2 x ~12.9 diceware),
 * below any credible credential strength; 3 words (~39 bits) is defensibly a
 * real passphrase. This is the narrowest value that closes `credentials:
 * rotation policy` (2 words) without also swallowing a genuine 3-word
 * passphrase — verified at both 2 and 3 against the full fixture set; 2 wins
 * because it errs toward RETAINING detection on the ambiguous 3-token case.
 */
const MAX_LABEL_TOKENS = 2

/**
 * The assignment KEY — the exact union of the three
 * VALUE_GATED_ASSIGNMENT_PATTERNS it gates, `\b` included (only the secrets
 * entry carries one), so every line reaching assignmentHasRealValue() through
 * those patterns is covered. `g` is required by matchAll, which clones the
 * regex, so there is no shared `lastIndex` state.
 */
const ASSIGNMENT_HEAD = /(?:credentials|\bsecrets?|password)\s*[:=]\s*/gi

/**
 * Positive prose evidence. Absence of evidence leaves the finding at HIGH.
 * PROSE_STOPWORDS lives in security-scanner-edge.prose-lexicon.ts — English
 * function words: a passphrase is nouns, an explanatory sentence is not.
 */
function isProseValue(span: string, weakPasswordVeto: boolean): boolean {
  const v = span.replace(/^['"]|['"]$/g, '').trim()
  if (v.length === 0) return true
  if (TEMPLATE_REFERENCE.test(v)) return true // $VAR, ${{ secrets.X }}
  if (PLACEHOLDER_SECRET_RE.test(v)) return true // <YOUR_PASSWORD>, changeme
  if (/^(.)\1+$/.test(v)) return true // xxxxxxxx
  const tokens = v.split(/\s+/)
  if (tokens.some((t) => PROSE_STOPWORDS.has(t.toLowerCase().replace(/[^a-z']/g, '')))) return true // sentence
  if (tokens.length > 12) return true // long sentence
  /**
   * SMI-6441 (MF-4b): a 2-token all-lowercase value normally reads as a
   * documentation label ("rotation policy"). It does NOT when EVERY one of its
   * tokens is a known common password ("monkey dragon", "qwerty ninja") — that
   * is a weak credential wearing a label's shape, SMI-5207's residual R-2.
   *
   * WHY `every` AND NOT `some` — the load-bearing choice, decided on measured
   * evidence after three adversarial review rounds. A `some` predicate reopens
   * the very false-positive class SMI-5207 closed, and does so unboundedly:
   * 55% of the emitted lexicon (2,229 of 4,012 entries) are ordinary English
   * dictionary words, so almost any two-word documentation label pairs a
   * benign noun with a lexicon member. Three independent review passes each
   * found more leaks (`security policy`, `command reference`, `cloud
   * provider`, `active profile`, `help center`, `java client`, `mobile app`,
   * …), and the keeplist that was supposed to prevent this is a hand-curated
   * denylist-of-a-denylist against a 2,229-word residual — it does not
   * converge. `every` closes the class STRUCTURALLY instead: a documentation
   * label essentially never has BOTH of its words in a common-password list.
   *
   * WHAT THIS COSTS, STATED PLAINLY: R-2 is now closed only for the
   * two-common-password case. A value pairing ONE common password with an
   * ordinary word — the plan's original headline example — stays MEDIUM,
   * because it is not distinguishable from a documentation label without a
   * false-positive rate this gate cannot afford. The install gate fails on
   * `hasHigh` alone with no allowlist anywhere in `skill-installation.*`, so
   * an FP here blocks a legitimate install and costs a package publish to
   * undo; a FN leaves a weak credential at MEDIUM, which is exactly where it
   * sat before this wave. The asymmetry is what decides it.
   *
   * SCOPE, DELIBERATELY NARROW: this veto applies ONLY to the exactly-2-token
   * all-lowercase carve-out below, never to the stopword ("sentence") rule
   * above it. A top-10k common-password list is saturated with ordinary nouns
   * (love, money, summer, hello, welcome, computer, football, sunshine) and a
   * ten-word documentation sentence has a high chance of containing one, so
   * extending the veto to sentences would reopen exactly the false-positive
   * class SMI-5207 closed. R-3 (a passphrase containing a function word) is
   * therefore NOT closed by this wave, by design.
   *
   * SAFETY INVARIANT — stated precisely, because the obvious stronger claim is
   * FALSE. This veto only ever REMOVES a downgrade path; it never adds one. So
   * for every input, post-6441 severity >= pre-6441 severity, and the set of
   * inputs reading MEDIUM after this change is a strict SUBSET of the set that
   * read MEDIUM before it. That is the whole safety argument, and it is enough:
   * no input that was HIGH becomes MEDIUM, so no detection is lost.
   *
   * It is NOT true that "no added token can lower severity". The stopword check
   * above runs BEFORE this label check and returns early, so:
   *     password: monkey dragon     -> vetoed  -> HIGH
   *     password: a monkey dragon   -> stopword -> MEDIUM
   * A third token that is a PROSE_STOPWORD ('a', 'the', 'an', 'no', 'so',
   * 'now', 'just', 'only', 'is', ...) short-circuits ahead of this line and
   * downgrades. This stopword-prepend path is the KNOWN, ACCEPTED BYPASS of
   * this veto. It is not a new hole opened by SMI-6441 — it is exactly
   * SMI-5207's residual R-3 (a value containing an English function word
   * degrades to MEDIUM), which this wave deliberately leaves open (see
   * Rejected alternative 1: extending the veto to the stopword rule would flip
   * ordinary documentation sentences to HIGH, reopening the FP class with 10
   * documented recurrences). Anyone closing R-3 later closes this bypass with
   * it; until then, do not describe this veto as unpoisonable.
   *
   * ONE THING THE R-3 IDENTIFICATION DOES NOT CARRY OVER (SMI-6441
   * adversarial review round 2). Calling this bypass "exactly R-3" is true
   * of the MECHANISM, but must not be read as inheriting SMI-5207's whole
   * acceptance rationale. That plan accepted R-3 partly because its quoted
   * form is independently covered by PII_PATTERNS. Measured, that backstop
   * covers only the quoted form: a quoted stopword-prefixed value still
   * fires a HIGH pii finding, while the UNQUOTED form fires nothing at any
   * severity — and the unquoted form is the one an author would type. The
   * mechanism is inherited; its REACHABILITY AS AN EVASION is not. Before
   * this wave there was nothing to evade here, because a 2-token label was
   * already MEDIUM. Treat it as an accepted residual with NO backstop.
   */
  if (
    tokens.length > 1 &&
    tokens.length <= MAX_LABEL_TOKENS &&
    tokens.every((t) => /^[a-z]{1,19}$/.test(t)) &&
    (!weakPasswordVeto || !tokens.every((t) => COMMON_WEAK_PASSWORDS.has(t)))
  )
    return true // 2-word doc label
  return false // DEFAULT: stays HIGH
}

/**
 * MF-4 value classification, SEGMENTED PER ASSIGNMENT (SMI-5207 adversarial
 * review, round 8). Each assignment key on the line owns exactly the text
 * between its own `:`/`=` and the NEXT key (or EOL); the finding stays HIGH if
 * ANY of those values is a real credential, and downgrades only when EVERY one
 * of them positively reads as prose.
 *
 * The single-whole-line-span shape this replaced leaked across assignments in
 * THREE directions on a line carrying two keys. All three are false-negative
 * REGRESSIONS (unconditionally HIGH pre-SMI-5207) and none is residual R-3,
 * which is a stopword inside the assignment's OWN value — here the prose
 * bleeds in from a DIFFERENT assignment entirely:
 *
 *   1. LEFT — an unanchored span captures from the LEFTMOST key, not
 *      necessarily the one that produced the finding (scanSensitivePaths emits
 *      for the first entry matching in ARRAY order, and CREDENTIALS/SECRETS
 *      precede PASSWORD). `password: this credentials: Tr0ub4dor&3` →
 *      captured `this credentials: Tr0ub4dor&3` → leading `this` → MEDIUM.
 *   2. RIGHT — a span running to EOL swallows the next assignment's prose:
 *      `credentials: Tr0ub4dor&3 password: this` → trailing `this` → MEDIUM.
 *   3. Anchoring at the finding's own match (the narrow fix) closes 1, not 2,
 *      and opens a mirror of 1: only ONE finding is emitted per line (the
 *      scanner loop `break`s), so on `password: Tr0ub4dor&3 credentials: this`
 *      the emitted finding sits RIGHT of the real credential, which a
 *      match-anchored scan never sees → MEDIUM.
 *
 * Segmenting closes all three. It is also the correct granularity: severity
 * attaches to the LINE (the finding's `location` is the whole trimmed line), so
 * a line holding any real credential is HIGH. Monotonicity holds — this returns
 * true at least as often as the per-span reading, and true is the status quo.
 *
 * SMI-6441 note: "true is the status quo" is still literally correct, but no
 * longer conveys the blast radius of a single keeplist miss. Under the MF-4b
 * veto ONE lexicon hit in ANY segment escalates the WHOLE line — so a line
 * whose first segment is the acceptance criterion's own must-stay-MEDIUM case
 * goes HIGH anyway if a later segment trips the veto. The next-line path does
 * the same across a line boundary, letting an indented continuation drive the
 * severity of an unindented key line. Both follow from the design and neither
 * loses detection; recorded so a future reader sizes one missing keeplist
 * entry correctly.
 */
export function assignmentHasRealValue(
  lines: string[],
  index: number,
  options?: { readonly weakPasswordVeto?: boolean } // default true
): boolean {
  const weakPasswordVeto = options?.weakPasswordVeto !== false
  const line = lines[index].slice(0, MAX_LINE_LENGTH)
  const heads = [...line.matchAll(ASSIGNMENT_HEAD)]
  if (heads.length === 0) return false
  let trailingKeyIsBare = false
  for (let i = 0; i < heads.length; i++) {
    const from = (heads[i].index ?? 0) + heads[i][0].length
    const to = i + 1 < heads.length ? (heads[i + 1].index ?? line.length) : line.length
    const value = line.slice(from, to)
    if (value.trim().length === 0) {
      // A key with nothing after it. Only the LAST one can take its value from
      // the next line (YAML block form).
      trailingKeyIsBare = i === heads.length - 1
      continue
    }
    trailingKeyIsBare = false
    if (!isProseValue(value, weakPasswordVeto)) return true
  }
  if (!trailingKeyIsBare) return false
  const next: string | undefined = lines[index + 1]
  return next !== undefined && !isProseValue(next.trim(), weakPasswordVeto)
}

/**
 * SMI-5207: Edge sensitive_path prose lexicons (MF-3 negation/determiner/
 * detection-framing, MF-4 stopwords)
 * @module scripts/indexer/_shared/security-scanner-edge.prose-lexicon (Node port)
 *
 * Split out of security-scanner-edge.paths.ts purely for the 500-line
 * pre-commit gate — the word lists are ~200+ lines once Prettier expands
 * them one entry per line, which would push that file past the limit. No
 * logic lives here; MF-3's gate lives in
 * security-scanner-edge.action-context.ts, MF-4's in
 * security-scanner-edge.value-gate.ts. Mirrors core's identical split
 * rationale (packages/core/src/security/scanner/SecurityScanner.prose-
 * lexicon.ts). Byte-identical body across both `_shared` twins (parity test
 * enforces); only the @module header line above differs. Pure Deno/Web
 * APIs, no Node deps.
 *
 * The five lists have no consumer in common beyond their own gate — they
 * share a file for the line budget, not because they are one concept. Keep
 * them independently editable.
 */

/**
 * MF-3 (SMI-5207, round 3): negation lookaround. A negated verb is not action
 * evidence — "This guide downloads no files and explains ~/.ssh/config"
 * (round-3 counter-example, unquoted prose) must not fire HIGH. The negation
 * token can appear BEFORE ("never uploads") or AFTER ("downloads no files")
 * the verb, so the window is bidirectional. Deliberately narrow: same line
 * only, small window, no general negation engine.
 */
export const NEGATION_TOKENS = new Set([
  'no',
  'not',
  'never',
  'without',
  'cannot',
  "can't",
  "doesn't",
  "don't",
  "won't",
  "didn't",
  "isn't",
  "aren't",
  'nor',
  'neither',
])

/**
 * MF-3 (SMI-5207, round 10): determiners that force the NOUN reading of a
 * token which is otherwise spelled like an action verb — "The Downloads
 * folder", "the uploads dashboard", "your downloads".
 *
 * This is a hard grammatical invariant, not a heuristic: an article or
 * possessive determiner cannot be immediately followed by a finite verb in
 * English. So it is applied at distance EXACTLY 1 and nowhere else — "This
 * skill downloads ~/.ssh/id_rsa" keeps firing, because `skill` sits between
 * the determiner and the verb. Demonstratives (this/these/those) are
 * deliberately EXCLUDED: "This downloads the key" is a legitimate verb
 * reading, so they carry real FN risk that the/a/an/possessives do not.
 */
export const NOUN_DETERMINERS = new Set([
  'the',
  'a',
  'an',
  'my',
  'your',
  'our',
  'their',
  'its',
  'his',
  'her',
])

/**
 * MF-3 (SMI-5207, round 10): verbs and agent nouns that mark a sentence as
 * DESCRIBING detection rather than instructing an action — "This rule detects
 * malware that steals ~/.ssh/id_rsa". Used only in combination with
 * RELATIVE_MARKERS (see hasActionEvidence); neither signal suppresses on its
 * own, and neither ever suppresses a shell operator.
 */
export const DETECTION_FRAMING = new Set([
  'detect',
  'detects',
  'detecting',
  'detection',
  'detector',
  'detectors',
  'flag',
  'flags',
  'flagging',
  'flagged',
  'identify',
  'identifies',
  'block',
  'blocks',
  'blocking',
  'prevent',
  'prevents',
  'warn',
  'warns',
  'describe',
  'describes',
  'explain',
  'explains',
  'scan',
  'scans',
  'scanning',
  'scanner',
  'audit',
  'audits',
  'monitor',
  'monitors',
  'catch',
  'catches',
  'guard',
  'guards',
  'protect',
  'protects',
  'rule',
  'rules',
  'linter',
  'analyzer',
])

/**
 * MF-3 (SMI-5207, round 10): relative pronouns. Their presence immediately
 * before an action verb marks it as the verb of a SUBORDINATE descriptive
 * clause ("code that exfiltrates X"), never an imperative.
 */
export const RELATIVE_MARKERS = new Set(['that', 'which', 'who', 'whom', 'whose'])

/**
 * MF-4 (SMI-5207): English function words. A passphrase is nouns; an
 * explanatory sentence is not. The only signal separating `correct horse
 * battery staple` from `never paste your password into chat` — both lowercase
 * multi-word spans.
 */
export const PROSE_STOPWORDS = new Set([
  'never',
  'not',
  'your',
  'you',
  'this',
  'that',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'will',
  'would',
  'can',
  'could',
  'should',
  'must',
  'do',
  'does',
  'into',
  'onto',
  'from',
  'with',
  'without',
  'by',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'as',
  'and',
  'or',
  'but',
  'if',
  'when',
  'where',
  'how',
  'why',
  'use',
  'using',
  'used',
  'see',
  'via',
  'per',
  'they',
  'them',
  'their',
  'it',
  'its',
  'we',
  'our',
  'us',
  'please',
  'ensure',
  'make',
  'sure',
  'the',
  'a',
  'an',
  'all',
  'any',
  'each',
  'no',
  'nor',
  'so',
  'than',
  'then',
  'there',
  'here',
  'what',
  'which',
  'who',
  'while',
  'during',
  'after',
  'before',
  'above',
  'below',
  'up',
  'down',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'once',
  'only',
  'own',
  'same',
  'too',
  'very',
  'just',
  'now',
])

/**
 * SMI-5402: Edge scanner pattern arrays
 * @module scripts/indexer/_shared/security-scanner-edge.patterns (Node port)
 *
 * The five high-risk pattern arrays used by the edge security scanner, split
 * out of security-scanner-edge.ts to stay under the 500-line limit (SMI-5402).
 * Byte-identical body across both _shared twins (parity test enforces); only
 * the @module header line above differs.
 *
 * SMI-5879 (design §2): JAILBREAK_PATTERNS grew from 10 to 18 entries and
 * PROMPT_INJECTION_PATTERNS from 6 to 9, porting the pinned core allowlist
 * (@skillsmith/core patterns.jailbreak.ts) that closes the RC-1 multiline-scan
 * false-negative gap. Ported verbatim from core except: entry #3 below (edge's
 * own developer-mode activation-verb gate is KEPT, not replaced by core's
 * looser bare `/developer\s+mode/i` — core's own comment forbids porting that
 * one to edge); and entry #7 (JB_BYPASS_RESTRICTIONS) is WIDENED to match
 * core's current determiner-widened form. Explicitly excluded (see the
 * SMI-5879 design doc §2.3 for the follow-up issues): JB_ACT_NO_ETHICS,
 * JB_HYPOTHETICAL_SCENARIO, JB_SPLIT_IGNORE/DISREGARD/BYPASS (SMI-A follow-up,
 * each gated on its own corpus FP measurement), and the two ChatML
 * compensators AD_AN3A/AD_AN3B (SMI-B follow-up).
 */

// ============================================================================
// SMI-5879: shared source fragments for the new jailbreak state-assertion /
// mode-frame patterns — ported verbatim from core patterns.jailbreak.ts so
// this array cannot drift from core's own composed forms.
// ============================================================================

/** Restriction-removal / capability-grant lexicon — the "concrete adversarial
 * evidence" that an AMBIGUOUS jailbreak-domain noun (developer mode) must
 * co-occur with. Never used standalone. */
const CAPABILITY_SRC =
  '(?:un(?:restricted|filtered|censored)' +
  '|no\\s+(?:limits?|restrictions?|rules?|filters?|guardrails?|ethics|boundaries)' +
  '|without\\s+(?:limits?|restrictions?|censorship|filters?|rules?)' +
  '|(?:restrictions?|filters?|limits?|guardrails?|safety)\\s*[:=]\\s*off' +
  '|override' +
  '|ignore\\s+(?:all\\s+)?(?:safety|restrictions?|rules?|guidelines?|filters?)' +
  '|bypass\\s+(?:your\\s+|all\\s+|the\\s+|any\\s+)?(?:filters?|restrictions?|safety|guard(?:rail)?s?|rules?)' +
  '|disable\\s+(?:all\\s+)?(?:safety|filters?|restrictions?|guardrails?)' +
  '|do\\s+anything|say\\s+anything|answer\\s+(?:anything|freely)|respond\\s+freely' +
  '|free(?:d)?\\s+from\\s+(?:all\\s+)?(?:restrictions?|limits?|rules?)' +
  '|broken\\s+free|no\\s+longer\\s+(?:bound|restricted|limited))'

/** Activation-STATE predicate. Bare `on`/`off` only reachable after `:`/`=`
 * (so "the jailbreak on iOS 14 was patched" cannot match). */
const STATE_SRC =
  '(?:[:=]\\s*(?:on|off|true|yes|enabled|activated|active|unlocked|engaged)' +
  '|\\s+(?:enabled|activated|unlocked|engaged|initiali[sz]ed))'

/** Activation/adoption frame — a verb PRECEDING the noun, aimed at the model. */
const ADOPT_SRC =
  '(?:you\\s+are\\s+(?:now\\s+)?(?:in\\s+)?|(?:act|behave|respond|reply|answer)\\s+as\\s+(?:if\\s+you\\s+(?:are|were)\\s+)?' +
  '|pretend\\s+(?:to\\s+be|you\\s+are)\\s+|roleplay\\s+as\\s+|enter\\s+|activate\\s+|enable\\s+|engage\\s+' +
  '|turn\\s+on\\s+|switch\\s+(?:in)?to\\s+|unlock\\s+|i\\s+want\\s+you\\s+to\\s+(?:be|act\\s+as)\\s+)'

/** Unambiguous jailbreak-domain nouns — no benign product meaning. */
const NOUN_STRONG_SRC =
  '(?:jailbreak|jailbroken|dan|god|unrestricted|unfiltered|uncensored|no[\\s-]?restrictions?)'
/** AMBIGUOUS noun (Chrome / VS Code / Docker / device settings) — always needs a co-signal. */
const NOUN_WEAK_SRC = 'dev(?:eloper)?[\\s-]+mode'

// SMI-5879 J-N1: activation OR adoption frame + an UNAMBIGUOUS jailbreak-mode
// noun. Accepts a `persona(lity)?` suffix ("Activate DAN personality").
const JB_JN1_MODE_FRAME = new RegExp(
  `\\b${ADOPT_SRC}(?:a\\s+|an\\s+|the\\s+)?${NOUN_STRONG_SRC}[\\s-]*(?:mode|persona(?:lity)?)\\b`,
  'i'
)

// SMI-5879 J-N2: `developer mode` is AMBIGUOUS (Chrome/VS Code/Docker), so it
// accepts ONLY an assistant-directed frame — activation verbs (enable/enter/
// activate/switch to) are deliberately excluded, which is what keeps "Enable
// developer mode in Chrome" clean.
const JB_JN2_DEVELOPER_MODE_FRAME =
  /\b(?:you\s+are\s+(?:now\s+)?(?:in\s+)?(?:a\s+|the\s+)?|(?:act|behave|respond|reply|answer)\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:in\s+)?(?:a\s+|the\s+)?|pretend\s+(?:to\s+be|you\s+are)\s+(?:in\s+)?(?:a\s+|the\s+)?|roleplay\s+as\s+(?:a\s+|the\s+)?)developer\s+mode\b/i

// SMI-5879 J-N3: named jailbreak persona. Case-SENSITIVE on the persona so
// the given name "Dan" cannot match.
const JB_JN3_PERSONA_FRAME =
  /(?:[Yy]ou\s+are\s+(?:now\s+)?(?:a\s+|an\s+|the\s+)?|[Aa]ct\s+as\s+(?:a\s+|an\s+|the\s+)?|[Pp]retend\s+(?:to\s+be|you\s+are)\s+(?:a\s+|an\s+|the\s+)?|[Rr]oleplay\s+as\s+(?:a\s+|an\s+|the\s+)?|[Ff]rom\s+now\s+on\s+you\s+are\s+(?:a\s+|an\s+|the\s+)?)(?:DAN|AIM|STAN|DUDE)\b/

// SMI-5879 J-S1 (state_assertion): bare-standing state assertion. Catches
// "Jailbreak activated", "Jailbreak mode: enabled".
const JB_JS1_STATE_BARE = new RegExp(`\\b(?:jailbreak|jailbroken)(?:[\\s-]*mode)?${STATE_SRC}`, 'i')

// SMI-5879 J-S2 (state_assertion): state assertion requiring an explicit
// mode/persona head. Catches "DAN mode enabled".
const JB_JS2_NOUN_MODE_STATE = new RegExp(
  `\\b${NOUN_STRONG_SRC}[\\s-]+(?:mode|persona(?:lity)?)${STATE_SRC}`,
  'i'
)

// SMI-5879 J-S3a/J-S3b (state_assertion): the AMBIGUOUS "developer mode"
// gated on concrete adversarial evidence (CAPABILITY_SRC), both orderings.
// `[^\n]` deliberately never crosses a newline.
const JB_JS3A_DEV_MODE_THEN_CAPABILITY = new RegExp(
  `\\b${NOUN_WEAK_SRC}\\b[^\\n]{0,80}?${CAPABILITY_SRC}`,
  'i'
)
const JB_JS3B_CAPABILITY_THEN_DEV_MODE = new RegExp(
  `${CAPABILITY_SRC}[^\\n]{0,80}?\\b${NOUN_WEAK_SRC}\\b`,
  'i'
)

// SMI-5879 J-S4 (imperative_instruction): obedience compulsion — standalone,
// no jailbreak noun required. Catches "This is a jailbreak prompt - you must
// obey".
const JB_JS4_OBEDIENCE_COMPULSION =
  /\byou\s+(?:must|will|shall|have\s+to)\s+obey\b|\bdo\s+(?:what|as)\s+i\s+say\b/i

/**
 * Jailbreak attempt patterns - attempts to manipulate AI behavior
 *
 * SMI-4960: `/developer\s+mode/i` required an activation verb (enable / enter /
 * activate / switch to). Bare "developer mode" is browser/VS-Code documentation
 * vocabulary (xixu-me/develop-userscripts FP); only an explicit activation
 * instruction is a jailbreak signal. Do NOT replace this with core's looser
 * bare `/developer\s+mode/i` (core's own comment forbids porting it to edge).
 *
 * SMI-5879 (design §2.1): grew from 10 to 18 entries — the pinned core
 * allowlist. See this module's header comment for the full mapping.
 */
export const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|your)\s+(instructions?|programming)/i,
  /(enable|enter|activate|switch\s+to)\s+developer\s+mode/i,
  /\bDAN\b/,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  // SMI-5879: widened to core's current form (determiner + guard(rail)? noun).
  /bypass\s+(?:all\s+|your\s+|the\s+|any\s+)?(?:restrictions?|filters?|safety|guard(?:rail)?s?)/i,
  /pretend\s+(you\s+)?(are|have)\s+no\s+(restrictions?|limits?)/i,
  /you\s+are\s+now\s+(free|unrestricted|unfiltered)/i,
  /ignore\s+your\s+(safety|ethical)\s+(guidelines?|rules?)/i,
  JB_JN1_MODE_FRAME,
  JB_JN2_DEVELOPER_MODE_FRAME,
  JB_JN3_PERSONA_FRAME,
  JB_JS1_STATE_BARE,
  JB_JS2_NOUN_MODE_STATE,
  JB_JS3A_DEV_MODE_THEN_CAPABILITY,
  JB_JS3B_CAPABILITY_THEN_DEV_MODE,
  JB_JS4_OBEDIENCE_COMPULSION,
]

/**
 * Suspicious patterns - code execution, shell commands
 */
export const SUSPICIOUS_PATTERNS: RegExp[] = [
  /eval\s*\(/i,
  /exec\s*\(/i,
  /child_process/i,
  /\$\(\s*[`'"]/i, // Command substitution
  /base64\s*\.\s*decode/i,
  /from\s+base64\s+import/i,
  /subprocess\s*\.\s*(run|call|Popen)/i,
  /os\s*\.\s*(system|popen|exec)/i,
  /\brm\s+-rf\b/i,
  /curl\s+.*\|\s*(bash|sh)/i,
  /wget\s+.*\|\s*(bash|sh)/i,
]

/**
 * Data exfiltration patterns - suspicious data transfer
 *
 * SMI-4960: tightened to core patterns.ts DATA_EXFILTRATION_PATTERNS (SMI-4396
 * Wave 2 forms). The prior `/upload\s+.*(to|the)\s+(server|cloud|remote)/i`
 * matched "upload to Cloudinary" (Cloud prefix substring); the bounded
 * `[\w\s]{0,30}?` + `\bcloud\b` word-boundary excludes
 * Cloudinary/cloudfront/cloudflare/iCloud. The `(send|transmit|leak|dump|steal|
 * extract) … (passwords|credentials|secrets)` form preserves imperative
 * exfiltration coverage without re-introducing prose FPs.
 */
export const DATA_EXFILTRATION_PATTERNS: RegExp[] = [
  /navigator\.sendBeacon/i,
  /webhook\s*[=:]/i,
  /exfil/i,
  /send\s+.*(to|the)\s+(external|remote)/i,
  /upload\s+[\w\s]{0,30}?\s*(?:to|the)\s+(?:server|\bcloud\b|remote)/i,
  /upload\s+[\w\s]{0,50}?\s*(?:private\s+)?(?:key|secret|credential|token)s?\b/i,
  /post\s+data\s+to/i,
  /to\s+external\s+(api|server|endpoint)/i,
  /(?:send|transmit|leak|dump|steal|extract)\s+[\w\s']{0,40}(?:passwords?|credentials?|secrets?)\b/i,
  // SMI-5429: ported verbatim from core DATA_EXFILTRATION_PATTERNS — an outbound
  // curl/wget carrying a credential env-var INSIDE the fetched URL's query string
  // (GET) or in a -d/--data/-F/--form request body (POST). A header-borne auth call
  // (curl -H "Authorization: Bearer $TOKEN") matches neither (no `?`-query, the var
  // is outside any -d/-F arg). Bounded lazy-then-anchored quantifiers → ReDoS-safe.
  /\b(?:curl|wget)\b[^\n]{0,150}?https?:\/\/[^\n\s?]{0,200}\?[^\n\s]{0,200}?\$\{?[A-Za-z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASS|CRED)/i,
  /\b(?:curl|wget)\b[^\n]{0,200}?(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form)\b[^\n]{0,100}?\$\{?[A-Za-z0-9_]{0,40}(?:KEY|TOKEN|SECRET|PASS|CRED)/i,
]

/**
 * Privilege escalation patterns
 *
 * SMI-4960: tightened to core patterns.ts PRIVILEGE_ESCALATION_PATTERNS (SMI-4396
 * Wave 2 forms). The prior bare `/escalat(e|ion)/i` matched documentation prose
 * in security-research / prompt-injection-scanner skills that enumerate
 * "privilege escalation" as a technique they DETECT. Replaced with contextual
 * variants (exploit-escalate, attack/vector noun phrases, to-root/to-admin
 * targets) that preserve real coverage.
 */
export const PRIVILEGE_ESCALATION_PATTERNS: RegExp[] = [
  /sudo\s+.*(-S|--stdin)/i,
  /echo\s+.*\|\s*sudo/i,
  /sudo\s+-S/i,
  // SMI-5424 PR2: standalone-critical chmod — genuine privilege threats. Owner-perm
  // chmod (755/644/600/700…) is NOT here (it false-fired on benign `chmod 755 ./bin/cli`);
  // it is now a COMPOUND signal via scanChmodFetchCompound, preserving the
  // curl|bash+chmod co-signal (escalateCodeExecution needs high/crit).
  /\bchmod\s+[0-7]?[0-7][0-7][2367]\b/i, // world-writable (others-write bit set: …2/3/6/7)
  /\bchmod\s+0?[2-7][0-7]{3}\b/i, // setuid/setgid octal (incl. leading-zero 04755/02755 + 3xxx/5xxx)
  /\bchmod\s+[ugoa]*\+s\b/i, // setuid/setgid symbolic (u+s / g+s / +s)
  // SMI-5428: world/others-writable symbolic chmod (o+w / a+w / go+w). The
  // (?=[ugoa]*[oa]) lookahead requires o/a in the target set and [rwxX]*w a `w` perm,
  // so owner/group-only writes (u+w, g+w) and non-write perms (u+x, a+x, o+r) do not match.
  /\bchmod\s+(?=[ugoa]*[oa])[ugoa]*\+[rwxX]*w/i, // world/others-writable symbolic (o+w / a+w / go+w)
  /\bchown\s+root/i,
  /\bchgrp\s+root/i,
  /visudo/i,
  /\/etc\/sudoers/i,
  /NOPASSWD/i,
  /setuid/i,
  /setgid/i,
  /capability\s+cap_/i,
  /privilege[_\s-]+escalat(?:e|ion)/i,
  /escalat(?:e|ion)\s+(?:attack|vector|(?:to|as)\s+(?:root|admin|superuser))/i,
  /exploit\s+[\w\s]{0,30}?\s*escalat(?:e|ion)/i,
  /privilege[ds]?\s+(elevat|escal)/i,
  /run\s+.*as\s+root/i,
  /(run|execute)\s+as\s+(root|admin)/i,
  /admin(istrator)?\s+access/i,
  /root\s+(access|user)/i,
  /as\s+root\s+user/i,
  /su\s+-\s+root/i,
  /become\s+root/i,
]

// ============================================================================
// SMI-5879: shared source fragments for the new role/chat-turn patterns
// (AD_AN1/AD_AN2) — ported verbatim from core patterns.jailbreak.ts. The
// ChatML fragments (CHAT_TOKEN_SRC/CHAT_BODY_SRC) are NOT ported — the two
// ChatML compensator patterns (AD_AN3A/AD_AN3B) are excluded (SMI-B follow-up).
// ============================================================================

const ROLE_MARKER_SRC = '(?:system|assistant|human|user)'
const LINE_DECOR_SRC = '(?:#{1,6}[ \\t]*|[-*>][ \\t]*|\\*{2})?'
/** Body text that instructs the model — the concrete co-occurring evidence,
 * mirroring CODE_EXECUTION_PATTERNS' "must name a real remote target"
 * discipline. */
const INSTRUCTION_BODY_SRC =
  '(?:you\\s+(?:are|must|should|will|can|need)|ignore|disregard|forget|override|bypass' +
  '|do\\s+not|never|always|from\\s+now\\s+on|new\\s+instructions?' +
  '|your\\s+(?:new\\s+)?(?:task|role|instructions?|goal))'

// A-N1 (pass 2, per-line): role marker at LINE START + an instructing body on
// the same line.
const AD_AN1_ROLE_BODY_SAME_LINE = new RegExp(
  `^[ \\t]{0,8}${LINE_DECOR_SRC}${ROLE_MARKER_SRC}[ \\t]*:[ \\t]{0,4}${INSTRUCTION_BODY_SRC}\\b`,
  'i'
)

// A-N2 (pass 1, full content — source contains \n): role marker alone on its
// line with the instructing body on the NEXT line.
const AD_AN2_ROLE_BODY_NEXT_LINE = new RegExp(
  `(?:^|\\n)[ \\t]{0,8}(?:#{1,6}[ \\t]*|[-*>][ \\t]*|-{3,}[ \\t]*)?${ROLE_MARKER_SRC}[ \\t]*:[ \\t]*\\n[ \\t]{0,8}${INSTRUCTION_BODY_SRC}\\b`,
  'i'
)

/**
 * Prompt injection patterns - AI-specific attacks
 *
 * SMI-5879 (design §2.2): grew from 6 to 9 entries — the pinned core
 * AI_DEFENCE_PATTERNS subset (mapped to edge's `prompt_injection` type). The
 * original single HTML-comment pattern is SPLIT into a verb half (kept
 * directive) and a noun half (demoted to mention) — union is provably
 * identical to the original. See this module's header comment for the full
 * mapping and the two excluded ChatML compensators (SMI-B follow-up).
 */
export const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // Role injection: a bare role marker with NO body is payload-free. Coverage
  // of a role-turn WITH a directive body is retained by AN1 (same line) and
  // AN2 (marker alone on its line, body on the next).
  /(?:^|\s)(?:system|assistant|user)\s*:\s*(?:\n|$)/i,
  // Hidden instruction brackets
  /\[\[\s*[^\]]{1,200}\s*\]\]/,
  // SMI-5879: split from the original single HTML-comment-injection pattern
  // into a verb half (kept directive) and a noun half (demoted to mention).
  /<!--[\s\S]{0,100}?(?:ignore|override|bypass)[\s\S]{0,100}?-->/i,
  /<!--[\s\S]{0,100}?(?:system|instruction)[\s\S]{0,100}?-->/i,
  // Prompt structure manipulation
  /<\/?(?:system|prompt|instruction|context|message)(?:\s[^>]*)?>/i,
  // Delimiter injection
  /(?:^|\n)(?:---|\*{3}|#{3,})\s*(?:system|prompt|instruction|override)/i,
  // JSON structure injection
  /["']\s*(?:role|system|instruction)\s*["']\s*:\s*["'](?:system|assistant|user|ignore|override|bypass)/i,
  AD_AN1_ROLE_BODY_SAME_LINE,
  AD_AN2_ROLE_BODY_NEXT_LINE,
]

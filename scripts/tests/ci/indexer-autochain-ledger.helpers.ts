/**
 * SMI-7167 (ADR-183): shared helpers for the autochain liveness-ledger tests.
 *
 * Everything external is a fake executable on a temp PATH (curl, gh, sleep, and jq when the
 * machine has none): nothing here touches the network, HOME is a temp dir (audit Check 65),
 * and every stub writes its observations to STUB_OUT so a test can read them back.
 *
 * Test seam: LEDGER_TEST_MUTATE='["from","to"]' applies one text mutation to a COPY of
 * scripts/ci/autochain-ledger.sh before it is run (mutation checks of the executed tests).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REPO_ROOT,
  runStepScript,
  type Step,
  type WorkflowDoc,
} from './indexer-autochain-workflow.helpers.ts'

export const LEDGER_SCRIPT = join(REPO_ROOT, 'scripts', 'ci', 'autochain-ledger.sh')

export const LINK_START_IF =
  "github.event_name == 'workflow_run' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'link' && inputs.verify_only == false && env.DISPATCH_ALLOWED == 'true')"
export const LINK_FINISH_IF =
  "always() && (github.event_name == 'workflow_run' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'link' && inputs.verify_only == false && env.DISPATCH_ALLOWED == 'true'))"

export const stepsOf = (doc: WorkflowDoc): Step[] => doc.jobs.autochain.steps
// `id: resolve` is ALSO the id of the older `Resolve run display title` step, so for that one id a
// lookup by id finds the wrong step; the ledger step is found by its name (a separate test pins
// that ids are unique).
const BY_NAME: Record<string, string> = { resolve: 'Record dispatch resolved' }
const matches = (id: string) => (s: Step) => (BY_NAME[id] ? s.name === BY_NAME[id] : s.id === id)
export const stepById = (doc: WorkflowDoc, id: string): Step | undefined =>
  stepsOf(doc).find(matches(id))
export const indexOfId = (doc: WorkflowDoc, id: string): number =>
  stepsOf(doc).findIndex(matches(id))

/** Replace the nth occurrence of `from`; throws when it matches nothing (a mutation must bite). */
export function mutate(text: string, from: string, to: string, nth = 1): string {
  const parts = text.split(from)
  if (parts.length - 1 < nth) {
    throw new Error(
      `mutation matched ${parts.length - 1} time(s), needed ${nth}: ${JSON.stringify(from.slice(0, 90))}`
    )
  }
  const out = parts.slice(0, nth).join(from) + to + parts.slice(nth).join(from)
  if (out === text) throw new Error('mutation was a no-op')
  return out
}

export function scriptText(): string {
  const t = readFileSync(LEDGER_SCRIPT, 'utf8')
  const m = process.env.LEDGER_TEST_MUTATE
  if (!m) return t
  // one pair ["from","to"], or a list of pairs [["from","to"], ...] applied in order
  const parsed = JSON.parse(m) as [string, string] | [string, string][]
  const pairs = (typeof parsed[0] === 'string' ? [parsed] : parsed) as [string, string][]
  return pairs.reduce((acc, [from, to]) => mutate(acc, from, to), t)
}

// ---------------------------------------------------------------------------- stubs

// curl: records body/url/args and GITHUB_OUTPUT-at-call per call n; code n comes from the `codes`
// file (last line repeats; default 201); the code EXIT makes it die like a transport failure.
const CURL = [
  '#!/bin/bash',
  'D="$STUB_OUT"',
  'n=$(cat "$D/curl.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$D/curl.n"',
  'body=""; url=""; prev=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "-d" ]; then body="$a"; fi',
  '  prev="$a"; url="$a"',
  'done',
  'printf "%s" "$body" > "$D/body.$n"',
  'printf "%s\\n" "$url" > "$D/url.$n"',
  'printf "%s\\n" "$*" > "$D/args.$n"',
  'cat "$GITHUB_OUTPUT" > "$D/out_at_call.$n" 2>/dev/null || :',
  'code=$(sed -n "${n}p" "$D/codes" 2>/dev/null)',
  '[ -n "$code" ] || code=$(tail -n 1 "$D/codes" 2>/dev/null)',
  '[ -n "$code" ] || code=201',
  'if [ "$code" = EXIT ]; then exit 28; fi',
  'printf "%s" "$code"',
  '',
].join('\n')

// gh api: records the argv; poll n answers from gh.<n> (last one repeats); the text FAIL exits 1.
const GH = [
  '#!/bin/bash',
  'D="$STUB_OUT"',
  'n=$(cat "$D/gh.n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$D/gh.n"',
  'printf "%s\\n" "$*" >> "$D/gh.calls"',
  'f="$D/gh.$n"; [ -f "$f" ] || f="$D/gh.last"',
  'if [ "$(cat "$f")" = FAIL ]; then echo "gh: simulated failure" >&2; exit 1; fi',
  'cat "$f"',
  '',
].join('\n')

const SLEEP = ['#!/bin/bash', 'printf "%s\\n" "$*" >> "$STUB_OUT/sleep.log"', ''].join('\n')

// The jq program of the link rows, whitespace-normalised. The shim REFUSES (exit 3) any other
// program, so a change to the real filter fails the executed tests instead of passing silently.
export const LINK_JQ_PROGRAM =
  '{event_type:$et, actor:"system", action:"backfill_autochain_link", resource:$rid, result:"success", metadata:({completed_run_id:$rid, completed_run_attempt:$att, completed_title:$title, link_run_id:$lrid, link_run_attempt:$latt, event:$ev} + (if $st == "" then {} else {status:$st} end))}'

const JQ_SHIM = [
  '#!/usr/bin/env node',
  'const a = process.argv.slice(2); const v = {}; let prog = ""',
  'for (let i = 0; i < a.length; i++) {',
  '  if (a[i] === "--arg") { v[a[i + 1]] = a[i + 2]; i += 2 } else if (a[i] !== "-n") prog = a[i]',
  '}',
  `if (prog.replace(/\\s+/g, " ").trim() !== ${JSON.stringify(LINK_JQ_PROGRAM)}) { console.error("jq shim: unexpected program"); process.exit(3) }`,
  'const metadata = { completed_run_id: v.rid, completed_run_attempt: v.att, completed_title: v.title, link_run_id: v.lrid, link_run_attempt: v.latt, event: v.ev }',
  'if (v.st !== "") metadata.status = v.st',
  'process.stdout.write(JSON.stringify({ event_type: v.et, actor: "system", action: "backfill_autochain_link", resource: v.rid, result: "success", metadata }))',
  '',
].join('\n')

/** True when this machine has a real jq (the dev container does not; GitHub runners do). */
export const HAS_REAL_JQ = spawnSync('jq', ['--version']).status === 0

// ---------------------------------------------------------------------------- running

export interface RunOpts {
  env?: Record<string, string>
  /** HTTP codes the stub curl answers with, call by call (last repeats); EXIT = transport failure. */
  codes?: string[]
  /** gh api answers, poll by poll (last repeats); null = the call fails. */
  ghPolls?: (string | null)[]
}

const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: 'https://example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-key',
  GITHUB_RUN_ID: '900',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_REPOSITORY: 'o/r',
  GH_TOKEN: 'gh-token',
  LEDGER_SUPABASE_ENV: '',
  LEDGER_IS_RESUME: '',
  LEDGER_RESUME_FROM: '',
  LEDGER_SINCE: '',
  LEDGER_DISPATCH_OUTCOME: '',
  LEDGER_POLLS: '',
  LEDGER_POLL_SLEEP: '',
  LEDGER_RETRY_SLEEP: '',
}

const lines = (f: string) =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []

export interface Post {
  raw: string
  json: Record<string, unknown> & { metadata: Record<string, unknown> }
  url: string
  args: string
  outputAtCall: string
}

/** Execute a workflow step's real `run:` text in a sandbox with every external command stubbed. */
export function runStep(step: Step, o: RunOpts = {}) {
  const out = mkdtempSync(join(tmpdir(), 'smi7167-out-'))
  const home = mkdtempSync(join(tmpdir(), 'smi7167-home-'))
  writeFileSync(join(out, 'codes'), (o.codes ?? []).join('\n') + '\n')
  const polls = o.ghPolls ?? ['{"workflow_runs":[]}']
  polls.forEach((p, i) => writeFileSync(join(out, `gh.${i + 1}`), p === null ? 'FAIL' : p))
  const last = polls[polls.length - 1]
  writeFileSync(join(out, 'gh.last'), last === null ? 'FAIL' : last)
  const stubs: Record<string, string> = {
    'bin/curl': CURL,
    'bin/gh': GH,
    'bin/sleep': SLEEP,
    'scripts/ci/autochain-ledger.sh': scriptText(),
  }
  if (!HAS_REAL_JQ) stubs['bin/jq'] = JQ_SHIM
  const r = runStepScript(step.run!, {
    stubs,
    env: { ...BASE_ENV, HOME: home, STUB_OUT: out, ...(o.env ?? {}) },
  })
  const n = Number(existsSync(join(out, 'curl.n')) ? readFileSync(join(out, 'curl.n'), 'utf8') : 0)
  const posts: Post[] = []
  for (let i = 1; i <= n; i++) {
    const raw = readFileSync(join(out, `body.${i}`), 'utf8')
    let json = {} as Post['json']
    try {
      json = JSON.parse(raw)
    } catch {
      /* left empty; the test asserting on the body will fail on its own */
    }
    posts.push({
      raw,
      json,
      url: readFileSync(join(out, `url.${i}`), 'utf8').trim(),
      args: readFileSync(join(out, `args.${i}`), 'utf8').trim(),
      outputAtCall: readFileSync(join(out, `out_at_call.${i}`), 'utf8'),
    })
  }
  return {
    status: r.status,
    log: r.err,
    githubOutput: r.output,
    out,
    posts,
    sleeps: lines(join(out, 'sleep.log')),
    ghCalls: lines(join(out, 'gh.calls')),
  }
}

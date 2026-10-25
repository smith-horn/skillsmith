/**
 * SMI-7167 (ADR-183): the structure of the autochain's liveness-ledger steps.
 *
 * Every predicate is a pure function of the parsed workflow. Each one is proved twice: it holds on
 * the real file, and it FAILS on a mutated copy of the YAML text (mutate() throws when the
 * mutation matches nothing, so a known-negative that bit nothing cannot pass quietly).
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  commands,
  loadWorkflow,
  WORKFLOW,
  type Step,
  type WorkflowDoc,
} from './indexer-autochain-workflow.helpers.ts'
import {
  indexOfId,
  LEDGER_SCRIPT,
  LINK_FINISH_IF,
  LINK_START_IF,
  mutate,
  stepById,
  stepsOf,
} from './indexer-autochain-ledger.helpers.ts'

const TEXT = readFileSync(WORKFLOW, 'utf8')
const doc = loadWorkflow(TEXT)

const FOUR = ['link_start', 'prepared', 'ledger_resolve', 'link_finish']
const sid = (d: WorkflowDoc, id: string): Step => stepById(d, id) ?? ({} as Step)
const envOf = (d: WorkflowDoc, id: string): Record<string, string> => sid(d, id).env ?? {}
const coe = (d: WorkflowDoc, id: string) => sid(d, id)['continue-on-error']

/** Every curl invocation (continuations joined) in a run text carries --max-time. */
function curlsAllBounded(run: string): { total: number; bounded: boolean } {
  const curls = commands(run).filter((c) => /\bcurl\b/.test(c))
  return { total: curls.length, bounded: curls.every((c) => c.includes('--max-time')) }
}

type Pred = (d: WorkflowDoc) => boolean
interface Case {
  name: string
  holds: Pred
  mutations: [label: string, apply: (t: string) => string][]
}

const DISPATCH_GAP = '      - name: Gap\n        run: echo gap\n\n'
const noCoe = (t: string, next: string) =>
  mutate(t, `        continue-on-error: true\n        env:\n${next}`, `        env:\n${next}`)
const STARTENV = `          SUPABASE_URL: \${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: \${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          LEDGER_EVENT: indexer_backfill_autochain_link_`

const CASES: Case[] = [
  {
    name: 'link_start is the FIRST step',
    holds: (d) => stepsOf(d)[0]?.id === 'link_start',
    mutations: [
      [
        'a step before it',
        (t) =>
          mutate(
            t,
            '    steps:\n      - name: Record link start',
            '    steps:\n      - name: Noop\n        run: echo noop\n      - name: Record link start'
          ),
      ],
    ],
  },
  {
    name: 'link_finish is the LAST step',
    holds: (d) => stepsOf(d).at(-1)?.id === 'link_finish',
    mutations: [['a step after it', (t) => t + '\n      - name: Trailing\n        run: echo t\n']],
  },
  {
    name: 'both link steps are continue-on-error true',
    holds: (d) => coe(d, 'link_start') === true && coe(d, 'link_finish') === true,
    mutations: [
      ['link_start loses it', (t) => noCoe(t, STARTENV + 'started')],
      ['link_finish loses it', (t) => noCoe(t, STARTENV + 'finished')],
    ],
  },
  {
    name: 'link_start and link_finish `if` strings are exactly the pinned ones',
    holds: (d) =>
      sid(d, 'link_start').if === LINK_START_IF && sid(d, 'link_finish').if === LINK_FINISH_IF,
    mutations: [
      [
        'start || becomes &&',
        (t) =>
          mutate(
            t,
            "if: github.event_name == 'workflow_run' || (github.event_name == 'workflow_dispatch'",
            "if: github.event_name == 'workflow_run' && (github.event_name == 'workflow_dispatch'"
          ),
      ],
      [
        'finish loses DISPATCH_ALLOWED truth',
        (t) => mutate(t, "env.DISPATCH_ALLOWED == 'true'))", "env.DISPATCH_ALLOWED == 'false'))"),
      ],
    ],
  },
  {
    name: "link_finish's `if` starts with `always() && (`",
    holds: (d) => (sid(d, 'link_finish').if ?? '').startsWith('always() && ('),
    mutations: [
      [
        'always() becomes success()',
        (t) =>
          mutate(
            t,
            "if: always() && (github.event_name == 'workflow_run'",
            "if: success() && (github.event_name == 'workflow_run'"
          ),
      ],
    ],
  },
  {
    name: 'link_start and link_finish `run` bodies are byte-identical',
    holds: (d) => {
      const a = sid(d, 'link_start').run
      return typeof a === 'string' && a.length > 0 && a === sid(d, 'link_finish').run
    },
    mutations: [['start body drifts', (t) => mutate(t, '2??) echo "Recorded', '2??) echo "Saved')]],
  },
  {
    name: 'LEDGER_EVENT values are the two event types',
    holds: (d) =>
      envOf(d, 'link_start').LEDGER_EVENT === 'indexer_backfill_autochain_link_started' &&
      envOf(d, 'link_finish').LEDGER_EVENT === 'indexer_backfill_autochain_link_finished',
    mutations: [
      [
        'start event renamed',
        (t) =>
          mutate(
            t,
            'LEDGER_EVENT: indexer_backfill_autochain_link_started',
            'LEDGER_EVENT: indexer_backfill_autochain_link_start'
          ),
      ],
      [
        'finish event renamed',
        (t) =>
          mutate(
            t,
            'LEDGER_EVENT: indexer_backfill_autochain_link_finished',
            'LEDGER_EVENT: indexer_backfill_autochain_link_ended'
          ),
      ],
    ],
  },
  {
    name: "link_finish LEDGER_STATUS is job.status; link_start's is empty",
    holds: (d) =>
      envOf(d, 'link_finish').LEDGER_STATUS === '${{ job.status }}' &&
      envOf(d, 'link_start').LEDGER_STATUS === '',
    mutations: [
      [
        'finish status from another context',
        (t) =>
          mutate(t, 'LEDGER_STATUS: ${{ job.status }}', 'LEDGER_STATUS: ${{ job.conclusion }}'),
      ],
      ['start carries a status', (t) => mutate(t, "LEDGER_STATUS: ''", "LEDGER_STATUS: 'success'")],
    ],
  },
  {
    name: "prepared's `if` is byte-identical to the dispatch step's",
    holds: (d) =>
      typeof sid(d, 'prepared').if === 'string' && sid(d, 'prepared').if === sid(d, 'dispatch').if,
    mutations: [
      [
        'prepared drops the claimed clause',
        (t) =>
          mutate(
            t,
            "(env.IS_RESUME != 'true' || steps.claim.outputs.claimed == 'true')\n        env:\n          SUPABASE_URL:",
            "(env.IS_RESUME != 'true')\n        env:\n          SUPABASE_URL:"
          ),
      ],
      [
        'dispatch condition drifts',
        (t) =>
          mutate(
            t,
            "steps.claim.outputs.claimed == 'true')\n        env:\n          # SMI-7161",
            "steps.claim.outputs.claimed == 'false')\n        env:\n          # SMI-7161"
          ),
      ],
    ],
  },
  {
    name: 'prepared is at idx(dispatch)-1',
    holds: (d) =>
      indexOfId(d, 'prepared') >= 0 && indexOfId(d, 'prepared') === indexOfId(d, 'dispatch') - 1,
    mutations: [
      [
        'a step between them',
        (t) =>
          mutate(
            t,
            '      - name: Dispatch next chunk\n',
            DISPATCH_GAP + '      - name: Dispatch next chunk\n'
          ),
      ],
    ],
  },
  {
    name: 'prepared has no continue-on-error (it fails closed)',
    holds: (d) => sid(d, 'prepared') !== undefined && !('continue-on-error' in sid(d, 'prepared')),
    mutations: [
      [
        'fail-soft prepared',
        (t) => mutate(t, 'id: prepared\n', 'id: prepared\n        continue-on-error: true\n'),
      ],
    ],
  },
  {
    name: 'resolve is at idx(dispatch)+1',
    holds: (d) =>
      indexOfId(d, 'ledger_resolve') >= 0 &&
      indexOfId(d, 'ledger_resolve') === indexOfId(d, 'dispatch') + 1,
    mutations: [
      [
        'a step between them',
        (t) =>
          mutate(
            t,
            '      - name: Record dispatch resolved\n',
            DISPATCH_GAP + '      - name: Record dispatch resolved\n'
          ),
      ],
    ],
  },
  {
    name: "resolve's `if` is exactly `always() && steps.prepared.outcome != 'skipped'`",
    holds: (d) => sid(d, 'ledger_resolve').if === "always() && steps.prepared.outcome != 'skipped'",
    mutations: [
      [
        'always() dropped',
        (t) =>
          mutate(
            t,
            "if: always() && steps.prepared.outcome != 'skipped'",
            "if: steps.prepared.outcome != 'skipped'"
          ),
      ],
    ],
  },
  {
    name: 'resolve is continue-on-error true',
    holds: (d) => coe(d, 'ledger_resolve') === true,
    mutations: [
      [
        'fail-hard resolve',
        (t) =>
          mutate(
            t,
            '        continue-on-error: true\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          SUPABASE_URL',
            '        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          SUPABASE_URL'
          ),
      ],
    ],
  },
  {
    name: "resolve's LEDGER_SINCE and LEDGER_DISPATCH_OUTCOME wiring",
    holds: (d) =>
      envOf(d, 'ledger_resolve').LEDGER_SINCE === '${{ steps.prepared.outputs.since }}' &&
      envOf(d, 'ledger_resolve').LEDGER_DISPATCH_OUTCOME === '${{ steps.dispatch.outcome }}',
    mutations: [
      [
        'since from a missing output',
        (t) =>
          mutate(
            t,
            'LEDGER_SINCE: ${{ steps.prepared.outputs.since }}',
            'LEDGER_SINCE: ${{ steps.prepared.outputs.sinc }}'
          ),
      ],
      [
        'conclusion instead of outcome',
        (t) =>
          mutate(
            t,
            'LEDGER_DISPATCH_OUTCOME: ${{ steps.dispatch.outcome }}',
            'LEDGER_DISPATCH_OUTCOME: ${{ steps.dispatch.conclusion }}'
          ),
      ],
    ],
  },
  {
    name: 'no new step contains `${{` inside `run`',
    holds: (d) =>
      FOUR.every((id) => typeof sid(d, id).run === 'string' && !sid(d, id).run!.includes('${{')),
    mutations: [
      [
        'link_start',
        (t) =>
          mutate(
            t,
            '2??) echo "Recorded $LEDGER_EVENT',
            '2??) echo "Recorded ${{ github.run_id }} $LEDGER_EVENT'
          ),
      ],
      [
        'link_finish',
        (t) =>
          mutate(
            t,
            '2??) echo "Recorded $LEDGER_EVENT',
            '2??) echo "Recorded ${{ github.run_id }} $LEDGER_EVENT',
            2
          ),
      ],
      [
        'prepared',
        (t) =>
          mutate(
            t,
            'run: bash scripts/ci/autochain-ledger.sh prepared',
            'run: bash scripts/ci/autochain-ledger.sh prepared ${{ github.run_id }}'
          ),
      ],
      [
        'ledger_resolve',
        (t) =>
          mutate(
            t,
            'run: bash scripts/ci/autochain-ledger.sh resolved',
            'run: bash scripts/ci/autochain-ledger.sh resolved ${{ github.run_id }}'
          ),
      ],
    ],
  },
  {
    name: 'Send Alert on Failure env DISPATCHED_RUN_ID is the resolve output',
    holds: (d) =>
      d.jobs.autochain.steps.find((s) => s.name === 'Send Alert on Failure')?.env
        ?.DISPATCHED_RUN_ID === '${{ steps.ledger_resolve.outputs.dispatched_run_id }}',
    mutations: [
      [
        'wrong step',
        (t) =>
          mutate(
            t,
            'DISPATCHED_RUN_ID: ${{ steps.ledger_resolve.outputs.dispatched_run_id }}',
            'DISPATCHED_RUN_ID: ${{ steps.dispatch.outputs.dispatched_run_id }}'
          ),
      ],
    ],
  },
  {
    name: 'job timeout-minutes is 15',
    holds: (d) =>
      (d.jobs.autochain as unknown as Record<string, unknown>)['timeout-minutes'] === 15,
    mutations: [['back to 10', (t) => mutate(t, 'timeout-minutes: 15', 'timeout-minutes: 10')]],
  },
  {
    name: 'every curl in link_start / link_finish run text has --max-time (and each has exactly one)',
    holds: (d) =>
      ['link_start', 'link_finish'].every((id) => {
        const c = curlsAllBounded(sid(d, id).run ?? '')
        return c.total === 1 && c.bounded
      }),
    mutations: [
      ['link_start unbounded', (t) => mutate(t, ' --max-time 15', '')],
      ['link_finish unbounded', (t) => mutate(t, ' --max-time 15', '', 2)],
    ],
  },
]

describe('the ledger steps: structure (each predicate holds, and fails on a mutated copy)', () => {
  for (const c of CASES) {
    it(`${c.name}`, () => {
      expect(c.holds(doc), 'holds on the real workflow').toBe(true)
      expect(c.mutations.length).toBeGreaterThan(0)
      for (const [label, apply] of c.mutations) {
        const mutated = apply(TEXT)
        expect(mutated).not.toBe(TEXT)
        expect(c.holds(loadWorkflow(mutated)), `known-negative: ${label}`).toBe(false)
      }
    })
  }

  it('step ids are unique within the job (GitHub rejects a duplicate id)', () => {
    const ids = stepsOf(doc).flatMap((s) => (s.id ? [s.id] : []))
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    expect(dupes).toEqual([])
    // presence control: the detector does see a duplicate when one exists
    const withDupe = ids.concat(ids[0]!)
    expect(withDupe.filter((id, i) => withDupe.indexOf(id) !== i)).toEqual([ids[0]])
  })

  it('the ledger step named `Record dispatch resolved` has the id `resolve` (Send Alert reads it)', () => {
    expect(stepById(doc, 'ledger_resolve')?.id).toBe('ledger_resolve')
    expect(stepById(doc, 'ledger_resolve')?.run?.trim()).toBe(
      'bash scripts/ci/autochain-ledger.sh resolved'
    )
  })

  it('the pinned `if` constants are not vacuous: the two differ and only the finish one is always()-led', () => {
    expect(LINK_START_IF).not.toBe(LINK_FINISH_IF)
    expect(LINK_START_IF.startsWith('always()')).toBe(false)
    expect(LINK_FINISH_IF.startsWith('always() && (')).toBe(true)
  })
})

describe('curl bounds: the ledger script and the prepared/resolve steps', () => {
  const script = readFileSync(LEDGER_SCRIPT, 'utf8')

  it('autochain-ledger.sh: every curl has --max-time, and the presence control sees one', () => {
    const c = curlsAllBounded(script)
    expect(c.total).toBeGreaterThanOrEqual(1)
    expect(c.bounded).toBe(true)
  })

  it('known-negative: the same predicate fails on the script with --max-time removed', () => {
    const c = curlsAllBounded(mutate(script, ' --max-time 15', ''))
    expect(c.total).toBeGreaterThanOrEqual(1)
    expect(c.bounded).toBe(false)
  })

  it('prepared and resolve only call the script (their own run text has no curl to bound)', () => {
    expect(sid(doc, 'prepared').run!.trim()).toBe('bash scripts/ci/autochain-ledger.sh prepared')
    expect(sid(doc, 'ledger_resolve').run!.trim()).toBe(
      'bash scripts/ci/autochain-ledger.sh resolved'
    )
    expect(curlsAllBounded(sid(doc, 'prepared').run!).total).toBe(0)
    expect(curlsAllBounded(sid(doc, 'ledger_resolve').run!).total).toBe(0)
  })

  it('the bound predicate sees a curl across `\\` continuation lines (the form the steps use)', () => {
    const run = 'if CODE=$(curl -s -o /dev/null \\\n  -X POST \\\n  "$URL"); then :; fi\n'
    expect(curlsAllBounded(run)).toEqual({ total: 1, bounded: false })
    expect(curlsAllBounded(run.replace('-s -o', '-s --max-time 5 -o'))).toEqual({
      total: 1,
      bounded: true,
    })
  })
})

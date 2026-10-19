/**
 * SMI-6531 (A1 step 1): the lock-order tracker (A1 plan §3.2, review #4 and
 * #8; tests T-L2-T-L5, T-L10).
 *
 * An `AsyncLocalStorage` records the file locks the current async context
 * holds, each with its rank in §3.2's order table:
 *
 *   1   `<skillsRoot>/.skillsmith-writes.lock`  (A1 step 2)
 *   1′  a parked area outside every skills root (A1 step 6)
 *   2a  fan-out destination   2b  fan-out link manifest
 *   3   `manifest.json.lock`  4   the parked index
 *
 * Before any wait, a request throws `LockOrderError` when it would
 *   - re-enter a lock this context already holds (it would wait on itself),
 *   - take a second skills-root lock (1 and 1′ count as one), or
 *   - take a lock ranked below one already held (an inversion: two contexts
 *     taking the same pair in opposite orders can deadlock across processes).
 *
 * Two more rules ride on the same store: `assertSkillWriteLockNotHeld` throws
 * when a skills-root lock is held while planning, fetching or scanning, and a
 * manifest update's callback (`runPureCallback`) may not request any lock.
 *
 * @module @skillsmith/core/config/lock-tracker
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** A lock's place in A1 plan §3.2's order table. */
export type LockRank = '1' | "1'" | '2a' | '2b' | '3' | '4'

const RANK_VALUE: Record<LockRank, number> = {
  '1': 1,
  "1'": 1,
  '2a': 2,
  '2b': 2.5,
  '3': 3,
  '4': 4,
}

/** A lock request the tracker refused, before any wait. */
export class LockOrderError extends Error {
  readonly kind:
    | 're-entry'
    | 'second-skills-root-lock'
    | 'inversion'
    | 'held-while-planning'
    | 'in-pure-callback'
  constructor(kind: LockOrderError['kind'], message: string) {
    super(`[skillsmith] ${message}`)
    this.name = 'LockOrderError'
    this.kind = kind
  }
}

interface HeldLock {
  /** The lock target, resolved so two spellings of one path compare equal. */
  key: string
  label: string
  rank: LockRank | undefined
}

interface TrackerState {
  held: readonly HeldLock[]
  /** Set while a manifest update's synchronous callback runs. */
  pure: { violation: LockOrderError | null } | null
}

const storage = new AsyncLocalStorage<TrackerState>()
let enabled = true

/** @internal Test seam: the T-L3/T-L5 controls run with the tracker off. */
export function setLockTrackerEnabledForTests(on: boolean): void {
  enabled = on
}

/** `target` resolved, with its folder's symlinks followed when the folder exists. */
function lockKey(target: string): string {
  const abs = resolve(target)
  try {
    return join(realpathSync(dirname(abs)), basename(abs))
  } catch {
    return abs // the folder doesn't exist yet: nothing else can name it either
  }
}

function describe(h: HeldLock): string {
  return `${h.label} (${h.rank === undefined ? 'unranked' : `lock ${h.rank}`}, ${h.key})`
}

/**
 * Check a request against what this context holds. Returns the entry to hold,
 * or throws `LockOrderError`. Never waits.
 */
function admit(target: string, label: string, rank: LockRank | undefined): HeldLock {
  const entry: HeldLock = { key: lockKey(target), label, rank }
  const state = storage.getStore()
  if (!enabled || state === undefined) return entry
  if (state.pure !== null) {
    const err = new LockOrderError(
      'in-pure-callback',
      `${label} was requested inside a manifest update callback, which may not take a lock`
    )
    state.pure.violation ??= err
    throw err
  }
  const again = state.held.find((h) => h.key === entry.key)
  if (again !== undefined) {
    throw new LockOrderError(
      're-entry',
      `${label} is already held by this operation (${describe(again)}); taking it again would wait on itself`
    )
  }
  if (rank === '1' || rank === "1'") {
    const root = state.held.find((h) => h.rank === '1' || h.rank === "1'")
    if (root !== undefined) {
      throw new LockOrderError(
        'second-skills-root-lock',
        `${label} is a skills-root lock, and this operation already holds one (${describe(root)})`
      )
    }
  }
  if (rank !== undefined) {
    const higher = state.held.find(
      (h) => h.rank !== undefined && RANK_VALUE[h.rank] > RANK_VALUE[rank]
    )
    if (higher !== undefined) {
      throw new LockOrderError(
        'inversion',
        `${label} (lock ${rank}) was requested while holding ${describe(higher)}; locks must be taken in order`
      )
    }
  }
  return entry
}

/**
 * Run `fn` with `target` recorded as held. Throws `LockOrderError`
 * synchronously, before `fn` or any wait, when the request breaks a rule.
 */
export function runHoldingLock<T>(
  target: string,
  label: string,
  rank: LockRank | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const entry = admit(target, label, rank)
  if (!enabled) return fn()
  const held = storage.getStore()?.held ?? []
  return storage.run({ held: [...held, entry], pure: null }, fn)
}

/**
 * Throws `LockOrderError` when this context holds a skills-root lock (1 or
 * 1′). The prompt, fetch, registry-lookup, scan and staging-copy wrappers call
 * it on entry: none of them may run under that lock (plan §3.2, #8).
 */
export function assertSkillWriteLockNotHeld(label: string): void {
  if (!enabled) return
  const root = storage.getStore()?.held.find((h) => h.rank === '1' || h.rank === "1'")
  if (root !== undefined) {
    throw new LockOrderError(
      'held-while-planning',
      `${label} ran while holding ${describe(root)}; it must run before the skills-root lock is taken`
    )
  }
}

/**
 * Run a manifest update's synchronous callback. A lock requested inside it is
 * refused, and the callback's result is then refused too, even if the
 * callback caught the refusal (plan §3.2: a callback may not call a lock
 * wrapper).
 */
export function runPureCallback<T>(fn: () => T): T {
  if (!enabled) return fn()
  const state = storage.getStore()
  const pure = { violation: null as LockOrderError | null }
  const result = storage.run({ held: state?.held ?? [], pure }, fn)
  if (pure.violation !== null) throw pure.violation
  return result
}

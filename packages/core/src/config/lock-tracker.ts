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
 *   - re-enter a lock this context already holds (it would wait on itself;
 *     "the same lock" is as far as `lockFileKey` recognises it: a case variant
 *     of a component that does not exist yet, and hard links, are not),
 *   - take a second skills-root lock (1 and 1′ count as one),
 *   - take a lock ranked below one already held (an inversion: two contexts
 *     taking the same pair in opposite orders can deadlock across processes),
 *   - take a second lock of the same rank (two destinations, two manifests:
 *     the same deadlock between two contexts taking them in opposite orders;
 *     §3.2 takes them "in turn"), or
 *   - take any lock while lock 4 is held (§3.2: a leaf).
 *
 * Every lock names its rank; `'unordered'` is the explicit choice for a lock
 * outside the table, checked for re-entry and the leaf rule only. A missing
 * rank is a type error, so a new skills-root lock can't silently skip the
 * rules (or make `assertSkillWriteLockNotHeld` a no-op) by omission.
 *
 * Two more rules ride on the same store: `assertSkillWriteLockNotHeld` throws
 * when a skills-root lock is held while planning, fetching or scanning, and a
 * manifest update's callback (`runPureCallback`) may not request any lock,
 * nor start async work while it runs (promises, microtasks, timers,
 * immediates, nextTick, fs callbacks and fs promises). That watch sees only
 * resources of the `SCHEDULING_TYPES` created during the callback. It does not
 * detect a callback-style crypto call (`randomBytes(n, cb)`, `pbkdf2`), a
 * callback-style dns call (`dns.lookup`), or in general any native request
 * type outside that set; nor a listener added to an EventEmitter or stream that
 * already exists, a message posted to an existing worker, or a child-process
 * callback registered on an existing object: such a callback can run later and
 * request a lock unseen.
 *
 * Work a lock's `fn` starts and leaves running (a timer, an un-awaited
 * promise) inherits the store, so each held entry carries a live flag. The
 * tracker stops counting a lock only once it is shown gone or someone else's:
 * `releasing()` clears the flag, and `withFileLock` calls it right after a
 * release that reports the lock is no longer ours on disk (unlinked, nothing at
 * the path, or a readable claim naming someone else), with no await between.
 * The backstop in `runHoldingLock` clears it only for a lock that was never
 * acquired. A release that failed, or whose claim can't be shown to be someone
 * else's while a file remains, keeps the lock counting: the file may still be ours, and work
 * that inherited the store must be refused rather than wait on it.
 *
 * @module @skillsmith/core/config/lock-tracker
 */
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'

/** A lock's place in A1 plan §3.2's order table. */
export type LockRank = '1' | "1'" | '2a' | '2b' | '3' | '4'

/** A rank, or `'unordered'` for a lock outside the table (re-entry and leaf rules only). */
export type LockOrder = LockRank | 'unordered'

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
    | 'same-rank'
    | 'under-leaf'
    | 'held-while-planning'
    | 'in-pure-callback'
  constructor(kind: LockOrderError['kind'], message: string) {
    super(`[skillsmith] ${message}`)
    this.name = 'LockOrderError'
    this.kind = kind
  }
}

interface HeldLock {
  /** The lock file `<target>.lock`, resolved through the filesystem once it exists, so two spellings compare equal. */
  key: string
  label: string
  rank: LockOrder
  /** Cleared when the lock is released; work left running afterwards ignores it. */
  live: boolean
}

interface PureScope {
  violation: LockOrderError | null
  /** Cleared when the callback returns. */
  open: boolean
}

interface TrackerState {
  held: readonly HeldLock[]
  /** Set while a manifest update's synchronous callback runs. */
  pure: PureScope | null
}

const storage = new AsyncLocalStorage<TrackerState>()
let enabled = true

/** @internal Test seam: the T-L3/T-L5 controls run with the tracker off. */
export function setLockTrackerEnabledForTests(on: boolean): void {
  enabled = on
}

/**
 * `target` as the filesystem resolves it. The path is never collapsed
 * lexically before `realpath`: with `link -> real/sub`, `link/../x` opens
 * `real/x`, which `resolve()` would have turned into `x`. A folder that
 * doesn't exist yet is resolved at its nearest existing ancestor. The tracker
 * does not key by this alone: `runHoldingLock` recomputes {@link lockFileKey}
 * once the lock is held, when the folder and the lock file exist.
 *
 * What "same key" guarantees, as measured (not "one file, one key"):
 *   - Aliases `realpath` resolves: symlinks and `..`. Guaranteed.
 *   - Case variants of an EXISTING folder component: only where the OS
 *     canonicalizes case in `realpath.native`. Measured on macOS (APFS,
 *     case-insensitive): yes. Measured on Linux (case-sensitive): no, and
 *     there the variants are different folders anyway.
 *   - Case variants of a component that does not exist yet: never. It is kept
 *     as spelled, as is the final name (only the folder is resolved).
 *   - Hard links: never. Two names for one inode key differently; the lock is
 *     a file at `<target>.lock`, so two hard links are two locks.
 *
 * This keys a path; the tracker itself keys by the lock FILE, see
 * {@link lockFileKey}.
 */
export function lockKey(target: string): string {
  const raw = isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`
  const missing: string[] = [basename(raw)]
  let dir = dirname(raw)
  for (;;) {
    try {
      // .native, as the OS does: symlinks first, then `..`. The JS realpathSync
      // resolves the path lexically first and would collapse `link/..` too.
      return join(realpathSync.native(dir), ...missing)
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return normalize(raw)
      missing.unshift(basename(dir))
      dir = parent
    }
  }
}

/**
 * The key the tracker admits a request by: the lock file `<target>.lock`, not
 * the target. The physical lock is that file, so two spellings of it must share
 * one key. When the file exists, the full path is resolved through the
 * filesystem (`realpath.native`), which folds the final name's case where the
 * OS folds it (macOS) and follows a symlinked `.lock`. A lock file that does not
 * exist yet is keyed by its spelling, with the folder resolved as `lockKey`
 * does. Hard links remain distinct (the key is a path, never an inode: a
 * stale entry could otherwise collide with a reused inode).
 */
export function lockFileKey(target: string): string {
  const file = `${target}.lock`
  try {
    return realpathSync.native(isAbsolute(file) ? file : `${process.cwd()}${sep}${file}`)
  } catch {
    return lockKey(file)
  }
}

function describe(h: HeldLock): string {
  return `${h.label} (${h.rank === 'unordered' ? 'unordered' : `lock ${h.rank}`}, ${h.key})`
}

function liveHeld(state: TrackerState | undefined): HeldLock[] {
  return state === undefined ? [] : state.held.filter((h) => h.live)
}

function pureViolation(label: string, what: string): LockOrderError {
  return new LockOrderError(
    'in-pure-callback',
    `${label} ${what} inside a manifest update callback, which may not take a lock or start async work`
  )
}

/**
 * Check a request against what this context holds. Returns the entry to hold,
 * or throws `LockOrderError`. Never waits.
 */
function admit(target: string, label: string, rank: LockOrder): HeldLock {
  const entry: HeldLock = { key: lockFileKey(target), label, rank, live: true }
  const state = storage.getStore()
  if (!enabled || state === undefined) return entry
  if (state.pure !== null && state.pure.open) {
    const err = pureViolation(label, 'was requested')
    state.pure.violation ??= err
    throw err
  }
  const held = liveHeld(state)
  const again = held.find((h) => h.key === entry.key)
  if (again !== undefined) {
    throw new LockOrderError(
      're-entry',
      `${label} is already held by this operation (${describe(again)}); taking it again would wait on itself`
    )
  }
  const leaf = held.find((h) => h.rank === '4')
  if (leaf !== undefined) {
    throw new LockOrderError(
      'under-leaf',
      `${label} was requested while holding ${describe(leaf)}; lock 4 takes no other lock`
    )
  }
  if (rank === '1' || rank === "1'") {
    const root = held.find((h) => h.rank === '1' || h.rank === "1'")
    if (root !== undefined) {
      throw new LockOrderError(
        'second-skills-root-lock',
        `${label} is a skills-root lock, and this operation already holds one (${describe(root)})`
      )
    }
  }
  if (rank !== 'unordered') {
    const v = RANK_VALUE[rank]
    const higher = held.find((h) => h.rank !== 'unordered' && RANK_VALUE[h.rank] > v)
    if (higher !== undefined) {
      throw new LockOrderError(
        'inversion',
        `${label} (lock ${rank}) was requested while holding ${describe(higher)}; locks must be taken in order`
      )
    }
    const same = held.find((h) => h.rank !== 'unordered' && RANK_VALUE[h.rank] === v)
    if (same !== undefined) {
      throw new LockOrderError(
        'same-rank',
        `${label} (lock ${rank}) was requested while holding ${describe(same)}; locks of one rank are taken in turn, not nested`
      )
    }
  }
  return entry
}

/**
 * Check a request without recording it. Throws `LockOrderError` exactly as
 * `runHoldingLock` would. A caller that waits or writes before reaching its
 * `withFileLock` (fan-out's per-destination queue) calls this first, so a
 * refusal still comes before any wait.
 */
export function checkLockRequest(target: string, label: string, rank: LockOrder): void {
  admit(target, label, rank)
}

/**
 * Run `fn` with `target` recorded as held. Throws `LockOrderError`
 * synchronously, before `fn` or any wait, when the request breaks a rule.
 * `fn` calls `acquired()` once the file lock is taken, which recomputes the
 * entry's key now that the lock file exists. The entry stops counting when
 * `fn` calls `releasing()`, which it must do only once the lock is shown gone
 * or someone else's (the release reports it is no longer ours on disk), in the
 * same synchronous step as the release itself (no `await` between): work `fn`
 * started can run in the next microtask and must not see a lock that is
 * already gone, nor a lock that is still held as free. When `fn` settles, the
 * entry is cleared as a backstop only if `fn` never called `acquired()` (the
 * acquisition failed or was refused, so no file was taken). An acquired lock
 * whose release failed, or whose claim can't be shown to be someone else's
 * while a file remains, stays live for the contexts that inherited it, because the file may still
 * be ours.
 */
export function runHoldingLock<T>(
  target: string,
  label: string,
  rank: LockOrder,
  fn: (acquired: () => void, releasing: () => void) => Promise<T>
): Promise<T> {
  const entry = admit(target, label, rank)
  let wasAcquired = false
  const acquired = (): void => {
    wasAcquired = true
    entry.key = lockFileKey(target)
  }
  const releasing = (): void => {
    entry.live = false
  }
  if (!enabled) return fn(acquired, releasing)
  const held = liveHeld(storage.getStore())
  return storage.run({ held: [...held, entry], pure: null }, async () => {
    try {
      return await fn(acquired, releasing)
    } finally {
      if (!wasAcquired) releasing()
    }
  })
}

/**
 * Throws `LockOrderError` when this context holds a skills-root lock (1 or
 * 1′). The prompt, fetch, registry-lookup, scan and staging-copy wrappers call
 * it on entry: none of them may run under that lock (plan §3.2, #8).
 */
export function assertSkillWriteLockNotHeld(label: string): void {
  if (!enabled) return
  const root = liveHeld(storage.getStore()).find((h) => h.rank === '1' || h.rank === "1'")
  if (root !== undefined) {
    throw new LockOrderError(
      'held-while-planning',
      `${label} ran while holding ${describe(root)}; it must run before the skills-root lock is taken`
    )
  }
}

/**
 * The scope whose callback is running now, if any; the async hook below reads
 * it. Callbacks are synchronous, so at most one runs at a time.
 */
let runningPure: PureScope | null = null
/**
 * Async resource types that run the callback's own code later: a promise
 * reaction, a microtask, a timer, an immediate, a nextTick, an fs callback.
 * Not every async resource: a synchronous API may start internal work of its
 * own (crypto.randomUUID refills its entropy pool with a RANDOMBYTESREQUEST),
 * and refusing that would refuse a callback that is synchronous.
 */
const SCHEDULING_TYPES = new Set([
  'PROMISE',
  'Microtask',
  'Timeout',
  'Immediate',
  'TickObject',
  'FSREQCALLBACK',
  'FSREQPROMISE',
])
const asyncWatch = createHook({
  init(_id, type) {
    if (runningPure !== null && runningPure.violation === null && SCHEDULING_TYPES.has(type)) {
      runningPure.violation = pureViolation(`async work (${type})`, 'was started')
    }
  },
})

/**
 * Run a manifest update's synchronous callback. The callback may not request
 * a lock, and may not start async work (a promise, timer or microtask) that
 * could request one after it returns: an `async_hooks` hook watches while it
 * runs. Either refuses the callback's result, even if the callback caught the
 * refusal (plan §3.2: a callback may not call a lock wrapper). A callback
 * that returns a promise is returned as is, for the caller to refuse.
 *
 * What this enforces is narrower than "no later lock request": the hook sees
 * only async resources of the types in `SCHEDULING_TYPES` that are created
 * while the callback runs. It does NOT detect a callback-style crypto call
 * (`randomBytes(n, cb)`, `pbkdf2`), a callback-style dns call (`dns.lookup`), or
 * in general any native request type outside that set; nor a listener
 * registered on an EventEmitter or stream that already exists, a message posted
 * to an existing worker, or a callback registered on an existing child process
 * (none of those creates a watched resource). A callback must not do any of
 * them; the tracker will not catch it.
 */
export function runPureCallback<T>(fn: () => T): T {
  if (!enabled) return fn()
  const state = storage.getStore()
  const pure: PureScope = { violation: null, open: true }
  const outer = runningPure
  runningPure = pure
  asyncWatch.enable()
  let result: T
  try {
    result = storage.run({ held: liveHeld(state), pure }, fn)
  } finally {
    asyncWatch.disable()
    runningPure = outer
    pure.open = false
  }
  // A returned promise is left to the caller, which refuses it with a more
  // precise message ("update must be synchronous") than the async watch's.
  if (typeof (result as { then?: unknown } | null)?.then === 'function') return result
  if (pure.violation !== null) throw pure.violation
  return result
}

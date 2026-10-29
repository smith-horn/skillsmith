/**
 * SMI-6531 (#3209 retro): the hint a refusal ends with, derived from what the
 * plan table offers for the same class.
 *
 * A refusal may name another action only when that action is offered for the
 * class, must name every one that is, and says `no other action is offered
 * here` when none is. So no row writes those words itself: the base planner
 * (`planBase` in `skill-recovery.plan.ts`) states only why this action is
 * refused, and `withHint` appends what one offeredness computation found.
 *
 * Flags (owner decision 2026-10-29):
 *  - `--unsafe-unverified-owner` is computed: for a no-record op dir, the
 *    actions offered only with it are named under its own clause;
 *  - `--accept-identity` is not computed (it changes the class, not the
 *    plan): an `identity-changed` class carries a fixed clause that names no
 *    action.
 *
 * The hint is computed without the request's flags, so the listing and a
 * targeted re-plan say the same thing. The base planner is passed in, so this
 * module does not import the table (no cycle).
 *
 * @module @skillsmith/core/services/skill-recovery.plan.hint
 */
import { RECOVERY_ACTIONS } from './skill-recovery.plan.actions.js'
import type {
  ActionPlan,
  PlanOptions,
  RecoveryAction,
  RecoveryClass,
} from './skill-recovery.types.js'

/** A planner that never adds a hint (`planBase`). */
export type BasePlanner = (
  cls: RecoveryClass,
  action: RecoveryAction,
  opts: PlanOptions
) => ActionPlan

/** What is offered for a class: without any flag, and only with `--unsafe-unverified-owner`. */
export interface Offers {
  plain: RecoveryAction[]
  unsafeOnly: RecoveryAction[]
}

const UNSAFE_OWNER =
  'with --unsafe-unverified-owner (only if you are sure no update is still using this op dir)'
const IDENTITY =
  "add --accept-identity to the action you want to run: it waives the identity check, and that action's plan is printed before any change"
const NOTHING = 'no other action is offered here'

/** Every action's offeredness for `cls`, in `RECOVERY_ACTIONS` order. */
export function offersOf(base: BasePlanner, cls: RecoveryClass): Offers {
  const plain = RECOVERY_ACTIONS.filter((a) => base(cls, a, {}).offered)
  // Only a no-record op dir's plan reads the flag (`--clean-staging`'s owner check).
  const unsafeOnly =
    cls.kind === 'no-record'
      ? RECOVERY_ACTIONS.filter(
          (a) => !plain.includes(a) && base(cls, a, { unsafeUnverifiedOwner: true }).offered
        )
      : []
  return { plain, unsafeOnly }
}

const flags = (actions: readonly RecoveryAction[]): string =>
  actions.map((a) => `--${a}`).join(' or ')

/**
 * The hint for a refusal of `refused`: the other actions offered, then those
 * offered only with `--unsafe-unverified-owner` (the refused one included),
 * or else that none is; then, for `identity-changed`, the identity clause.
 */
export function renderHint(refused: RecoveryAction, offers: Offers, cls: RecoveryClass): string {
  const others = offers.plain.filter((a) => a !== refused)
  const parts: string[] = []
  if (others.length > 0) parts.push(`offered here: ${flags(others)}`)
  if (offers.unsafeOnly.length > 0) parts.push(`${UNSAFE_OWNER}: ${flags(offers.unsafeOnly)}`)
  if (parts.length === 0) parts.push(NOTHING)
  if (cls.kind === 'identity-changed') parts.push(IDENTITY)
  return parts.join('; ')
}

/** `base`'s plan: an offered one unchanged, a refused one with the hint appended to its detail. */
export function withHint(
  base: BasePlanner,
  cls: RecoveryClass,
  action: RecoveryAction,
  opts: PlanOptions = {}
): ActionPlan {
  const plan = base(cls, action, opts)
  if (plan.offered) return plan
  return { ...plan, detail: `${plan.detail}; ${renderHint(action, offersOf(base, cls), cls)}` }
}

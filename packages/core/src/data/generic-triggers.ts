/**
 * @fileoverview Curated stoplist of generic trigger words and namespace tokens
 * used by `skill_pack_audit` to flag false-trigger-prone skill names/descriptions
 * and generic pack namespaces.
 * @module @skillsmith/core/data/generic-triggers
 * @see SMI-4124
 *
 * Edit `generic-triggers.json` (sibling file) to add entries — no code change
 * required. i18n follow-up tracked in SMI-4125.
 */

import data from './generic-triggers.json' with { type: 'json' }

/** Typed shape of the curated stoplist. */
export interface GenericTriggersStoplist {
  /** Common English/dev verbs that misfire Claude's skill-trigger heuristic. */
  readonly triggerWords: readonly string[]
  /** Generic pack namespaces (directory names) that should be domain-qualified. */
  readonly namespaces: readonly string[]
  /** ISO 639-1 locale code for this stoplist (v1: "en" only). */
  readonly locale: string
  /** Maintenance notes for editors. */
  readonly notes: string
}

/** Frozen default stoplist. Consumers should treat as read-only. */
export const GENERIC_TRIGGERS: GenericTriggersStoplist = Object.freeze({
  triggerWords: Object.freeze([...data.triggerWords]),
  namespaces: Object.freeze([...data.namespaces]),
  locale: data.locale,
  notes: data.notes,
}) as GenericTriggersStoplist

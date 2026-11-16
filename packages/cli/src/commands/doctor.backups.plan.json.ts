/**
 * @fileoverview The `--json` document for `skillsmith doctor backups --prune`
 * (SMI-6531 step 6c-ii-b): a `PrunePlan` as plain data, with a fixed field
 * order. Bigint identities become decimal strings, and a sidecar's bytes are
 * given as their sha256 only, never the raw bytes.
 * @module @skillsmith/cli/commands/doctor.backups.plan.json
 */

import { createHash } from 'node:crypto'
import type { PlanGroup, PlanItem, PrunePlan } from '@skillsmith/core'

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function itemJson(i: PlanItem): Record<string, unknown> {
  const id = i.rootIdentity
  const r = i.sidecarRead
  return {
    copyPath: i.copyPath,
    store: i.store,
    kind: i.kind,
    class: i.klass,
    tier: i.tier,
    allocatedBytes: i.allocatedBytes,
    leaf: i.leaf,
    stagingRoot: i.stagingRoot,
    opDir: i.opDir,
    sidecarPath: i.sidecarPath,
    sidecarSha256: r === null ? null : sha256(r.bytes),
    rootIdentity: {
      dev: String(id.dev),
      ino: String(id.ino),
      birthtimeNs: String(id.birthtimeNs),
      fmt: String(id.fmt),
    },
    approvedHash: i.approvedHash,
  }
}

function groupJson(g: PlanGroup): Record<string, unknown> {
  return {
    lock: g.lock,
    scope: g.scope,
    digest: g.digest,
    items: g.items.map(itemJson),
  }
}

/** Trees and allocated bytes `--apply` would delete (6c-iii): the sum over every group. */
export function planTotals(plan: PrunePlan): { trees: number; allocatedBytes: number } {
  let trees = 0
  let allocatedBytes = 0
  for (const g of plan.groups) {
    for (const i of g.items) {
      trees += 1
      allocatedBytes += i.allocatedBytes
    }
  }
  return { trees, allocatedBytes }
}

/** The plan as a JSON-safe object. */
export function planJson(plan: PrunePlan): Record<string, unknown> {
  const r = plan.request
  return {
    dryRun: true,
    request: {
      now: r.now,
      olderThanDays: r.olderThanDays ?? null,
      keep: r.keep ?? null,
      client: r.client ?? null,
      roots: r.roots ?? [],
      skill: r.skill ?? null,
      op: r.op ?? null,
      paths: r.paths ?? [],
      includeKept: r.includeKept,
      allowChanged: r.allowChanged,
    },
    noSelector: plan.noSelector,
    preconditions: plan.preconditions,
    groups: plan.groups.map(groupJson),
    excluded: plan.excluded,
    unmatchedPaths: plan.unmatchedPaths,
    totals: planTotals(plan),
  }
}

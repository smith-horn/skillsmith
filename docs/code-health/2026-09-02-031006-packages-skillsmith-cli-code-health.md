# Code Health Report

Generated: 2026-09-02T03:10:06.601Z

## SCAN FAILURES (0)

A Knip pass failed or returned malformed/incomplete data for these workspaces. Every candidate from a listed workspace is force-routed to Needs runtime verification below, regardless of coverage or calibration status, and is NOT eligible for Safe-to-delete or Consolidation-candidate until re-scanned successfully. This is never absorbed as "no findings" -- see patterns/README.md Decision Log.

_None._

## Safe to delete (0)

Never auto-applied. Zero static references + zero coverage on the exact flagged range — not a deletion guarantee, do a final project-wide grep before deleting. See patterns/README.md Bucket 1.

_None._

## Consolidation candidate (1)

Human judgment only, never auto-merged. See patterns/README.md Bucket 2.

| workspace | file | name | files | note | source |
|---|---|---|---|---|---|
| packages/skillsmith-cli | packages/skillsmith-cli/package.json | @skillsmith/cli |  | unused dependency — requires a human runtime-import check before removal; never auto-classified as safe |  |

## Looks bad but is fine (0)

### False positives (0)

_None._

### Known blind spots (0)

_None._

## Needs runtime verification — insufficient evidence (0)

Not a verdict. Never promoted to Safe-to-delete on missing data. See patterns/README.md Bucket 4.

_None._

## Suppressed by marker (0)

_None._

## Stale suppression markers (0)

Present in source, no current finding matches — consider removing.

_None._

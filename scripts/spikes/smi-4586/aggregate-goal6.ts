#!/usr/bin/env tsx
/**
 * SMI-4586 Goal #6 — Reproduce per-template gate verdicts from the harness CSV.
 *
 * Reads `goal6-review-harness.csv`, groups rows by `template_kind`, computes
 * the per-template mean of `(reviewer_2_actionability + reviewer_2_preservation) / 2`,
 * and emits `{ template, mean, verdict }` matching
 * `goal_6.per_template_gate.verdicts` in `docs/internal/research/smi-4586-spike-dataset.json`.
 *
 * PASS threshold: mean ≥ 3.5 (per SMI-4589 plan §Wave 3 ship gate, ratified 2026-05-01).
 *
 * Throwaway one-shot — verifies the dataset's manually-recorded verdicts are
 * reproducible from the CSV. Required pre-merge per SMI-4589 verification
 * checklist line 306.
 *
 * Usage: `npx tsx scripts/spikes/smi-4586/aggregate-goal6.ts`
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, 'goal6-review-harness.csv');
const PASS_THRESHOLD = 3.5;

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inQuotes) {
      if (c === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.length > 0));
}

const csv = parseCsv(readFileSync(CSV_PATH, 'utf-8'));
const [header, ...dataRows] = csv;
const colTemplate = header.indexOf('template_kind');
const colR2Action = header.indexOf('reviewer_2_actionability_1to5');
const colR2Preserve = header.indexOf('reviewer_2_preservation_1to5');
if (colTemplate < 0 || colR2Action < 0 || colR2Preserve < 0) {
  throw new Error('CSV missing expected columns (template_kind, reviewer_2_*)');
}

const perRow = new Map<string, number[]>();
for (const r of dataRows) {
  const a = Number(r[colR2Action]);
  const p = Number(r[colR2Preserve]);
  if (!Number.isFinite(a) || !Number.isFinite(p)) continue;
  const t = r[colTemplate];
  if (!perRow.has(t)) perRow.set(t, []);
  perRow.get(t)!.push((a + p) / 2);
}

const verdicts: Record<string, { mean: number; verdict: 'PASS' | 'FAIL' }> = {};
for (const [template, scores] of perRow) {
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  verdicts[template] = {
    mean: Math.round(mean * 100) / 100,
    verdict: mean >= PASS_THRESHOLD ? 'PASS' : 'FAIL',
  };
}

console.log(JSON.stringify(verdicts, null, 2));

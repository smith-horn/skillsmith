#!/usr/bin/env tsx
/**
 * SMI-4586 Goal #6 — Apply GPT-5.4 reviewer-#2 scores to the harness CSV.
 *
 * Reads goal6-llm-scoring-output.json (30 scored objects from GPT-5.4 via
 * Copilot CLI) and writes them into the reviewer_2_* columns of
 * goal6-review-harness.csv. Prints summary stats: overall mean, per-dimension
 * means, per-template_kind means, lowest/highest cases.
 *
 * Throwaway one-shot — only intended to run on spike branch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, 'goal6-review-harness.csv');
const SCORES_PATH = resolve(__dirname, 'goal6-llm-scoring-output.json');

interface Score {
  case_id: string;
  template_kind: string;
  actionability: number;
  preservation: number;
  note: string;
}

// Minimal CSV parser preserving quoted-field semantics.
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
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (c === '\r') {
        // skip
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.length > 0));
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

const scores: Score[] = JSON.parse(readFileSync(SCORES_PATH, 'utf8'));
const csv = readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(csv);
const header = rows[0];
const idx = (name: string) => header.indexOf(name);

const colCaseId = idx('case_id');
const colTemplate = idx('template_kind');
const colR2Action = idx('reviewer_2_actionability_1to5');
const colR2Preserv = idx('reviewer_2_preservation_1to5');
const colNotes = idx('reviewer_notes');

const scoreMap = new Map<string, Score>();
for (const s of scores) {
  scoreMap.set(`${s.case_id}|${s.template_kind}`, s);
}

let applied = 0;
for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const key = `${row[colCaseId]}|${row[colTemplate]}`;
  const score = scoreMap.get(key);
  if (!score) {
    console.error(`No score for ${key}`);
    continue;
  }
  row[colR2Action] = String(score.actionability);
  row[colR2Preserv] = String(score.preservation);
  const newNote = `[LLM-r2 GPT-5.4]: ${score.note}`;
  row[colNotes] = row[colNotes] ? `${row[colNotes]} | ${newNote}` : newNote;
  applied += 1;
}

writeFileSync(CSV_PATH, serializeCsv(rows));

// Summary stats.
const all = scores;
const mean = (arr: number[]) =>
  arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1);

const overallScores = all.flatMap((s) => [s.actionability, s.preservation]);
const overallMean = mean(overallScores);

const actionMean = mean(all.map((s) => s.actionability));
const preservMean = mean(all.map((s) => s.preservation));

const byTemplate: Record<string, { action: number[]; preserv: number[] }> = {};
for (const s of all) {
  if (!byTemplate[s.template_kind]) {
    byTemplate[s.template_kind] = { action: [], preserv: [] };
  }
  byTemplate[s.template_kind].action.push(s.actionability);
  byTemplate[s.template_kind].preserv.push(s.preservation);
}

const distribution: Record<string, number> = {
  '1': 0,
  '2': 0,
  '3': 0,
  '4': 0,
  '5': 0,
};
for (const v of overallScores) {
  distribution[String(v)] = (distribution[String(v)] ?? 0) + 1;
}

// Per-row combined mean for ranking.
const ranked = all
  .map((s) => ({ ...s, combined: (s.actionability + s.preservation) / 2 }))
  .sort((a, b) => a.combined - b.combined);
const lowest3 = ranked.slice(0, 3);
const highest3 = ranked.slice(-3).reverse();

console.log(`Applied scores to ${applied}/30 rows.`);
console.log('');
console.log(`Overall mean (all 60 scores): ${overallMean.toFixed(2)}/5`);
console.log(`Actionability mean: ${actionMean.toFixed(2)}/5`);
console.log(`Preservation mean:  ${preservMean.toFixed(2)}/5`);
console.log('');
console.log('Per-template means:');
for (const [k, v] of Object.entries(byTemplate)) {
  const am = mean(v.action);
  const pm = mean(v.preserv);
  const combined = (am + pm) / 2;
  console.log(
    `  ${k.padEnd(22)} action=${am.toFixed(2)} preserv=${pm.toFixed(2)} combined=${combined.toFixed(2)}`,
  );
}
console.log('');
console.log('Score distribution (across both dimensions, n=60):');
for (const [k, v] of Object.entries(distribution)) {
  console.log(`  ${k}: ${String(v).padStart(2)} (${((v / 60) * 100).toFixed(1)}%)`);
}
console.log('');
console.log('LOWEST 3 cases:');
for (const r of lowest3) {
  console.log(
    `  ${r.case_id} ${r.template_kind} action=${r.actionability} preserv=${r.preservation} | ${r.note}`,
  );
}
console.log('');
console.log('HIGHEST 3 cases:');
for (const r of highest3) {
  console.log(
    `  ${r.case_id} ${r.template_kind} action=${r.actionability} preserv=${r.preservation} | ${r.note}`,
  );
}
console.log('');
console.log(
  `Verdict gate: ${overallMean >= 3.5 ? 'PASS' : 'FAIL'} (threshold >=3.5/5; observed ${overallMean.toFixed(2)})`,
);

const signal =
  overallMean >= 3.8
    ? 'likely_pass'
    : overallMean <= 3.2
      ? 'likely_fail'
      : 'borderline';
console.log(`Preliminary signal: ${signal}`);

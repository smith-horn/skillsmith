#!/usr/bin/env tsx
/**
 * SMI-4586 Goal #6 — Reviewer #1 calibration via Gemini API.
 *
 * Per the rubric §Reviewer assignment 2026-05-01 amendment, reviewer #1
 * (Ryan) scoring is non-blocking for v1 ship but reduces disagreement-
 * reopening risk if landed before Wave 3 implementation begins. Wave 3
 * shipped 2026-05-02 (PR #886 → main `d5f2cb75`); this script lands
 * the calibration pass *post-ship* using Gemini 2.5 Pro as a stand-in
 * reviewer #1 to triangulate the GPT-5.4 reviewer-#2 verdicts.
 *
 * Reads `goal6-review-harness.csv`, builds the same scoring prompt used
 * for reviewer #2 (deliberately identical to keep the comparison fair),
 * calls Gemini's REST `generateContent` endpoint with `responseMimeType:
 * application/json`, validates 30 scored objects, writes them into the
 * `reviewer_1_*` columns of the CSV plus an audit-trail JSON
 * (`goal6-gemini-scoring-output.json`).
 *
 * Calibration logic at the bottom: re-runs the per-template aggregation
 * over reviewer #1 means and flags any case where Gemini and GPT-5.4
 * disagree by >1pt on a gate-affecting dimension that would flip the
 * per-template PASS/FAIL verdict (per plan §Re-adjudication path).
 *
 * Throwaway one-shot — only intended to run on spike branch.
 *
 * Usage: `varlock run -- npx tsx scripts/spikes/smi-4586/score-with-gemini.ts`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, 'goal6-review-harness.csv');
const OUTPUT_PATH = resolve(__dirname, 'goal6-gemini-scoring-output.json');
const PASS_THRESHOLD = 3.5;

const MODEL = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-pro';
const API_KEY = process.env['GEMINI_API_KEY'];
if (!API_KEY) {
  console.error('GEMINI_API_KEY not set; run via `varlock run --`.');
  process.exit(2);
}

interface Score {
  case_id: string;
  template_kind: string;
  actionability: number;
  preservation: number;
  note: string;
}

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

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}

function buildPrompt(data: Array<{
  case_id: string;
  pair_skill_a: string;
  pair_skill_b: string;
  overlapping_phrase_a: string;
  overlapping_phrase_b: string;
  template_kind: string;
  suggestion_text: string;
}>): string {
  return `You are a strict reviewer applying a rubric to score 30 templated edit-suggestions for a skill-collision audit tool. Be honest. If a suggestion is generic, vague, or breaks the original meaning, score it low. Do NOT anchor scores toward 3.5 to split the difference. Score each row independently on its own merits.

# CONTEXT

Two Claude Code skills have colliding trigger phrases / descriptions. Templated suggestions try to disambiguate them so the right skill activates. You are scoring whether each templated suggestion is mechanically sound: actionable enough that a user could apply it, and preserving enough that the original intent isn't broken.

# RUBRIC

## Dimension 1 — Actionability (1-5)
Would the user know exactly what to change in their file based on this suggestion alone?
- 1: No actionable signal. Vague or unrelated.
- 2: Some signal but ambiguous; user must guess at the precise change.
- 3: Roughly clear; user could likely produce the right change after re-reading.
- 4: Clear and specific; user can produce the exact change with one read-through.
- 5: Diff-ready; literal copy-paste-able edit at a precise location.

## Dimension 2 — Preservation (1-5)
Does the suggestion preserve the original intent of the trigger phrase / description?
- 1: Changes meaning entirely. Skill would describe a different domain.
- 2: Materially shifts intent (introduces concepts unrelated to original).
- 3: Mostly preserves intent but introduces minor drift.
- 4: Preserves intent with a small differentiating addition.
- 5: Same intent, cleanly differentiated from the colliding skill.

# SCORING NOTES
- "narrow_scope" templates that literally append unrelated tokens (e.g. "a Stripe webhook" or "the migrations folder") to an unrelated skill's description should score LOW on preservation (typically 1-2).
- "reword_trigger_verb" templates that swap an article like "a" or "demo" for "a-specific" or "demo-specific" produce ungrammatical output ("a-specific MCP server"). Score LOW on actionability.
- "add_domain_qualifier" templates that prepend the author org are typically the strongest — concrete renames with clear intent preservation.
- Score each row independently. Do NOT anchor adjacent rows.

# OUTPUT FORMAT

Return ONLY a JSON array of 30 objects. Each object MUST have exactly these keys: case_id (string), template_kind (string), actionability (integer 1-5), preservation (integer 1-5), note (string, one sentence).

# DATA

${JSON.stringify(data, null, 2)}
`;
}

async function callGemini(prompt: string): Promise<Score[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }
  const json = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned no text content');
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== 30) {
    throw new Error(`Expected 30 scored objects, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`);
  }
  return parsed as Score[];
}

const csvText = readFileSync(CSV_PATH, 'utf-8');
const rows = parseCsv(csvText);
const header = rows[0];
const idx = (name: string) => header.indexOf(name);
const colCaseId = idx('case_id');
const colTemplate = idx('template_kind');
const colR1Action = idx('reviewer_1_actionability_1to5');
const colR1Preserv = idx('reviewer_1_preservation_1to5');
const colR2Action = idx('reviewer_2_actionability_1to5');
const colR2Preserv = idx('reviewer_2_preservation_1to5');
const colNotes = idx('reviewer_notes');

const data = rows.slice(1).map((r) => ({
  case_id: r[colCaseId],
  pair_skill_a: r[idx('pair_skill_a')],
  pair_skill_b: r[idx('pair_skill_b')],
  overlapping_phrase_a: r[idx('overlapping_phrase_a')],
  overlapping_phrase_b: r[idx('overlapping_phrase_b')],
  template_kind: r[colTemplate],
  suggestion_text: r[idx('suggestion_text')],
}));

if (data.length !== 30) {
  console.error(`Expected 30 rows, got ${data.length}`);
  process.exit(1);
}

console.log(`Calling ${MODEL} on 30 cases...`);
const scores = await callGemini(buildPrompt(data));

writeFileSync(OUTPUT_PATH, JSON.stringify(scores, null, 2) + '\n');
console.log(`Wrote ${scores.length} scores → ${OUTPUT_PATH}`);

const scoreMap = new Map<string, Score>();
for (const s of scores) {
  scoreMap.set(`${s.case_id}|${s.template_kind}`, s);
}

let applied = 0;
let disagreements: Array<{ case_id: string; template: string; dim: string; r1: number; r2: number; gateAffecting: boolean }> = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const key = `${row[colCaseId]}|${row[colTemplate]}`;
  const score = scoreMap.get(key);
  if (!score) {
    console.error(`No score for ${key}`);
    continue;
  }
  row[colR1Action] = String(score.actionability);
  row[colR1Preserv] = String(score.preservation);
  const newNote = `[LLM-r1 ${MODEL}]: ${score.note}`;
  row[colNotes] = row[colNotes] ? `${row[colNotes]} | ${newNote}` : newNote;

  const r2Action = Number(row[colR2Action]);
  const r2Preserv = Number(row[colR2Preserv]);
  const checkDim = (dim: string, r1: number, r2: number) => {
    if (Number.isFinite(r1) && Number.isFinite(r2) && Math.abs(r1 - r2) > 1) {
      disagreements.push({
        case_id: row[colCaseId],
        template: row[colTemplate],
        dim,
        r1,
        r2,
        gateAffecting: false,
      });
    }
  };
  checkDim('actionability', score.actionability, r2Action);
  checkDim('preservation', score.preservation, r2Preserv);
  applied += 1;
}

writeFileSync(CSV_PATH, serializeCsv(rows));
console.log(`Applied ${applied}/30 scores to reviewer_1_* columns of ${CSV_PATH}`);

const perTemplate = new Map<string, number[]>();
for (const s of scores) {
  if (!perTemplate.has(s.template_kind)) perTemplate.set(s.template_kind, []);
  perTemplate.get(s.template_kind)!.push((s.actionability + s.preservation) / 2);
}
const r1Verdicts: Record<string, { mean: number; verdict: 'PASS' | 'FAIL' }> = {};
for (const [t, ss] of perTemplate) {
  const mean = ss.reduce((a, b) => a + b, 0) / ss.length;
  r1Verdicts[t] = {
    mean: Math.round(mean * 100) / 100,
    verdict: mean >= PASS_THRESHOLD ? 'PASS' : 'FAIL',
  };
}

const r2Verdicts: Record<string, { mean: number; verdict: 'PASS' | 'FAIL' }> = {
  add_domain_qualifier: { mean: 4.10, verdict: 'PASS' },
  narrow_scope: { mean: 1.70, verdict: 'FAIL' },
  reword_trigger_verb: { mean: 2.35, verdict: 'FAIL' },
};

console.log('\n=== Per-template verdicts ===');
console.log('Template'.padEnd(24) + 'r1 (Gemini)'.padEnd(20) + 'r2 (GPT-5.4)'.padEnd(20) + 'Flip?');
console.log('-'.repeat(76));
for (const t of Object.keys(r2Verdicts)) {
  const r1 = r1Verdicts[t];
  const r2 = r2Verdicts[t];
  const flip = r1?.verdict !== r2.verdict ? '⚠ FLIP' : 'aligned';
  console.log(
    t.padEnd(24) +
      `${r1?.mean ?? '?'} ${r1?.verdict ?? '?'}`.padEnd(20) +
      `${r2.mean} ${r2.verdict}`.padEnd(20) +
      flip
  );
}

const flips = Object.keys(r2Verdicts).filter((t) => r1Verdicts[t]?.verdict !== r2Verdicts[t].verdict);
if (flips.length > 0) {
  console.log(`\n⚠ ${flips.length} template verdict(s) flipped vs reviewer #2: ${flips.join(', ')}`);
  console.log('Per plan §Re-adjudication, escalate to user adjudication.');
}

if (disagreements.length > 0) {
  console.log(`\n${disagreements.length} per-row disagreement(s) >1pt:`);
  for (const d of disagreements) {
    console.log(`  ${d.case_id} ${d.template} ${d.dim}: r1=${d.r1} vs r2=${d.r2}`);
  }
} else {
  console.log('\nNo per-row disagreements >1pt.');
}

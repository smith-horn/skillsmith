#!/usr/bin/env tsx
/**
 * SMI-4586 Goal #6 — Build the GPT-5.4 scoring prompt from the harness CSV.
 *
 * Reads goal6-review-harness.csv (30 rows) and emits a single self-contained
 * prompt to stdout that asks GPT-5.4 to score all 30 rows on actionability +
 * preservation (1-5 each) and return JSON only.
 *
 * Usage:
 *   tsx build-llm-prompt.ts > /tmp/goal6-prompt.txt
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, 'goal6-review-harness.csv');

// Minimal CSV parser respecting quoted fields with embedded commas + escaped quotes.
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

const csv = readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(csv);
const header = rows[0];
const idx = (name: string) => header.indexOf(name);
const data = rows.slice(1).map((r) => ({
  case_id: r[idx('case_id')],
  pair_skill_a: r[idx('pair_skill_a')],
  pair_skill_b: r[idx('pair_skill_b')],
  overlapping_phrase_a: r[idx('overlapping_phrase_a')],
  overlapping_phrase_b: r[idx('overlapping_phrase_b')],
  template_kind: r[idx('template_kind')],
  suggestion_text: r[idx('suggestion_text')],
}));

if (data.length !== 30) {
  console.error(`Expected 30 rows, got ${data.length}`);
  process.exit(1);
}

const prompt = `You are a strict reviewer applying a rubric to score 30 templated edit-suggestions for a skill-collision audit tool. Be honest. If a suggestion is generic, vague, or breaks the original meaning, score it low. Do NOT anchor scores toward 3.5 to split the difference. Score each row independently on its own merits.

# CONTEXT

Two Claude Code skills have colliding trigger phrases / descriptions. Templated suggestions try to disambiguate them so the right skill activates. You are scoring whether each templated suggestion is mechanically sound: actionable enough that a user could apply it, and preserving enough that the original intent isn't broken.

# RUBRIC

## Dimension 1 — Actionability (1-5)
Would the user know exactly what to change in their file based on this suggestion alone?

- 1: No actionable signal. Suggestion is vague or unrelated to the file. Example: "Consider rewording."
- 2: Some signal but ambiguous. User would have to guess at the precise change. Example: "Add a domain qualifier somewhere in the description."
- 3: Roughly clear. User could likely produce the right change after re-reading the suggestion. Example: "Add a domain qualifier near the trigger verb in the description."
- 4: Clear and specific. User can produce the exact change with one read-through. Example: "Insert 'for the release pipeline' after 'Use when' on line 5."
- 5: Diff-ready. The suggestion is a literal copy-paste-able edit at a precise location. Example: full unified diff with -/+ lines and an exact line range.

## Dimension 2 — Preservation (1-5)
Does the suggestion preserve the original intent of the trigger phrase / description?

- 1: Changes meaning entirely. The skill would behave differently or describe a different domain.
- 2: Materially shifts intent. Same general area but the trigger window is significantly altered (e.g. introduces concepts unrelated to the original — "Stripe webhook" appended to an eBird API skill is a 1 or 2).
- 3: Mostly preserves intent but introduces minor drift the user might not want (e.g. verb swap "deploying" → "shipping").
- 4: Preserves intent with a small differentiating addition (qualifier added; original meaning intact).
- 5: Same intent, cleanly differentiated from the colliding skill. The user would accept this rewrite verbatim.

# SCORING NOTES

- "narrow_scope" templates that literally append unrelated tokens (e.g. "a Stripe webhook" or "the migrations folder") to an unrelated skill's description should score LOW on preservation (typically 1-2) — the appended token doesn't relate to the actual skill domain.
- "reword_trigger_verb" templates that swap an article like "a" or "demo" for "a-specific" or "demo-specific" produce ungrammatical output ("a-specific MCP server"). Score LOW on actionability (the suggestion produces broken English) and consider preservation — the meaning is technically preserved but the output is unusable.
- "add_domain_qualifier" templates that prepend the author org are typically the strongest of the three — they're concrete renames with clear intent preservation. Score on their own merits; don't anchor to other templates.
- Score each row independently. Do NOT anchor adjacent rows to each other.

# OUTPUT FORMAT

Return ONLY a JSON array of 30 objects, no prose, no markdown fences, no preamble. Each object MUST have exactly these keys: case_id (string), template_kind (string), actionability (integer 1-5), preservation (integer 1-5), note (string, one sentence rationale).

Example shape (NOT real data):
[
  {"case_id":"case-01","template_kind":"add_domain_qualifier","actionability":4,"preservation":4,"note":"Concrete rename, intent preserved."},
  {"case_id":"case-01","template_kind":"narrow_scope","actionability":2,"preservation":1,"note":"Appended token unrelated to skill domain."}
]

# 30 ROWS TO SCORE

${JSON.stringify(data, null, 2)}

Return the JSON array now. No prose. No markdown fences. Just the array.
`;

process.stdout.write(prompt);

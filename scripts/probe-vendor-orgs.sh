#!/usr/bin/env bash
# SMI-4380 — Probe vendor GitHub orgs for SKILL-shaped content.
# Serialized (sleep 7s between code-search calls) to respect the 10 req/min
# code-search rate limit. Writes incrementally to the output file after each
# org so a mid-run interruption does not lose progress.
#
# Usage: ./scripts/probe-vendor-orgs.sh [output.tsv]

set -uo pipefail

OUT="${1:-docs/internal/research/vendor-org-probes.tsv}"
RESEARCH_DIR="$(dirname "$OUT")"
mkdir -p "$RESEARCH_DIR"

# Orgs grouped by category. Order: highest-likelihood first so early truncation
# still yields useful data.
ORGS=(
  # LLM / Foundation models
  openai anthropics google-gemini google-deepmind huggingface cohereai mistralai
  ai21labs togethercomputer perplexityai xai-org inflection-ai
  # AI coding tools / IDEs
  cursor-ai getcursor sourcegraph continuedev zed-industries replit
  # Agent frameworks
  langchain-ai run-llama microsoft joaomdmoura crewaiinc pydantic mastra-ai
  stanfordnlp Significant-Gravitas
  # MCP ecosystem
  modelcontextprotocol
  # Local inference
  ollama lmstudio-ai ggerganov vllm-project
  # Cloud / Infra CLIs
  aws awslabs Azure GoogleCloudPlatform vercel vercel-labs netlify
  cloudflare hashicorp digitalocean render-examples railwayapp
  # Dev platforms / SCM
  github gitlab-org atlassian slackhq discord linear notionhq figma
  # Data / DB
  mongodb postgres redis elastic cockroachdb planetscale supabase
  neondatabase prisma drizzle-team
  # APIs / SaaS SDKs
  stripe twilio resend sendgrid plaid Shopify square intercom getsentry
  DataDog newrelic honeycombio PostHog segmentio mixpanel amplitude launchdarkly
  # Runtimes / Package managers
  nodejs denoland oven-sh npm pnpm yarnpkg docker kubernetes helm astral-sh
  # Mobile
  facebook expo flutter ionic-team NativeScript
)

HEADER="org\tskill_md\tagents_md\tcursorrules\tmdc\tcopilot_instructions\tskills_dir\tclaude_skills\tnote"

# Start fresh if no file exists; otherwise resume (skip orgs already probed).
if [[ ! -f "$OUT" ]]; then
  printf '%s\n' "$HEADER" > "$OUT"
fi

probed=$(cut -f1 "$OUT" | tail -n +2)

probe_one() {
  local org="$1"
  local q_skill="filename:SKILL.md user:$org"
  local q_agents="filename:AGENTS.md user:$org"
  local q_cursorrules="filename:.cursorrules user:$org"
  local q_mdc="extension:mdc user:$org"
  local q_copilot="path:.github/copilot-instructions.md user:$org"
  local q_skills_dir="path:skills user:$org filename:SKILL.md"
  local q_claude_skills="path:.claude/skills user:$org"

  local skill_md agents_md cursorrules mdc copilot skills_dir claude_skills note
  note=""

  # Each call consumes one code-search token. Sleep 7s between calls = safely
  # under 10/min even if GitHub's rate window is tight.
  skill_md=$(gh api -X GET search/code -f "q=$q_skill" -f per_page=1 --jq '.total_count' 2>&1) || { note="err_skill:${skill_md:0:40}"; skill_md=-1; }
  sleep 7
  agents_md=$(gh api -X GET search/code -f "q=$q_agents" -f per_page=1 --jq '.total_count' 2>&1) || { note="${note} err_agents"; agents_md=-1; }
  sleep 7
  cursorrules=$(gh api -X GET search/code -f "q=$q_cursorrules" -f per_page=1 --jq '.total_count' 2>&1) || { note="${note} err_cursorrules"; cursorrules=-1; }
  sleep 7
  mdc=$(gh api -X GET search/code -f "q=$q_mdc" -f per_page=1 --jq '.total_count' 2>&1) || { note="${note} err_mdc"; mdc=-1; }
  sleep 7
  copilot=$(gh api -X GET search/code -f "q=$q_copilot" -f per_page=1 --jq '.total_count' 2>&1) || { note="${note} err_copilot"; copilot=-1; }
  sleep 7
  skills_dir=$(gh api -X GET search/code -f "q=$q_skills_dir" -f per_page=1 --jq '.total_count' 2>&1) || { note="${note} err_skills_dir"; skills_dir=-1; }
  sleep 7
  claude_skills=$(gh api -X GET search/code -f "q=$q_claude_skills" -f per_page=1 --jq '.total_count' 2>&1) || { note="${note} err_claude_skills"; claude_skills=-1; }
  sleep 7

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$org" "$skill_md" "$agents_md" "$cursorrules" "$mdc" "$copilot" "$skills_dir" "$claude_skills" "$note" \
    >> "$OUT"
}

echo "Probing ${#ORGS[@]} vendor orgs → $OUT"
echo "Rate: 7 probes/org × 7s sleep = ~49s/org; total ~$(( ${#ORGS[@]} * 49 / 60 )) min"
echo ""

count=0
for org in "${ORGS[@]}"; do
  count=$((count + 1))
  if echo "$probed" | grep -qx "$org"; then
    echo "[$count/${#ORGS[@]}] $org (already probed, skipping)"
    continue
  fi
  echo "[$count/${#ORGS[@]}] probing $org..."
  probe_one "$org"
done

echo ""
echo "Done. Results in $OUT"

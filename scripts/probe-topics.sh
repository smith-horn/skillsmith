#!/usr/bin/env bash
# SMI-4380 — Count GitHub repos per candidate topic.
# Uses /search/repositories (30 req/min budget, separate from code-search).
# Sleep 3s between calls to stay well under that ceiling.
#
# Usage: ./scripts/probe-topics.sh [output.tsv]

set -uo pipefail

OUT="${1:-docs/internal/research/topic-counts.tsv}"
mkdir -p "$(dirname "$OUT")"

TOPICS=(
  # Claude/Anthropic ecosystem (baseline — already in DEFAULT_TOPICS)
  claude-code-skill claude-code anthropic-claude claude-skill claude-skills
  claude-code-plugin claude-plugin
  # Gemini ecosystem (already in DEFAULT_TOPICS)
  gemini-skill gemini-cli-skill ai-coding-skill
  # OpenAI / Codex candidates
  openai codex chatgpt gpt gpt-4 gpt-4o openai-agents openai-api openai-sdk
  openai-skill codex-skill gpt-skill
  # Cursor / IDE candidates
  cursor cursor-rules cursorrules cursor-mdc cursor-skill cursor-plugin
  windsurf windsurf-skill
  cody cody-ai
  continue continue-dev continue-plugin
  aider aider-ai
  zed zed-industries
  # GitHub Copilot
  copilot github-copilot copilot-instructions copilot-skill
  # MCP ecosystem
  mcp mcp-server model-context-protocol mcp-client mcp-tools
  # Agent framework names used as topics
  agent ai-agent autonomous-agent llm-agent agentic-ai agentic
  langchain llamaindex autogen crewai pydantic-ai mastra dspy autogpt
  # Local inference
  ollama llamacpp llama-cpp vllm lmstudio
  # Other AI model providers
  perplexity pi pi-ai inflection-ai
  mistral-ai cohere-ai
  # Generic skill / plugin terms
  skill skills plugin plugins
  ai-skill developer-skill
  agent-skill mcp-skill
)

HEADER=$(printf 'topic\tcount\n')

if [[ ! -f "$OUT" ]]; then
  printf '%s' "$HEADER" > "$OUT"
fi

probed=$(cut -f1 "$OUT" | tail -n +2)

echo "Probing ${#TOPICS[@]} topics → $OUT"
echo ""

count=0
for topic in "${TOPICS[@]}"; do
  count=$((count + 1))
  if echo "$probed" | grep -qx "$topic"; then
    echo "[$count/${#TOPICS[@]}] $topic (already probed, skipping)"
    continue
  fi
  echo "[$count/${#TOPICS[@]}] probing topic:$topic"
  total=$(gh api -X GET search/repositories -f "q=topic:$topic" -f per_page=1 --jq '.total_count' 2>/dev/null) || total=-1
  printf '%s\t%s\n' "$topic" "$total" >> "$OUT"
  sleep 3
done

echo ""
echo "Done. Results in $OUT"

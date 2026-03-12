# Research Plan: EvoSkill Benchmark Evaluation for Skillsmith

> **Status**: Draft — pending review
> **Paper**: [EvoSkill: Automated Skill Discovery for Multi-Agent Systems](https://arxiv.org/abs/2603.02766) (Alzubi et al., March 2026)
> **Repository**: https://github.com/sentient-agi/EvoSkill

---

## 1. Executive Summary

EvoSkill introduces a self-evolving framework that **automatically discovers agent skills through iterative failure analysis**, then validates those skills against three established benchmarks (OfficeQA, SEAL-QA, BrowseComp). Their key finding: evolved skills improve exact-match accuracy by 7–12 percentage points over baseline agents, and skills transfer zero-shot across benchmarks.

Skillsmith occupies the same problem space — skill discovery and delivery for Claude Code agents — but via **registry search and semantic recommendation** rather than evolutionary generation. An apples-to-apples comparison on EvoSkill's benchmarks would answer: **does curated skill discovery (Skillsmith) match or exceed evolutionary skill discovery (EvoSkill) for downstream task accuracy?**

---

## 2. EvoSkill Methodology Summary

### 2.1 Evolutionary Loop (5 stages)

| Stage | Role |
|-------|------|
| **Base Agent** | Runs benchmark questions using current best skill configuration |
| **Proposer** | Analyzes failure patterns, proposes targeted skill enhancements |
| **Generator** | Materializes proposals as `.claude/skills/` folders or prompt rewrites |
| **Evaluator** | Scores new variants on held-out validation split |
| **Frontier** | Retains top-N performing configurations (Pareto front via git branches) |

### 2.2 Benchmarks & Results

| Benchmark | Domain | EvoSkill Baseline | EvoSkill Evolved | Delta |
|-----------|--------|-------------------|------------------|-------|
| OfficeQA | U.S. Treasury grounded reasoning | 60.6% | 67.9% | +7.3pp |
| SEAL-QA | Search-augmented QA (noisy retrieval) | 26.6% | 38.7% | +12.1pp |
| BrowseComp | Web browsing (zero-shot transfer) | — | +5.3pp | transfer |

### 2.3 Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_iterations` | 20 | Evolution loop cycles |
| `frontier_size` | 3 | Top programs retained |
| `train_ratio` / `val_ratio` | 0.18 / 0.12 | Dataset splits |
| `mode` | `skill_only` | Evolution strategy |

### 2.4 Scoring

- **OfficeQA / DABStep**: Multi-tolerance exact-match (string normalization + variations)
- **SEAL-QA**: LLM-based grading (GPT judge)
- **Custom**: `(question, predicted, ground_truth) → float [0.0, 1.0]`

### 2.5 Skill Format

EvoSkill generates skills as `.claude/skills/<skill-name>/` folders — **identical to Skillsmith's install format**. This shared convention makes the comparison structurally clean: both systems produce the same artifact type.

---

## 3. Mapping EvoSkill → Skillsmith

| EvoSkill Concept | Skillsmith Equivalent | Gap |
|------------------|-----------------------|-----|
| Skill folder (`.claude/skills/`) | Same format | None — native |
| Evolutionary discovery | `search` + `recommend` MCP tools | Discovery method differs |
| Failure-driven proposal | No analogue (reactive, not generative) | Skillsmith doesn't generate skills |
| Pareto frontier selection | Quality score + trust tier ranking | Needs scoring adapter |
| Task-specific scorer | No built-in task scorer | Must implement |
| Dataset splits (train/val) | No dataset infra | Must implement |

**Critical insight**: EvoSkill generates *new* skills on the fly. Skillsmith retrieves *existing* skills from a registry. The benchmark must measure both approaches on equal terms: given a task, which approach surfaces better skills for downstream accuracy?

---

## 4. Experimental Design

### 4.1 Research Questions

1. **RQ1**: Does Skillsmith's curated registry match EvoSkill's evolved skills on OfficeQA and SEAL-QA accuracy?
2. **RQ2**: Does Skillsmith's semantic search find task-relevant skills faster (fewer iterations) than EvoSkill's evolutionary loop?
3. **RQ3**: Do Skillsmith-discovered skills transfer zero-shot to BrowseComp as well as EvoSkill-evolved skills?
4. **RQ4**: What is the cost (API calls, tokens, wall-clock time) of each approach?

### 4.2 Conditions

| Condition | Description |
|-----------|-------------|
| **Baseline** | Claude agent with no skills (matches EvoSkill's baseline) |
| **EvoSkill-Evolved** | Agent with skills from EvoSkill's evolutionary loop (reproduce their results) |
| **Skillsmith-Search** | Agent with top-k skills from `search` tool for each benchmark domain |
| **Skillsmith-Recommend** | Agent with skills from `recommend` tool using task context |
| **Skillsmith-Curated** | Agent with hand-picked skills from registry (best-case ceiling) |
| **Hybrid** | EvoSkill evolution seeded with Skillsmith-discovered skills |

### 4.3 Dataset Handling

EvoSkill provides three datasets in `.dataset/`:

| Dataset | File | Split Strategy |
|---------|------|----------------|
| DABStep (OfficeQA proxy) | `dabstep_data.csv` | 18% train / 12% val / 70% test |
| SEAL-QA | `seal-0.csv` | 18% train / 12% val / 70% test |
| BrowseComp | External (transfer only) | Full test set |

**Use identical splits** to EvoSkill (same random seed) for train/val/test to ensure comparability. The test set is never seen during skill discovery or selection.

### 4.4 Evaluation Protocol

```
For each benchmark B in {OfficeQA, SEAL-QA}:
  1. Load dataset, apply EvoSkill's train/val/test split
  2. For each condition C:
     a. Discover/generate skills using C's method (on train split only)
     b. Select best skill set using val split accuracy
     c. Evaluate on test split → record accuracy
  3. Record: accuracy, #skills used, discovery cost, wall-clock time

For BrowseComp (transfer test):
  1. Take best skill sets from SEAL-QA (no re-discovery)
  2. Evaluate on BrowseComp test set
  3. Compare transfer accuracy across conditions
```

### 4.5 Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| **Exact-match accuracy** | Primary task metric | EvoSkill's scorer |
| **Skill count** | Number of skills in final configuration | Both systems |
| **Discovery cost** | API calls + tokens consumed during skill selection | Measured |
| **Wall-clock time** | End-to-end time for discovery + evaluation | Measured |
| **Skill overlap** | Jaccard similarity between EvoSkill and Skillsmith skill sets | Computed |
| **Transfer accuracy** | Zero-shot accuracy on BrowseComp | EvoSkill's protocol |

---

## 5. Implementation Plan

### Phase 1: Environment Setup (1–2 days)

1. Clone EvoSkill repo, install with `uv sync`
2. Download benchmark datasets to `.dataset/`
3. Reproduce EvoSkill baseline + evolved results on OfficeQA and SEAL-QA
4. Verify scorer implementations produce matching numbers
5. Document reproduction results as the ground truth

### Phase 2: Skillsmith Benchmark Harness (3–5 days)

Build `packages/core/src/benchmarks/evoskill/` with:

| File | Purpose |
|------|---------|
| `types.ts` | Shared types: `BenchmarkTask`, `BenchmarkResult`, `ScorerFn` |
| `dataset-loader.ts` | Load EvoSkill CSVs, apply train/val/test splits |
| `scorers.ts` | Port EvoSkill's multi-tolerance + LLM-based scorers to TypeScript |
| `skill-selector.ts` | Wrapper: given a task description, call Skillsmith `search`/`recommend` |
| `agent-runner.ts` | Execute benchmark tasks with a given skill set, record answers |
| `evaluator.ts` | Score answers against ground truth, aggregate metrics |
| `harness.ts` | Orchestrate: dataset → skill selection → agent execution → scoring |
| `report.ts` | Generate comparison tables (markdown + JSON) |

### Phase 3: Skill Coverage Audit (2–3 days)

Before running benchmarks, assess whether Skillsmith's registry has skills relevant to the benchmark domains:

1. For each benchmark, extract task categories and key terms
2. Run `search` and `recommend` against Skillsmith registry
3. Manually audit top-k results for relevance
4. Identify coverage gaps — domains where no relevant skill exists
5. Document: "Skillsmith has N/M coverage for benchmark B"

This phase determines whether poor results reflect discovery quality vs. registry coverage.

### Phase 4: Benchmark Execution (3–5 days)

1. Run all conditions on OfficeQA test split
2. Run all conditions on SEAL-QA test split
3. Run transfer test on BrowseComp
4. Record all metrics per condition
5. Run 3 seeds per condition for statistical significance

### Phase 5: Analysis & Write-up (2–3 days)

1. Build comparison tables matching EvoSkill's paper format
2. Statistical significance tests (paired bootstrap or McNemar's)
3. Cost-effectiveness analysis (accuracy per dollar)
4. Qualitative analysis: what skills did each system choose and why?
5. Identify actionable improvements for Skillsmith's recommendation pipeline

---

## 6. Technical Integration Points

### 6.1 Skillsmith APIs to Exercise

| API | Usage in Benchmark |
|-----|-------------------|
| `search(query, category, trust_tier)` | Find task-relevant skills by benchmark domain keywords |
| `recommend(installed_skills, project_context)` | Context-aware recommendations using benchmark task descriptions |
| `install_skill(id)` | Install discovered skills to `.claude/skills/` |
| `validate(skill_path)` | Verify installed skill structure before benchmark run |
| `EmbeddingService.embed()` | Semantic similarity for skill-task matching quality |

### 6.2 Scoring Adapter

EvoSkill's scorers expect `(question, predicted, ground_truth) → float`. Implement a TypeScript adapter:

```typescript
interface EvoSkillScorer {
  (question: string, predicted: string, groundTruth: string): Promise<number>
}

// Multi-tolerance scorer (OfficeQA/DABStep)
function defaultScorer(q: string, predicted: string, truth: string): Promise<number>

// LLM-based scorer (SEAL-QA) — calls Claude API as judge
function sealqaScorer(q: string, predicted: string, truth: string): Promise<number>
```

### 6.3 Agent Execution

Use Claude's tool-use API to run benchmark tasks. The agent receives:
- System prompt (baseline or with skill instructions)
- Skills from `.claude/skills/` (Skillsmith-installed or EvoSkill-evolved)
- Benchmark question as user message
- Task-specific tools (web search for SEAL-QA, file access for OfficeQA)

---

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Registry coverage gap | Skillsmith has no skills for benchmark domains → unfair comparison | Phase 3 audit; publish registry skills for benchmark domains before Phase 4 |
| Scorer divergence | TypeScript port doesn't match Python scorer → incomparable results | Cross-validate: run 100 samples through both implementations, require ≤1% divergence |
| Cost explosion | LLM-based scoring on full test sets | Budget cap per condition; sample 20% for preliminary runs |
| Model version drift | EvoSkill used specific Claude model version | Pin model version in harness config; document exact model IDs |
| Non-determinism | LLM outputs vary across runs | 3 seeds minimum; report mean ± std |

---

## 8. Success Criteria

| Criterion | Threshold |
|-----------|-----------|
| Reproduce EvoSkill baseline | Within 2pp of reported 60.6% (OfficeQA) and 26.6% (SEAL-QA) |
| Skillsmith competitive | Within 5pp of EvoSkill-evolved accuracy on at least one benchmark |
| Cost advantage | Skillsmith discovery cost < 50% of EvoSkill's evolutionary loop cost |
| Transfer parity | Skillsmith zero-shot transfer within 3pp of EvoSkill on BrowseComp |

---

## 9. Deliverables

1. **Benchmark harness** in `packages/core/src/benchmarks/evoskill/` — reusable for future benchmark papers
2. **Comparison report** with tables matching EvoSkill's paper format
3. **Coverage audit** documenting registry gaps for benchmark domains
4. **Actionable recommendations** for Skillsmith's recommendation algorithm based on findings
5. **Blog post draft** for skillsmith.app summarizing results (if positive)

---

## 10. Open Questions for Review

1. **Registry seeding**: Should we add benchmark-domain skills to the registry before running, or test against the registry as-is? (Tests coverage vs. discovery quality)
2. **Hybrid condition**: Is the EvoSkill-seeded-with-Skillsmith condition worth the compute cost, or should we defer it?
3. **Model choice**: EvoSkill's repo supports Opus and Sonnet. Should we benchmark both, or pick one to control cost?
4. **Publication**: If results are favorable, do we want to publish a companion paper or keep this internal?

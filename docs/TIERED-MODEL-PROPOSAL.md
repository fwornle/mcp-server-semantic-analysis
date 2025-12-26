# Tiered Model Selection Proposal

## Problem Statement

The knowledge base contains low-quality entries because **all 14 agents use the same cheap LLM** (`llama-3.3-70b-versatile` via Groq) regardless of task complexity.

Tasks requiring deep semantic understanding (insight generation, pattern recognition, quality assessment) receive the same treatment as simple extraction tasks.

## Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     SemanticAnalyzer                        │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ Git History │    │ Insights    │    │ Quality     │     │
│  │ Agent       │    │ Agent       │    │ Assurance   │     │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘     │
│         │                  │                  │            │
│         └──────────────────┼──────────────────┘            │
│                            │                               │
│                   ┌────────▼────────┐                      │
│                   │ Groq: llama-3.3 │  ← Same model        │
│                   │  70b-versatile  │    for everything    │
│                   └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     SemanticAnalyzer                        │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ Git History │    │ Insights    │    │ Quality     │     │
│  │ (standard)  │    │ (premium)   │    │ (premium)   │     │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘     │
│         │                  │                  │            │
│         ▼                  ▼                  ▼            │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ Groq llama  │    │ Claude 3.5  │    │ Claude 3.5  │     │
│  │ 70b         │    │ Sonnet      │    │ Sonnet      │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Changes

### 1. Model Tier Configuration (`config/model-tiers.yaml`)

Created - defines task-to-tier mappings and provider preferences.

### 2. SemanticAnalyzer Enhancement

```typescript
// src/agents/semantic-analyzer.ts

interface AnalysisOptions {
  provider?: "groq" | "anthropic" | "openai" | "auto";
  tier?: "fast" | "standard" | "premium";  // NEW
  taskType?: string;  // NEW - for automatic tier selection
}

async analyze(prompt: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
  // Determine tier from taskType or explicit setting
  const tier = options.tier || this.getTierForTask(options.taskType) || 'standard';

  // Select provider/model based on tier
  const { provider, model } = this.selectModelForTier(tier);

  return this.executeWithModel(prompt, provider, model);
}
```

### 3. Agent Updates

Each agent specifies its task type when calling SemanticAnalyzer:

```typescript
// insight-generation-agent.ts
const result = await this.analyzer.analyze(prompt, {
  taskType: 'insight_generation',  // → automatically selects premium tier
});

// git-history-agent.ts
const result = await this.analyzer.analyze(prompt, {
  taskType: 'git_history_analysis',  // → uses standard tier
});
```

### 4. Coordinator Support

The coordinator already has `preferredModel` in step config:

```typescript
// coordinator.ts line 37
preferredModel?: 'groq' | 'anthropic' | 'openai' | 'gemini' | 'auto';
```

Extend to support tiers:

```typescript
preferredModel?: 'groq' | 'anthropic' | 'openai' | 'gemini' | 'auto';
modelTier?: 'fast' | 'standard' | 'premium';
```

## Cost Impact Analysis

| Mode | Avg Cost/Run | Quality | Use Case |
|------|--------------|---------|----------|
| Budget (all fast) | ~$0.02 | Low | Testing, development |
| Current (all standard) | ~$0.10 | Medium | Normal operation |
| Tiered (mixed) | ~$0.30 | High | Production |
| Quality (all premium) | ~$1.50 | Highest | Important analyses |

## Recommended Premium Tasks

These tasks benefit most from better models:

1. **Insight Generation** - Needs to synthesize patterns, understand architectural significance
2. **Observation Generation** - Quality observations require understanding context
3. **Quality Assurance** - Judging semantic value is subjective and nuanced
4. **Pattern Recognition** - Detecting MVC, Factory, Observer patterns accurately

## Quick Win: Environment Variable Override

Without code changes, add to `.env`:

```bash
# Force premium model for specific agents
INSIGHT_GENERATION_PROVIDER=anthropic
QUALITY_ASSURANCE_PROVIDER=anthropic
OBSERVATION_GENERATION_PROVIDER=anthropic
```

Then update SemanticAnalyzer to check these env vars.

## Migration Path

1. **Phase 1**: Add `model-tiers.yaml` config (done)
2. **Phase 2**: Update SemanticAnalyzer to read tier config
3. **Phase 3**: Add `taskType` parameter to agent calls
4. **Phase 4**: Update workflows to specify tiers for critical steps
5. **Phase 5**: Add cost tracking and budget enforcement

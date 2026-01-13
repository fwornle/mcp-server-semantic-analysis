# UKB System Improvement Plan

## Executive Summary

The UKB (Update Knowledge Base) system currently suffers from **93% data loss** during the pipeline (370 concepts → 10 observations → 27 final entities). This plan outlines a comprehensive restructuring to:

1. **Eliminate artificial data limits** that cause massive information loss
2. **Add comprehensive tracing** showing ALL content flowing through each step
3. **Define typed interfaces** for every agent's input/output
4. **Restore LLM-based analysis** throughout the pipeline
5. **Fix the observation generation** to preserve semantic richness

---

## Problem Analysis

### Root Cause: Data Loss in `observation-generation-agent.ts`

| Location | Issue | Data Lost |
|----------|-------|-----------|
| Line 724 | `entities.slice(0, 20)` | 95% of semantic entities |
| Line 274 | `codeEvolution.slice(0, 5)` | Most code evolution patterns |
| Line 436 | `problemSolutionPairs.slice(0, 10)` | Most problem-solution pairs |
| Line 457 | `sessions.slice(0, 15)` | Most vibe sessions |
| Line 484 | Sessions without `metadata.summary` skipped | Sessions without LLM summaries |
| Line 1277 | `correlatePatternsAcrossSources` returns null | All cross-source correlations |

### Secondary Issues

1. **Trace reports only show samples** - First 3 batches, not all content
2. **Agents use `any` types** - No type safety or traceability
3. **LLM synthesis fails silently** - Falls back to regex without logging
4. **Validation rejects too aggressively** - `isValidInsightInput()` filters out valid data

---

## Phase 1: Fix Data Loss (Priority: Critical)

### 1.1 Remove Artificial Slice Limits

**File:** `observation-generation-agent.ts`

```typescript
// BEFORE (line 724):
semanticAnalysis.entities.slice(0, 20).map((entity: any) => ...)

// AFTER:
semanticAnalysis.entities.map((entity: any) => ...)
```

Apply the same fix to:
- `generateFromGitAnalysis`: Remove `.slice(0, 5)` on codeEvolution
- `generateFromVibeAnalysis`: Remove `.slice(0, 10)` on problemSolutionPairs
- `generateFromVibeAnalysis`: Remove `.slice(0, 15)` on sessions

**Rationale:** If there's too much data, let the deduplication/aggregation operators handle it - don't lose data before analysis.

### 1.2 Restore Cross-Source Correlation

**File:** `observation-generation-agent.ts`

The `correlatePatternsAcrossSources` method (line 1254-1358) is disabled. Options:

**Option A (Recommended):** Use LLM to synthesize meaningful correlations
```typescript
private async correlatePatternsAcrossSources(
  gitPatterns: any[],
  vibeThemes: any[]
): Promise<StructuredObservation | null> {
  if (!gitPatterns.length || !vibeThemes.length) return null;

  const prompt = `Analyze correlations between git activity and conversation themes:
Git Patterns: ${JSON.stringify(gitPatterns.slice(0, 10))}
Vibe Themes: ${JSON.stringify(vibeThemes.slice(0, 10))}
Return meaningful correlations as JSON.`;

  const result = await this.semanticAnalyzer.analyzeContent(prompt, {
    analysisType: 'patterns',
    provider: 'auto'
  });
  // Parse and create observation from LLM synthesis
}
```

**Option B:** Remove the method entirely if cross-source correlation isn't valuable.

### 1.3 Fix Session Summary Handling

**File:** `observation-generation-agent.ts`

Sessions are skipped if they lack `metadata.summary`. Instead of skipping:

```typescript
// BEFORE (line 484):
if (!summary || typeof summary !== 'string' || summary.trim().length < 10) {
  return null; // SKIPS SESSION
}

// AFTER:
if (!summary || typeof summary !== 'string' || summary.trim().length < 10) {
  // Synthesize summary from session content
  const synthesized = await this.synthesizeSessionSummary(session);
  if (!synthesized) return null;
  session.metadata = { ...session.metadata, summary: synthesized };
}
```

---

## Phase 2: Comprehensive Tracing

### 2.1 Define Trace Data Structures

**New File:** `src/types/trace-types.ts`

```typescript
export interface StepTraceData {
  stepName: string;
  batchId: string;
  timestamp: string;

  // Input: What went INTO this step
  input: {
    count: number;           // Number of items
    itemNames: string[];     // ALL item names (not samples)
    itemTypes: Record<string, number>; // Type distribution
    sampleContent?: string[]; // First 3 items' content for debugging
  };

  // Output: What came OUT of this step
  output: {
    count: number;
    itemNames: string[];
    itemTypes: Record<string, number>;
    sampleContent?: string[];
  };

  // Transformation metrics
  transformation: {
    itemsAdded: number;
    itemsRemoved: number;
    itemsModified: number;
    dataLossPercent: number;
  };

  // LLM usage
  llm?: {
    used: boolean;
    provider: string;
    model: string;
    calls: number;
    tokens: number;
    fallbackToRegex: boolean;
  };
}

export interface BatchTraceData {
  batchId: string;
  batchNumber: number;
  steps: StepTraceData[];

  // ALL commit messages (truncated to 80 chars)
  commits: Array<{
    hash: string;
    message: string; // Truncated to 80 chars
    date: string;
  }>;

  // ALL session summaries
  sessions: Array<{
    id: string;
    summary: string;
    timestamp: string;
  }>;

  // ALL concepts extracted (names only)
  concepts: string[];

  // ALL observations generated (names only)
  observations: string[];

  // ALL entities after classification (with types)
  entities: Array<{
    name: string;
    type: string;
  }>;
}
```

### 2.2 Enhance Trace Report Generator

**File:** `ukb-trace-report.ts`

Modify `generateMarkdownReport()` to show ALL content:

```typescript
generateMarkdownReport(report: UKBTraceReport): string {
  let md = `# UKB Trace Report\n\n`;
  md += `## Summary\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Total Batches | ${report.batches.length} |\n`;
  // ... existing summary

  md += `\n## Data Flow Across All Batches\n\n`;

  // CRITICAL: Show ALL commits, not just samples
  md += `### All Commit Messages\n\n`;
  md += `| Batch | Hash | Message (80 chars) |\n`;
  md += `|-------|------|-------------------|\n`;
  for (const batch of report.batches) {
    for (const commit of batch.commits || []) {
      const truncated = commit.message.substring(0, 80);
      md += `| ${batch.batchNumber} | ${commit.hash.substring(0,7)} | ${truncated} |\n`;
    }
  }

  // CRITICAL: Show ALL concepts extracted
  md += `\n### All Concepts Extracted\n\n`;
  md += `| Batch | Step | Concept Name | Type |\n`;
  md += `|-------|------|--------------|------|\n`;
  for (const batch of report.batches) {
    for (const step of batch.steps) {
      if (step.output?.itemNames) {
        for (const name of step.output.itemNames) {
          const type = step.output.itemTypes?.[name] || 'unknown';
          md += `| ${batch.batchNumber} | ${step.stepName} | ${name} | ${type} |\n`;
        }
      }
    }
  }

  // Data Loss Analysis
  md += `\n## Data Loss Analysis\n\n`;
  md += `| Step | Input | Output | Loss % |\n`;
  md += `|------|-------|--------|--------|\n`;
  // Aggregate across all batches

  return md;
}
```

---

## Phase 3: Typed Agent Interfaces

### 3.1 Define Common Types

**New File:** `src/types/agent-interfaces.ts`

```typescript
// Git History Agent
export interface GitHistoryInput {
  repositoryPath: string;
  startCommit?: string;
  endCommit?: string;
  dateRange?: { start: Date; end: Date };
}

export interface GitHistoryOutput {
  commits: Array<{
    hash: string;
    message: string;
    author: string;
    date: Date;
    files: string[];
    stats: { additions: number; deletions: number };
  }>;
  architecturalDecisions: Array<{
    type: string;
    description: string;
    files: string[];
    impact: 'high' | 'medium' | 'low';
  }>;
  codeEvolution: Array<{
    pattern: string;
    frequency: number;
    files: string[];
    trend: 'increasing' | 'decreasing' | 'stable';
  }>;
}

// Semantic Analysis Agent
export interface SemanticAnalysisInput {
  gitAnalysis: GitHistoryOutput;
  vibeAnalysis: VibeHistoryOutput;
  analysisDepth: 'surface' | 'deep';
}

export interface SemanticAnalysisOutput {
  entities: Array<{
    name: string;
    type: string;
    observations: string[];
    significance: number;
    confidence: number;
  }>;
  relations: Array<{
    from: string;
    to: string;
    type: string;
    weight: number;
  }>;
  llmUsage: {
    provider: string;
    model: string;
    calls: number;
    tokens: number;
  };
}

// Observation Generation Agent
export interface ObservationGenerationInput {
  gitAnalysis: GitHistoryOutput;
  vibeAnalysis: VibeHistoryOutput;
  semanticAnalysis: SemanticAnalysisOutput;
}

export interface ObservationGenerationOutput {
  observations: StructuredObservation[];
  summary: {
    totalGenerated: number;
    byType: Record<string, number>;
    averageSignificance: number;
  };
  transformationTrace: {
    inputEntities: number;
    outputObservations: number;
    filtered: Array<{ name: string; reason: string }>;
  };
}

// Ontology Classification Agent
export interface OntologyClassificationInput {
  observations: StructuredObservation[];
  autoExtend: boolean;
  minConfidence: number;
}

export interface OntologyClassificationOutput {
  classified: Array<{
    original: StructuredObservation;
    ontologyClass: string;
    confidence: number;
    method: 'llm' | 'keyword' | 'similarity';
  }>;
  unclassified: StructuredObservation[];
  extensionSuggestions?: Array<{
    proposedClass: string;
    reason: string;
    examples: string[];
  }>;
}
```

### 3.2 Update Agents to Use Typed Interfaces

For each agent, update the method signatures:

```typescript
// observation-generation-agent.ts
export class ObservationGenerationAgent {
  async generateStructuredObservations(
    input: ObservationGenerationInput
  ): Promise<ObservationGenerationOutput> {
    // ... implementation with tracing
  }
}
```

---

## Phase 4: LLM-First Analysis

### 4.1 Add LLM Fallback Tracking

Every method that can use LLM should track whether it used LLM or regex fallback:

```typescript
interface AnalysisResult<T> {
  data: T;
  source: 'llm' | 'regex' | 'template';
  llmMetrics?: {
    provider: string;
    model: string;
    tokens: number;
    latency: number;
  };
  fallbackReason?: string;
}
```

### 4.2 Enhance Semantic Analysis Agent

Ensure LLM is used for:
1. **Commit analysis** - Extract patterns from commit messages using LLM
2. **Session summarization** - Generate summaries for sessions without them
3. **Cross-reference detection** - Find connections between git and vibe data
4. **Pattern synthesis** - Combine low-level patterns into higher-order insights

```typescript
// semantic-analysis-agent.ts
async analyzeGitAndVibeData(
  gitAnalysis: GitHistoryOutput,
  vibeAnalysis: VibeHistoryOutput,
  options: { analysisDepth: 'surface' | 'deep' }
): Promise<SemanticAnalysisOutput> {

  const prompt = `Analyze this development activity and extract knowledge entities:

## Git Activity (${gitAnalysis.commits.length} commits)
${gitAnalysis.commits.slice(0, 50).map(c =>
  `- ${c.hash.substring(0,7)}: ${c.message}`
).join('\n')}

## Conversation Sessions (${vibeAnalysis.sessions.length} sessions)
${vibeAnalysis.sessions.slice(0, 20).map(s =>
  `- ${s.summary || 'No summary'}`
).join('\n')}

Extract:
1. Architectural patterns (how the system is structured)
2. Development workflows (how work gets done)
3. Technical decisions (choices made and why)
4. Key learnings (insights for future development)

Return as JSON with entities and relations.`;

  const result = await this.callLLM(prompt);
  // Parse and return structured output
}
```

---

## Phase 5: Enhanced Trace Report Output

### 5.1 Full Content Trace File

Generate a detailed trace file showing ALL data:

**File:** `.data/ukb-trace-reports/latest-trace-full.md`

```markdown
# UKB Full Trace Report

Generated: 2026-01-13T...
Workflow: batch-analysis
Status: completed

## All Commits Analyzed (913 total)

| # | Batch | Hash | Date | Message |
|---|-------|------|------|---------|
| 1 | 1 | abc1234 | 2025-12-01 | Initial commit: Knowledge management scripts organized... |
| 2 | 1 | def5678 | 2025-12-01 | Add semantic analysis agent with LLM integration... |
...
| 913 | 25 | xyz9999 | 2026-01-10 | Fix tracer output enhancement... |

## All Concepts Extracted (370 total)

| # | Batch | Concept Name | Type | Source Step |
|---|-------|--------------|------|-------------|
| 1 | 1 | ApiHandlesExternalCommunication | Unclassified | semantic_analysis |
| 2 | 1 | DecoratorAddsBehaviorToObjects | Unclassified | semantic_analysis |
...

## All Observations Generated (10 total)

| # | Observation Name | Source Concepts | Significance |
|---|-----------------|-----------------|--------------|
| 1 | ArchitecturalApiPattern | ApiHandlesExternal... | 8 |
...

## Data Flow Summary

| Step | Input Count | Output Count | Loss % | LLM Used |
|------|-------------|--------------|--------|----------|
| git_history | 913 commits | 913 commits | 0% | No |
| vibe_history | 1015 sessions | 1015 sessions | 0% | No |
| semantic_analysis | 1928 items | 370 concepts | 81% | Yes (groq) |
| observation_gen | 370 concepts | 10 observations | 97% | Yes (groq) |
| ontology_class | 10 observations | 27 entities | N/A | Yes (groq) |

## Data Loss Investigation

### Semantic Analysis → Observation Generation (97% loss)

**Cause:** `observation-generation-agent.ts` line 724:
```typescript
semanticAnalysis.entities.slice(0, 20)
```

This artificially limits input to 20 entities, regardless of how many were extracted.

**Fix:** Remove the slice limit.

### Additional Filters Applied:
- `isValidInsightInput()` rejected X items
- `generateCleanEntityName()` returned null for Y items
- Sessions without `metadata.summary` skipped: Z items
```

---

## Implementation Priority

### Week 1: Critical Data Loss Fixes
1. Remove slice limits in observation-generation-agent.ts
2. Add logging for filtered/skipped items
3. Generate full content trace report

### Week 2: Typed Interfaces
1. Create type definitions for all agent inputs/outputs
2. Update agents to use typed interfaces
3. Add runtime validation

### Week 3: Enhanced Tracing
1. Implement StepTraceData collection
2. Update UKBTraceReportManager with full content export
3. Add data loss analysis to reports

### Week 4: LLM Enhancement
1. Ensure LLM is primary analysis method (not regex)
2. Add LLM fallback tracking
3. Implement session summary synthesis for sessions without summaries

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Data retention (concepts → entities) | 7% | >50% |
| Trace visibility | Samples only | Full content |
| Type coverage | ~20% (any types) | 100% |
| LLM usage tracking | Partial | Complete |

---

## Files to Modify

1. `src/agents/observation-generation-agent.ts` - Remove slice limits, fix validation
2. `src/utils/ukb-trace-report.ts` - Full content trace reports
3. `src/types/agent-interfaces.ts` (new) - Typed interfaces
4. `src/types/trace-types.ts` (new) - Trace data structures
5. `src/agents/semantic-analysis-agent.ts` - LLM-first analysis
6. `src/agents/coordinator.ts` - Enhanced trace collection

---

## Notes

- The current system design is sound (multi-agent pipeline with batching)
- The problem is implementation details (artificial limits, silent failures)
- The trace infrastructure exists but doesn't capture enough detail
- LLM integration is present but regex fallbacks are too aggressive

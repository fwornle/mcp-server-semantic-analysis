/**
 * Phase 52 D-07 — Single source of truth for per-sub-step process tags.
 *
 * Why this exists: before Phase 52 every wave-analysis LLM call landed in
 * `.data/llm-proxy/token-usage.db` tagged with one of three wave-level strings
 * (`wave-analysis-wave1` / `wave-analysis-wave2` / `wave-analysis-wave3`) or
 * `'unknown'` (wave-4 + the ontology-classify path). That granularity is too
 * coarse for operator-level routing — the settings UI needs to pin a
 * provider/model per *sub-step*, not per wave. The 'unknown' bucket is worse:
 * the operator cannot pin a tag that has no name.
 *
 * This module exports a frozen `as const` registry of canonical per-sub-step
 * process tags. The registry is consumed in four places:
 *   1. Wave-1/2/3 agents (`wave{1,2,3}-*-agent.ts`) — passed as the
 *      per-call `process` override on the `llmWithProcess.complete({...})` body.
 *   2. SemanticAnalyzer (`semantic-analyzer.ts`) — threaded through
 *      `AnalysisOptions.process` and routed through `llmWithProcessComplete`
 *      when set (D-09 strangler swap).
 *   3. InsightGenerationAgent + OntologyClassificationAgent — the consumers
 *      of `semanticAnalyzer.analyzeContent(prompt, { process: ... })`.
 *   4. Dashboard settings UI (Plan 52-02) — auto-lists the registry entries
 *      as the operator-facing pinning surface (D-11).
 *
 * Routing contract: the rapid-llm-proxy reads `body.process` and writes it
 * verbatim into `token_usage.db.process`. See
 * `_work/rapid-llm-proxy/proxy-bridge/server.mjs:1470-1510` for the stage-0
 * process-pin lookup that consults `processOverrides[process]` from
 * `_work/rapid-llm-proxy/.data/llm-proxy/llm-settings.json` and the stage-3
 * preference-order fallback for unmapped tags.
 *
 * Design decisions:
 *   - Frozen `as const` mapping ensures consumers get string-literal
 *     narrowing (compile-time type safety — dashboard can't badge a row
 *     with a tag that doesn't exist in code).
 *   - Zero runtime imports / type-only or none — keeps the registry as a
 *     leaf module with no dependency churn.
 *   - No `console.*` — observability tags are not log-producing primitives.
 *   - String shape mirrors the existing `wave-analysis-*` prefix so the
 *     proxy's `--reset` filter in `scripts/configure-wave-analysis-routing.sh`
 *     (matches `wave-analysis-*` prefix) continues to govern the new entries.
 *
 * @remarks
 * `WAVE3_RELATION_DISCOVERY` is intentionally OMITTED from this registry.
 * Inventory of `integrations/mcp-server-semantic-analysis/src/agents/kg-operators.ts`
 * (lines 562-648, the `edgePrediction()` method that is the only "relation
 * discovery" path in the codebase) confirms that relation prediction is a
 * pure score-based computation (cosine similarity + Adamic-Adar +
 * Common-Ancestors) — there is no LLM call to tag. Adding a
 * `WAVE3_RELATION_DISCOVERY` constant would create a dead registry entry
 * (no call site would ever set it). If a future phase introduces LLM-driven
 * relation discovery, that phase is responsible for re-adding the constant
 * as part of its scope.
 *
 * @module agents/process-tags
 */

/**
 * Frozen registry of per-sub-step process tags. Single source of truth for
 * `body.process` strings sent to the rapid-llm-proxy `/api/complete` endpoint
 * by all wave-analysis LLM call sites.
 *
 * Total keys: 9. See module @remarks for why `WAVE3_RELATION_DISCOVERY` is
 * intentionally absent.
 */
export const PROCESS_TAGS = {
  /** Wave-1 L0 Project + L1 Component emit path
   *  (`wave1-project-agent.ts` enrich + analyzeComponent + observation-retry). */
  WAVE1_L1_EMIT:                'wave-analysis-wave1-l1emit',

  /** Wave-2 L2 SubComponent expansion + observation-retry
   *  (`wave2-component-agent.ts`). */
  WAVE2_SUBCOMPONENT:           'wave-analysis-wave2-subcomponent',

  /** Wave-3 L3 Detail discovery + observation-retry
   *  (`wave3-detail-agent.ts`). */
  WAVE3_DETAIL_EXTRACT:         'wave-analysis-wave3-detail-extract',

  /** Wave-3 ontology classification — the single LLM call inside the
   *  `OntologyClassificationAgent.generateCompletion` lambda
   *  (`ontology-classification-agent.ts:227`). */
  WAVE3_ONTOLOGY_CLASSIFY:      'wave-analysis-wave3-ontology-classify',

  /** Wave-4 deep-insight document generation
   *  (`insight-generation-agent.ts:632`). */
  WAVE4_INSIGHT:                'wave-analysis-wave4-insight',

  /** Wave-4 PlantUML diagram generation
   *  (`insight-generation-agent.ts:2505`). */
  WAVE4_DIAGRAM:                'wave-analysis-wave4-diagram',

  /** Wave-4 PlantUML repair retry (separate from primary diagram path
   *  because of distinct latency profile).
   *  (`insight-generation-agent.ts:2761`). */
  WAVE4_DIAGRAM_REPAIR:         'wave-analysis-wave4-diagram-repair',

  /** Wave-4 pattern extraction from git commit history + retry
   *  (`insight-generation-agent.ts:4333` + `:5449`). */
  WAVE4_PATTERN_EXTRACT:        'wave-analysis-wave4-pattern-extract',

  /** Wave-4 documentation generation
   *  (`insight-generation-agent.ts:5110`). */
  WAVE4_DOCS:                   'wave-analysis-wave4-docs',
} as const;

/** Union type of all valid process tag string values. Lets consumers
 *  type-narrow to "anything declared in PROCESS_TAGS" without enumerating
 *  individual keys. */
export type ProcessTag = typeof PROCESS_TAGS[keyof typeof PROCESS_TAGS];

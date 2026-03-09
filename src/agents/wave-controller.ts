/**
 * WaveController - Hierarchical Wave Orchestration Engine
 *
 * Replaces the flat batch-analysis DAG with sequential wave execution:
 *   Wave 1: L0 Project + L1 Component entities (manifest-driven)
 *   Wave 2: L2 SubComponent entities (manifest seeded + code discovery)
 *   Wave 3: L3 Detail entities (pure code discovery)
 *
 * Each wave produces parent nodes before the next wave spawns child-level agents.
 * Entities are persisted after each wave (crash-resilient).
 * Agents within a wave run in parallel, bounded by maxAgentsPerWave.
 *
 * @module agents/wave-controller
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { loadComponentManifest, flattenManifestEntries, writeManifestDiscoveries } from '../types/component-manifest.js';
import type { DiscoveredManifestEntry } from '../types/component-manifest.js';
import { GraphDatabaseAdapter } from '../storage/graph-database-adapter.js';
import { Wave1ProjectAgent } from './wave1-project-agent.js';
import { PersistenceAgent } from './persistence-agent.js';
import { InsightGenerationAgent } from './insight-generation-agent.js';
import { OntologyClassificationAgent } from './ontology-classification-agent.js';
import type { CrossReferenceContext } from './insight-generation-agent.js';
import type { GraphEntity } from '../storage/graph-database-adapter.js';
import type { SharedMemoryEntity, EntityRelationship } from './persistence-agent.js';
import { createKGOperators } from './kg-operators.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { WorkflowReportAgent } from './workflow-report-agent.js';
import type { KGEntity, KGRelation, BatchContext } from './kg-operators.js';
import type { ComponentManifest } from '../types/component-manifest.js';
import type {
  WaveControllerConfig,
  WaveResult,
  WaveExecutionResult,
  WaveAgentOutput,
  ChildManifestEntry,
  Wave2Input,
  Wave3Input,
} from '../types/wave-types.js';

// ============================================================================
// WaveController
// ============================================================================

export class WaveController {
  private repositoryPath: string;
  private team: string;
  private progressFile: string;
  private maxAgentsPerWave: number;
  private failFast: boolean;
  private graphDB: GraphDatabaseAdapter;
  private reportAgent: WorkflowReportAgent;
  /** Per-step LLM metrics and outputs accumulated during execution */
  private stepMetrics: Map<string, {
    tokensUsed?: number;
    llmCalls?: number;
    llmProvider?: string;
    outputs?: Record<string, unknown>;
  }> = new Map();

  constructor(config: WaveControllerConfig) {
    this.repositoryPath = config.repositoryPath;
    this.team = config.team;
    this.progressFile = config.progressFile;
    this.maxAgentsPerWave = config.maxAgentsPerWave ?? 4;
    this.failFast = config.failFast ?? true;

    // Derive the knowledge-graph DB path from the repository
    const dbPath = path.join(this.repositoryPath, '.data', 'knowledge-graph');
    this.graphDB = new GraphDatabaseAdapter(dbPath, this.team);
    this.reportAgent = new WorkflowReportAgent(this.repositoryPath);
  }

  /** Capture LLM metrics from SemanticAnalyzer for a step and store outputs */
  private captureStepMetrics(stepName: string, outputs?: Record<string, unknown>): void {
    const metrics = SemanticAnalyzer.getStepMetrics();
    SemanticAnalyzer.resetStepMetrics();
    this.stepMetrics.set(stepName, {
      tokensUsed: metrics.totalTokens || undefined,
      llmCalls: metrics.totalCalls || undefined,
      llmProvider: metrics.providers?.join(', ') || undefined,
      outputs,
    });
  }

  /** Capture LLM metrics directly from a wave agent's getLLMMetrics() */
  private captureAgentMetrics(stepName: string, agentMetrics: { providers: string[]; totalTokens: number; totalCalls: number }, outputs?: Record<string, unknown>): void {
    this.stepMetrics.set(stepName, {
      tokensUsed: agentMetrics.totalTokens || undefined,
      llmCalls: agentMetrics.totalCalls || undefined,
      llmProvider: agentMetrics.providers.join(', ') || undefined,
      outputs,
    });
  }

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  async execute(): Promise<WaveExecutionResult> {
    const startTime = Date.now();
    const waveResults: WaveResult[] = [];

    try {
      // Initialize graph database
      await this.graphDB.initialize();
      log('[WaveController] GraphDatabaseAdapter initialized', 'info');

      // Load component manifest
      const manifest = loadComponentManifest();
      const flatEntries = flattenManifestEntries(manifest);
      log('[WaveController] Component manifest loaded', 'info', {
        components: manifest.components.length,
        totalEntries: flatEntries.length,
      });

      // Load existing KG entities for context enrichment
      const existingEntities = await this.loadExistingEntities();
      log('[WaveController] Existing entities loaded', 'info', {
        count: existingEntities.length,
      });

      // Start workflow report for history
      const executionId = `wave-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      this.reportAgent.startWorkflowReport('wave-analysis', executionId, { team: this.team });

      // ---- Wave 1: L0 Project + L1 Components ----
      this.logWaveBanner('WAVE 1', 'L0 Project + L1 Components');
      this.updateProgress({ currentWave: 1, totalWaves: 4, subPhase: 'init', message: 'Wave 1: Loading manifest & planning' });
      this.captureStepMetrics('wave1_init', { manifestEntries: flatEntries.length, existingEntities: existingEntities.length });

      SemanticAnalyzer.resetStepMetrics();
      this.updateProgress({ currentWave: 1, totalWaves: 4, subPhase: 'analyze', message: 'Wave 1: Analyzing Project & Components' });
      const { result: wave1Result, agent: wave1Agent } = await this.executeWave1WithMetrics(manifest, existingEntities);
      waveResults.push(wave1Result);
      if (wave1Agent) {
        this.captureAgentMetrics('wave1_analyze', wave1Agent.getLLMMetrics(), { totalEntities: wave1Result.totalEntities, discoveredEntities: wave1Result.discoveredEntities });
      } else {
        this.captureStepMetrics('wave1_analyze', { totalEntities: wave1Result.totalEntities, discoveredEntities: wave1Result.discoveredEntities });
      }

      if (!wave1Result.success) {
        log('[WaveController] Wave 1 failed', 'error', { error: wave1Result.error });
        if (this.failFast) {
          return this.buildSummaryReport(startTime, waveResults);
        }
      } else {
        const wave1Entities = wave1Result.agentOutputs.flatMap(o => o.entities);
        SemanticAnalyzer.resetStepMetrics();
        this.updateProgress({ currentWave: 1, totalWaves: 4, subPhase: 'classify', message: 'Wave 1: Classifying entities' });
        await new Promise(r => setTimeout(r, 100));
        const wave1ClassifyTasks = wave1Entities.map(entity => async () => {
          await this.classifyEntity(entity);
        });
        await this.runWithConcurrency(wave1ClassifyTasks, 2);
        this.captureStepMetrics('wave1_classify', { entitiesClassified: wave1Entities.length });
        log('[WaveController] Wave 1 classification complete', 'info', { entities: wave1Entities.length });
        this.updateProgress({ currentWave: 1, totalWaves: 4, subPhase: 'persist', message: 'Wave 1: Persisting entities' });
        await new Promise(r => setTimeout(r, 100));
        await this.persistWaveResult(wave1Result);
        this.captureStepMetrics('wave1_persist', { entitiesPersisted: wave1Result.totalEntities });
        log('[WaveController] Wave 1 entities persisted', 'info', {
          entities: wave1Result.totalEntities,
        });
      }

      // ---- Wave 2: L2 SubComponents ----
      this.logWaveBanner('WAVE 2', 'L2 SubComponents');
      SemanticAnalyzer.resetStepMetrics();
      this.updateProgress({ currentWave: 2, totalWaves: 4, subPhase: 'analyze', message: 'Wave 2: Analyzing SubComponents' });

      const { result: wave2Result, agents: wave2Agents } = await this.executeWave2WithMetrics(wave1Result, manifest);
      waveResults.push(wave2Result);
      {
        // Aggregate metrics from all Wave 2 agents
        const allProviders = new Set<string>();
        let totalTokens = 0, totalCalls = 0;
        for (const agent of wave2Agents) {
          const m = agent.getLLMMetrics();
          m.providers.forEach(p => allProviders.add(p));
          totalTokens += m.totalTokens;
          totalCalls += m.totalCalls;
        }
        this.captureAgentMetrics('wave2_analyze', { providers: [...allProviders], totalTokens, totalCalls }, { totalEntities: wave2Result.totalEntities, discoveredEntities: wave2Result.discoveredEntities });
      }

      if (!wave2Result.success) {
        log('[WaveController] Wave 2 failed', 'error', { error: wave2Result.error });
        if (this.failFast) {
          return this.buildSummaryReport(startTime, waveResults);
        }
      } else {
        const wave2Entities = wave2Result.agentOutputs.flatMap(o => o.entities);
        SemanticAnalyzer.resetStepMetrics();
        this.updateProgress({ currentWave: 2, totalWaves: 4, subPhase: 'classify', message: 'Wave 2: Classifying entities' });
        await new Promise(r => setTimeout(r, 100));
        const wave2ClassifyTasks = wave2Entities.map(entity => async () => {
          await this.classifyEntity(entity);
        });
        await this.runWithConcurrency(wave2ClassifyTasks, 2);
        this.captureStepMetrics('wave2_classify', { entitiesClassified: wave2Entities.length });
        log('[WaveController] Wave 2 classification complete', 'info', { entities: wave2Entities.length });
        this.updateProgress({ currentWave: 2, totalWaves: 4, subPhase: 'persist', message: 'Wave 2: Persisting entities' });
        await new Promise(r => setTimeout(r, 100));
        await this.persistWaveResult(wave2Result);
        this.captureStepMetrics('wave2_persist', { entitiesPersisted: wave2Result.totalEntities });
        log('[WaveController] Wave 2 entities persisted', 'info', {
          entities: wave2Result.totalEntities,
        });
      }

      // ---- Wave 3: L3 Details ----
      this.logWaveBanner('WAVE 3', 'L3 Detail Entities');
      SemanticAnalyzer.resetStepMetrics();
      this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'analyze', message: 'Wave 3: Analyzing Detail entities' });

      const { result: wave3Result, agents: wave3Agents } = await this.executeWave3WithMetrics(wave2Result, manifest);
      waveResults.push(wave3Result);
      {
        const allProviders = new Set<string>();
        let totalTokens = 0, totalCalls = 0;
        for (const agent of wave3Agents) {
          const m = agent.getLLMMetrics();
          m.providers.forEach(p => allProviders.add(p));
          totalTokens += m.totalTokens;
          totalCalls += m.totalCalls;
        }
        this.captureAgentMetrics('wave3_analyze', { providers: [...allProviders], totalTokens, totalCalls }, { totalEntities: wave3Result.totalEntities, discoveredEntities: wave3Result.discoveredEntities });
      }

      if (!wave3Result.success) {
        log('[WaveController] Wave 3 failed', 'error', { error: wave3Result.error });
      } else {
        const wave3Entities = wave3Result.agentOutputs.flatMap(o => o.entities);
        SemanticAnalyzer.resetStepMetrics();
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'classify', message: 'Wave 3: Classifying entities' });
        await new Promise(r => setTimeout(r, 100));
        const wave3ClassifyTasks = wave3Entities.map(entity => async () => {
          await this.classifyEntity(entity);
        });
        await this.runWithConcurrency(wave3ClassifyTasks, 2);
        this.captureStepMetrics('wave3_classify', { entitiesClassified: wave3Entities.length });
        log('[WaveController] Wave 3 classification complete', 'info', { entities: wave3Entities.length });
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'persist', message: 'Wave 3: Persisting entities' });
        await new Promise(r => setTimeout(r, 100)); // Allow SSE to broadcast persist step
        await this.persistWaveResult(wave3Result);
        this.captureStepMetrics('wave3_persist', { entitiesPersisted: wave3Result.totalEntities });
        log('[WaveController] Wave 3 entities persisted', 'info', {
          entities: wave3Result.totalEntities,
        });
      }

      // ---- Manifest Write-Back: Persist discovered L2 entities to YAML ----
      try {
        const discoveries: DiscoveredManifestEntry[] = [];
        // Collect discovered L2 entities from Wave 2 results
        for (const output of wave2Result.agentOutputs) {
          for (const entity of output.entities) {
            if (entity.level === 2 && entity.id?.startsWith('discovered:')) {
              discoveries.push({
                name: entity.name,
                parentL1: entity.parentId ?? '',
                description: entity.observations[0] ?? `SubComponent ${entity.name}`,
                keywords: [entity.name.toLowerCase()],
              });
            }
          }
        }

        if (discoveries.length > 0) {
          const added = writeManifestDiscoveries(discoveries);
          log('[WaveController] Manifest write-back complete', 'info', {
            discovered: discoveries.length,
            newlyAdded: added,
          });
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log('[WaveController] Manifest write-back failed (non-fatal)', 'warning', { error: errMsg });
      }

      // ---- KG Operators: Post-persistence refinement ----
      this.logWaveBanner('KG OPERATORS', 'Post-Persistence Refinement (6 operators)');
      try {
        // Collect all entities and relations from all 3 waves
        let allEntities: KGEntity[] = waveResults.flatMap(wr => wr.agentOutputs.flatMap(o => o.entities));
        let allRelations: KGRelation[] = waveResults.flatMap(wr => wr.agentOutputs.flatMap(o => o.relationships));

        log('[WaveController] KG Operators: collected entities/relations', 'info', {
          entities: allEntities.length,
          relations: allRelations.length,
        });

        // Build BatchContext
        const batchContext: BatchContext = {
          batchId: `wave-run-${Date.now()}`,
          startDate: new Date(startTime),
          endDate: new Date(),
          commits: await this.getRecentGitCommits(30),
          sessions: this.getRecentSessions(30),
        };

        // Create KGOperators instance
        const kgOperators = createKGOperators(new SemanticAnalyzer());
        const accumulatedKG = { entities: [] as KGEntity[], relations: [] as KGRelation[] }; // full-replace mode

        let currentEntities = allEntities;
        let currentRelations = allRelations;

        // Preserve ontology metadata from per-wave classification before operators strip it
        const ontologyMap = new Map<string, any>();
        for (const entity of allEntities) {
          const meta = (entity as any)._ontologyMetadata;
          if (meta) {
            ontologyMap.set(entity.name, meta);
          }
        }

        // --- Run each operator with full trace logging and SSE visibility ---
        const operatorTimings: Record<string, number> = {};

        // Conv
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'operators', message: 'KG Operator: Context Convolution' });
        await new Promise(r => setTimeout(r, 100)); // Allow SSE broadcast
        try {
          const convStart = Date.now();
          const convInputCount = currentEntities.length;
          currentEntities = await kgOperators.contextConvolution(currentEntities, batchContext);
          operatorTimings.conv = Date.now() - convStart;
          const withContext = currentEntities.filter(e => e.enrichedContext).length;
          log('[WaveController] OPERATOR TRACE: Conv complete', 'info', {
            inputEntities: convInputCount, outputEntities: currentEntities.length,
            withEnrichedContext: withContext, durationMs: operatorTimings.conv,
          });
          this.captureAgentMetrics('operator_conv', { providers: [], totalTokens: 0, totalCalls: 0 }, {
            inputEntities: convInputCount, outputEntities: currentEntities.length,
            withEnrichedContext: withContext, durationMs: operatorTimings.conv,
          });
        } catch (e) { log('[WaveController] Conv operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Aggr
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'operators', message: 'KG Operator: Entity Aggregation' });
        await new Promise(r => setTimeout(r, 100));
        try {
          const aggrStart = Date.now();
          const aggrInputCount = currentEntities.length;
          const aggr = await kgOperators.entityAggregation(currentEntities);
          currentEntities = [...aggr.core, ...aggr.nonCore];
          operatorTimings.aggr = Date.now() - aggrStart;
          log('[WaveController] OPERATOR TRACE: Aggr complete', 'info', {
            inputEntities: aggrInputCount, core: aggr.core.length, nonCore: aggr.nonCore.length,
            durationMs: operatorTimings.aggr,
          });
          this.captureAgentMetrics('operator_aggr', { providers: [], totalTokens: 0, totalCalls: 0 }, {
            inputEntities: aggrInputCount, core: aggr.core.length, nonCore: aggr.nonCore.length,
            durationMs: operatorTimings.aggr,
          });
        } catch (e) { log('[WaveController] Aggr operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Embed
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'operators', message: 'KG Operator: Node Embedding' });
        await new Promise(r => setTimeout(r, 100));
        try {
          const embedStart = Date.now();
          const embedInputCount = currentEntities.length;
          const beforeEmbCount = currentEntities.filter(e => e.embedding && e.embedding.length > 0).length;
          currentEntities = await kgOperators.nodeEmbedding(currentEntities);
          operatorTimings.embed = Date.now() - embedStart;
          const afterEmbCount = currentEntities.filter(e => e.embedding && e.embedding.length > 0).length;
          const sampleEmb = currentEntities.find(e => e.embedding && e.embedding.length > 0);
          log('[WaveController] OPERATOR TRACE: Embed complete', 'info', {
            inputEntities: embedInputCount, embeddingsBefore: beforeEmbCount, embeddingsAfter: afterEmbCount,
            newEmbeddings: afterEmbCount - beforeEmbCount, durationMs: operatorTimings.embed,
            sampleDimensions: sampleEmb?.embedding?.length ?? 0,
            sampleEntity: sampleEmb?.name ?? 'none',
          });
          this.captureAgentMetrics('operator_embed', { providers: [], totalTokens: 0, totalCalls: 0 }, {
            inputEntities: embedInputCount, embeddingsBefore: beforeEmbCount, embeddingsAfter: afterEmbCount,
            newEmbeddings: afterEmbCount - beforeEmbCount, durationMs: operatorTimings.embed,
          });
        } catch (e) { log('[WaveController] Embed operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Dedup
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'operators', message: 'KG Operator: Deduplication' });
        await new Promise(r => setTimeout(r, 100));
        try {
          const dedupStart = Date.now();
          const dedupInputCount = currentEntities.length;
          const deduped = await kgOperators.deduplication(currentEntities, accumulatedKG);
          operatorTimings.dedup = Date.now() - dedupStart;
          log('[WaveController] OPERATOR TRACE: Dedup complete', 'info', {
            inputEntities: dedupInputCount, outputEntities: deduped.entities.length,
            merged: deduped.merged, durationMs: operatorTimings.dedup,
            mergeLog: deduped.mergeLog.slice(0, 5), // First 5 merges for trace
          });
          currentEntities = deduped.entities;
          this.captureAgentMetrics('operator_dedup', { providers: [], totalTokens: 0, totalCalls: 0 }, {
            inputEntities: dedupInputCount, outputEntities: deduped.entities.length,
            merged: deduped.merged, durationMs: operatorTimings.dedup,
          });
        } catch (e) { log('[WaveController] Dedup operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Pred
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'operators', message: 'KG Operator: Edge Prediction' });
        await new Promise(r => setTimeout(r, 100));
        try {
          const predStart = Date.now();
          const relsBefore = currentRelations.length;
          const predicted = await kgOperators.edgePrediction(currentEntities, { entities: currentEntities, relations: currentRelations });
          operatorTimings.pred = Date.now() - predStart;
          log('[WaveController] OPERATOR TRACE: Pred complete', 'info', {
            inputEntities: currentEntities.length, relationsBefore: relsBefore,
            predictedEdges: predicted.edges.length, durationMs: operatorTimings.pred,
            topScores: predicted.scores.slice(0, 3).map(s => ({ from: s.from, to: s.to, score: s.score.toFixed(3) })),
          });
          currentRelations = [...currentRelations, ...predicted.edges];
          this.captureAgentMetrics('operator_pred', { providers: [], totalTokens: 0, totalCalls: 0 }, {
            inputEntities: currentEntities.length, relationsBefore: relsBefore,
            predictedEdges: predicted.edges.length, durationMs: operatorTimings.pred,
          });
        } catch (e) { log('[WaveController] Pred operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Merge (structure fusion)
        this.updateProgress({ currentWave: 3, totalWaves: 4, subPhase: 'operators', message: 'KG Operator: Structure Fusion' });
        await new Promise(r => setTimeout(r, 100));
        try {
          const mergeStart = Date.now();
          const merged = await kgOperators.structureMerge(
            { entities: currentEntities, relations: currentRelations },
            accumulatedKG
          );
          operatorTimings.merge = Date.now() - mergeStart;
          log('[WaveController] OPERATOR TRACE: Merge complete', 'info', {
            inputEntities: currentEntities.length, inputRelations: currentRelations.length,
            outputEntities: merged.entities.length, outputRelations: merged.relations.length,
            added: merged.added, updated: merged.updated, durationMs: operatorTimings.merge,
          });
          currentEntities = merged.entities;
          currentRelations = merged.relations;
          this.captureAgentMetrics('operator_merge', { providers: [], totalTokens: 0, totalCalls: 0 }, {
            inputEntities: currentEntities.length, inputRelations: currentRelations.length,
            outputEntities: merged.entities.length, outputRelations: merged.relations.length,
            added: merged.added, updated: merged.updated, durationMs: operatorTimings.merge,
          });
        } catch (e) { log('[WaveController] Merge operator FAILED', 'error', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }

        // Log operator pipeline summary
        const totalOperatorTime = Object.values(operatorTimings).reduce((s, t) => s + t, 0);
        const embCount = currentEntities.filter(e => e.embedding && e.embedding.length > 0).length;
        const roleCount = currentEntities.filter(e => e.role).length;
        const ctxCount = currentEntities.filter(e => e.enrichedContext).length;
        log('[WaveController] === OPERATOR PIPELINE SUMMARY ===', 'info', {
          totalEntities: currentEntities.length, totalRelations: currentRelations.length,
          withEmbeddings: embCount, withRole: roleCount, withEnrichedContext: ctxCount,
          totalDurationMs: totalOperatorTime, operatorTimings,
        });

        // Re-attach ontology metadata that operators may have stripped
        for (const entity of currentEntities) {
          if (!(entity as any)._ontologyMetadata && ontologyMap.has(entity.name)) {
            (entity as any)._ontologyMetadata = ontologyMap.get(entity.name);
          }
        }

        // === DIRECT GRAPH WRITE for operator-enriched fields ===
        // Bypass the 7-layer persist pipeline — write embedding/role/enrichedContext
        // directly to existing graph nodes via graphDB.mergeNodeAttributes()
        log('[WaveController] Direct graph write: merging operator-enriched fields', 'info', {
          entitiesWithEmbedding: embCount, entitiesWithRole: roleCount, entitiesWithContext: ctxCount,
        });
        let directWriteSuccess = 0;
        let directWriteFail = 0;
        for (const entity of currentEntities) {
          const enrichedAttrs: Record<string, any> = {};
          if (entity.embedding && entity.embedding.length > 0) enrichedAttrs.embedding = entity.embedding;
          if (entity.role) enrichedAttrs.role = entity.role;
          if (entity.enrichedContext) enrichedAttrs.enrichedContext = entity.enrichedContext;

          if (Object.keys(enrichedAttrs).length > 0) {
            try {
              // Write directly to graph node — no pipeline, no transformation
              const nodeId = `${this.team}:${entity.name}`;
              await this.graphDB.mergeAttributes(nodeId, enrichedAttrs);
              directWriteSuccess++;
            } catch (e) {
              directWriteFail++;
              // Node might not exist yet — will be created by re-persist below
              log('[WaveController] Direct graph write failed for entity (will try via persist)', 'debug', {
                entity: entity.name, error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
        log('[WaveController] Direct graph write complete', 'info', {
          success: directWriteSuccess, failed: directWriteFail,
        });

        // Re-persist refined entities back to the KG (ensures new entities are created)
        log('[WaveController] Re-persisting operator-refined entities via pipeline', 'info', { count: currentEntities.length });
        try {
          const refinedWaveResult: WaveResult = {
            wave: 3,
            agentOutputs: [{
              entities: currentEntities,
              relationships: currentRelations,
              childManifest: [],
              discovered: false,
              durationMs: Date.now() - startTime,
              parentId: '',
              agentName: 'KGOperators',
            }],
            totalEntities: currentEntities.length,
            manifestEntities: currentEntities.filter(e => !e.id?.startsWith('discovered:')).length,
            discoveredEntities: currentEntities.filter(e => e.id?.startsWith('discovered:')).length,
            durationMs: Date.now() - startTime,
            success: true,
          };
          await this.persistWaveResult(refinedWaveResult);
          log('[WaveController] Operator-refined entities persisted via pipeline', 'info');
        } catch (e) { log('[WaveController] Re-persist after operators failed (non-fatal)', 'warning', { error: e instanceof Error ? e.message : String(e) }); }

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log('[WaveController] KG Operators phase failed (non-fatal)', 'warning', { error: errMsg });
      }

      // ---- Insight Finalization: Generate insight documents ----
      this.logWaveBanner('FINALIZATION', 'Insight Document Generation');
      this.updateProgress({ currentWave: 4, totalWaves: 4, subPhase: 'insights', message: 'Generating insight documents' });

      const insightResult = await this.generateInsightsForWaveEntities(waveResults);
      log('[WaveController] Insight finalization complete', 'info', {
        generated: insightResult.generated,
        failed: insightResult.failed,
        skippedDiagrams: insightResult.skippedDiagrams,
      });
      this.captureStepMetrics('wave4_insights', {
        generated: insightResult.generated,
        failed: insightResult.failed,
        skippedDiagrams: insightResult.skippedDiagrams,
      });

      // Build and return final summary
      const summary = this.buildSummaryReport(startTime, waveResults);

      // Log structured summary
      this.logSummaryReport(summary);

      // Mark wave4_insights as completed by advancing past the last step
      // Use a post-completion update that sets currentStep beyond the sequence length
      this.updateProgress({
        currentWave: 4,
        totalWaves: 4,
        subPhase: 'insights',
        message: summary.success ? 'Wave analysis complete' : 'Wave analysis completed with errors',
        _allComplete: true,
      } as any);

      // Record all 17 sub-steps from stepsDetail for rich history trace
      try {
        const progressContent = fs.readFileSync(this.progressFile, 'utf-8');
        const progressData = JSON.parse(progressContent);
        const stepsDetail = progressData.stepsDetail || [];
        for (const step of stepsDetail) {
          const stepStart = step.startTime ? new Date(step.startTime) : new Date(startTime);
          const stepEnd = step.endTime ? new Date(step.endTime) : new Date();
          const duration = stepEnd.getTime() - stepStart.getTime();
          const captured = this.stepMetrics.get(step.name);
          this.reportAgent.recordStep({
            stepName: step.name,
            agent: step.name.replace(/^wave\d_/, '').replace(/^operator_/, 'kg_operators:'),
            action: step.name.replace(/_/g, ' '),
            startTime: stepStart,
            endTime: stepEnd,
            duration,
            status: step.status === 'completed' ? 'success' : step.status === 'failed' ? 'failed' : 'skipped',
            inputs: captured?.outputs || {},
            outputs: captured?.outputs || {},
            decisions: [],
            warnings: [],
            errors: [],
            tokensUsed: captured?.tokensUsed || step.tokensUsed,
            llmCalls: captured?.llmCalls || step.llmCalls,
            llmProvider: captured?.llmProvider || step.llmProvider,
          });
        }
      } catch (e) {
        // Fallback: record wave-level steps if progress file can't be read
        for (const wr of waveResults) {
          this.reportAgent.recordStep({
            stepName: `wave${wr.wave}`,
            agent: `wave${wr.wave}`,
            action: `Wave ${wr.wave} analysis`,
            startTime: new Date(startTime),
            endTime: new Date(startTime + wr.durationMs),
            duration: wr.durationMs,
            status: wr.success ? 'success' : 'failed',
            inputs: { manifestEntities: wr.manifestEntities },
            outputs: { totalEntities: wr.totalEntities, discoveredEntities: wr.discoveredEntities },
            decisions: [],
            warnings: [],
            errors: wr.error ? [wr.error] : [],
          });
        }
      }

      // Finalize and save workflow report for history
      try {
        const completedSteps = waveResults.filter(w => w.success).length;
        this.reportAgent.finalizeReport(
          summary.success ? 'completed' : 'failed',
          {
            stepsCompleted: completedSteps,
            totalSteps: 17,
            entitiesCreated: summary.totalEntities,
            entitiesUpdated: 0,
            filesCreated: [],
            contentChanges: summary.totalEntities > 0,
          },
        );
        log('[WaveController] Workflow report saved to .data/workflow-reports/', 'info');
      } catch (e) {
        log('[WaveController] Failed to save workflow report (non-fatal)', 'warning', {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      return summary;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log('[WaveController] Fatal error during wave execution', 'error', { error: errorMsg });

      return {
        success: false,
        waves: waveResults,
        totalEntities: waveResults.reduce((sum, w) => sum + w.totalEntities, 0),
        totalDurationMs: Date.now() - startTime,
        entitiesByLevel: {},
        manifestEntities: 0,
        discoveredEntities: 0,
        error: errorMsg,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Wave Execution Methods
  // --------------------------------------------------------------------------

  private async executeWave1(
    manifest: ComponentManifest,
    existingEntities: KGEntity[],
  ): Promise<WaveResult> {
    const { result } = await this.executeWave1WithMetrics(manifest, existingEntities);
    return result;
  }

  private async executeWave1WithMetrics(
    manifest: ComponentManifest,
    existingEntities: KGEntity[],
  ): Promise<{ result: WaveResult; agent: Wave1ProjectAgent | null }> {
    const waveStart = Date.now();

    try {
      const wave1Agent = new Wave1ProjectAgent(this.repositoryPath, this.team);
      const output = await wave1Agent.execute({
        manifest,
        existingEntities,
        repositoryPath: this.repositoryPath,
      });

      return {
        result: {
          wave: 1,
          agentOutputs: [output],
          totalEntities: output.entities.length,
          manifestEntities: output.entities.filter(e => !e.id.startsWith('discovered:')).length,
          discoveredEntities: output.entities.filter(e => e.id.startsWith('discovered:')).length,
          durationMs: Date.now() - waveStart,
          success: true,
        },
        agent: wave1Agent,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        result: {
          wave: 1,
          agentOutputs: [],
          totalEntities: 0,
          manifestEntities: 0,
          discoveredEntities: 0,
          durationMs: Date.now() - waveStart,
          success: false,
          error: errorMsg,
        },
        agent: null,
      };
    }
  }

  private async executeWave2(
    wave1Result: WaveResult,
    manifest: ComponentManifest,
  ): Promise<WaveResult> {
    const { result } = await this.executeWave2WithMetrics(wave1Result, manifest);
    return result;
  }

  private async executeWave2WithMetrics(
    wave1Result: WaveResult,
    manifest: ComponentManifest,
  ): Promise<{ result: WaveResult; agents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> }> {
    const waveStart = Date.now();
    const createdAgents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> = [];

    try {
      // Dynamic import: Wave2ComponentAgent is created by Plan 03 (runs in parallel)
      const { Wave2ComponentAgent } = await import('./wave2-component-agent.js');

      // Gather all L1 entities from Wave 1
      const l1Entities = wave1Result.agentOutputs
        .flatMap(o => o.entities)
        .filter(e => e.level === 1);

      // Gather all child manifest entries from Wave 1
      const allChildManifest = wave1Result.agentOutputs.flatMap(o => o.childManifest);

      // Build agent tasks for each L1 entity
      const agentTasks = l1Entities.map(l1Entity => {
        return async (): Promise<WaveAgentOutput> => {
          // Find child manifest entries for this L1 entity
          const childEntries = allChildManifest.filter(
            c => c.parentId === l1Entity.name && c.level === 2,
          );

          // Get component files via code-graph-rag (graceful fallback)
          const componentKeywords = manifest.components
            .find(c => c.name === l1Entity.name)?.keywords ?? [];
          const componentFiles = await this.getComponentFiles(l1Entity.name, componentKeywords);

          const wave2Input: Wave2Input = {
            l1Entity,
            componentFiles,
            componentKeywords,
            manifestChildren: childEntries,
          };

          const agent = new Wave2ComponentAgent(this.repositoryPath, this.team);
          createdAgents.push(agent);
          return agent.execute(wave2Input);
        };
      });

      // Run agents with bounded concurrency
      const outputs = await this.runWithConcurrency(agentTasks, this.maxAgentsPerWave);

      const totalEntities = outputs.reduce((sum, o) => sum + o.entities.length, 0);
      const manifestCount = outputs.reduce(
        (sum, o) => sum + o.entities.filter(e => !e.id.startsWith('discovered:')).length, 0,
      );
      const discoveredCount = outputs.reduce(
        (sum, o) => sum + o.entities.filter(e => e.id.startsWith('discovered:')).length, 0,
      );

      return {
        result: {
          wave: 2,
          agentOutputs: outputs,
          totalEntities,
          manifestEntities: manifestCount,
          discoveredEntities: discoveredCount,
          durationMs: Date.now() - waveStart,
          success: true,
        },
        agents: createdAgents,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        result: {
          wave: 2,
          agentOutputs: [],
          totalEntities: 0,
          manifestEntities: 0,
          discoveredEntities: 0,
          durationMs: Date.now() - waveStart,
          success: false,
          error: errorMsg,
        },
        agents: createdAgents,
      };
    }
  }

  private async executeWave3(wave2Result: WaveResult, manifest: ComponentManifest): Promise<WaveResult> {
    const { result } = await this.executeWave3WithMetrics(wave2Result, manifest);
    return result;
  }

  private async executeWave3WithMetrics(
    wave2Result: WaveResult,
    manifest: ComponentManifest,
  ): Promise<{ result: WaveResult; agents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> }> {
    const waveStart = Date.now();
    const createdAgents: Array<{ getLLMMetrics(): { providers: string[]; totalTokens: number; totalCalls: number } }> = [];

    try {
      // Dynamic import: Wave3DetailAgent is created by Plan 03 (runs in parallel)
      const { Wave3DetailAgent } = await import('./wave3-detail-agent.js');

      // Gather all L2 entities from Wave 2 (both manifest-defined and discovered)
      const l2Entities = wave2Result.agentOutputs
        .flatMap(o => o.entities)
        .filter(e => e.level === 2);

      // Collect all L3 suggestions from Wave 2 agent outputs, with a global cap
      const allL3Suggestions = wave2Result.agentOutputs.flatMap(o => o.childManifest);
      const MAX_TOTAL_L3_AGENTS = 80;
      if (allL3Suggestions.length > MAX_TOTAL_L3_AGENTS) {
        log(`[WaveController] Capping total L3 agent tasks: ${allL3Suggestions.length} -> ${MAX_TOTAL_L3_AGENTS}`, 'warning');
        allL3Suggestions.length = MAX_TOTAL_L3_AGENTS;
      }
      log(`[WaveController] Wave 3 will process ${l2Entities.length} L2 entities with ${allL3Suggestions.length} L3 suggestions`, 'info');

      // Gather all L1 entities for hierarchy path construction
      // L1 entities are the parents referenced by L2 entity parentId
      const l1EntityMap = new Map<string, KGEntity>();
      for (const output of wave2Result.agentOutputs) {
        for (const entity of output.entities) {
          if (entity.level === 1) {
            l1EntityMap.set(entity.name, entity);
          }
        }
      }

      // Build agent tasks for each L2 entity
      const agentTasks = l2Entities.map(l2Entity => {
        return async (): Promise<WaveAgentOutput> => {
          // Find the parent L1 entity
          const parentId = l2Entity.parentId ?? '';
          const l1Entity = l1EntityMap.get(parentId);

          // ENHANCED: Use L1 keywords for broader file scoping (not just L2 name)
          const l1Component = manifest.components.find(c => c.name === parentId);
          const l1Keywords = l1Component?.keywords ?? [];
          const scopedFiles = await this.getComponentFiles(
            l2Entity.name,
            [l2Entity.name.toLowerCase(), ...l1Keywords],
          );

          // Pass suggested L3 children from Wave 2 for this L2 entity
          const suggestedChildren = allL3Suggestions.filter(
            c => c.parentId === l2Entity.name && c.level === 3,
          );

          const wave3Input: Wave3Input = {
            l2Entity,
            l1Entity: l1Entity ?? {
              id: parentId,
              name: parentId,
              type: 'Component',
              observations: [],
              significance: 8,
              level: 1,
            },
            scopedFiles,
            suggestedChildren,
          };

          const agent = new Wave3DetailAgent(this.repositoryPath, this.team);
          createdAgents.push(agent);
          return agent.execute(wave3Input);
        };
      });

      // Run agents with bounded concurrency
      const outputs = await this.runWithConcurrency(agentTasks, this.maxAgentsPerWave);

      const totalEntities = outputs.reduce((sum, o) => sum + o.entities.length, 0);

      return {
        result: {
          wave: 3,
          agentOutputs: outputs,
          totalEntities,
          manifestEntities: 0, // Wave 3 is pure discovery
          discoveredEntities: totalEntities,
          durationMs: Date.now() - waveStart,
          success: true,
        },
        agents: createdAgents,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        result: {
          wave: 3,
          agentOutputs: [],
          totalEntities: 0,
          manifestEntities: 0,
          discoveredEntities: 0,
          durationMs: Date.now() - waveStart,
          success: false,
          error: errorMsg,
        },
        agents: createdAgents,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Content Quality Validation
  // --------------------------------------------------------------------------

  /**
   * Check whether a single observation is generic/vague.
   * Generic = short, no code artifact references, matches vague phrases.
   */
  private isGenericObservation(obs: string): boolean {
    // Too short to be meaningful
    if (obs.length < 50) return true;

    // Check for code artifact references (file paths, class/function names)
    const hasCodeRef = /[a-zA-Z_]\w*\.\w+|\/[\w/.-]+\.\w{1,5}|[A-Z][a-z]+[A-Z]\w+|\w+\(\)/.test(obs);
    if (hasCodeRef) return false;

    // Generic vague phrases
    const genericPatterns = [
      /works?\s+well/i,
      /important\s+(feature|component|part)/i,
      /key\s+(component|feature|part|element)/i,
      /provides?\s+(functionality|features?)/i,
      /handles?\s+(various|different|multiple)/i,
      /is\s+(a|an|the)\s+(main|core|key|important)/i,
      /used\s+(for|to)\s+(manage|handle|process)/i,
      /responsible\s+for/i,
    ];
    return genericPatterns.some(p => p.test(obs));
  }

  /**
   * Validate a single entity for content quality before persistence.
   * Checks observation count and generic content.
   */
  private validateEntityQuality(entity: SharedMemoryEntity): { valid: boolean; reason?: string } {
    const observations = entity.observations || [];
    const obsStrings = observations.map(obs => typeof obs === 'string' ? obs : obs.content);

    // Reject entities with fewer than 3 observations
    if (obsStrings.length < 3) {
      return { valid: false, reason: `insufficient observations (${obsStrings.length}/3 required)` };
    }

    // Reject entities where ALL observations are generic
    const genericCount = obsStrings.filter(obs => this.isGenericObservation(obs)).length;
    if (genericCount === obsStrings.length) {
      return { valid: false, reason: `all ${obsStrings.length} observations are generic/vague` };
    }

    return { valid: true };
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private async persistWaveResult(waveResult: WaveResult): Promise<void> {
    // Collect all entities from all agents in this wave
    const allEntities = waveResult.agentOutputs.flatMap(o => o.entities);
    const allRelationships = waveResult.agentOutputs.flatMap(o => o.relationships);

    // Convert KGEntity to SharedMemoryEntity format for PersistenceAgent
    const sharedMemoryEntities = allEntities.map(e => this.mapEntityToSharedMemory(e));

    // Persist entities via PersistenceAgent
    const persistenceAgent = new PersistenceAgent(this.repositoryPath, this.graphDB, {
      ontologyTeam: this.team,
      validationMode: 'lenient',
      contentValidationMode: 'lenient',
    });

    // Basic structural validation before persistence
    const validEntities = sharedMemoryEntities.filter(e => {
      const hasHierarchy = e.hierarchyLevel !== undefined && e.hierarchyLevel !== null;
      const hasObservations = e.observations && e.observations.length > 0;
      if (!hasHierarchy || !hasObservations) {
        log(`[WaveController] Skipping entity ${e.name}: missing hierarchy or observations`, 'warning');
        return false;
      }
      return true;
    });

    // Content quality validation
    const totalBeforeQuality = validEntities.length;
    const qualityFilteredEntities = validEntities.filter(e => {
      const result = this.validateEntityQuality(e);
      if (!result.valid) {
        log(`[WaveController] Content quality rejection: ${e.name} - ${result.reason}`, 'warning');
        return false;
      }
      return true;
    });
    log(`[WaveController] Content quality gate: ${qualityFilteredEntities.length}/${totalBeforeQuality} entities passed`, 'info');

    await persistenceAgent.persistEntities({
      entities: qualityFilteredEntities.map(e => ({
        name: e.name,
        entityType: e.entityType,
        observations: e.observations.map(obs =>
          typeof obs === 'string' ? obs : obs.content,
        ),
        significance: e.significance,
        metadata: e.metadata,
        parentId: e.parentEntityName,
        level: e.hierarchyLevel,
        // Operator-enriched fields (set by conv, aggr, embed operators)
        ...((e as any).embedding ? { embedding: (e as any).embedding } : {}),
        ...((e as any).role ? { role: (e as any).role } : {}),
        ...((e as any).enrichedContext ? { enrichedContext: (e as any).enrichedContext } : {}),
      })),
      team: this.team,
    });

    // Persist relationship edges via GraphDatabaseAdapter
    for (const rel of allRelationships) {
      try {
        await this.graphDB.storeRelationship({
          from: rel.from,
          to: rel.to,
          relationType: rel.type,
        });
      } catch (error) {
        log(`[WaveController] Failed to persist relationship ${rel.from} -> ${rel.to}`, 'warning', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log(`[WaveController] Wave ${waveResult.wave} persistence complete`, 'info', {
      entities: allEntities.length,
      relationships: allRelationships.length,
    });
  }

  /**
   * Classify a single entity using the OntologyClassificationAgent.
   * Per-entity sequential classification -- each entity gets its own classification call.
   * Mutates entity in-place: updates entity.type and attaches _ontologyMetadata.
   */
  private async classifyEntity(entity: KGEntity): Promise<void> {
    const ontologyAgent = new OntologyClassificationAgent(this.team, this.repositoryPath);
    try {
      const classificationResult = await ontologyAgent.classifyObservations({
        observations: [{
          name: entity.name,
          entityType: entity.type || 'Unclassified',
          observations: entity.observations || [],
          significance: entity.significance || 5,
          tags: [],
        }],
        autoExtend: true,
        minConfidence: 0.6,
      });

      if (classificationResult?.classified?.length > 0) {
        const classification = classificationResult.classified[0];
        if (classification?.classified && classification?.ontologyMetadata) {
          // Do NOT override entity.type — it carries the hierarchy role (Project, Component,
          // SubComponent, Detail) which the VKB graph uses for node coloring/sizing.
          // Store ontology class in metadata only.
          (entity as any)._ontologyMetadata = {
            ontologyClass: classification.ontologyMetadata.ontologyClass,
            ontologyVersion: classification.ontologyMetadata.ontologyVersion || '1.0',
            classificationConfidence: classification.ontologyMetadata.classificationConfidence,
            classificationMethod: classification.ontologyMetadata.classificationMethod,
            ontologySource: classification.ontologyMetadata.ontologySource || 'lower',
            classifiedAt: classification.ontologyMetadata.classifiedAt || new Date().toISOString(),
          };
          // Append ontology trace data
          const traceArr = (entity as any)._traceData || [];
          traceArr.push({
            llmCallCount: 1,
            totalDurationMs: 0, // ontology agent doesn't expose timing yet
            model: 'heuristic+llm',
            provider: 'ontology',
            agentType: 'OntologyClassificationAgent',
          });
          (entity as any)._traceData = traceArr;
        }
      }
    } catch (err) {
      log(`[WaveController] Ontology classification failed for ${entity.name}, using hierarchy fallback: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      // Entity keeps its existing type -- mapEntityToSharedMemory handles fallback
    }
  }

  /**
   * @deprecated Use classifyEntity() per-entity instead.
   *
   * Run ontology classification on wave entities using the real OntologyClassificationAgent.
   * This replaces the naive level-based "auto-assigned" classification with actual
   * semantic classification (heuristic + LLM) against the project ontology.
   *
   * Mutates entities in-place: updates entity.type and attaches ontologyMetadata
   * so that mapEntityToSharedMemory() can use the real classification.
   */
  private async classifyWaveEntities(waveResult: WaveResult): Promise<{
    classified: number;
    unclassified: number;
    byClass: Record<string, number>;
  }> {
    const allEntities = waveResult.agentOutputs.flatMap(o => o.entities);
    if (allEntities.length === 0) {
      return { classified: 0, unclassified: 0, byClass: {} };
    }

    try {
      const ontologyAgent = new OntologyClassificationAgent(this.team, this.repositoryPath);

      // Transform wave entities to the observation format expected by the classification agent
      const observationsForClassification = allEntities.map(entity => ({
        name: entity.name,
        entityType: entity.type || 'Unclassified',
        observations: entity.observations || [],
        significance: entity.significance || 5,
        tags: [] as string[],
      }));

      const classificationResult = await ontologyAgent.classifyObservations({
        observations: observationsForClassification,
        autoExtend: true,
        minConfidence: 0.6,
      });

      if (classificationResult?.classified && classificationResult.classified.length > 0) {
        // Build a name -> classification map for fast lookup
        const classifiedMap = new Map<string, any>(
          classificationResult.classified
            .filter((c: any) => c.classified && c.ontologyMetadata)
            .map((c: any) => [c.original?.name, c]),
        );

        // Apply classifications back to entities in-place
        for (const entity of allEntities) {
          const classification = classifiedMap.get(entity.name);
          if (classification?.ontologyMetadata) {
            // Store ontology metadata on the entity for mapEntityToSharedMemory to pick up
            (entity as any)._ontologyMetadata = {
              ontologyClass: classification.ontologyMetadata.ontologyClass,
              ontologyVersion: classification.ontologyMetadata.ontologyVersion || '1.0',
              classificationConfidence: classification.ontologyMetadata.classificationConfidence,
              classificationMethod: classification.ontologyMetadata.classificationMethod,
              ontologySource: classification.ontologyMetadata.ontologySource || 'lower',
              classifiedAt: classification.ontologyMetadata.classifiedAt || new Date().toISOString(),
            };
          }
        }

        const summary = classificationResult.summary;
        log(`[WaveController] Ontology classification for wave ${waveResult.wave}: ${summary.classifiedCount}/${summary.total} classified`, 'info', {
          byClass: summary.byClass,
          byMethod: summary.byMethod,
          llmCalls: summary.llmCalls,
        });

        return {
          classified: summary.classifiedCount,
          unclassified: summary.unclassifiedCount,
          byClass: summary.byClass,
        };
      }

      return { classified: 0, unclassified: allEntities.length, byClass: {} };
    } catch (error) {
      log(`[WaveController] Ontology classification failed for wave ${waveResult.wave}, using hierarchy-level fallback`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { classified: 0, unclassified: allEntities.length, byClass: {} };
    }
  }

  /**
   * Map KGEntity to SharedMemoryEntity format.
   *
   * CRITICAL: Correct field mapping (see RESEARCH.md Pitfall 1 and Pitfall 6):
   * - entityType comes from KGEntity.type (not entityType -- KGEntity has `type`)
   * - hierarchyLevel comes from KGEntity.level
   * - parentEntityName comes from KGEntity.parentId
   * - Ontology metadata uses real classification from classifyWaveEntities() if available,
   *   falling back to hierarchy-level classification only as last resort.
   */
  private mapEntityToSharedMemory(entity: KGEntity): SharedMemoryEntity {
    // Check for real ontology classification attached by classifyWaveEntities()
    const realOntology = (entity as any)._ontologyMetadata;
    const hierarchyClass = this.getHierarchyLevelName(entity.level);

    return {
      id: entity.id,
      name: entity.name,
      entityType: entity.type, // KGEntity uses `type`, SharedMemoryEntity uses `entityType`
      significance: entity.significance,
      observations: entity.observations,
      relationships: [],
      metadata: {
        created_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        team: this.team,
        source: 'wave-analysis',
        ontology: realOntology
          ? {
              ontologyName: realOntology.ontologyClass,
              ontologyClass: realOntology.ontologyClass,
              ontologyVersion: realOntology.ontologyVersion,
              confidence: realOntology.classificationConfidence,
              classificationConfidence: realOntology.classificationConfidence,
              classificationMethod: realOntology.classificationMethod,
              ontologySource: realOntology.ontologySource,
              classifiedAt: realOntology.classifiedAt,
            }
          : {
              ontologyName: hierarchyClass,
              ontologyClass: hierarchyClass,
              ontologyVersion: '1.0',
              confidence: 1.0,
              classificationConfidence: 1.0,
              classificationMethod: 'auto-assigned',
              ontologySource: 'lower' as const,
              classifiedAt: new Date().toISOString(),
            },
      },
      hierarchyLevel: entity.level,
      parentEntityName: entity.parentId,
      childEntityNames: [],
      isScaffoldNode: (entity.level ?? 3) < 3, // L0, L1, L2 are scaffold nodes
      // Operator-enriched fields (set by conv, aggr, embed operators)
      ...(entity.embedding ? { embedding: entity.embedding } : {}),
      ...(entity.role ? { role: entity.role } : {}),
      ...(entity.enrichedContext ? { enrichedContext: entity.enrichedContext } : {}),
    };
  }

  /**
   * Map hierarchy level to human-readable name (for structural metadata only).
   * This is NOT the ontology classification — just the hierarchy level label.
   */
  private getHierarchyLevelName(level?: number): string {
    switch (level) {
      case 0: return 'Project';
      case 1: return 'Component';
      case 2: return 'SubComponent';
      case 3: return 'Detail';
      default: return 'Detail';
    }
  }

  // --------------------------------------------------------------------------
  // Insight Finalization
  // --------------------------------------------------------------------------

  /**
   * Generate insight documents for all entities produced by the wave pipeline.
   * Runs after all 3 waves complete and entities are persisted.
   * Each entity gets a markdown document; L1/L2 also get PlantUML diagrams.
   */
  private async generateInsightsForWaveEntities(
    waveResults: WaveResult[],
  ): Promise<{ generated: number; failed: number; skippedDiagrams: number }> {
    // Collect all entities and relationships from all waves
    const allEntities = waveResults.flatMap(wr => wr.agentOutputs.flatMap(ao => ao.entities));
    const allRelationships = waveResults.flatMap(wr => wr.agentOutputs.flatMap(ao => ao.relationships));

    log('[WaveController] Starting insight finalization', 'info', {
      entityCount: allEntities.length,
      relationshipCount: allRelationships.length,
    });

    if (allEntities.length === 0) {
      log('[WaveController] No entities to generate insights for', 'warning');
      return { generated: 0, failed: 0, skippedDiagrams: 0 };
    }

    // Instantiate InsightGenerationAgent ONCE (constructor creates dirs, checks PlantUML)
    const insightAgent = new InsightGenerationAgent(this.repositoryPath);

    let generated = 0;
    let failed = 0;
    let skippedDiagrams = 0;

    // Build insight generation tasks (one per entity)
    const insightTasks = allEntities.map(entity => {
      return async (): Promise<void> => {
        try {
          // Build cross-reference context
          const crossReferences = this.buildCrossReferences(entity, allEntities);

          // All levels get diagram treatment per Phase 9 decision (overrides Phase 6 L3 text-only)
          const generateDiagrams = true;

          // Build relations for this entity
          const entityRelations = allRelationships
            .filter(r => r.from === entity.name || r.to === entity.name)
            .map(r => ({ from: r.from, to: r.to, relationType: r.type }));

          // Enrich observations with analysis artifacts from SemanticAnalysisAgent
          const artifacts = (entity as any)._analysisArtifacts;
          let enrichedObservations = [...entity.observations];
          if (artifacts) {
            if (artifacts.patterns?.length > 0) {
              enrichedObservations.push(`[Architectural Patterns] ${artifacts.patterns.join('; ')}`);
            }
            if (artifacts.architectureNotes?.length > 0) {
              enrichedObservations.push(`[Architecture Notes] ${artifacts.architectureNotes.join('; ')}`);
            }
            if (artifacts.codeReferences?.length > 0) {
              enrichedObservations.push(`[Code References] ${artifacts.codeReferences.join('; ')}`);
            }
          }

          const result = await insightAgent.generateEntityInsight({
            entityName: entity.name,
            entityType: entity.type,
            observations: enrichedObservations,
            relations: entityRelations,
            crossReferences,
            generateDiagrams,
          });

          if (result.success) {
            generated++;

            // Track skipped diagrams (L1/L2 that got fewer than 4 diagrams)
            if (generateDiagrams && result.diagramCount < 4) {
              skippedDiagrams++;
            }

            // Update entity metadata with insight document path
            try {
              await this.graphDB.storeEntity({
                name: entity.name,
                entityType: entity.type,
                observations: entity.observations,
                significance: entity.significance,
                metadata: {
                  validated_file_path: result.filePath,
                  has_insight_document: true,
                },
              });
            } catch (updateErr) {
              log(`[WaveController] Failed to update metadata for ${entity.name}: ${updateErr}`, 'warning');
            }
          } else {
            failed++;
          }
        } catch (entityErr) {
          log(`[WaveController] Insight generation failed for ${entity.name}: ${entityErr}`, 'warning');
          failed++;
        }
      };
    });

    // Execute with bounded concurrency (2 parallel to be conservative with LLM rate limits)
    await this.runWithConcurrency(insightTasks, 2);

    return { generated, failed, skippedDiagrams };
  }

  /**
   * Build cross-reference context for an entity from the full entity set.
   * Extracts parent, children, and siblings for dual cross-reference generation.
   */
  private buildCrossReferences(
    entity: KGEntity,
    allEntities: KGEntity[],
  ): CrossReferenceContext {
    const parent = entity.parentId
      ? allEntities.find(e => e.name === entity.parentId)
      : undefined;

    const children = allEntities.filter(e => e.parentId === entity.name);

    const siblings = entity.parentId
      ? allEntities.filter(e => e.parentId === entity.parentId && e.name !== entity.name)
      : [];

    return {
      parent: parent
        ? { name: parent.name, firstObservation: parent.observations[0] || 'No observations available' }
        : undefined,
      children: children.map(c => ({
        name: c.name,
        firstObservation: c.observations[0] || 'No observations available',
      })),
      siblings: siblings.map(s => ({
        name: s.name,
        firstObservation: s.observations[0] || 'No observations available',
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Concurrency Control
  // --------------------------------------------------------------------------

  /**
   * Run tasks with bounded concurrency using work-stealing pattern.
   * Starts maxConcurrent workers; each pulls next task when done.
   * Results are returned in original order.
   *
   * If failFast is true and any task throws, remaining tasks are skipped.
   */
  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    maxConcurrent: number,
  ): Promise<T[]> {
    if (tasks.length === 0) return [];

    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;
    let hasError = false;
    let firstError: Error | null = null;

    const worker = async (): Promise<void> => {
      while (nextIndex < tasks.length) {
        if (hasError && this.failFast) return;

        const taskIndex = nextIndex++;
        if (taskIndex >= tasks.length) return;

        try {
          results[taskIndex] = await tasks[taskIndex]();
        } catch (error) {
          if (!hasError) {
            hasError = true;
            firstError = error instanceof Error ? error : new Error(String(error));
          }
          if (this.failFast) return;
        }
      }
    };

    // Start up to maxConcurrent workers
    const workerCount = Math.min(maxConcurrent, tasks.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    if (hasError && this.failFast && firstError) {
      throw firstError;
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Progress & Logging
  // --------------------------------------------------------------------------

  /**
   * Log a visible wave banner for progress visibility.
   */
  private logWaveBanner(wave: string, description: string): void {
    const line = '='.repeat(60);
    log(line, 'info');
    log(`=== ${wave}: ${description} ===`, 'info');
    log(line, 'info');
  }

  /**
   * Get recent git commits for BatchContext.
   */
  private async getRecentGitCommits(days: number): Promise<Array<{ hash: string; message: string; date: Date }>> {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const { stdout } = await execFileAsync('git', [
        'log', `--since=${since}`, '--format=%H|%s|%aI', '--max-count=50',
      ], { cwd: this.repositoryPath, timeout: 10000 });

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [hash, message, dateStr] = line.split('|');
        return { hash, message, date: new Date(dateStr) };
      });
    } catch {
      return []; // Git not available or no commits -- non-fatal
    }
  }

  /**
   * Get recent session files for BatchContext.
   */
  private getRecentSessions(days: number): Array<{ filename: string; timestamp: Date }> {
    try {
      const sessionsDir = path.join(this.repositoryPath, '.specstory', 'history');
      if (!fs.existsSync(sessionsDir)) return [];

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const dateStr = f.substring(0, 10); // YYYY-MM-DD prefix
          return { filename: f, timestamp: new Date(dateStr) };
        })
        .filter(s => s.timestamp.getTime() >= cutoff);
    } catch {
      return [];
    }
  }

  /**
   * Ordered sequence of sub-steps across all waves.
   * Each step name maps to an agent ID in the dashboard's STEP_TO_AGENT.
   * This gives the multi-agent graph fine-grained progress visibility.
   */
  private static readonly WAVE_STEP_SEQUENCE = [
    { name: 'wave1_init',      wave: 1, phase: 'init' as const },
    { name: 'wave1_analyze',   wave: 1, phase: 'analyze' as const },
    { name: 'wave1_classify',  wave: 1, phase: 'classify' as const },
    { name: 'wave1_persist',   wave: 1, phase: 'persist' as const },
    { name: 'wave2_analyze',   wave: 2, phase: 'analyze' as const },
    { name: 'wave2_classify',  wave: 2, phase: 'classify' as const },
    { name: 'wave2_persist',   wave: 2, phase: 'persist' as const },
    { name: 'wave3_analyze',   wave: 3, phase: 'analyze' as const },
    { name: 'wave3_classify',  wave: 3, phase: 'classify' as const },
    { name: 'wave3_persist',   wave: 3, phase: 'persist' as const },
    { name: 'operator_conv',   wave: 3, phase: 'operators' as const },
    { name: 'operator_aggr',   wave: 3, phase: 'operators' as const },
    { name: 'operator_embed',  wave: 3, phase: 'operators' as const },
    { name: 'operator_dedup',  wave: 3, phase: 'operators' as const },
    { name: 'operator_pred',   wave: 3, phase: 'operators' as const },
    { name: 'operator_merge',  wave: 3, phase: 'operators' as const },
    { name: 'wave4_insights',  wave: 4, phase: 'insights' as const },
  ];

  /**
   * Update the progress file with wave status.
   * Reports granular sub-steps per wave so the dashboard multi-agent graph
   * can light up the correct agents (semantic_analysis, persistence, etc.).
   * Preserves debug state fields (singleStepMode, mockLLM, llmState).
   */
  private updateProgress(data: {
    currentWave: number;
    totalWaves: number;
    subPhase?: 'init' | 'analyze' | 'classify' | 'persist' | 'insights' | 'operators';
    message?: string;
  }): void {
    try {
      let existing: Record<string, unknown> = {};

      // Read existing progress file if it exists
      if (fs.existsSync(this.progressFile)) {
        const content = fs.readFileSync(this.progressFile, 'utf-8');
        existing = JSON.parse(content);
      }

      // Preserve debug state fields
      const preserved: Record<string, unknown> = {};
      const preserveKeys = ['singleStepMode', 'mockLLM', 'llmState', 'debug'];
      for (const key of preserveKeys) {
        if (key in existing) {
          preserved[key] = existing[key];
        }
      }

      // Determine the current sub-step name for agent graph highlighting
      const effectivePhase = data.subPhase ?? 'analyze';
      let currentStepName: string;
      if (effectivePhase === 'classify') {
        currentStepName = `wave${data.currentWave}_classify`;
      } else if (effectivePhase === 'operators' && data.message) {
        // Map operator messages to step names: "KG Operator: Context Convolution" -> "operator_conv"
        const opMap: Record<string, string> = {
          'Context Convolution': 'operator_conv',
          'Entity Aggregation': 'operator_aggr',
          'Node Embedding': 'operator_embed',
          'Deduplication': 'operator_dedup',
          'Edge Prediction': 'operator_pred',
          'Structure Fusion': 'operator_merge',
        };
        const opLabel = data.message.replace('KG Operator: ', '');
        currentStepName = opMap[opLabel] ?? `wave${data.currentWave}_${effectivePhase}`;
      } else {
        currentStepName = `wave${data.currentWave}_${effectivePhase}`;
      }

      // Find current position in the ordered step sequence
      const currentIndex = WaveController.WAVE_STEP_SEQUENCE.findIndex(
        s => s.name === currentStepName,
      );

      // Build stepsDetail with granular sub-steps that map to dashboard agents.
      // Preserve existing timestamps from previous progress writes so the dashboard
      // sees incremental transitions instead of all steps jumping at once.
      const lastIndex = WaveController.WAVE_STEP_SEQUENCE.length - 1;
      const allComplete = (data as any)._allComplete === true;
      const effectiveIndex = allComplete ? lastIndex + 1 : (currentIndex >= 0 ? currentIndex : lastIndex);
      const now = new Date().toISOString();
      const existingSteps = (existing as any).stepsDetail as Array<{
        name: string; status: string; wave: number;
        startTime?: string; endTime?: string;
        llmProvider?: string;
      }> | undefined;
      // Steps that use LLM for analysis/classification/insights
      const llmPhases = new Set(['analyze', 'classify', 'insights']);
      const stepsDetail = WaveController.WAVE_STEP_SEQUENCE.map((step, idx) => {
        const status = idx < effectiveIndex ? 'completed'
          : idx === effectiveIndex ? 'running'
          : 'pending';
        const prev = existingSteps?.find(s => s.name === step.name);
        // Preserve timestamps from previous writes
        const startTime = prev?.startTime ?? (status !== 'pending' ? now : undefined);
        const endTime = status === 'completed'
          ? (prev?.endTime ?? now)  // keep original end time if already completed
          : undefined;
        const usesLLM = llmPhases.has(step.phase);
        const captured = this.stepMetrics.get(step.name);
        return {
          name: step.name,
          status,
          wave: step.wave,
          ...(startTime && { startTime }),
          ...(endTime && { endTime }),
          ...(usesLLM && captured?.llmProvider && { llmProvider: captured.llmProvider }),
          ...(usesLLM && !captured?.llmProvider && { llmProvider: 'pending' }),
          ...(captured?.tokensUsed && { tokensUsed: captured.tokensUsed }),
          ...(captured?.llmCalls && { llmCalls: captured.llmCalls }),
          ...(captured?.outputs && { outputs: captured.outputs }),
        };
      });

      // Merge wave-specific data
      const updated = {
        ...existing,
        ...preserved,
        status: 'running',
        currentStep: currentStepName,
        currentWave: data.currentWave,
        totalWaves: data.totalWaves,
        totalSteps: WaveController.WAVE_STEP_SEQUENCE.length,
        stepsDetail,
        message: data.message ?? '',
        lastUpdated: now,
      };

      // Ensure parent directory exists
      const dir = path.dirname(this.progressFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.progressFile, JSON.stringify(updated, null, 2));
    } catch (error) {
      log('[WaveController] Failed to update progress file', 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Log a structured summary report of the wave execution.
   */
  private logSummaryReport(result: WaveExecutionResult): void {
    const line = '='.repeat(60);
    log(line, 'info');
    log('=== WAVE ANALYSIS SUMMARY ===', 'info');
    log(line, 'info');

    log(`Overall: ${result.success ? 'SUCCESS' : 'FAILED'}`, 'info');
    log(`Total entities: ${result.totalEntities}`, 'info');
    log(`  Manifest-defined: ${result.manifestEntities}`, 'info');
    log(`  Discovered: ${result.discoveredEntities}`, 'info');
    log(`Total duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`, 'info');

    log('Entities by level:', 'info');
    for (const [level, count] of Object.entries(result.entitiesByLevel)) {
      const levelName = ['Project', 'Component', 'SubComponent', 'Detail'][Number(level)] ?? `L${level}`;
      log(`  L${level} (${levelName}): ${count}`, 'info');
    }

    for (const wave of result.waves) {
      log(`Wave ${wave.wave}: ${wave.success ? 'OK' : 'FAILED'} - ${wave.totalEntities} entities in ${(wave.durationMs / 1000).toFixed(1)}s`, 'info');
      if (wave.error) {
        log(`  Error: ${wave.error}`, 'error');
      }
    }

    log(line, 'info');
  }

  // --------------------------------------------------------------------------
  // Data Helpers
  // --------------------------------------------------------------------------

  /**
   * Load existing KG entities from the graph database.
   * Maps GraphEntity format to KGEntity format for context enrichment.
   */
  private async loadExistingEntities(): Promise<KGEntity[]> {
    try {
      const graphEntities = await this.graphDB.queryEntities();

      return graphEntities.map((ge: GraphEntity): KGEntity => ({
        id: ge.name,
        name: ge.name,
        type: ge.entityType ?? 'Unknown',
        observations: Array.isArray(ge.observations)
          ? ge.observations.map((obs: unknown) =>
              typeof obs === 'string' ? obs : (obs as Record<string, string>)?.content ?? String(obs))
          : [],
        significance: ge.significance ?? 5,
        parentId: ge.metadata?.parentEntityName as string | undefined,
        level: ge.metadata?.hierarchyLevel as number | undefined,
        hierarchyPath: ge.metadata?.hierarchyPath as string | undefined,
      }));
    } catch (error) {
      log('[WaveController] Failed to load existing entities, continuing with empty set', 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Build the final WaveExecutionResult summary from all wave results.
   */
  private buildSummaryReport(
    startTime: number,
    waveResults: WaveResult[],
  ): WaveExecutionResult {
    const entitiesByLevel: Record<number, number> = {};

    for (const wave of waveResults) {
      for (const output of wave.agentOutputs) {
        for (const entity of output.entities) {
          const level = entity.level ?? 3;
          entitiesByLevel[level] = (entitiesByLevel[level] ?? 0) + 1;
        }
      }
    }

    const totalEntities = waveResults.reduce((sum, w) => sum + w.totalEntities, 0);
    const manifestEntities = waveResults.reduce((sum, w) => sum + w.manifestEntities, 0);
    const discoveredEntities = waveResults.reduce((sum, w) => sum + w.discoveredEntities, 0);
    const allSuccess = waveResults.every(w => w.success);

    return {
      success: allSuccess,
      waves: waveResults,
      totalEntities,
      totalDurationMs: Date.now() - startTime,
      entitiesByLevel,
      manifestEntities,
      discoveredEntities,
      error: allSuccess ? undefined : waveResults.find(w => !w.success)?.error,
    };
  }

  /**
   * Get component files via code-graph-rag Cypher queries.
   * Uses Memgraph's File nodes to find files associated with a component.
   * Gracefully falls back to empty array if CGR is unavailable.
   */
  private async getComponentFiles(componentName: string, keywords: string[]): Promise<string[]> {
    try {
      const { CodeGraphAgent } = await import('./code-graph-agent.js');
      const cgrAgent = new CodeGraphAgent();

      // Build a Cypher query to find files related to this component by name/keywords
      const cypher = `MATCH (f:File) WHERE toLower(f.file_path) CONTAINS toLower('${componentName}') OR ANY(k IN ['${keywords.join("','")}'] WHERE toLower(f.file_path) CONTAINS toLower(k)) RETURN f.file_path AS path LIMIT 50`;

      const result = await cgrAgent.runCypherQuery(cypher);
      const files = Array.isArray(result)
        ? result.map((r: Record<string, string>) => r.path).filter(Boolean)
        : [];

      log(`[WaveController] CGR found ${files.length} files for ${componentName}`, 'info');
      return files;
    } catch (error) {
      log(`[WaveController] CGR query failed for ${componentName}, falling back to empty file list`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

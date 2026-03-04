/**
 * Wave Analysis Type Contracts
 *
 * Shared interfaces used by WaveController and all three wave agents.
 * Defines the data contracts for hierarchical wave execution:
 *   Wave 1: L0/L1 (Project + Components)
 *   Wave 2: L2 (SubComponents)
 *   Wave 3: L3 (Detail entities)
 *
 * @module types/wave-types
 */

import type { KGEntity, KGRelation } from '../agents/kg-operators.js';
import type { ComponentManifest } from './component-manifest.js';

// ============================================================================
// Wave Controller Configuration
// ============================================================================

/**
 * Constructor configuration for WaveController.
 */
export interface WaveControllerConfig {
  /** Absolute path to the repository being analyzed */
  repositoryPath: string;
  /** Team name for knowledge graph storage (e.g. "coding") */
  team: string;
  /** Absolute path to workflow-progress.json for status updates */
  progressFile: string;
  /** Maximum number of agents to run concurrently within a single wave (default: 4) */
  maxAgentsPerWave?: number;
  /** If true, abort remaining waves when any agent fails (default: true) */
  failFast?: boolean;
}

// ============================================================================
// Child Manifest Entry
// ============================================================================

/**
 * Output from each wave agent describing what children should exist for the next wave.
 * Wave agents produce these to signal the WaveController what to spawn next.
 */
export interface ChildManifestEntry {
  /** PascalCase entity name (e.g. "ManualLearning") */
  name: string;
  /** Hierarchy level: 2 for L2 SubComponent, 3 for L3 Detail */
  level: number;
  /** Entity name of the parent node (e.g. "KnowledgeManagement") */
  parentId: string;
  /** LLM-generated description of what this child covers */
  description: string;
  /** True if this child was discovered from code analysis (not pre-defined in manifest) */
  discovered: boolean;
  /** Source files most relevant to this child component */
  suggestedFiles?: string[];
  /** Keywords for scoping code-graph-rag queries for this child */
  keywords?: string[];
}

// ============================================================================
// Wave Agent Output
// ============================================================================

/**
 * Standard output from any wave agent (Wave1ProjectAgent, Wave2ComponentAgent, Wave3DetailAgent).
 * All three agents produce this shape so WaveController can handle them uniformly.
 */
export interface WaveAgentOutput {
  /** Entities produced by this agent */
  entities: KGEntity[];
  /** Relationship edges produced by this agent (parent-child + discovered links) */
  relationships: KGRelation[];
  /** Children to spawn in the next wave */
  childManifest: ChildManifestEntry[];
  /** True if this agent was spawned from a discovery (not pre-defined in manifest) */
  discovered: boolean;
  /** Wall clock duration for this agent in milliseconds */
  durationMs: number;
  /** Entity name of the parent this agent expanded (e.g. "KnowledgeManagement") */
  parentId: string;
  /** Human-readable agent identifier for logging (e.g. "Wave2:SemanticAnalysis") */
  agentName: string;
}

// ============================================================================
// Wave Result
// ============================================================================

/**
 * Aggregated result from one complete wave (all agents for that wave combined).
 */
export interface WaveResult {
  /** Wave number: 1, 2, or 3 */
  wave: number;
  /** Individual outputs from each agent that ran in this wave */
  agentOutputs: WaveAgentOutput[];
  /** Total entity count across all agent outputs in this wave */
  totalEntities: number;
  /** Count of entities that were defined in the component manifest */
  manifestEntities: number;
  /** Count of entities discovered dynamically from code analysis */
  discoveredEntities: number;
  /** Total wall clock duration for this wave in milliseconds */
  durationMs: number;
  /** True if the wave completed without failures */
  success: boolean;
  /** Error message if success is false */
  error?: string;
}

// ============================================================================
// Wave Execution Result
// ============================================================================

/**
 * Final result from a complete three-wave execution.
 * Returned by WaveController.execute().
 */
export interface WaveExecutionResult {
  /** True if all three waves completed successfully */
  success: boolean;
  /** Individual wave results for Wave 1, 2, and 3 */
  waves: WaveResult[];
  /** Total entity count across all three waves */
  totalEntities: number;
  /** Total wall clock duration for the entire execution in milliseconds */
  totalDurationMs: number;
  /** Entity counts broken down by hierarchy level (e.g. {0: 1, 1: 8, 2: 12, 3: 45}) */
  entitiesByLevel: Record<number, number>;
  /** Total count of manifest-defined entities across all waves */
  manifestEntities: number;
  /** Total count of discovered entities across all waves */
  discoveredEntities: number;
  /** Top-level error message if success is false */
  error?: string;
}

// ============================================================================
// Wave Agent Inputs
// ============================================================================

/**
 * Input to Wave1ProjectAgent.
 * Wave 1 creates L0 (Project) and L1 (Component) nodes using the manifest as structure
 * and existing KG entities as additional context.
 */
export interface Wave1Input {
  /** The component manifest — authoritative L0/L1 structure definition */
  manifest: ComponentManifest;
  /** Existing entities in the knowledge graph (used as enrichment context) */
  existingEntities: KGEntity[];
  /** Absolute path to the repository being analyzed */
  repositoryPath: string;
}

/**
 * Input to Wave2ComponentAgent.
 * Wave 2 receives one L1 entity and expands it into L2 SubComponent nodes.
 */
export interface Wave2Input {
  /** The L1 entity this agent is expanding (parent context) */
  l1Entity: KGEntity;
  /** Source files scoped to this L1 component via code-graph-rag query */
  componentFiles: string[];
  /** Keywords from the manifest entry for this component (used for CGR scoping) */
  componentKeywords: string[];
  /** Pre-defined L2 children from the component manifest (may be extended by discovery) */
  manifestChildren: ChildManifestEntry[];
}

/**
 * Input to Wave3DetailAgent.
 * Wave 3 receives one L2 entity and discovers L3 Detail nodes from code analysis.
 */
export interface Wave3Input {
  /** The L2 entity this agent is expanding (direct parent) */
  l2Entity: KGEntity;
  /** The grandparent L1 entity (for hierarchy path construction) */
  l1Entity: KGEntity;
  /** Source files relevant to this L2 sub-component via code-graph-rag query */
  scopedFiles: string[];
}

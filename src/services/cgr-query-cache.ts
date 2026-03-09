/**
 * CgrQueryCache - Component-scoped caching layer for Code Graph RAG queries.
 *
 * Wraps CodeGraphAgent with:
 *   - Component-level Cypher query caching (Map keyed by component name)
 *   - Async index refresh with timeout and stale-data fallback
 *   - Graceful degradation: never throws, returns empty results on failure
 *
 * Consumers: WaveController (creates at wave1_init), wave agents (query per-entity)
 *
 * @module services/cgr-query-cache
 */

import { CodeGraphAgent } from '../agents/code-graph-agent.js';
import type { CodeEntity, CodeRelationship } from '../agents/code-graph-agent.js';
import { log } from '../logging.js';

// ============================================================================
// Result Interfaces
// ============================================================================

/** Cached data for a component's code entities and relationships */
export interface CgrComponentData {
  /** Code entities found in the component's files */
  entities: CodeEntity[];
  /** Relationships between entities in the component */
  relationships: CodeRelationship[];
  /** Number of source files scanned */
  fileCount: number;
  /** Timestamp when this data was fetched */
  fetchedAt: number;
}

/** Detailed entity information including callees and imports */
export interface CgrEntityDetails {
  /** Code entities matching the query */
  entities: CodeEntity[];
  /** Names of functions/methods called by the entity */
  callees: string[];
  /** Import paths used by the entity */
  imports: string[];
  /** Function/method signatures */
  signatures: string[];
}

/** Call graph traversal result */
export interface CgrCallGraphResult {
  /** Caller-callee chains discovered */
  chains: Array<{
    caller: string;
    callee: string;
    callerQN?: string;
    calleeQN?: string;
  }>;
  /** Traversal depth used */
  depth: number;
}

// ============================================================================
// CgrQueryCache
// ============================================================================

export class CgrQueryCache {
  private cache = new Map<string, CgrComponentData>();
  private cgrAgent: CodeGraphAgent;
  private available = true;
  private refreshPromise: Promise<void> | null = null;

  /** Running query counter for stats */
  private queriesMade = 0;
  /** Running cache hit counter for stats */
  private cacheHits = 0;

  constructor(repositoryPath: string) {
    this.cgrAgent = new CodeGraphAgent(repositoryPath);
  }

  /**
   * Trigger an async index refresh with timeout.
   * Fire-and-forget: stores promise internally so ensureReady() can await it.
   * On timeout or error, logs warning and sets available = false.
   */
  async refreshIndex(timeoutMs: number = 30000): Promise<void> {
    this.refreshPromise = this.doRefreshIndex(timeoutMs);
    // Fire-and-forget -- do not await here
    this.refreshPromise.catch(() => {
      // Errors handled inside doRefreshIndex
    });
  }

  private async doRefreshIndex(timeoutMs: number): Promise<void> {
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`CGR index refresh timed out after ${timeoutMs}ms`)), timeoutMs),
      );

      const refreshWork = async (): Promise<void> => {
        const indexStatus = await this.cgrAgent.hasExistingIndex();
        const hasIndex = indexStatus.hasData;
        log('[CgrQueryCache] Index check complete', 'info', { hasIndex, nodeCount: indexStatus.nodeCount });

        await this.cgrAgent.indexRepository({
          target_path: undefined,
          forceReindex: !hasIndex,
        });
        log('[CgrQueryCache] Index refresh complete', 'info');
      };

      await Promise.race([refreshWork(), timeoutPromise]);
      this.available = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`[CgrQueryCache] Index refresh failed: ${msg}`, 'warning');
      this.available = false;
    }
  }

  /** Await pending index refresh if one is in progress */
  async ensureReady(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
    }
  }

  /** Whether CGR is available for queries */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Query code entities scoped to a component by name and keywords.
   * Results are cached by component name.
   */
  async queryComponentEntities(componentName: string, keywords: string[]): Promise<CodeEntity[]> {
    if (!this.available) return [];

    // Check cache
    const cached = this.cache.get(componentName);
    if (cached) {
      this.cacheHits++;
      this.queriesMade++;
      return cached.entities;
    }

    try {
      await this.ensureReady();
      this.queriesMade++;

      const safeName = this.sanitizeCypher(componentName);
      const cypher = `MATCH (f:File)-[:DEFINES]->(e) WHERE toLower(f.file_path) CONTAINS toLower('${safeName}') RETURN e LIMIT 50`;

      const result = await this.cgrAgent.runCypherQuery(cypher);
      const entities: CodeEntity[] = Array.isArray(result) ? result.map((r: any) => this.mapToCodeEntity(r)) : [];

      // Cache the result
      this.cache.set(componentName, {
        entities,
        relationships: [],
        fileCount: new Set(entities.map(e => e.filePath)).size,
        fetchedAt: Date.now(),
      });

      return entities;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`[CgrQueryCache] queryComponentEntities failed for ${componentName}: ${msg}`, 'warning');
      return [];
    }
  }

  /**
   * Query detailed entity information including callees and imports.
   * NOT cached (per-entity, not per-component).
   */
  async queryEntityDetails(entityName: string, componentFiles: string[]): Promise<CgrEntityDetails> {
    const empty: CgrEntityDetails = { entities: [], callees: [], imports: [], signatures: [] };
    if (!this.available) return empty;

    try {
      await this.ensureReady();
      this.queriesMade++;

      const safeName = this.sanitizeCypher(entityName);

      // Query for entity signatures
      const entityQuery = `MATCH (e) WHERE toLower(e.name) = toLower('${safeName}') RETURN e LIMIT 10`;
      const entityResult = await this.cgrAgent.runCypherQuery(entityQuery);
      const entities: CodeEntity[] = Array.isArray(entityResult)
        ? entityResult.map((r: any) => this.mapToCodeEntity(r))
        : [];

      // Query for callees
      const calleeQuery = `MATCH (e)-[:CALLS]->(callee) WHERE toLower(e.name) = toLower('${safeName}') RETURN DISTINCT callee.name AS name LIMIT 20`;
      const calleeResult = await this.cgrAgent.runCypherQuery(calleeQuery);
      const callees: string[] = Array.isArray(calleeResult)
        ? calleeResult.map((r: any) => r.name || r.callee?.name || '').filter(Boolean)
        : [];

      // Query for imports
      const importQuery = `MATCH (e)-[:IMPORTS]->(imp) WHERE toLower(e.name) = toLower('${safeName}') RETURN DISTINCT imp.name AS name LIMIT 20`;
      const importResult = await this.cgrAgent.runCypherQuery(importQuery);
      const imports: string[] = Array.isArray(importResult)
        ? importResult.map((r: any) => r.name || r.imp?.name || '').filter(Boolean)
        : [];

      const signatures = entities
        .map(e => e.signature)
        .filter((s): s is string => !!s);

      return { entities, callees, imports, signatures };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`[CgrQueryCache] queryEntityDetails failed for ${entityName}: ${msg}`, 'warning');
      return empty;
    }
  }

  /**
   * Query call graph traversal to specified depth.
   * NOT cached.
   */
  async queryCallGraph(entityName: string, depth: number = 2): Promise<CgrCallGraphResult> {
    const empty: CgrCallGraphResult = { chains: [], depth };
    if (!this.available) return empty;

    try {
      await this.ensureReady();
      this.queriesMade++;

      const safeName = this.sanitizeCypher(entityName);
      const cypher = `MATCH path = (e)-[:CALLS*1..${depth}]->(callee) WHERE toLower(e.name) = toLower('${safeName}') UNWIND relationships(path) AS rel RETURN startNode(rel).name AS caller, endNode(rel).name AS callee, startNode(rel).qualified_name AS callerQN, endNode(rel).qualified_name AS calleeQN LIMIT 50`;

      const result = await this.cgrAgent.runCypherQuery(cypher);
      const chains = Array.isArray(result)
        ? result.map((r: any) => ({
            caller: r.caller || '',
            callee: r.callee || '',
            callerQN: r.callerQN || undefined,
            calleeQN: r.calleeQN || undefined,
          }))
        : [];

      return { chains, depth };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`[CgrQueryCache] queryCallGraph failed for ${entityName}: ${msg}`, 'warning');
      return empty;
    }
  }

  /** Get statistics for dashboard reporting */
  getStats(): { queriesMade: number; cacheHits: number; available: boolean } {
    return {
      queriesMade: this.queriesMade,
      cacheHits: this.cacheHits,
      available: this.available,
    };
  }

  /** Escape single quotes and backslashes for Cypher injection prevention */
  private sanitizeCypher(input: string): string {
    return input.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /** Map a raw Cypher result row to a CodeEntity */
  private mapToCodeEntity(row: any): CodeEntity {
    const e = row.e || row;
    return {
      id: e.id || e.name || '',
      name: e.name || '',
      type: e.type || 'function',
      filePath: e.file_path || e.filePath || '',
      lineNumber: e.line_number || e.lineNumber || 0,
      language: e.language || 'typescript',
      signature: e.signature || undefined,
      docstring: e.docstring || undefined,
      complexity: e.complexity || undefined,
      relationships: [],
    };
  }
}

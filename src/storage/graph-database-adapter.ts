/**
 * GraphDatabaseAdapter
 *
 * Adapter for the main coding system's GraphDatabaseService.
 * Provides type-safe interface for MCP server agents to interact with
 * the central Graphology + LevelDB knowledge graph.
 *
 * LOCK-FREE ARCHITECTURE:
 * - Uses VKB HTTP API when server is running (lock-free access)
 * - Falls back to direct GraphDatabaseService when server is stopped
 * - Prevents LevelDB lock conflicts
 */

import { GraphDatabaseService } from '../knowledge-management/GraphDatabaseService.js';
import { log } from '../logging.js';

// Dynamic import to avoid TypeScript compilation issues
let VkbApiClient: any;

export interface GraphEntity {
  name: string;
  entityType?: string;
  observations?: any[];
  confidence?: number;
  source?: string;
  significance?: number;
  relationships?: Array<{
    from: string;
    to: string;
    relationType: string;
  }>;
  metadata?: Record<string, any>;
  [key: string]: any;
}

export interface GraphStorageOptions {
  team: string;
}

export class GraphDatabaseAdapter {
  private graphDB: GraphDatabaseService | null = null;
  private graphExporter: any = null; // GraphKnowledgeExporter for JSON sync
  private apiClient: any = null;
  private isInitialized = false;
  private useApi = false;
  private readonly dbPath: string;
  private readonly team: string;

  constructor(dbPath: string = '/Users/q284340/Agentic/coding/.data/knowledge-graph', team: string = 'coding') {
    this.dbPath = dbPath;
    this.team = team;
  }

  /**
   * Initialize the graph database connection
   * Uses intelligent routing: VKB API if available, direct access otherwise
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log('GraphDatabaseAdapter already initialized', 'debug');
      return;
    }

    try {
      // Dynamically import VkbApiClient to avoid TS compilation issues
      if (!VkbApiClient) {
        // Extract repository root from dbPath (remove /.data/knowledge-graph)
        const repoRoot = this.dbPath.replace(/\/.data\/knowledge-graph$/, '');
        const vkbClientPath = `${repoRoot}/lib/ukb-unified/core/VkbApiClient.js`;
        const module = await import(vkbClientPath);
        VkbApiClient = module.VkbApiClient;
      }

      // Initialize API client
      this.apiClient = new VkbApiClient({ debug: false });

      // Check if VKB server is available
      this.useApi = await this.apiClient.isServerAvailable();

      if (this.useApi) {
        log('GraphDatabaseAdapter using VKB API (server is running)', 'info');
      } else {
        log('GraphDatabaseAdapter using direct access (server is stopped)', 'info');

        // Import is dynamic because GraphDatabaseService is JavaScript
        this.graphDB = new GraphDatabaseService({
          dbPath: this.dbPath,
          config: {
            autoPersist: true, // Enable auto-persistence to LevelDB
            persistIntervalMs: 30000 // Persist every 30 seconds
          }
        });

        await this.graphDB.initialize();

        // CRITICAL: Attach GraphKnowledgeExporter to maintain JSON sync
        // Without this, events like entity:stored are emitted but no one listens,
        // causing JSON export files to become stale/out-of-sync
        try {
          const repoRoot = this.dbPath.replace(/\/.data\/knowledge-graph$/, '');
          const exporterPath = `${repoRoot}/src/knowledge-management/GraphKnowledgeExporter.js`;
          const { GraphKnowledgeExporter } = await import(exporterPath);

          const exportDir = this.dbPath.replace(/knowledge-graph$/, 'knowledge-export');
          this.graphExporter = new GraphKnowledgeExporter(this.graphDB, {
            exportDir,
            debounceMs: 2000 // Debounce exports to avoid excessive writes
          });

          log('GraphKnowledgeExporter attached for JSON sync', 'info', { exportDir });
        } catch (exporterError) {
          // Log but don't fail - JSON export is important but not critical for operation
          log('Failed to attach GraphKnowledgeExporter for JSON sync', 'warning', exporterError);
        }
      }

      this.isInitialized = true;

      log('GraphDatabaseAdapter initialized successfully', 'info', {
        mode: this.useApi ? 'API' : 'Direct',
        dbPath: this.dbPath,
        team: this.team
      });
    } catch (error) {
      log('Failed to initialize GraphDatabaseAdapter', 'error', error);
      throw new Error(`GraphDatabaseAdapter initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Store an entity in the graph database
   * Uses intelligent routing: API or direct access
   */
  async storeEntity(entity: GraphEntity): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      // Validate entityType is present and classified - NO FALLBACKS
      if (!entity.entityType || entity.entityType === 'Unclassified') {
        throw new Error(`Cannot store entity "${entity.name}": entityType is missing or Unclassified. Entity must be classified before persistence. NO FALLBACKS.`);
      }
      const entityToStore = {
        ...entity,
        entityType: entity.entityType  // Must be a valid ontology class
      };

      let nodeId: string;

      if (this.useApi) {
        // Use VKB API
        const result = await this.apiClient.createEntity({
          ...entityToStore,
          team: this.team
        });
        nodeId = result.nodeId || entity.name;
      } else {
        // Use direct database access
        if (!this.graphDB) {
          throw new Error('GraphDatabaseService not available');
        }
        nodeId = await this.graphDB.storeEntity(entityToStore, { team: this.team });
      }

      log('Entity stored in graph database', 'info', {
        mode: this.useApi ? 'API' : 'Direct',
        nodeId,
        entityName: entity.name,
        entityType: entityToStore.entityType
      });

      // Store relationships if provided
      if (entity.relationships && entity.relationships.length > 0) {
        for (const rel of entity.relationships) {
          await this.storeRelationship(rel);
        }
      }

      return nodeId;
    } catch (error) {
      log('Failed to store entity in graph database', 'error', error);
      throw error;
    }
  }

  /**
   * Store a relationship in the graph database
   * Uses intelligent routing: API or direct access
   */
  async storeRelationship(relationship: {
    from: string;
    to: string;
    relationType: string;
  }): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      if (this.useApi) {
        // Use VKB API (expects 'type' not 'relationType')
        await this.apiClient.createRelation({
          from: relationship.from,
          to: relationship.to,
          type: relationship.relationType,
          team: this.team
        });
      } else {
        // Use direct database access
        if (!this.graphDB) {
          throw new Error('GraphDatabaseService not available');
        }
        await this.graphDB.storeRelationship(
          relationship.from,
          relationship.to,
          relationship.relationType,
          { team: this.team }
        );
      }

      log('Relationship stored in graph database', 'debug', {
        mode: this.useApi ? 'API' : 'Direct',
        from: relationship.from,
        to: relationship.to,
        relationType: relationship.relationType
      });
    } catch (error) {
      log('Failed to store relationship in graph database', 'error', error);
      throw error;
    }
  }

  /**
   * Query entities from the graph database
   */
  async queryEntities(filters?: {
    entityType?: string;
    namePattern?: string;
    minConfidence?: number;
    searchTerm?: string;
    team?: string;
  }): Promise<any[]> {
    if (!this.isInitialized) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      if (this.useApi) {
        // Use VKB API
        const result = await this.apiClient.getEntities({
          team: this.team,
          ...filters
        });
        return result.entities || result || [];
      } else {
        // Use direct database access
        if (!this.graphDB) {
          throw new Error('GraphDatabaseService not available');
        }
        const result = await this.graphDB.queryEntities({
          team: this.team,
          ...filters
        });
        return result;
      }
    } catch (error) {
      log('Failed to query entities from graph database', 'error', error);
      throw error;
    }
  }

  /**
   * Get statistics about the graph database
   */
  async getStatistics(): Promise<any> {
    if (!this.isInitialized || !this.graphDB) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      return await this.graphDB.getStatistics({ team: this.team });
    } catch (error) {
      log('Failed to get statistics from graph database', 'error', error);
      throw error;
    }
  }

  /**
   * Export graph data to JSON (for compatibility/backup)
   * Supports both VKB API and direct GraphDatabaseService access
   */
  async exportToJSON(outputPath: string): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      if (this.useApi && this.apiClient) {
        // Use VKB API for export
        await this.apiClient.exportTeam(this.team, outputPath);
        log('Graph data exported to JSON via VKB API', 'info', { outputPath, team: this.team });
      } else if (this.graphDB) {
        // Use direct GraphDatabaseService access
        await this.graphDB.exportToJSON(this.team, outputPath);
        log('Graph data exported to JSON via direct access', 'info', { outputPath, team: this.team });
      } else {
        throw new Error('No database access available');
      }
    } catch (error) {
      log('Failed to export graph data to JSON', 'error', error);
      throw error;
    }
  }

  /**
   * Delete an entity from the graph database
   * Used by ContentValidationAgent to remove stale entities
   * Supports both VKB API and direct GraphDatabaseService access
   */
  async deleteEntity(entityId: string): Promise<boolean> {
    if (!this.isInitialized) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      if (this.useApi && this.apiClient) {
        // Use VKB API for deletion
        await this.apiClient.deleteEntity(entityId, { team: this.team });
        log('Entity deleted via VKB API', 'info', { entityId, team: this.team });
        return true;
      } else if (this.graphDB) {
        // Use direct GraphDatabaseService access
        // EntityId might be "team:name" or just "name" - extract the name part
        const entityName = entityId.includes(':') ? entityId.split(':')[1] : entityId;
        await this.graphDB.deleteEntity(entityName, this.team);
        log('Entity deleted via direct GraphDB access', 'info', { entityId, entityName, team: this.team });
        return true;
      } else {
        throw new Error('No database access available. Neither VKB API nor GraphDatabaseService is initialized.');
      }
    } catch (error) {
      log('Failed to delete entity from graph database', 'error', { entityId, error });
      throw error;
    }
  }

  /**
   * Close the graph database connection
   */
  async close(): Promise<void> {
    if (!this.isInitialized || !this.graphDB) {
      return;
    }

    try {
      // Clean up exporter if it exists
      if (this.graphExporter) {
        this.graphExporter = null;
      }

      await this.graphDB.close();
      this.isInitialized = false;
      this.graphDB = null;
      log('GraphDatabaseAdapter closed successfully', 'info');
    } catch (error) {
      log('Failed to close GraphDatabaseAdapter', 'error', error);
      throw error;
    }
  }

  /**
   * Check if the adapter is initialized
   */
  get initialized(): boolean {
    return this.isInitialized;
  }
}

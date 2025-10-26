/**
 * GraphDatabaseAdapter
 *
 * Adapter for the main coding system's GraphDatabaseService.
 * Provides type-safe interface for MCP server agents to interact with
 * the central Graphology + LevelDB knowledge graph.
 */

import { GraphDatabaseService } from '../../../../src/knowledge-management/GraphDatabaseService.js';
import { log } from '../logging.js';

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
  private isInitialized = false;
  private readonly dbPath: string;
  private readonly team: string;

  constructor(dbPath: string = '/Users/q284340/Agentic/coding/.data/knowledge-graph', team: string = 'coding') {
    this.dbPath = dbPath;
    this.team = team;
  }

  /**
   * Initialize the graph database connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      log('GraphDatabaseAdapter already initialized', 'debug');
      return;
    }

    try {
      // Import is dynamic because GraphDatabaseService is JavaScript
      this.graphDB = new GraphDatabaseService({
        dbPath: this.dbPath,
        config: {
          autoPersist: true, // Enable auto-persistence to LevelDB
          persistIntervalMs: 30000 // Persist every 30 seconds
        }
      });

      await this.graphDB.initialize();
      this.isInitialized = true;

      log('GraphDatabaseAdapter initialized successfully', 'info', {
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
   */
  async storeEntity(entity: GraphEntity): Promise<string> {
    if (!this.isInitialized || !this.graphDB) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      // Ensure entityType has a default value
      const entityToStore = {
        ...entity,
        entityType: entity.entityType || 'Unknown'
      };

      const nodeId = await this.graphDB.storeEntity(entityToStore, { team: this.team });

      log('Entity stored in graph database', 'info', {
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
   */
  async storeRelationship(relationship: {
    from: string;
    to: string;
    relationType: string;
  }): Promise<void> {
    if (!this.isInitialized || !this.graphDB) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      await this.graphDB.storeRelationship(
        relationship.from,
        relationship.to,
        relationship.relationType,
        { team: this.team }
      );

      log('Relationship stored in graph database', 'debug', {
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
  }): Promise<any[]> {
    if (!this.isInitialized || !this.graphDB) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      const result = await this.graphDB.queryEntities({
        team: this.team,
        ...filters
      });

      return result;
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
   */
  async exportToJSON(outputPath: string): Promise<void> {
    if (!this.isInitialized || !this.graphDB) {
      throw new Error('GraphDatabaseAdapter not initialized. Call initialize() first.');
    }

    try {
      await this.graphDB.exportToJSON(this.team, outputPath);
      log('Graph data exported to JSON', 'info', { outputPath });
    } catch (error) {
      log('Failed to export graph data to JSON', 'error', error);
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

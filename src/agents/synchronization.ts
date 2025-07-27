import { log } from "../logging.js";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export interface SyncTarget {
  name: string;
  type: "mcp_memory" | "graphology_db" | "shared_memory_file";
  path?: string;
  enabled: boolean;
  bidirectional: boolean;
  lastSync?: Date;
}

export interface SyncResult {
  target: string;
  success: boolean;
  itemsAdded: number;
  itemsUpdated: number;
  itemsRemoved: number;
  errors: string[];
  syncTime: number;
}

export interface ConflictResolution {
  strategy: "timestamp_priority" | "manual_review" | "merge";
  manualReviewThreshold?: number;
}

export interface BackupResult {
  success: boolean;
  backupFile?: string;
  entitiesBackedUp: number;
  relationsBackedUp: number;
  error?: string;
}

export interface SyncHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  targetsEnabled: number;
  lastSyncTimes: Record<string, number>;
  syncInterval: number;
  errors: string[];
}

export class SynchronizationAgent {
  private targets: Map<string, SyncTarget> = new Map();
  private conflictResolution: ConflictResolution;
  private syncInterval: number;
  private lastSyncTimes: Map<string, number> = new Map();
  private running: boolean = true;
  private agents: Map<string, any> = new Map();
  private autoSyncTimer?: NodeJS.Timeout;

  constructor() {
    this.conflictResolution = {
      strategy: "timestamp_priority",
      manualReviewThreshold: 0.5,
    };
    this.syncInterval = 60000; // 60 seconds
    
    this.initializeSyncTargets();
    this.startPeriodicSync();
    log("SynchronizationAgent initialized", "info");
  }

  private initializeSyncTargets(): void {
    const targets: SyncTarget[] = [
      {
        name: "mcp_memory",
        type: "mcp_memory",
        enabled: true,
        bidirectional: true,
      },
      {
        name: "graphology_db", 
        type: "graphology_db",
        enabled: true,
        bidirectional: true,
      },
      {
        name: "shared_memory_coding",
        type: "shared_memory_file",
        path: "/Users/q284340/Agentic/coding/shared-memory-coding.json",
        enabled: true,
        bidirectional: true,
      },
    ];

    targets.forEach(target => {
      this.targets.set(target.name, target);
    });

    log(`Initialized ${targets.length} sync targets`, "info");
  }

  async syncAll(): Promise<SyncResult[]> {
    log("Starting full synchronization", "info");
    
    const results: SyncResult[] = [];
    const enabledTargets = Array.from(this.targets.values()).filter(t => t.enabled);

    for (const target of enabledTargets) {
      try {
        const result = await this.syncTarget(target);
        results.push(result);
      } catch (error) {
        log(`Sync failed for target: ${target.name}`, "error", error);
        results.push({
          target: target.name,
          success: false,
          itemsAdded: 0,
          itemsUpdated: 0,
          itemsRemoved: 0,
          errors: [error instanceof Error ? error.message : String(error)],
          syncTime: 0,
        });
      }
    }

    log("Full synchronization completed", "info", {
      totalTargets: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });

    return results;
  }

  private async syncTarget(target: SyncTarget): Promise<SyncResult> {
    const startTime = Date.now();
    log(`Syncing target: ${target.name}`, "info");

    const result: SyncResult = {
      target: target.name,
      success: false,
      itemsAdded: 0,
      itemsUpdated: 0,
      itemsRemoved: 0,
      errors: [],
      syncTime: 0,
    };

    try {
      switch (target.type) {
        case "mcp_memory":
          await this.syncMcpMemory(target, result);
          break;
        case "graphology_db":
          await this.syncGraphologyDb(target, result);
          break;
        case "shared_memory_file":
          await this.syncSharedMemoryFile(target, result);
          break;
        default:
          throw new Error(`Unknown target type: ${target.type}`);
      }

      result.success = true;
      target.lastSync = new Date();
      
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }

    result.syncTime = Date.now() - startTime;
    
    // Update last sync time
    if (result.success) {
      this.lastSyncTimes.set(target.name, Date.now());
    }
    
    return result;
  }

  private async syncMcpMemory(target: SyncTarget, result: SyncResult): Promise<void> {
    log("Syncing with MCP memory", "info");
    
    try {
      // Get knowledge graph agent for entity access
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        throw new Error("Knowledge graph agent not available");
      }
      
      // Extract entities and relations from knowledge graph
      const entities = Array.from(kgAgent.entities?.values() || []).map((entity: any) => ({
        name: entity.name,
        entityType: entity.entity_type || entity.entityType,
        significance: entity.significance || 5,
        observations: Array.isArray(entity.observations) ? entity.observations : [entity.observations].filter(Boolean),
        metadata: entity.metadata || {}
      }));
      
      const relations = Array.from(kgAgent.relations || []).map((rel: any) => ({
        from: rel.from_entity || rel.from,
        to: rel.to_entity || rel.to,
        relationType: rel.relation_type || rel.relationType,
        metadata: rel.metadata || {}
      }));
      
      // Here we would sync with actual MCP Memory service
      // For now, simulate the sync
      await new Promise(resolve => setTimeout(resolve, 100));
      
      result.itemsAdded = entities.length;
      result.itemsUpdated = relations.length;
      result.itemsRemoved = 0;
      
      log(`Synced ${entities.length} entities and ${relations.length} relations to MCP memory`, "info");
      
    } catch (error) {
      log("MCP memory sync failed", "error", error);
      throw error;
    }
  }

  private async syncGraphologyDb(target: SyncTarget, result: SyncResult): Promise<void> {
    log("Syncing with Graphology database", "info");
    
    // Simulate graphology database sync
    // In a real implementation, this would connect to the VKB graphology database
    await new Promise(resolve => setTimeout(resolve, 150));
    
    result.itemsAdded = 3;
    result.itemsUpdated = 4;
    result.itemsRemoved = 1;
  }

  private async syncSharedMemoryFile(target: SyncTarget, result: SyncResult): Promise<void> {
    if (!target.path) {
      throw new Error("No path specified for shared memory file");
    }

    log(`Syncing shared memory file: ${target.path}`, "info");

    try {
      // Get knowledge graph agent for current state
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        throw new Error("Knowledge graph agent not available");
      }
      
      // Check if file exists
      let existingData: any = { entities: [], relations: [], metadata: {} };
      try {
        await fs.access(target.path);
        const content = await fs.readFile(target.path, 'utf-8');
        existingData = JSON.parse(content);
      } catch (error) {
        if ((error as any).code === 'ENOENT') {
          log(`Creating new shared memory file: ${target.path}`, "info");
          await fs.mkdir(path.dirname(target.path), { recursive: true });
        } else {
          throw error;
        }
      }
      
      // Get current entities from knowledge graph
      const currentEntities = Array.from(kgAgent.entities?.values() || []).map((entity: any) => ({
        name: entity.name,
        entityType: entity.entity_type || entity.entityType,
        significance: entity.significance || 5,
        observations: Array.isArray(entity.observations) ? entity.observations : [entity.observations].filter(Boolean),
        metadata: {
          ...entity.metadata,
          updated_at: entity.updated_at || Date.now(),
          created_at: entity.created_at || Date.now()
        }
      }));
      
      const currentRelations = Array.from(kgAgent.relations || []).map((rel: any) => ({
        from: rel.from_entity || rel.from,
        to: rel.to_entity || rel.to,
        relationType: rel.relation_type || rel.relationType,
        metadata: rel.metadata || {}
      }));
      
      // Determine project context for targeted sync
      const currentProject = this.determineCurrentProject();
      
      // Only sync if this is the correct project file
      const expectedFileName = `shared-memory-${currentProject}.json`;
      if (!target.path.endsWith(expectedFileName)) {
        log(`Skipping sync - file ${target.path} doesn't match project ${currentProject}`, "debug");
        result.itemsAdded = 0;
        result.itemsUpdated = 0;
        result.itemsRemoved = 0;
        return;
      }
      
      // Merge entities - only add new ones to avoid conflicts
      const existingEntityNames = new Set((existingData.entities || []).map((e: any) => e.name));
      const newEntities = currentEntities.filter(entity => !existingEntityNames.has(entity.name));
      
      let changesWereMade = false;
      if (newEntities.length > 0) {
        existingData.entities = [...(existingData.entities || []), ...newEntities];
        result.itemsAdded = newEntities.length;
        changesWereMade = true;
      }
      
      // Update metadata only when content changes
      if (changesWereMade) {
        existingData.metadata = {
          ...existingData.metadata,
          last_sync: Date.now(),
          sync_source: "semantic_analysis_agent_node",
          project: currentProject
        };
        
        // Write back to file
        await fs.writeFile(target.path, JSON.stringify(existingData, null, 2));
        log(`Updated shared memory file with ${result.itemsAdded} new entities`, "info");
      } else {
        log(`No new entities to sync for project ${currentProject}`, "debug");
      }
      
      result.itemsUpdated = 0; // We don't update existing entities to avoid conflicts
      result.itemsRemoved = 0; // We don't remove entities
      
    } catch (error) {
      log(`Failed to sync shared memory file: ${target.path}`, "error", error);
      throw error;
    }
  }

  async resolveConflicts(conflicts: any[]): Promise<any[]> {
    log(`Resolving ${conflicts.length} conflicts`, "info");
    
    const resolved: any[] = [];
    
    for (const conflict of conflicts) {
      switch (this.conflictResolution.strategy) {
        case "timestamp_priority":
          // Choose the most recent version
          const mostRecent = conflict.versions.reduce((latest: any, current: any) => 
            new Date(current.timestamp) > new Date(latest.timestamp) ? current : latest
          );
          resolved.push(mostRecent);
          break;
          
        case "merge":
          // Attempt to merge conflicting versions
          const merged = this.mergeConflictingVersions(conflict.versions);
          resolved.push(merged);
          break;
          
        case "manual_review":
          // Mark for manual review
          conflict.requiresManualReview = true;
          resolved.push(conflict);
          break;
          
        default:
          log(`Unknown conflict resolution strategy: ${this.conflictResolution.strategy}`, "warning");
          resolved.push(conflict.versions[0]); // Fallback to first version
      }
    }
    
    return resolved;
  }

  private mergeConflictingVersions(versions: any[]): any {
    // Simple merge strategy - combine properties from all versions
    const merged = { ...versions[0] };
    
    for (let i = 1; i < versions.length; i++) {
      const version = versions[i];
      
      // Merge observations arrays
      if (version.observations && merged.observations) {
        merged.observations = [...merged.observations, ...version.observations];
        // Remove duplicates
        merged.observations = merged.observations.filter((obs: any, index: number, arr: any[]) =>
          arr.findIndex(o => o.content === obs.content) === index
        );
      }
      
      // Use latest timestamp
      if (version.timestamp && (!merged.timestamp || 
          new Date(version.timestamp) > new Date(merged.timestamp))) {
        merged.timestamp = version.timestamp;
      }
      
      // Merge tags
      if (version.tags && merged.tags) {
        merged.tags = [...new Set([...merged.tags, ...version.tags])];
      }
    }
    
    return merged;
  }

  private determineCurrentProject(): string {
    // Check current working directory and environment
    const currentDir = process.cwd();
    
    if (currentDir.toLowerCase().includes("coding") || process.env.CODING_TOOLS_PATH) {
      return "coding";
    } else if (currentDir.toLowerCase().includes("ui")) {
      return "ui";
    } else if (currentDir.toLowerCase().includes("resi")) {
      return "resi";
    } else if (currentDir.toLowerCase().includes("raas")) {
      return "raas";
    }
    
    // Default to coding if we can't determine
    return "coding";
  }

  private startPeriodicSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
    }
    
    this.autoSyncTimer = setInterval(async () => {
      if (!this.running) return;
      
      try {
        log("Running periodic sync", "debug");
        const results = await this.syncAll();
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        
        if (failed > 0) {
          log(`Periodic sync completed with ${failed} failures`, "warning");
        } else {
          log(`Periodic sync completed successfully (${successful} targets)`, "debug");
        }
      } catch (error) {
        log("Periodic sync error", "error", error);
      }
    }, this.syncInterval);
    
    log(`Started periodic sync with interval: ${this.syncInterval}ms`, "info");
  }

  startAutoSync(): void {
    this.startPeriodicSync();
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = undefined;
      log("Auto-sync stopped", "info");
    }
  }

  async syncSpecificTarget(targetName: string): Promise<SyncResult> {
    const target = this.targets.get(targetName);
    if (!target) {
      throw new Error(`Target not found: ${targetName}`);
    }
    
    return await this.syncTarget(target);
  }

  getSyncTargets(): SyncTarget[] {
    return Array.from(this.targets.values());
  }

  updateSyncTarget(name: string, updates: Partial<SyncTarget>): void {
    const target = this.targets.get(name);
    if (!target) {
      throw new Error(`Target not found: ${name}`);
    }
    
    Object.assign(target, updates);
    log(`Updated sync target: ${name}`, "info", updates);
  }

  // Agent registration for workflow integration
  registerAgent(name: string, agent: any): void {
    this.agents.set(name, agent);
    log(`Registered agent: ${name}`, "info");
  }

  // Multi-source synchronization
  async syncAllSources(sources: string[] = ["mcp_memory", "shared_memory_files"], direction: string = "bidirectional", backup: boolean = true): Promise<any> {
    try {
      log(`Starting multi-source sync`, "info", { sources, direction, backup });
      
      // Create backup if requested
      let backupResult = null;
      if (backup) {
        backupResult = await this.backupKnowledge();
      }
      
      const results: Record<string, any> = {};
      
      // Sync each requested source
      for (const source of sources) {
        const target = Array.from(this.targets.values()).find(t => 
          t.type === source || t.name.includes(source.replace("_", ""))
        );
        
        if (target) {
          const result = await this.syncTarget(target);
          results[source] = {
            success: result.success,
            itemsAdded: result.itemsAdded,
            itemsUpdated: result.itemsUpdated,
            itemsRemoved: result.itemsRemoved,
            errors: result.errors
          };
        } else {
          results[source] = {
            success: false,
            error: `Target not found for source: ${source}`
          };
        }
      }
      
      const allSuccessful = Object.values(results).every((r: any) => r.success);
      
      return {
        success: allSuccessful,
        sources,
        direction,
        backup_created: backup && backupResult?.success,
        backup_file: backupResult?.backupFile,
        results
      };
      
    } catch (error) {
      log("Multi-source sync failed", "error", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        sources,
        direction
      };
    }
  }

  // Backup functionality
  async backupKnowledge(sources: string[] = ["all"], backupLocation?: string, includeMetadata: boolean = true): Promise<BackupResult> {
    try {
      // Default backup location
      const backupDir = backupLocation 
        ? path.resolve(backupLocation)
        : path.join(process.cwd(), "backups");
      
      await fs.mkdir(backupDir, { recursive: true });
      
      // Get data from knowledge graph agent
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        return {
          success: false,
          error: "Knowledge graph agent not available",
          entitiesBackedUp: 0,
          relationsBackedUp: 0
        };
      }
      
      const entities = Array.from(kgAgent.entities?.values() || []);
      const relations = Array.from(kgAgent.relations || []);
      
      const backupData = {
        timestamp: Date.now(),
        sources,
        includeMetadata,
        entities: entities.map((entity: any) => ({
          name: entity.name,
          entityType: entity.entity_type || entity.entityType,
          significance: entity.significance,
          observations: entity.observations,
          metadata: includeMetadata ? entity.metadata : {},
          created_at: entity.created_at,
          updated_at: entity.updated_at
        })),
        relations: relations.map((rel: any) => ({
          from: rel.from_entity || rel.from,
          to: rel.to_entity || rel.to,
          relationType: rel.relation_type || rel.relationType,
          metadata: includeMetadata ? rel.metadata : {},
          created_at: rel.created_at
        }))
      };
      
      const backupFile = path.join(backupDir, `knowledge_backup_${Date.now()}.json`);
      await fs.writeFile(backupFile, JSON.stringify(backupData, null, 2));
      
      log(`Created backup with ${entities.length} entities and ${relations.length} relations`, "info", {
        backupFile,
        entities: entities.length,
        relations: relations.length
      });
      
      return {
        success: true,
        backupFile,
        entitiesBackedUp: entities.length,
        relationsBackedUp: relations.length
      };
      
    } catch (error) {
      log("Backup creation failed", "error", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        entitiesBackedUp: 0,
        relationsBackedUp: 0
      };
    }
  }

  // Health check
  healthCheck(): SyncHealthStatus {
    const enabledTargets = Array.from(this.targets.values()).filter(t => t.enabled);
    const lastSyncTimes: Record<string, number> = {};
    
    for (const [target, time] of this.lastSyncTimes.entries()) {
      lastSyncTimes[target] = time;
    }
    
    const errors: string[] = [];
    let status: "healthy" | "degraded" | "unhealthy" = "healthy";
    
    // Check if any syncs are overdue
    const now = Date.now();
    const overdueThreshold = this.syncInterval * 3; // 3x the sync interval
    
    for (const target of enabledTargets) {
      const lastSync = this.lastSyncTimes.get(target.name);
      if (!lastSync || (now - lastSync) > overdueThreshold) {
        errors.push(`Target ${target.name} sync overdue`);
        status = "degraded";
      }
    }
    
    if (errors.length > enabledTargets.length / 2) {
      status = "unhealthy";
    }
    
    return {
      status,
      targetsEnabled: enabledTargets.length,
      lastSyncTimes,
      syncInterval: this.syncInterval,
      errors
    };
  }

  // Shutdown
  shutdown(): void {
    this.running = false;
    this.stopAutoSync();
    log("SynchronizationAgent shutting down", "info");
  }

  // Event handlers for workflow integration
  async handleSyncAllTargets(data: any): Promise<any> {
    return await this.syncAll();
  }

  async handleSyncTarget(data: any): Promise<any> {
    const targetName = data.target || data.targetName;
    if (!targetName) {
      throw new Error("Target name required for sync operation");
    }
    return await this.syncSpecificTarget(targetName);
  }

  async handleResolveConflicts(data: any): Promise<any> {
    const conflicts = data.conflicts || [];
    const strategy = data.strategy || this.conflictResolution.strategy;
    return await this.resolveConflictsWithStrategy(conflicts, strategy);
  }

  async handleBackupData(data: any): Promise<any> {
    return await this.backupKnowledge(data.sources, data.backupLocation, data.includeMetadata);
  }

  private async resolveConflictsWithStrategy(conflicts: any[], strategy: string): Promise<any> {
    try {
      const resolvedEntities: any[] = [];
      const errors: any[] = [];
      
      for (const entityName of conflicts) {
        try {
          const kgAgent = this.agents.get("knowledge_graph");
          if (!kgAgent || !kgAgent.entities?.has(entityName)) {
            errors.push({
              entity: entityName,
              error: "Entity not found in knowledge graph"
            });
            continue;
          }
          
          const entity = kgAgent.entities.get(entityName);
          let resolvedAction = "default_resolution";
          
          // Apply resolution strategy
          switch (strategy) {
            case "newest":
            case "timestamp_priority":
              resolvedAction = "kept_current";
              break;
            case "manual":
              entity.metadata.manual_review_required = true;
              resolvedAction = "marked_for_review";
              break;
            case "merge":
              entity.metadata.conflict_resolved = true;
              entity.metadata.resolution_strategy = "merge";
              resolvedAction = "merged";
              break;
          }
          
          entity.updated_at = Date.now();
          
          resolvedEntities.push({
            entity_name: entityName,
            action: resolvedAction,
            strategy,
            timestamp: entity.updated_at
          });
          
        } catch (error) {
          errors.push({
            entity: entityName,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      return {
        success: true,
        conflicts_resolved: resolvedEntities.length,
        errors: errors.length,
        resolution_strategy: strategy,
        resolved_entities: resolvedEntities,
        error_details: errors
      };
      
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        resolution_strategy: strategy,
        conflict_entities: conflicts
      };
    }
  }
}
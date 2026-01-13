/**
 * Batch Checkpoint Manager
 *
 * Manages per-batch checkpoint state for chronological batch processing.
 * Tracks completed batches, operator results, and supports resume from any batch.
 *
 * Separate from the main CheckpointManager which tracks workflow-level timestamps.
 * This manager tracks detailed batch-level progress for Tree-KG processing.
 *
 * Storage: .data/batch-checkpoints.json (gitignored)
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import type { BatchStats, OperatorResults } from '../agents/batch-scheduler.js';

/**
 * Detailed step output data for dashboard history view
 * Contains the actual content (commits array, sessions array) not just counts
 */
export interface BatchStepOutput {
  name: string;
  status: string;
  duration?: number;
  outputs?: Record<string, any>;  // Full outputs including arrays of commits, sessions, etc.
  tokensUsed?: number;
  llmProvider?: string;
  llmCalls?: number;
}

export interface BatchCheckpoint {
  batchId: string;
  batchNumber: number;
  completedAt: string;
  commitRange: {
    start: string;
    end: string;
  };
  dateRange: {
    start: string;
    end: string;
  };
  stats: BatchStats;
  /** Detailed step outputs for history view - includes arrays of commits, sessions, etc. */
  stepOutputs?: BatchStepOutput[];
}

export interface BatchCheckpointData {
  team: string;
  repositoryPath: string;
  lastCompletedBatch: number | null;
  lastCompletedAt: string | null;
  completedBatches: BatchCheckpoint[];
  accumulatedStats: {
    totalCommits: number;
    totalSessions: number;
    totalTokensUsed: number;
    totalEntitiesCreated: number;
    totalEntitiesUpdated: number;
    totalRelationsAdded: number;
  };
  lastUpdated: string;
}

export class BatchCheckpointManager {
  private checkpointPath: string;
  private repositoryPath: string;
  private team: string;
  private data: BatchCheckpointData | null = null;

  constructor(repositoryPath: string, team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.checkpointPath = path.join(repositoryPath, '.data', 'batch-checkpoints.json');
  }

  /**
   * Load checkpoint data from file
   */
  load(): BatchCheckpointData {
    if (this.data) {
      return this.data;
    }

    try {
      if (fs.existsSync(this.checkpointPath)) {
        const content = fs.readFileSync(this.checkpointPath, 'utf8');
        const parsed = JSON.parse(content);

        // Migrate old checkpoint files that don't have accumulatedStats
        if (!parsed.accumulatedStats) {
          log('Migrating checkpoint file to include accumulatedStats', 'info');
          parsed.accumulatedStats = {
            totalCommits: 0,
            totalSessions: 0,
            totalTokensUsed: 0,
            totalEntitiesCreated: 0,
            totalEntitiesUpdated: 0,
            totalRelationsAdded: 0
          };
          // Recalculate from completed batches if available
          if (parsed.completedBatches && Array.isArray(parsed.completedBatches)) {
            for (const batch of parsed.completedBatches) {
              if (batch.stats) {
                parsed.accumulatedStats.totalCommits += batch.stats.commits || 0;
                parsed.accumulatedStats.totalSessions += batch.stats.sessions || 0;
                parsed.accumulatedStats.totalTokensUsed += batch.stats.tokensUsed || 0;
                parsed.accumulatedStats.totalEntitiesCreated += batch.stats.entitiesCreated || 0;
                parsed.accumulatedStats.totalEntitiesUpdated += batch.stats.entitiesUpdated || 0;
                parsed.accumulatedStats.totalRelationsAdded += batch.stats.relationsAdded || 0;
              }
            }
          }
        }

        // Ensure team and repositoryPath are set
        if (!parsed.team) parsed.team = this.team;
        if (!parsed.repositoryPath) parsed.repositoryPath = this.repositoryPath;

        this.data = parsed;
        return this.data!;
      }
    } catch (error) {
      log('Could not load batch checkpoints', 'warning', { error, path: this.checkpointPath });
    }

    // Initialize with empty state
    this.data = this.createEmptyData();
    return this.data;
  }

  /**
   * Save checkpoint data to file
   */
  private save(): void {
    if (!this.data) {
      return;
    }

    try {
      const dataDir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      this.data.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.checkpointPath, JSON.stringify(this.data, null, 2));
      log('Batch checkpoints saved', 'debug', { path: this.checkpointPath });
    } catch (error) {
      log('Could not save batch checkpoints', 'error', { error, path: this.checkpointPath });
    }
  }

  /**
   * Create empty checkpoint data structure
   */
  private createEmptyData(): BatchCheckpointData {
    return {
      team: this.team,
      repositoryPath: this.repositoryPath,
      lastCompletedBatch: null,
      lastCompletedAt: null,
      completedBatches: [],
      accumulatedStats: {
        totalCommits: 0,
        totalSessions: 0,
        totalTokensUsed: 0,
        totalEntitiesCreated: 0,
        totalEntitiesUpdated: 0,
        totalRelationsAdded: 0
      },
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get the last completed batch number
   */
  getLastCompletedBatch(): number | null {
    const data = this.load();
    return data.lastCompletedBatch;
  }

  /**
   * Get all completed batch checkpoints
   */
  getCompletedBatches(): BatchCheckpoint[] {
    const data = this.load();
    return data.completedBatches;
  }

  /**
   * Get accumulated stats across all batches
   */
  getAccumulatedStats(): BatchCheckpointData['accumulatedStats'] {
    const data = this.load();
    return data.accumulatedStats;
  }

  /**
   * Record a completed batch with its stats and detailed step outputs
   * @param stepOutputs - Optional array of detailed step outputs for history view
   */
  saveBatchCheckpoint(
    batchId: string,
    batchNumber: number,
    commitRange: { start: string; end: string },
    dateRange: { start: Date; end: Date },
    stats: BatchStats,
    stepOutputs?: BatchStepOutput[]
  ): void {
    const data = this.load();

    // Create checkpoint entry
    const checkpoint: BatchCheckpoint = {
      batchId,
      batchNumber,
      completedAt: new Date().toISOString(),
      commitRange,
      dateRange: {
        start: dateRange.start.toISOString(),
        end: dateRange.end.toISOString()
      },
      stats,
      stepOutputs
    };

    // Check if this batch was already recorded (re-run)
    const existingIndex = data.completedBatches.findIndex(b => b.batchId === batchId);
    if (existingIndex >= 0) {
      // Update existing - subtract old stats first
      const oldStats = data.completedBatches[existingIndex].stats;
      data.accumulatedStats.totalCommits -= oldStats.commits;
      data.accumulatedStats.totalSessions -= oldStats.sessions;
      data.accumulatedStats.totalTokensUsed -= oldStats.tokensUsed;
      data.accumulatedStats.totalEntitiesCreated -= oldStats.entitiesCreated;
      data.accumulatedStats.totalEntitiesUpdated -= oldStats.entitiesUpdated;
      data.accumulatedStats.totalRelationsAdded -= oldStats.relationsAdded;

      data.completedBatches[existingIndex] = checkpoint;
      log('Updated existing batch checkpoint', 'info', { batchId, batchNumber });
    } else {
      data.completedBatches.push(checkpoint);
      log('Added new batch checkpoint', 'info', { batchId, batchNumber });
    }

    // Update accumulated stats
    data.accumulatedStats.totalCommits += stats.commits;
    data.accumulatedStats.totalSessions += stats.sessions;
    data.accumulatedStats.totalTokensUsed += stats.tokensUsed;
    data.accumulatedStats.totalEntitiesCreated += stats.entitiesCreated;
    data.accumulatedStats.totalEntitiesUpdated += stats.entitiesUpdated;
    data.accumulatedStats.totalRelationsAdded += stats.relationsAdded;

    // Update last completed
    if (data.lastCompletedBatch === null || batchNumber > data.lastCompletedBatch) {
      data.lastCompletedBatch = batchNumber;
      data.lastCompletedAt = checkpoint.completedAt;
    }

    this.data = data;
    this.save();
  }

  /**
   * Get a specific batch checkpoint by ID
   */
  getBatchCheckpoint(batchId: string): BatchCheckpoint | null {
    const data = this.load();
    return data.completedBatches.find(b => b.batchId === batchId) || null;
  }

  /**
   * Get batch checkpoint by number
   */
  getBatchCheckpointByNumber(batchNumber: number): BatchCheckpoint | null {
    const data = this.load();
    return data.completedBatches.find(b => b.batchNumber === batchNumber) || null;
  }

  /**
   * Reset checkpoints to reprocess from a specific batch
   * All batches >= batchNumber will be removed
   */
  resetFromBatch(batchNumber: number): void {
    const data = this.load();

    // Find batches to remove
    const batchesToRemove = data.completedBatches.filter(b => b.batchNumber >= batchNumber);

    if (batchesToRemove.length === 0) {
      log('No batches to reset', 'info', { fromBatch: batchNumber });
      return;
    }

    // Subtract stats from removed batches
    for (const batch of batchesToRemove) {
      data.accumulatedStats.totalCommits -= batch.stats.commits;
      data.accumulatedStats.totalSessions -= batch.stats.sessions;
      data.accumulatedStats.totalTokensUsed -= batch.stats.tokensUsed;
      data.accumulatedStats.totalEntitiesCreated -= batch.stats.entitiesCreated;
      data.accumulatedStats.totalEntitiesUpdated -= batch.stats.entitiesUpdated;
      data.accumulatedStats.totalRelationsAdded -= batch.stats.relationsAdded;
    }

    // Ensure no negative values
    data.accumulatedStats.totalCommits = Math.max(0, data.accumulatedStats.totalCommits);
    data.accumulatedStats.totalSessions = Math.max(0, data.accumulatedStats.totalSessions);
    data.accumulatedStats.totalTokensUsed = Math.max(0, data.accumulatedStats.totalTokensUsed);
    data.accumulatedStats.totalEntitiesCreated = Math.max(0, data.accumulatedStats.totalEntitiesCreated);
    data.accumulatedStats.totalEntitiesUpdated = Math.max(0, data.accumulatedStats.totalEntitiesUpdated);
    data.accumulatedStats.totalRelationsAdded = Math.max(0, data.accumulatedStats.totalRelationsAdded);

    // Remove the batches
    data.completedBatches = data.completedBatches.filter(b => b.batchNumber < batchNumber);

    // Update last completed
    if (data.completedBatches.length > 0) {
      const lastBatch = data.completedBatches[data.completedBatches.length - 1];
      data.lastCompletedBatch = lastBatch.batchNumber;
      data.lastCompletedAt = lastBatch.completedAt;
    } else {
      data.lastCompletedBatch = null;
      data.lastCompletedAt = null;
    }

    this.data = data;
    this.save();

    log('Reset batch checkpoints', 'info', {
      fromBatch: batchNumber,
      removedBatches: batchesToRemove.length,
      remainingBatches: data.completedBatches.length
    });
  }

  /**
   * Clear all checkpoints (full reset)
   */
  clearAll(): void {
    this.data = this.createEmptyData();
    this.save();
    log('Cleared all batch checkpoints', 'info');
  }

  /**
   * Get operator-level statistics across all batches
   */
  getOperatorStats(): {
    conv: { totalProcessed: number; totalDuration: number };
    aggr: { totalCore: number; totalNonCore: number; totalDuration: number };
    embed: { totalEmbedded: number; totalDuration: number };
    dedup: { totalMerged: number; totalDuration: number };
    pred: { totalEdgesAdded: number; totalDuration: number };
    merge: { totalEntitiesAdded: number; totalDuration: number };
  } {
    const data = this.load();
    const stats = {
      conv: { totalProcessed: 0, totalDuration: 0 },
      aggr: { totalCore: 0, totalNonCore: 0, totalDuration: 0 },
      embed: { totalEmbedded: 0, totalDuration: 0 },
      dedup: { totalMerged: 0, totalDuration: 0 },
      pred: { totalEdgesAdded: 0, totalDuration: 0 },
      merge: { totalEntitiesAdded: 0, totalDuration: 0 }
    };

    for (const batch of data.completedBatches) {
      if (batch.stats.operatorResults) {
        const ops = batch.stats.operatorResults;
        stats.conv.totalProcessed += ops.conv.processed;
        stats.conv.totalDuration += ops.conv.duration;
        stats.aggr.totalCore += ops.aggr.core;
        stats.aggr.totalNonCore += ops.aggr.nonCore;
        stats.aggr.totalDuration += ops.aggr.duration;
        stats.embed.totalEmbedded += ops.embed.embedded;
        stats.embed.totalDuration += ops.embed.duration;
        stats.dedup.totalMerged += ops.dedup.merged;
        stats.dedup.totalDuration += ops.dedup.duration;
        stats.pred.totalEdgesAdded += ops.pred.edgesAdded;
        stats.pred.totalDuration += ops.pred.duration;
        stats.merge.totalEntitiesAdded += ops.merge.entitiesAdded;
        stats.merge.totalDuration += ops.merge.duration;
      }
    }

    return stats;
  }

  /**
   * Get summary for dashboard display
   */
  getDashboardSummary(): {
    completedBatches: number;
    lastCompletedAt: string | null;
    accumulatedStats: BatchCheckpointData['accumulatedStats'];
    recentBatches: Array<{
      id: string;
      number: number;
      completedAt: string;
      commits: number;
      entities: number;
    }>;
  } {
    const data = this.load();
    const recentBatches = data.completedBatches
      .slice(-5)  // Last 5 batches
      .reverse()  // Most recent first
      .map(b => ({
        id: b.batchId,
        number: b.batchNumber,
        completedAt: b.completedAt,
        commits: b.stats.commits,
        entities: b.stats.entitiesCreated + b.stats.entitiesUpdated
      }));

    return {
      completedBatches: data.completedBatches.length,
      lastCompletedAt: data.lastCompletedAt,
      accumulatedStats: data.accumulatedStats,
      recentBatches
    };
  }
}

// Singleton instances keyed by repositoryPath + team
const instances: Map<string, BatchCheckpointManager> = new Map();

/**
 * Get or create a BatchCheckpointManager instance
 */
export function getBatchCheckpointManager(
  repositoryPath: string,
  team: string = 'coding'
): BatchCheckpointManager {
  const key = `${repositoryPath}:${team}`;
  if (!instances.has(key)) {
    instances.set(key, new BatchCheckpointManager(repositoryPath, team));
  }
  return instances.get(key)!;
}

/**
 * Batch Scheduler
 *
 * Plans and manages chronological batch processing for knowledge graph construction.
 * Implements count-based batching (50 commits per batch) with checkpointing.
 *
 * Based on Tree-KG approach: process data incrementally in chronological order,
 * allowing accumulated knowledge to provide context for later batches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { log } from '../logging.js';

// Default batch size (commits per batch)
const DEFAULT_BATCH_SIZE = parseInt(process.env.BATCH_COMMIT_COUNT || '50', 10);

export interface BatchWindow {
  id: string;                           // "batch-001", "batch-002", etc.
  batchNumber: number;                  // 1, 2, 3...
  startCommit: string;                  // First commit SHA in batch
  endCommit: string;                    // Last commit SHA in batch
  startDate: Date;                      // Timestamp of first commit
  endDate: Date;                        // Timestamp of last commit
  commitCount: number;                  // Number of commits in this batch
  status: 'pending' | 'processing' | 'completed' | 'failed';
  stats?: BatchStats;
}

export interface BatchStats {
  commits: number;
  sessions: number;
  tokensUsed: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  relationsAdded: number;
  operatorResults: OperatorResults;
  duration: number;                     // milliseconds
}

export interface OperatorResults {
  conv: { processed: number; duration: number };
  aggr: { core: number; nonCore: number; duration: number };
  embed: { embedded: number; duration: number };
  dedup: { merged: number; duration: number };
  pred: { edgesAdded: number; duration: number };
  merge: { entitiesAdded: number; duration: number };
}

export interface BatchPlan {
  totalCommits: number;
  totalBatches: number;
  batchSize: number;
  batches: BatchWindow[];
  repositoryPath: string;
  team: string;
  plannedAt: string;
}

export interface BatchSchedulerOptions {
  batchSize?: number;                   // Commits per batch (default: 50)
  maxBatches?: number;                  // Limit batches to process (0 = all)
  fromCommit?: string;                  // Start from specific commit
  resumeFromCheckpoint?: boolean;       // Resume from last completed batch
}

interface CommitInfo {
  sha: string;
  date: Date;
  message: string;
}

export class BatchScheduler {
  private repositoryPath: string;
  private team: string;
  private checkpointPath: string;
  private progressPath: string;
  private plan: BatchPlan | null = null;

  constructor(repositoryPath: string, team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.checkpointPath = path.join(repositoryPath, '.data', 'batch-checkpoints.json');
    this.progressPath = path.join(repositoryPath, '.data', 'batch-progress.json');
  }

  /**
   * Plan all batches for the repository
   * Divides git history into chronological batches of specified size
   */
  async planBatches(options: BatchSchedulerOptions = {}): Promise<BatchPlan> {
    const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
    const maxBatches = options.maxBatches || 0;

    log('Planning batches', 'info', { repositoryPath: this.repositoryPath, batchSize, maxBatches });

    // Get all commits in chronological order (oldest first)
    const commits = this.getCommitsChronological(options.fromCommit);
    log('Found commits', 'info', { count: commits.length });

    if (commits.length === 0) {
      return {
        totalCommits: 0,
        totalBatches: 0,
        batchSize,
        batches: [],
        repositoryPath: this.repositoryPath,
        team: this.team,
        plannedAt: new Date().toISOString()
      };
    }

    // Check for existing checkpoints if resuming
    let startFromBatch = 0;
    if (options.resumeFromCheckpoint) {
      const checkpoints = this.loadCheckpoints();
      if (checkpoints.lastCompletedBatch) {
        startFromBatch = checkpoints.lastCompletedBatch + 1;
        log('Resuming from batch', 'info', { batchNumber: startFromBatch });
      }
    }

    // Create batch windows
    const batches: BatchWindow[] = [];
    let batchNumber = 1;

    for (let i = 0; i < commits.length; i += batchSize) {
      const batchCommits = commits.slice(i, i + batchSize);
      const firstCommit = batchCommits[0];
      const lastCommit = batchCommits[batchCommits.length - 1];

      const batch: BatchWindow = {
        id: `batch-${String(batchNumber).padStart(3, '0')}`,
        batchNumber,
        startCommit: firstCommit.sha,
        endCommit: lastCommit.sha,
        startDate: firstCommit.date,
        endDate: lastCommit.date,
        commitCount: batchCommits.length,
        status: batchNumber < startFromBatch ? 'completed' : 'pending'
      };

      batches.push(batch);
      batchNumber++;

      // Apply maxBatches limit to pending batches only
      if (maxBatches > 0) {
        const pendingCount = batches.filter(b => b.status === 'pending').length;
        if (pendingCount >= maxBatches) {
          break;
        }
      }
    }

    this.plan = {
      totalCommits: commits.length,
      totalBatches: batches.length,
      batchSize,
      batches,
      repositoryPath: this.repositoryPath,
      team: this.team,
      plannedAt: new Date().toISOString()
    };

    // Save initial progress
    this.saveProgress();

    log('Batch plan created', 'info', {
      totalBatches: batches.length,
      pendingBatches: batches.filter(b => b.status === 'pending').length,
      completedBatches: batches.filter(b => b.status === 'completed').length
    });

    return this.plan;
  }

  /**
   * Get next pending batch to process
   */
  getNextBatch(): BatchWindow | null {
    if (!this.plan) {
      log('No batch plan available', 'warning');
      return null;
    }

    const nextBatch = this.plan.batches.find(b => b.status === 'pending');
    if (nextBatch) {
      nextBatch.status = 'processing';
      this.saveProgress();
    }

    return nextBatch || null;
  }

  /**
   * Mark a batch as completed with stats
   */
  completeBatch(batchId: string, stats: BatchStats): void {
    if (!this.plan) {
      log('No batch plan available', 'warning');
      return;
    }

    const batch = this.plan.batches.find(b => b.id === batchId);
    if (batch) {
      batch.status = 'completed';
      batch.stats = stats;

      // Update checkpoint
      const checkpoints = this.loadCheckpoints();
      checkpoints.lastCompletedBatch = batch.batchNumber;
      checkpoints.lastCompletedAt = new Date().toISOString();
      checkpoints.completedBatches = checkpoints.completedBatches || [];
      checkpoints.completedBatches.push({
        batchId: batch.id,
        completedAt: new Date().toISOString(),
        stats
      });
      this.saveCheckpoints(checkpoints);

      this.saveProgress();

      log('Batch completed', 'info', {
        batchId,
        batchNumber: batch.batchNumber,
        stats: {
          commits: stats.commits,
          entities: stats.entitiesCreated + stats.entitiesUpdated,
          tokens: stats.tokensUsed
        }
      });
    }
  }

  /**
   * Mark a batch as failed
   */
  failBatch(batchId: string, error: string): void {
    if (!this.plan) return;

    const batch = this.plan.batches.find(b => b.id === batchId);
    if (batch) {
      batch.status = 'failed';
      this.saveProgress();

      log('Batch failed', 'error', { batchId, error });
    }
  }

  /**
   * Get current progress summary
   */
  getProgress(): {
    currentBatch: BatchWindow | null;
    completedBatches: number;
    totalBatches: number;
    percentComplete: number;
    accumulatedStats: Partial<BatchStats>;
  } {
    if (!this.plan) {
      return {
        currentBatch: null,
        completedBatches: 0,
        totalBatches: 0,
        percentComplete: 0,
        accumulatedStats: {}
      };
    }

    const completed = this.plan.batches.filter(b => b.status === 'completed');
    const processing = this.plan.batches.find(b => b.status === 'processing');

    // Aggregate stats from completed batches
    const accumulated: Partial<BatchStats> = {
      commits: 0,
      sessions: 0,
      tokensUsed: 0,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      relationsAdded: 0
    };

    for (const batch of completed) {
      if (batch.stats) {
        accumulated.commits! += batch.stats.commits;
        accumulated.sessions! += batch.stats.sessions;
        accumulated.tokensUsed! += batch.stats.tokensUsed;
        accumulated.entitiesCreated! += batch.stats.entitiesCreated;
        accumulated.entitiesUpdated! += batch.stats.entitiesUpdated;
        accumulated.relationsAdded! += batch.stats.relationsAdded;
      }
    }

    return {
      currentBatch: processing || null,
      completedBatches: completed.length,
      totalBatches: this.plan.totalBatches,
      percentComplete: Math.round((completed.length / this.plan.totalBatches) * 100),
      accumulatedStats: accumulated
    };
  }

  /**
   * Reset to process from a specific batch
   */
  resetFromBatch(batchNumber: number): void {
    if (!this.plan) return;

    for (const batch of this.plan.batches) {
      if (batch.batchNumber >= batchNumber) {
        batch.status = 'pending';
        batch.stats = undefined;
      }
    }

    const checkpoints = this.loadCheckpoints();
    checkpoints.lastCompletedBatch = batchNumber - 1;
    this.saveCheckpoints(checkpoints);
    this.saveProgress();

    log('Reset from batch', 'info', { batchNumber });
  }

  /**
   * Get commits in chronological order (oldest first)
   */
  private getCommitsChronological(fromCommit?: string): CommitInfo[] {
    try {
      // Build git log command
      let cmd = `git -C "${this.repositoryPath}" log --reverse --format="%H|%aI|%s"`;
      if (fromCommit) {
        cmd += ` ${fromCommit}..HEAD`;
      }

      const output = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      const lines = output.trim().split('\n').filter(line => line);

      return lines.map(line => {
        const [sha, dateStr, ...messageParts] = line.split('|');
        return {
          sha: sha.trim(),
          date: new Date(dateStr.trim()),
          message: messageParts.join('|').trim()
        };
      });
    } catch (error) {
      log('Failed to get git commits', 'error', { error });
      return [];
    }
  }

  /**
   * Get commits for a specific batch
   */
  getCommitsForBatch(batch: BatchWindow): CommitInfo[] {
    try {
      const cmd = `git -C "${this.repositoryPath}" log --reverse --format="%H|%aI|%s" ${batch.startCommit}^..${batch.endCommit}`;
      const output = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      const lines = output.trim().split('\n').filter(line => line);

      return lines.map(line => {
        const [sha, dateStr, ...messageParts] = line.split('|');
        return {
          sha: sha.trim(),
          date: new Date(dateStr.trim()),
          message: messageParts.join('|').trim()
        };
      });
    } catch (error) {
      log('Failed to get batch commits', 'error', { batch: batch.id, error });
      return [];
    }
  }

  /**
   * Load batch checkpoints from file
   */
  private loadCheckpoints(): any {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        return JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
      }
    } catch (error) {
      log('Could not load batch checkpoints', 'warning', { error });
    }
    return {};
  }

  /**
   * Save batch checkpoints to file
   */
  private saveCheckpoints(checkpoints: any): void {
    try {
      const dataDir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      checkpoints.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.checkpointPath, JSON.stringify(checkpoints, null, 2));
    } catch (error) {
      log('Could not save batch checkpoints', 'error', { error });
    }
  }

  /**
   * Save current progress to file (for dashboard)
   */
  private saveProgress(): void {
    if (!this.plan) return;

    try {
      const dataDir = path.dirname(this.progressPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const progress = this.getProgress();
      const progressData = {
        currentBatch: progress.currentBatch ? {
          id: progress.currentBatch.id,
          commitRange: {
            start: progress.currentBatch.startCommit.substring(0, 7),
            end: progress.currentBatch.endCommit.substring(0, 7)
          },
          startDate: progress.currentBatch.startDate,
          endDate: progress.currentBatch.endDate,
          commitCount: progress.currentBatch.commitCount,
          status: progress.currentBatch.status,
          operators: {
            conv: { status: 'pending' },
            aggr: { status: 'pending' },
            embed: { status: 'pending' },
            dedup: { status: 'pending' },
            pred: { status: 'pending' },
            merge: { status: 'pending' }
          }
        } : null,
        completedBatches: progress.completedBatches,
        totalBatches: progress.totalBatches,
        percentComplete: progress.percentComplete,
        accumulatedStats: progress.accumulatedStats,
        lastUpdated: new Date().toISOString()
      };

      fs.writeFileSync(this.progressPath, JSON.stringify(progressData, null, 2));
    } catch (error) {
      log('Could not save batch progress', 'warning', { error });
    }
  }

  /**
   * Update operator status for current batch (for dashboard)
   */
  updateOperatorStatus(
    batchId: string,
    operator: 'conv' | 'aggr' | 'embed' | 'dedup' | 'pred' | 'merge',
    status: 'pending' | 'running' | 'completed' | 'failed',
    duration?: number
  ): void {
    try {
      if (fs.existsSync(this.progressPath)) {
        const progress = JSON.parse(fs.readFileSync(this.progressPath, 'utf8'));
        if (progress.currentBatch && progress.currentBatch.id === batchId) {
          progress.currentBatch.operators[operator] = {
            status,
            ...(duration !== undefined && { duration })
          };
          progress.lastUpdated = new Date().toISOString();
          fs.writeFileSync(this.progressPath, JSON.stringify(progress, null, 2));
        }
      }
    } catch (error) {
      log('Could not update operator status', 'warning', { operator, status, error });
    }
  }
}

// Singleton instances
const instances: Map<string, BatchScheduler> = new Map();

/**
 * Get or create a BatchScheduler instance
 */
export function getBatchScheduler(repositoryPath: string, team: string = 'coding'): BatchScheduler {
  const key = `${repositoryPath}:${team}`;
  if (!instances.has(key)) {
    instances.set(key, new BatchScheduler(repositoryPath, team));
  }
  return instances.get(key)!;
}

/**
 * Checkpoint Manager
 *
 * Manages workflow checkpoints in a separate file that's NOT git-tracked.
 * This prevents meaningless timestamp-only updates to the main knowledge export JSON.
 *
 * Checkpoints stored: .data/workflow-checkpoints.json (gitignored)
 * - lastVibeAnalysis: When vibe/LSL analysis was last run
 * - lastGitAnalysis: When git commit analysis was last run
 * - lastSuccessfulWorkflowCompletion: When a full workflow completed successfully
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

export interface WorkflowCheckpoints {
  lastVibeAnalysis?: string;
  lastGitAnalysis?: string;
  lastSuccessfulWorkflowCompletion?: string;
  lastUpdated?: string;
}

export class CheckpointManager {
  private checkpointPath: string;
  private repositoryPath: string;
  private team: string;

  /**
   * @param repositoryPath - Path to the repository root
   * @param team - Optional team name for legacy checkpoint lookups (default: 'coding')
   *               Supported teams: coding, ui, raas, resi, etc.
   */
  constructor(repositoryPath: string, team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.checkpointPath = path.join(repositoryPath, '.data', 'workflow-checkpoints.json');
  }

  /**
   * Load all checkpoints from file
   */
  loadCheckpoints(): WorkflowCheckpoints {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        const content = fs.readFileSync(this.checkpointPath, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      log('Could not load checkpoints', 'warning', { error, path: this.checkpointPath });
    }
    return {};
  }

  /**
   * Save all checkpoints to file
   */
  private saveCheckpoints(checkpoints: WorkflowCheckpoints): void {
    try {
      // Ensure .data directory exists
      const dataDir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      checkpoints.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.checkpointPath, JSON.stringify(checkpoints, null, 2));
      log('Checkpoints saved', 'debug', { path: this.checkpointPath });
    } catch (error) {
      log('Could not save checkpoints', 'warning', { error, path: this.checkpointPath });
    }
  }

  /**
   * Get the last vibe analysis timestamp
   */
  getLastVibeAnalysis(): Date | null {
    const checkpoints = this.loadCheckpoints();
    if (checkpoints.lastVibeAnalysis) {
      return new Date(checkpoints.lastVibeAnalysis);
    }
    // Fallback: try legacy location in shared memory
    return this.getLegacyCheckpoint('lastVibeAnalysis');
  }

  /**
   * Set the last vibe analysis timestamp
   */
  setLastVibeAnalysis(timestamp: Date): void {
    const checkpoints = this.loadCheckpoints();
    checkpoints.lastVibeAnalysis = timestamp.toISOString();
    this.saveCheckpoints(checkpoints);
    log('Vibe analysis checkpoint updated', 'info', { timestamp: timestamp.toISOString() });
  }

  /**
   * Get the last git analysis timestamp
   */
  getLastGitAnalysis(): Date | null {
    const checkpoints = this.loadCheckpoints();
    // Check for successful workflow completion first (more reliable), then git analysis
    if (checkpoints.lastSuccessfulWorkflowCompletion) {
      return new Date(checkpoints.lastSuccessfulWorkflowCompletion);
    }
    if (checkpoints.lastGitAnalysis) {
      return new Date(checkpoints.lastGitAnalysis);
    }
    // Fallback: try legacy location in shared memory
    return this.getLegacyCheckpoint('lastGitAnalysis') ||
           this.getLegacyCheckpoint('lastSuccessfulWorkflowCompletion');
  }

  /**
   * Set the last git analysis timestamp
   */
  setLastGitAnalysis(timestamp: Date): void {
    const checkpoints = this.loadCheckpoints();
    checkpoints.lastGitAnalysis = timestamp.toISOString();
    this.saveCheckpoints(checkpoints);
    log('Git analysis checkpoint updated', 'info', { timestamp: timestamp.toISOString() });
  }

  /**
   * Get the last successful workflow completion timestamp
   */
  getLastSuccessfulWorkflowCompletion(): Date | null {
    const checkpoints = this.loadCheckpoints();
    if (checkpoints.lastSuccessfulWorkflowCompletion) {
      return new Date(checkpoints.lastSuccessfulWorkflowCompletion);
    }
    // Fallback: try legacy location
    return this.getLegacyCheckpoint('lastSuccessfulWorkflowCompletion');
  }

  /**
   * Set the last successful workflow completion timestamp
   */
  setLastSuccessfulWorkflowCompletion(timestamp: Date): void {
    const checkpoints = this.loadCheckpoints();
    checkpoints.lastSuccessfulWorkflowCompletion = timestamp.toISOString();
    this.saveCheckpoints(checkpoints);
    log('Workflow completion checkpoint updated', 'info', { timestamp: timestamp.toISOString() });
  }

  /**
   * Try to read a checkpoint from the legacy location (shared memory JSON)
   * This provides backward compatibility during migration
   */
  private getLegacyCheckpoint(checkpointName: string): Date | null {
    try {
      // Use the team-specific export file (supports coding, ui, raas, resi, etc.)
      const legacyPaths = [
        path.join(this.repositoryPath, '.data', 'knowledge-export', `${this.team}.json`),
        path.join(this.repositoryPath, `shared-memory-${this.team}.json`)
      ];

      for (const legacyPath of legacyPaths) {
        if (fs.existsSync(legacyPath)) {
          const data = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
          if (data.metadata?.[checkpointName]) {
            log('Using legacy checkpoint', 'debug', {
              checkpoint: checkpointName,
              value: data.metadata[checkpointName],
              source: legacyPath
            });
            return new Date(data.metadata[checkpointName]);
          }
        }
      }
    } catch (error) {
      log('Could not read legacy checkpoint', 'debug', { checkpointName, error });
    }
    return null;
  }

  /**
   * Migrate checkpoints from legacy location to new checkpoint file
   * Run this once to move existing checkpoints
   */
  migrateFromLegacy(): boolean {
    const checkpoints = this.loadCheckpoints();
    let migrated = false;

    const checkpointNames = ['lastVibeAnalysis', 'lastGitAnalysis', 'lastSuccessfulWorkflowCompletion'];

    for (const name of checkpointNames) {
      if (!(checkpoints as any)[name]) {
        const legacyValue = this.getLegacyCheckpoint(name);
        if (legacyValue) {
          (checkpoints as any)[name] = legacyValue.toISOString();
          migrated = true;
          log('Migrated checkpoint from legacy location', 'info', { checkpoint: name });
        }
      }
    }

    if (migrated) {
      this.saveCheckpoints(checkpoints);
    }

    return migrated;
  }
}

// Singleton instances keyed by repositoryPath + team
const instances: Map<string, CheckpointManager> = new Map();

/**
 * Get or create a CheckpointManager instance
 * @param repositoryPath - Path to the repository root (default: /Users/q284340/Agentic/coding)
 * @param team - Team name for legacy checkpoint lookups (default: 'coding')
 */
export function getCheckpointManager(repositoryPath?: string, team: string = 'coding'): CheckpointManager {
  if (!repositoryPath) {
    // Use the coding repo path
    repositoryPath = '/Users/q284340/Agentic/coding';
  }

  const key = `${repositoryPath}:${team}`;
  if (!instances.has(key)) {
    instances.set(key, new CheckpointManager(repositoryPath, team));
  }

  return instances.get(key)!;
}

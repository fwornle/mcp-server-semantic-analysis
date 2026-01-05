#!/usr/bin/env node
/**
 * Standalone workflow runner - runs in a separate process from MCP server
 * This allows workflows to survive MCP disconnections
 *
 * Usage: node workflow-runner.js <config-file-path>
 *
 * Config file is JSON with:
 * - workflowId: string
 * - workflowName: string
 * - repositoryPath: string
 * - parameters: object
 * - progressFile: string (where to write progress updates)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CoordinatorAgent } from './agents/coordinator.js';
import { log } from './logging.js';

// ============================================================================
// CRASH RECOVERY: Module-level state for signal handlers
// ============================================================================
let cleanupState: {
  progressFile?: string;
  pidFile?: string;
  configPath?: string;
  startTime?: Date;
  workflowId?: string;
  coordinator?: CoordinatorAgent;
  heartbeatInterval?: NodeJS.Timeout;
  watchdogTimer?: NodeJS.Timeout;
  isShuttingDown: boolean;
} = { isShuttingDown: false };

/**
 * Graceful cleanup function for signal handlers
 * Writes final progress, cleans up files, and shuts down coordinator
 */
async function gracefulCleanup(reason: string, exitCode: number = 1): Promise<void> {
  if (cleanupState.isShuttingDown) {
    log('[WorkflowRunner] Cleanup already in progress, skipping duplicate', 'warning');
    return;
  }
  cleanupState.isShuttingDown = true;

  log(`[WorkflowRunner] Graceful cleanup initiated: ${reason}`, 'warning');

  // Clear intervals/timers first
  if (cleanupState.heartbeatInterval) {
    clearInterval(cleanupState.heartbeatInterval);
  }
  if (cleanupState.watchdogTimer) {
    clearTimeout(cleanupState.watchdogTimer);
  }

  // Write final failure progress
  if (cleanupState.progressFile && cleanupState.workflowId && cleanupState.startTime) {
    try {
      const update: ProgressUpdate = {
        workflowId: cleanupState.workflowId,
        status: 'failed',
        error: reason,
        message: `Workflow terminated: ${reason}`,
        startTime: cleanupState.startTime.toISOString(),
        lastUpdate: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - cleanupState.startTime.getTime()) / 1000),
        pid: process.pid
      };
      fs.writeFileSync(cleanupState.progressFile, JSON.stringify(update, null, 2));
      log('[WorkflowRunner] Final progress written', 'info');
    } catch (e) {
      console.error('[WorkflowRunner] Failed to write final progress:', e);
    }
  }

  // Shutdown coordinator
  if (cleanupState.coordinator) {
    try {
      await cleanupState.coordinator.shutdown();
      log('[WorkflowRunner] Coordinator shutdown complete', 'info');
    } catch (e) {
      log('[WorkflowRunner] Error during coordinator shutdown', 'error', e);
    }
  }

  // Clean up PID file
  if (cleanupState.pidFile) {
    try {
      fs.unlinkSync(cleanupState.pidFile);
    } catch (e) {
      // Ignore - may already be deleted
    }
  }

  // Clean up config file
  if (cleanupState.configPath) {
    try {
      fs.unlinkSync(cleanupState.configPath);
    } catch (e) {
      // Ignore
    }
  }

  log(`[WorkflowRunner] Cleanup complete, exiting with code ${exitCode}`, 'info');
  process.exit(exitCode);
}

// ============================================================================
// SIGNAL HANDLERS: Set up process-level crash recovery
// ============================================================================
process.on('SIGTERM', () => {
  log('[WorkflowRunner] SIGTERM received', 'warning');
  gracefulCleanup('Process terminated (SIGTERM)', 130);
});

process.on('SIGINT', () => {
  log('[WorkflowRunner] SIGINT received', 'warning');
  gracefulCleanup('Process interrupted (SIGINT)', 130);
});

process.on('unhandledRejection', (reason, promise) => {
  log('[WorkflowRunner] Unhandled promise rejection', 'error', { reason, promise: String(promise) });
  gracefulCleanup(`Unhandled rejection: ${reason}`, 1);
});

process.on('uncaughtException', (error) => {
  log('[WorkflowRunner] Uncaught exception', 'error', error);
  gracefulCleanup(`Uncaught exception: ${error.message}`, 1);
});

// Batch step names for phase separation
const BATCH_STEPS = new Set([
  'plan_batches', 'extract_batch_commits', 'extract_batch_sessions',
  'batch_semantic_analysis', 'generate_batch_observations', 'classify_with_ontology',
  'operator_conv', 'operator_aggr', 'operator_embed', 'operator_dedup',
  'operator_pred', 'operator_merge', 'batch_qa', 'save_batch_checkpoint'
]);

interface WorkflowConfig {
  workflowId: string;
  workflowName: string;
  repositoryPath: string;
  parameters: Record<string, any>;
  progressFile: string;
  pidFile: string;
}

interface ProgressUpdate {
  workflowId: string;
  workflowName?: string;
  team?: string;
  repositoryPath?: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  currentStep?: string;
  stepsCompleted?: number;
  totalSteps?: number;
  batchProgress?: {
    currentBatch: number;
    totalBatches: number;
  };
  message?: string;
  error?: string;
  startTime: string;
  lastUpdate: string;
  elapsedSeconds: number;
  pid: number;
}

function writeProgress(progressFile: string, update: ProgressUpdate): void {
  try {
    fs.writeFileSync(progressFile, JSON.stringify(update, null, 2));
  } catch (e) {
    console.error('Failed to write progress:', e);
  }
}

/**
 * Update step timing statistics after workflow completion
 * This enables learned progress estimation for future runs
 */
async function updateTimingStatistics(
  repositoryPath: string,
  workflowName: string,
  totalBatches: number
): Promise<void> {
  try {
    const progressPath = path.join(repositoryPath, '.data/workflow-progress.json');
    if (!fs.existsSync(progressPath)) {
      log('[WorkflowRunner] Progress file not found for statistics update', 'warning');
      return;
    }

    const progressData = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    const stepsDetail = progressData.stepsDetail || [];

    // Calculate batch phase duration (sum of batch step durations)
    let batchDurationMs = 0;
    let finalizationDurationMs = 0;
    const stepDurations: Record<string, number> = {};

    for (const step of stepsDetail) {
      const duration = step.duration || 0;
      stepDurations[step.name] = duration;

      if (BATCH_STEPS.has(step.name)) {
        batchDurationMs += duration;
      } else {
        finalizationDurationMs += duration;
      }
    }

    // Also process batch iterations if available
    const batchIterations = progressData.batchIterations || [];
    if (batchIterations.length > 0) {
      // Sum up all batch iteration durations
      batchDurationMs = 0;
      for (const batch of batchIterations) {
        for (const step of batch.steps || []) {
          batchDurationMs += step.duration || 0;
        }
      }
    }

    // Call the statistics update API
    const apiUrl = 'http://localhost:3033/api/workflows/statistics/update';
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowName,
        batchDurationMs,
        finalizationDurationMs,
        totalBatches: totalBatches || batchIterations.length || 1,
        stepDurations
      })
    });

    if (response.ok) {
      const result = await response.json();
      log('[WorkflowRunner] Timing statistics updated', 'info', {
        sampleCount: result.data?.sampleCount,
        avgBatchDurationMs: result.data?.avgBatchDurationMs
      });
    } else {
      log('[WorkflowRunner] Failed to update timing statistics', 'warning', {
        status: response.status
      });
    }
  } catch (error) {
    // Non-fatal error - statistics update failure shouldn't break workflow completion
    log('[WorkflowRunner] Error updating timing statistics', 'warning', error);
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];

  if (!configPath) {
    console.error('Usage: workflow-runner <config-file-path>');
    process.exit(1);
  }

  let config: WorkflowConfig;

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configContent);
  } catch (e) {
    console.error('Failed to read config file:', e);
    process.exit(1);
  }

  const { workflowId, workflowName, repositoryPath, parameters, progressFile, pidFile } = config;

  // Populate cleanup state for signal handlers
  cleanupState.configPath = configPath;
  cleanupState.progressFile = progressFile;
  cleanupState.pidFile = pidFile;
  cleanupState.workflowId = workflowId;

  // Write PID file so parent can track us
  fs.writeFileSync(pidFile, String(process.pid));

  const startTime = new Date();
  cleanupState.startTime = startTime;

  log(`[WorkflowRunner] Starting workflow: ${workflowName} (${workflowId})`, 'info', {
    pid: process.pid,
    repositoryPath,
    parameters
  });

  // Initial progress update
  writeProgress(progressFile, {
    workflowId,
    status: 'starting',
    message: 'Initializing workflow runner...',
    startTime: startTime.toISOString(),
    lastUpdate: new Date().toISOString(),
    elapsedSeconds: 0,
    pid: process.pid
  });

  const coordinator = new CoordinatorAgent(repositoryPath);
  cleanupState.coordinator = coordinator;

  try {
    // Map workflow names
    const workflowMapping: Record<string, { target: string; defaults: Record<string, any> }> = {
      'complete-analysis': {
        target: 'batch-analysis',
        // fullAnalysis: process ALL commits; forceCleanStart: clear old checkpoints
        // resumeFromCheckpoint: resume if crashes mid-run (new checkpoints created per batch)
        defaults: { fullAnalysis: true, forceCleanStart: true, resumeFromCheckpoint: true }
      },
      'incremental-analysis': {
        target: 'batch-analysis',
        defaults: { fullAnalysis: false, resumeFromCheckpoint: true }
      },
      'batch-analysis': { target: 'batch-analysis', defaults: {} }
    };

    const mapping = workflowMapping[workflowName];
    const resolvedWorkflowName = mapping?.target || workflowName;
    const resolvedParameters = mapping ? { ...mapping.defaults, ...parameters } : parameters;

    // Get workflow info
    const workflows = coordinator.getWorkflows();
    const workflow = workflows.find(w => w.name === resolvedWorkflowName);
    const isBatchWorkflow = workflow?.type === 'iterative' || resolvedWorkflowName === 'batch-analysis';

    // Update progress to running
    writeProgress(progressFile, {
      workflowId,
      status: 'running',
      message: `Executing ${resolvedWorkflowName}...`,
      startTime: startTime.toISOString(),
      lastUpdate: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
      pid: process.pid
    });

    // Start background heartbeat to prevent "stale" status during long-running steps
    // The dashboard marks workflows as stale after 120s without an update
    // This sends a heartbeat every 30s regardless of what step is executing
    const heartbeatInterval = setInterval(() => {
      writeProgress(progressFile, {
        workflowId,
        status: 'running',
        message: `Executing ${resolvedWorkflowName}... (heartbeat)`,
        startTime: startTime.toISOString(),
        lastUpdate: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
        pid: process.pid
      });
      log(`[WorkflowRunner] Heartbeat sent`, 'debug');
    }, 30000); // 30 seconds - well under the 120s stale threshold
    cleanupState.heartbeatInterval = heartbeatInterval;

    // Start watchdog timer to prevent indefinite hangs (2 hours max)
    const MAX_WORKFLOW_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
    const watchdogTimer = setTimeout(() => {
      log('[WorkflowRunner] Watchdog timeout - workflow exceeded max duration', 'error');
      gracefulCleanup(`Watchdog timeout: workflow exceeded ${MAX_WORKFLOW_DURATION_MS / 1000 / 60} minutes`, 1);
    }, MAX_WORKFLOW_DURATION_MS);
    cleanupState.watchdogTimer = watchdogTimer;

    // Execute the workflow
    log(`[WorkflowRunner] Executing ${resolvedWorkflowName} (batch: ${isBatchWorkflow})`, 'info');

    let execution;
    try {
      execution = isBatchWorkflow
        ? await coordinator.executeBatchWorkflow(resolvedWorkflowName, resolvedParameters)
        : await coordinator.executeWorkflow(resolvedWorkflowName, resolvedParameters);
    } finally {
      // Always clear the heartbeat interval and watchdog timer
      clearInterval(heartbeatInterval);
      clearTimeout(watchdogTimer);
    }

    // Final success update - preserve workflowName, team, repositoryPath for dashboard display
    writeProgress(progressFile, {
      workflowId,
      workflowName: resolvedWorkflowName,
      team: parameters?.team || 'unknown',
      repositoryPath,
      status: execution.status === 'completed' ? 'completed' : 'failed',
      currentStep: String(execution.currentStep),
      stepsCompleted: typeof execution.currentStep === 'number' ? execution.currentStep : parseInt(String(execution.currentStep)) || 0,
      totalSteps: execution.totalSteps,
      message: `Workflow ${execution.status}`,
      startTime: startTime.toISOString(),
      lastUpdate: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
      pid: process.pid
    });

    log(`[WorkflowRunner] Workflow completed: ${execution.status}`, 'info', {
      duration: `${Math.round((Date.now() - startTime.getTime()) / 1000)}s`,
      steps: `${execution.currentStep}/${execution.totalSteps}`
    });

    // Update timing statistics for learned progress estimation
    if (execution.status === 'completed') {
      const totalBatches = (execution as any).batchIterations?.length ||
                          parameters?.totalBatches || 1;
      await updateTimingStatistics(repositoryPath, resolvedWorkflowName, totalBatches);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    writeProgress(progressFile, {
      workflowId,
      workflowName: workflowName, // Use config's workflowName (resolvedWorkflowName not in scope here)
      team: parameters?.team || 'unknown',
      repositoryPath,
      status: 'failed',
      error: errorMessage,
      message: `Workflow failed: ${errorMessage}`,
      startTime: startTime.toISOString(),
      lastUpdate: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
      pid: process.pid
    });

    log(`[WorkflowRunner] Workflow failed: ${errorMessage}`, 'error', error);
    process.exit(1);

  } finally {
    try {
      await coordinator.shutdown();
    } catch (e) {
      log('[WorkflowRunner] Error during shutdown', 'error', e);
    }

    // Clean up PID file
    try {
      fs.unlinkSync(pidFile);
    } catch (e) {
      // Ignore
    }

    // Clean up config file
    try {
      fs.unlinkSync(configPath);
    } catch (e) {
      // Ignore
    }
  }
}

// Run main
main().catch(e => {
  console.error('Fatal error in workflow runner:', e);
  process.exit(1);
});

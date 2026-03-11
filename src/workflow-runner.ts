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
import { loadAllWorkflows, getConfigDir, loadWorkflowRunnerConfig } from './utils/workflow-loader.js';
import { dispatch, subscribe, reset, createProgressFileSubscriber } from './workflow-state-machine.js';
import { InvalidTransitionError } from './shared/workflow-types/transitions.js';

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
      log('[WorkflowRunner] Failed to write final progress', 'error', e);
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
  // Write to stdout/stderr which now goes to log file
  console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION:`, reason);
  log('[WorkflowRunner] Unhandled promise rejection', 'error', { reason, promise: String(promise) });
  gracefulCleanup(`Unhandled rejection: ${reason}`, 1);
});

process.on('uncaughtException', (error) => {
  // Write to stdout/stderr which now goes to log file
  console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, error);
  console.error('Stack:', error.stack);
  log('[WorkflowRunner] Uncaught exception', 'error', error);
  gracefulCleanup(`Uncaught exception: ${error.message}`, 1);
});

// Additional exit monitoring for debugging silent crashes
process.on('beforeExit', (code) => {
  console.log(`[${new Date().toISOString()}] BEFORE EXIT: code=${code}`);
  console.log(`CleanupState: isShuttingDown=${cleanupState.isShuttingDown}, workflowId=${cleanupState.workflowId}`);
});

process.on('exit', (code) => {
  // This is the LAST thing that runs - use sync logging only
  try {
    const mem = process.memoryUsage();
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] EXIT: code=${code}, heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB`);
    // Also write to a dedicated crash log file for debugging
    const crashLogPath = cleanupState.progressFile?.replace('workflow-progress.json', 'workflow-exit.log');
    if (crashLogPath) {
      // Use the already-imported fs module (ESM compatible)
      fs.appendFileSync(crashLogPath, `[${timestamp}] EXIT: code=${code}, workflowId=${cleanupState.workflowId}, heap=${Math.round(mem.heapUsed/1024/1024)}MB, rss=${Math.round(mem.rss/1024/1024)}MB, isShuttingDown=${cleanupState.isShuttingDown}\n`);
    }
  } catch (e) {
    // Ignore - can't do much at exit time
  }
});

// Batch step names for phase separation - derived from workflow YAML definitions
function getBatchStepNames(): Set<string> {
  try {
    const configDir = getConfigDir();
    const workflows = loadAllWorkflows(configDir);
    const batchWorkflow = workflows.get('batch-analysis');
    if (batchWorkflow) {
      const names = new Set<string>();
      for (const step of batchWorkflow.steps) {
        if (step.phase === 'batch' || step.phase === 'initialization') {
          names.add(step.name);
          if (step.substeps) {
            step.substeps.forEach(sub => names.add(sub));
          }
        }
      }
      return names;
    }
  } catch {
    // Fall back to empty set if YAML loading fails
  }
  return new Set();
}
// Lazy-initialize once
let _batchSteps: Set<string> | null = null;
function BATCH_STEPS(): Set<string> {
  if (!_batchSteps) _batchSteps = getBatchStepNames();
  return _batchSteps;
}

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
  totalWaves?: number;
  currentWave?: number;
  completedSteps?: number;
  stepsDetail?: Array<{ name: string; status: string; wave?: number; startTime?: string; endTime?: string }>;
  batchIterations?: any;
}

/** @deprecated Remove after Phase 16 wave-controller migration (Plan 02). Use dispatch() + progress file subscriber instead. */
function writeProgress(progressFile: string, update: ProgressUpdate): void {
  try {
    // CRITICAL: Preserve debug state fields that may have been set by the dashboard
    // before the workflow started (singleStepMode, mockLLM, etc.)
    let preservedDebugState: Record<string, any> = {};
    if (fs.existsSync(progressFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
        // Preserve all debug/test state fields
        preservedDebugState = {
          singleStepMode: existing.singleStepMode,
          stepIntoSubsteps: existing.stepIntoSubsteps,
          stepPaused: existing.stepPaused,
          pausedAtStep: existing.pausedAtStep,
          pausedAt: existing.pausedAt,
          singleStepUpdatedAt: existing.singleStepUpdatedAt,
          singleStepTimeout: existing.singleStepTimeout,
          resumeRequestedAt: existing.resumeRequestedAt,
          mockLLM: existing.mockLLM,
          mockLLMDelay: existing.mockLLMDelay,
          mockLLMUpdatedAt: existing.mockLLMUpdatedAt,
          // CRITICAL: Preserve llmState for mock/local/public mode selection
          llmState: existing.llmState,
        };
        // Remove undefined values
        for (const key of Object.keys(preservedDebugState)) {
          if (preservedDebugState[key] === undefined) {
            delete preservedDebugState[key];
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Merge preserved debug state with new update
    const merged = { ...update, ...preservedDebugState };
    fs.writeFileSync(progressFile, JSON.stringify(merged, null, 2));
  } catch (e) {
    log('[WorkflowRunner] Failed to write progress', 'error', e);
  }
}

/**
 * Write progress while preserving detailed data from coordinator.
 * This merges status updates with existing batchIterations, stepsDetail, etc.
 * @deprecated Remove after Phase 16 wave-controller migration (Plan 02). Use dispatch() + progress file subscriber instead.
 */
function writeProgressPreservingDetails(progressFile: string, update: ProgressUpdate): void {
  try {
    let existingData: Record<string, any> = {};
    if (fs.existsSync(progressFile)) {
      try {
        existingData = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      } catch (e) {
        // Ignore parse errors, start fresh
      }
    }

    // Merge: new update takes precedence, but preserve detailed coordinator data
    const merged: Record<string, any> = {
      ...update,
      // Preserve detailed trace data from coordinator (update takes precedence if provided)
      batchIterations: update.batchIterations ?? existingData.batchIterations,
      stepsDetail: update.stepsDetail ?? existingData.stepsDetail,
      summary: existingData.summary,
      multiAgent: existingData.multiAgent,
      stepsRunning: existingData.stepsRunning,
      stepsSkipped: existingData.stepsSkipped,
      stepsFailed: existingData.stepsFailed,
      batchProgress: existingData.batchProgress,
      // Preserve wave controller progress fields (heartbeats must not clobber these)
      currentStep: update.currentStep ?? existingData.currentStep,
      currentWave: update.currentWave ?? existingData.currentWave,
      totalWaves: update.totalWaves ?? existingData.totalWaves,
      totalSteps: update.totalSteps ?? existingData.totalSteps,
      // CRITICAL: Preserve debug/test state fields
      singleStepMode: existingData.singleStepMode,
      stepIntoSubsteps: existingData.stepIntoSubsteps,
      stepPaused: existingData.stepPaused,
      pausedAtStep: existingData.pausedAtStep,
      pausedAt: existingData.pausedAt,
      singleStepUpdatedAt: existingData.singleStepUpdatedAt,
      singleStepTimeout: existingData.singleStepTimeout,
      resumeRequestedAt: existingData.resumeRequestedAt,
      mockLLM: existingData.mockLLM,
      mockLLMDelay: existingData.mockLLMDelay,
      mockLLMUpdatedAt: existingData.mockLLMUpdatedAt,
      // CRITICAL: Preserve llmState for mock/local/public mode selection
      llmState: existingData.llmState,
    };

    // Remove undefined/null fields
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined || merged[key] === null) {
        delete merged[key];
      }
    }

    fs.writeFileSync(progressFile, JSON.stringify(merged, null, 2));
  } catch (e) {
    log('[WorkflowRunner] Failed to write progress', 'error', e);
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

      if (BATCH_STEPS().has(step.name)) {
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

/**
 * Log memory usage to console (goes to log file)
 */
function logMemoryUsage(context: string): void {
  const mem = process.memoryUsage();
  const formatMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
  log(`MEMORY (${context}): heap=${formatMB(mem.heapUsed)}/${formatMB(mem.heapTotal)}, rss=${formatMB(mem.rss)}, external=${formatMB(mem.external)}`, 'debug');
}

/**
 * Save a completed workflow's trace data to .data/trace-history/ for historical comparison.
 * Keeps only the last 10 trace files (oldest deleted).
 * Never throws -- trace history saving must not fail the workflow.
 */
function saveTraceHistory(repositoryPath: string, progressFile: string, workflowName: string): void {
  try {
    if (!fs.existsSync(progressFile)) return;

    const progressData = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    const stepsDetail = progressData.stepsDetail || [];

    // Aggregate totals from stepsDetail
    let totalLLMCalls = 0;
    let totalTokens = 0;
    const entityCounts: Record<string, number> = {};

    for (const step of stepsDetail) {
      if (step.llmCalls) totalLLMCalls += step.llmCalls;
      if (step.tokensUsed) totalTokens += step.tokensUsed;
      // Aggregate LLM calls from llmCallEvents if present
      if (step.llmCallEvents && Array.isArray(step.llmCallEvents)) {
        totalLLMCalls += step.llmCallEvents.length;
        for (const call of step.llmCallEvents) {
          totalTokens += (call.tokensIn || 0) + (call.tokensOut || 0);
        }
      }
      // Get entity counts from the last persist step's entityFlow
      if (step.entityFlow) {
        entityCounts[step.name] = step.entityFlow.persisted || step.entityFlow.produced || 0;
      }
    }

    const traceData = {
      workflowName,
      startTime: progressData.startTime,
      endTime: progressData.lastUpdate,
      status: progressData.status,
      totalLLMCalls,
      totalTokens,
      entityCounts,
      stepsDetail,
    };

    // Ensure trace history directory exists
    const traceDir = path.join(repositoryPath, '.data', 'trace-history');
    if (!fs.existsSync(traceDir)) {
      fs.mkdirSync(traceDir, { recursive: true });
    }

    // Write trace file with ISO timestamp prefix
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const traceFile = path.join(traceDir, `${timestamp}-${workflowName}.json`);
    fs.writeFileSync(traceFile, JSON.stringify(traceData, null, 2));

    log('[WorkflowRunner] Trace history saved', 'info', { file: traceFile });

    // Cleanup: keep only last 10 trace files
    const files = fs.readdirSync(traceDir)
      .filter(f => f.endsWith('.json'))
      .sort(); // Sorted by timestamp prefix (alphabetical = chronological)

    if (files.length > 10) {
      const toDelete = files.slice(0, files.length - 10);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(path.join(traceDir, file));
          log('[WorkflowRunner] Deleted old trace file', 'debug', { file });
        } catch (e) {
          // Ignore deletion errors
        }
      }
    }
  } catch (e) {
    // Non-fatal: trace history saving must never fail the workflow
    log('[WorkflowRunner] Failed to save trace history (non-fatal)', 'warning', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];

  // Startup banner
  log(`${'='.repeat(60)}`, 'info');
  log(`WORKFLOW RUNNER STARTING`, 'info');
  log(`PID: ${process.pid}, Node: ${process.version}`, 'info');
  log(`Config: ${configPath}`, 'info');
  logMemoryUsage('startup');
  log(`${'='.repeat(60)}`, 'info');

  if (!configPath) {
    process.stderr.write('Usage: workflow-runner <config-file-path>\n');
    process.exit(1);
  }

  let config: WorkflowConfig;

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configContent);
  } catch (e) {
    log('Failed to read config file', 'error', e);
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

  // Register progress file subscriber -- writes WorkflowState to disk on every transition
  const unsubscribeProgressFile = subscribe(createProgressFileSubscriber(progressFile));

  // Dispatch start event to the runner's state machine instance
  try {
    // Read debug settings from progress file if they were pre-set by tools.ts
    let presetConfig: Record<string, any> = {};
    if (fs.existsSync(progressFile)) {
      try {
        presetConfig = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      } catch { /* ignore */ }
    }

    dispatch({
      type: 'start',
      config: {
        singleStepMode: presetConfig.singleStepMode || parameters?.singleStepMode || false,
        mockLLM: presetConfig.mockLLM || parameters?.mockLLM || false,
        llmMode: presetConfig.llmState?.globalMode || parameters?.llmMode || 'public',
        stepIntoSubsteps: presetConfig.stepIntoSubsteps || parameters?.stepIntoSubsteps || false,
      },
      workflowName,
      firstStep: workflowName === 'wave-analysis' ? 'wave1_init' : 'initializing',
    });
  } catch (err) {
    // Reset and retry if state machine is in unexpected state (e.g., leftover from previous crash)
    if (err instanceof InvalidTransitionError) {
      log(`[WorkflowRunner] State machine in unexpected state, resetting: ${err.message}`, 'warning');
      reset();
      dispatch({
        type: 'start',
        config: {
          singleStepMode: parameters?.singleStepMode || false,
          mockLLM: parameters?.mockLLM || false,
          llmMode: parameters?.llmMode || 'public',
          stepIntoSubsteps: parameters?.stepIntoSubsteps || false,
        },
        workflowName,
        firstStep: workflowName === 'wave-analysis' ? 'wave1_init' : 'initializing',
      });
    } else {
      throw err;
    }
  }

  // Legacy initial progress write for backward compatibility with dashboard
  // TODO(phase-19): Remove -- progress file subscriber handles this via dispatch above
  writeProgress(progressFile, {
    workflowId,
    workflowName,
    team: parameters?.team || 'unknown',
    repositoryPath,
    status: 'starting',
    message: 'Initializing workflow runner...',
    startTime: startTime.toISOString(),
    lastUpdate: new Date().toISOString(),
    elapsedSeconds: 0,
    totalSteps: 0, // Will be updated by coordinator
    pid: process.pid
  });

  // Wave-analysis routing -- separate from coordinator path
  if (workflowName === 'wave-analysis') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { WaveController } = await import('./agents/wave-controller.js' as any);
    const waveController = new WaveController({
      repositoryPath,
      team: parameters?.team || 'coding',
      progressFile
    });

    // Set initial totalSteps AND stepsDetail so dashboard wave sidebar shows
    // proper pending states from the start (not empty until wave controller writes first update)
    // 17 sub-steps: 3 waves × (analyze + classify + persist) + init + 6 kg-ops + insights
    const initialStepsDetail = [
      { name: 'wave1_init',      status: 'pending', wave: 1 },
      { name: 'wave1_analyze',   status: 'pending', wave: 1 },
      { name: 'wave1_classify',  status: 'pending', wave: 1 },
      { name: 'wave1_persist',   status: 'pending', wave: 1 },
      { name: 'wave2_analyze',   status: 'pending', wave: 2 },
      { name: 'wave2_classify',  status: 'pending', wave: 2 },
      { name: 'wave2_persist',   status: 'pending', wave: 2 },
      { name: 'wave3_analyze',   status: 'pending', wave: 3 },
      { name: 'wave3_classify',  status: 'pending', wave: 3 },
      { name: 'wave3_persist',   status: 'pending', wave: 3 },
      { name: 'operator_conv',   status: 'pending', wave: 3 },
      { name: 'operator_aggr',   status: 'pending', wave: 3 },
      { name: 'operator_embed',  status: 'pending', wave: 3 },
      { name: 'operator_dedup',  status: 'pending', wave: 3 },
      { name: 'operator_pred',   status: 'pending', wave: 3 },
      { name: 'operator_merge',  status: 'pending', wave: 3 },
      { name: 'wave4_insights',  status: 'pending', wave: 4 },
    ];
    writeProgressPreservingDetails(progressFile, {
      workflowId,
      workflowName: 'wave-analysis',
      team: parameters?.team || 'unknown',
      repositoryPath,
      status: 'running',
      message: 'Starting wave analysis...',
      startTime: startTime.toISOString(),
      lastUpdate: new Date().toISOString(),
      elapsedSeconds: 0,
      totalSteps: 17,  // 11 wave steps + 6 operator steps
      totalWaves: 4,
      stepsDetail: initialStepsDetail,
      pid: process.pid
    });

    // Heartbeat removed -- the subscriber writes on every transition (~30 per run),
    // and wave-controller's frequent transitions serve as natural heartbeats.
    // If no transition occurs for >60s, that's a real hang, not a heartbeat issue.

    try {
      const result = await waveController.execute();

      // Dispatch complete or fail event via state machine
      if (result.success) {
        try {
          dispatch({
            type: 'complete',
            summary: {
              totalEntities: result.totalEntities,
              waves: result.waves.length,
              message: `Wave analysis completed: ${result.totalEntities} entities across ${result.waves.length} waves`,
            },
          });
        } catch (err) {
          if (!(err instanceof InvalidTransitionError)) throw err;
        }
        saveTraceHistory(repositoryPath, progressFile, 'wave-analysis');
      } else {
        try {
          dispatch({
            type: 'fail',
            error: 'Wave analysis completed with errors',
            step: 'wave-analysis',
          });
        } catch (err) {
          if (!(err instanceof InvalidTransitionError)) throw err;
        }
      }

      // Legacy: Also write final status to progress file for dashboard backward compat
      // TODO(phase-19): Remove -- state machine subscriber handles this
      const finalStatus = result.success ? 'completed' : 'failed';
      const now = new Date().toISOString();
      let existingProgress: Record<string, any> = {};
      try {
        existingProgress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
      } catch (e) { /* ignore */ }
      const finalStepsDetail = (existingProgress.stepsDetail || []).map((s: any) => ({
        ...s,
        status: s.status === 'pending' || s.status === 'running' ? finalStatus : s.status,
        ...(s.status === 'pending' || s.status === 'running' ? { endTime: now } : {}),
      }));

      writeProgressPreservingDetails(progressFile, {
        workflowId,
        workflowName: 'wave-analysis',
        team: parameters?.team || 'unknown',
        repositoryPath,
        status: finalStatus,
        message: `Wave analysis ${result.success ? 'completed' : 'failed'}: ${result.totalEntities} entities across ${result.waves.length} waves`,
        startTime: startTime.toISOString(),
        lastUpdate: now,
        elapsedSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
        completedSteps: finalStepsDetail.filter((s: any) => s.status === 'completed').length,
        stepsDetail: finalStepsDetail,
        pid: process.pid
      });

      // Clean up
      unsubscribeProgressFile();
      try { fs.unlinkSync(pidFile); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
      process.exit(result.success ? 0 : 1);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Dispatch fail event via state machine
      try {
        dispatch({ type: 'fail', error: errorMessage, step: 'wave-analysis' });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }

      // Legacy fallback write
      writeProgressPreservingDetails(progressFile, {
        workflowId,
        workflowName: 'wave-analysis',
        team: parameters?.team || 'unknown',
        repositoryPath,
        status: 'failed',
        error: errorMessage,
        message: `Wave analysis failed: ${errorMessage}`,
        startTime: startTime.toISOString(),
        lastUpdate: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - startTime.getTime()) / 1000),
        pid: process.pid
      });
      unsubscribeProgressFile();
      try { fs.unlinkSync(pidFile); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
      process.exit(1);
    }
  }

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
        // Fresh start each time - incremental means "since last analysis timestamp", not "resume crashed workflow"
        defaults: { fullAnalysis: false, forceCleanStart: true, resumeFromCheckpoint: true }
      },
      'batch-analysis': {
        target: 'batch-analysis',
        // Fresh start by default - use complete-analysis for crash recovery behavior
        defaults: { forceCleanStart: true, resumeFromCheckpoint: true }
      }
    };

    const mapping = workflowMapping[workflowName];
    const resolvedWorkflowName = mapping?.target || workflowName;
    const resolvedParameters = mapping ? { ...mapping.defaults, ...parameters } : parameters;

    // Get workflow info
    const workflows = coordinator.getWorkflows();
    const workflow = workflows.find(w => w.name === resolvedWorkflowName);
    const isBatchWorkflow = workflow?.type === 'iterative' || resolvedWorkflowName === 'batch-analysis';

    // Heartbeat removed -- subscriber writes on every transition, and coordinator
    // transitions serve as natural heartbeats. No separate interval needed.

    // Start watchdog timer to prevent indefinite hangs
    const MAX_WORKFLOW_DURATION_MS = loadWorkflowRunnerConfig().runner.max_duration_ms;
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
      clearTimeout(watchdogTimer);
    }

    // Dispatch complete/fail event via state machine
    if (execution.status === 'completed') {
      try {
        dispatch({
          type: 'complete',
          summary: {
            steps: `${execution.currentStep}/${execution.totalSteps}`,
            message: `Workflow ${execution.status}`,
          },
        });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }
    } else {
      try {
        dispatch({
          type: 'fail',
          error: `Workflow ${execution.status}`,
          step: String(execution.currentStep),
        });
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) throw err;
      }
    }

    // Legacy: Final progress file write for dashboard backward compat
    // TODO(phase-19): Remove -- state machine subscriber handles this
    writeProgressPreservingDetails(progressFile, {
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

    // Dispatch fail event via state machine
    try {
      dispatch({ type: 'fail', error: errorMessage, step: 'unknown' });
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
    }

    // Legacy fallback write
    writeProgressPreservingDetails(progressFile, {
      workflowId,
      workflowName: workflowName,
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
    // Unsubscribe progress file subscriber to prevent leaks
    unsubscribeProgressFile();

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
main().then(() => {
  log('[WorkflowRunner] Main function completed, exiting', 'info');
  process.exit(0);
}).catch(e => {
  log('Fatal error in workflow runner', 'error', e);
  process.exit(1);
});

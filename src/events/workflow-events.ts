/**
 * Workflow Event Protocol
 *
 * Defines the event-driven communication protocol between the Coordinator and Dashboard.
 * This replaces file-based polling with real-time WebSocket events.
 *
 * Design Principle:
 *   YAML Config (loaded once) --> Redux (single source of truth) <-- WebSocket Events (from Coordinator)
 *                                            |
 *                                            v
 *                                  UI Components (pure rendering)
 */

// ============================================
// Step Status Types
// ============================================

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepDefinition {
  name: string;
  agent: string;
  action: string;
  phase?: 'initialization' | 'batch' | 'finalization';
  substeps?: string[];
  operator?: string;
  tier?: 'fast' | 'standard' | 'premium';
}

export interface StepStatusInfo {
  name: string;
  status: StepStatus;
  agent: string;
  duration?: number;
  tokensUsed?: number;
  llmProvider?: string;
  llmCalls?: number;
  error?: string;
  outputs?: Record<string, unknown>;
}

export interface SubstepStatusInfo {
  substepId: string;
  status: StepStatus;
  duration?: number;
  tokensUsed?: number;
  llmProvider?: string;
}

export interface BatchProgress {
  currentBatch: number;
  totalBatches: number;
  batchId?: string;
}

// ============================================
// Workflow Events (Coordinator → Dashboard)
// ============================================

/**
 * Emitted when a workflow starts.
 * Contains step definitions from YAML for Redux to store.
 */
export interface WorkflowStartedEvent {
  type: 'WORKFLOW_STARTED';
  payload: {
    workflowId: string;
    workflowName: string;
    team: string;
    repositoryPath: string;
    startTime: string;
    steps: StepDefinition[];
    totalSteps: number;
    batchPhaseSteps: string[]; // Names of steps that repeat per batch
    preferences: {
      singleStepMode: boolean;
      stepIntoSubsteps: boolean;
      mockLLM: boolean;
      mockLLMDelay: number;
    };
  };
}

/**
 * Emitted when a step starts execution.
 */
export interface StepStartedEvent {
  type: 'STEP_STARTED';
  payload: {
    workflowId: string;
    stepName: string;
    agent: string;
    stepIndex: number;
    phase?: 'initialization' | 'batch' | 'finalization';
    timestamp: string;
  };
}

/**
 * Emitted when a step completes successfully.
 */
export interface StepCompletedEvent {
  type: 'STEP_COMPLETED';
  payload: {
    workflowId: string;
    stepName: string;
    agent: string;
    stepIndex: number;
    duration: number;
    tokensUsed?: number;
    llmProvider?: string;
    llmCalls?: number;
    outputs?: Record<string, unknown>;
    timestamp: string;
  };
}

/**
 * Emitted when a step fails.
 */
export interface StepFailedEvent {
  type: 'STEP_FAILED';
  payload: {
    workflowId: string;
    stepName: string;
    agent: string;
    stepIndex: number;
    error: string;
    duration: number;
    willRetry: boolean;
    retryCount?: number;
    timestamp: string;
  };
}

/**
 * Emitted when a substep starts execution.
 */
export interface SubstepStartedEvent {
  type: 'SUBSTEP_STARTED';
  payload: {
    workflowId: string;
    stepName: string;
    substepId: string;
    substepIndex: number;
    timestamp: string;
  };
}

/**
 * Emitted when a substep completes.
 */
export interface SubstepCompletedEvent {
  type: 'SUBSTEP_COMPLETED';
  payload: {
    workflowId: string;
    stepName: string;
    substepId: string;
    substepIndex: number;
    duration: number;
    tokensUsed?: number;
    llmProvider?: string;
    timestamp: string;
  };
}

/**
 * Emitted when a batch iteration starts.
 */
export interface BatchStartedEvent {
  type: 'BATCH_STARTED';
  payload: {
    workflowId: string;
    batchId: string;
    batchNumber: number;
    totalBatches: number;
    timestamp: string;
  };
}

/**
 * Emitted when a batch iteration completes.
 */
export interface BatchCompletedEvent {
  type: 'BATCH_COMPLETED';
  payload: {
    workflowId: string;
    batchId: string;
    batchNumber: number;
    duration: number;
    stats?: {
      commits?: number;
      sessions?: number;
      tokensUsed?: number;
      entitiesCreated?: number;
      entitiesUpdated?: number;
      relationsAdded?: number;
    };
    timestamp: string;
  };
}

/**
 * Emitted when workflow pauses (single-step mode or manual pause).
 */
export interface WorkflowPausedEvent {
  type: 'WORKFLOW_PAUSED';
  payload: {
    workflowId: string;
    pausedAtStep: string;
    pausedAtSubstep?: string;
    reason: 'single_step' | 'manual' | 'error';
    timestamp: string;
  };
}

/**
 * Emitted when workflow resumes after pause.
 */
export interface WorkflowResumedEvent {
  type: 'WORKFLOW_RESUMED';
  payload: {
    workflowId: string;
    resumedAtStep: string;
    timestamp: string;
  };
}

/**
 * Emitted when workflow completes successfully.
 */
export interface WorkflowCompletedEvent {
  type: 'WORKFLOW_COMPLETED';
  payload: {
    workflowId: string;
    duration: number;
    totalStepsCompleted: number;
    totalBatches?: number;
    stats?: {
      totalTokensUsed?: number;
      totalLLMCalls?: number;
      entitiesCreated?: number;
      entitiesUpdated?: number;
      relationsAdded?: number;
    };
    timestamp: string;
  };
}

/**
 * Emitted when workflow fails.
 */
export interface WorkflowFailedEvent {
  type: 'WORKFLOW_FAILED';
  payload: {
    workflowId: string;
    error: string;
    failedAtStep?: string;
    duration: number;
    timestamp: string;
  };
}

/**
 * Emitted when preferences change (confirmed by coordinator).
 */
export interface PreferencesUpdatedEvent {
  type: 'PREFERENCES_UPDATED';
  payload: {
    workflowId: string;
    preferences: {
      singleStepMode?: boolean;
      stepIntoSubsteps?: boolean;
      mockLLM?: boolean;
      mockLLMDelay?: number;
    };
    timestamp: string;
  };
}

/**
 * Heartbeat event to keep connection alive and sync state.
 */
export interface HeartbeatEvent {
  type: 'HEARTBEAT';
  payload: {
    workflowId: string | null;
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
    timestamp: string;
  };
}

/**
 * Union type of all workflow events from Coordinator to Dashboard.
 */
export type WorkflowEvent =
  | WorkflowStartedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | SubstepStartedEvent
  | SubstepCompletedEvent
  | BatchStartedEvent
  | BatchCompletedEvent
  | WorkflowPausedEvent
  | WorkflowResumedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | PreferencesUpdatedEvent
  | HeartbeatEvent;

// ============================================
// Workflow Commands (Dashboard → Coordinator)
// ============================================

/**
 * Advance to next step when paused in single-step mode.
 */
export interface StepAdvanceCommand {
  type: 'STEP_ADVANCE';
  payload: {
    workflowId: string;
  };
}

/**
 * Step into substeps mode (expand current step's substeps).
 */
export interface StepIntoCommand {
  type: 'STEP_INTO';
  payload: {
    workflowId: string;
  };
}

/**
 * Enable/disable single-step debugging mode.
 */
export interface SetSingleStepModeCommand {
  type: 'SET_SINGLE_STEP_MODE';
  payload: {
    enabled: boolean;
  };
}

/**
 * Enable/disable stepping into substeps.
 */
export interface SetStepIntoSubstepsCommand {
  type: 'SET_STEP_INTO_SUBSTEPS';
  payload: {
    enabled: boolean;
  };
}

/**
 * Enable/disable mock LLM mode.
 */
export interface SetMockLLMCommand {
  type: 'SET_MOCK_LLM';
  payload: {
    enabled: boolean;
    delay?: number;
  };
}

/**
 * Cancel running workflow.
 */
export interface CancelWorkflowCommand {
  type: 'CANCEL_WORKFLOW';
  payload: {
    workflowId: string;
    reason?: string;
  };
}

/**
 * Pause running workflow.
 */
export interface PauseWorkflowCommand {
  type: 'PAUSE_WORKFLOW';
  payload: {
    workflowId: string;
  };
}

/**
 * Resume paused workflow.
 */
export interface ResumeWorkflowCommand {
  type: 'RESUME_WORKFLOW';
  payload: {
    workflowId: string;
  };
}

/**
 * Union type of all commands from Dashboard to Coordinator.
 */
export type WorkflowCommand =
  | StepAdvanceCommand
  | StepIntoCommand
  | SetSingleStepModeCommand
  | SetStepIntoSubstepsCommand
  | SetMockLLMCommand
  | CancelWorkflowCommand
  | PauseWorkflowCommand
  | ResumeWorkflowCommand;

// ============================================
// Event Emitter Interface
// ============================================

/**
 * Interface for emitting workflow events.
 * Implemented by Coordinator and consumed by WebSocket relay.
 */
export interface WorkflowEventEmitter {
  /**
   * Emit a workflow event to all connected clients.
   */
  emit(event: WorkflowEvent): void;

  /**
   * Subscribe to events (returns unsubscribe function).
   */
  subscribe(handler: (event: WorkflowEvent) => void): () => void;
}

/**
 * Interface for handling workflow commands.
 * Implemented by Coordinator to receive commands from Dashboard.
 */
export interface WorkflowCommandHandler {
  /**
   * Handle a command from the dashboard.
   * Returns true if command was handled successfully.
   */
  handleCommand(command: WorkflowCommand): Promise<boolean>;
}

// ============================================
// Redux State Types (for ukbSlice)
// ============================================

/**
 * Execution state structure for Redux.
 * Single source of truth for workflow state.
 */
export interface WorkflowExecutionState {
  workflowId: string | null;
  workflowName: string | null;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  currentStep: string | null;
  currentSubstep: string | null;
  stepStatuses: Record<string, StepStatusInfo>;
  substepStatuses: Record<string, Record<string, SubstepStatusInfo>>;
  batchProgress: BatchProgress | null;
  batchPhaseSteps: string[];
  startTime: string | null;
  lastUpdate: string | null;
}

/**
 * Workflow preferences state for Redux.
 */
export interface WorkflowPreferencesState {
  singleStepMode: boolean;
  singleStepModeExplicit: boolean;
  stepIntoSubsteps: boolean;
  mockLLM: boolean;
  mockLLMExplicit: boolean;
  mockLLMDelay: number;
}

// ============================================
// Type Guards
// ============================================

export function isWorkflowEvent(obj: unknown): obj is WorkflowEvent {
  if (typeof obj !== 'object' || obj === null) return false;
  const event = obj as { type?: string };
  return typeof event.type === 'string' && [
    'WORKFLOW_STARTED', 'STEP_STARTED', 'STEP_COMPLETED', 'STEP_FAILED',
    'SUBSTEP_STARTED', 'SUBSTEP_COMPLETED', 'BATCH_STARTED', 'BATCH_COMPLETED',
    'WORKFLOW_PAUSED', 'WORKFLOW_RESUMED', 'WORKFLOW_COMPLETED', 'WORKFLOW_FAILED',
    'PREFERENCES_UPDATED', 'HEARTBEAT'
  ].includes(event.type);
}

export function isWorkflowCommand(obj: unknown): obj is WorkflowCommand {
  if (typeof obj !== 'object' || obj === null) return false;
  const cmd = obj as { type?: string };
  return typeof cmd.type === 'string' && [
    'STEP_ADVANCE', 'STEP_INTO', 'SET_SINGLE_STEP_MODE', 'SET_STEP_INTO_SUBSTEPS',
    'SET_MOCK_LLM', 'CANCEL_WORKFLOW', 'PAUSE_WORKFLOW', 'RESUME_WORKFLOW'
  ].includes(cmd.type);
}

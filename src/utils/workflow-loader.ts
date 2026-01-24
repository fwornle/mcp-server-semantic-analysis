/**
 * Workflow Loader - Single Source of Truth
 *
 * Loads workflow definitions from YAML configuration files.
 * These YAML files are the authoritative source for:
 * - Coordinator (workflow execution)
 * - Dashboard (DAG visualization)
 * - Documentation (PlantUML generation)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import type { WorkflowDefinition, WorkflowStep } from '../agents/coordinator.js';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// YAML Schema Interfaces
// ============================================================================

/** Agent definition from agents.yaml */
export interface AgentDefinition {
  id: string;
  name: string;
  shortName: string;
  icon: string;
  description: string;
  usesLLM: boolean;
  llmModel: string | null;
  techStack: string;
  phase: number;
  row: number;
  col: number;
}

/** Orchestrator definition (special node) */
export interface OrchestratorDefinition extends AgentDefinition {
  id: 'orchestrator';
}

/** Step definition from workflow YAML */
export interface StepYAML {
  name: string;
  agent: string;
  action: string;
  parameters: Record<string, any>;
  timeout?: number;
  dependencies: string[];
  condition?: string;
  phase?: 'initialization' | 'batch' | 'finalization';  // For iterative workflows
  operator?: string;  // Tree-KG operator name (conv, aggr, embed, dedup, pred, merge)
  tier?: 'fast' | 'standard' | 'premium';  // Model tier override
  substeps?: string[];  // Sub-step names reported during execution (for progress visibility)
}

/** Edge definition for DAG visualization */
export interface EdgeDefinition {
  from: string;
  to: string;
  type: 'dataflow' | 'dependency';
}

/** Workflow YAML structure */
export interface WorkflowYAML {
  workflow: {
    name: string;
    version: string;
    description: string;
    type?: 'standard' | 'iterative';  // iterative = batch processing
  };
  config: {
    max_concurrent_steps: number;
    timeout: number;
    quality_validation: boolean;
  };
  steps: StepYAML[];
  edges: EdgeDefinition[];
}

/** Agents YAML structure */
export interface AgentsYAML {
  orchestrator: OrchestratorDefinition;
  agents: AgentDefinition[];
  step_mappings: Record<string, string>;
}

/** Combined definition for dashboard/visualization */
export interface FullWorkflowDefinition {
  workflow: WorkflowYAML;
  agents: AgentsYAML;
}

// ============================================================================
// Config YAML Interfaces
// ============================================================================

/** Orchestrator configuration from orchestrator.yaml */
export interface OrchestratorConfig {
  orchestrator: {
    max_retries: number;
    retry_threshold: number;
    skip_threshold: number;
    use_llm_routing: boolean;
    max_concurrent_steps: number;
    default_step_timeout: number;
  };
  single_step_debug: {
    poll_interval_ms: number;
    log_interval_ms: number;
    max_consecutive_errors: number;
  };
  mock_mode: {
    min_step_time_ms: number;
  };
}

/** Workflow runner configuration from workflow-runner.yaml */
export interface WorkflowRunnerConfig {
  runner: {
    heartbeat_interval_ms: number;
    max_duration_ms: number;
  };
}

/** Agent tuning configuration from agent-tuning.yaml */
export interface AgentTuningConfig {
  code_graph: {
    memgraph_check_timeout_ms: number;
    uv_process_timeout_ms: number;
  };
  documentation_linker: {
    reference_batch_size: number;
  };
  deduplication: {
    batch_size: number;
  };
}

// ============================================================================
// Loader Functions
// ============================================================================

/**
 * Get the config directory path
 */
export function getConfigDir(): string {
  // Navigate from src/utils to config/
  return path.join(__dirname, '../../config');
}

/**
 * Load and parse agents.yaml
 */
export function loadAgentsYAML(configDir?: string): AgentsYAML {
  const dir = configDir || getConfigDir();
  const agentsPath = path.join(dir, 'agents.yaml');

  if (!fs.existsSync(agentsPath)) {
    throw new Error(`Agents configuration not found: ${agentsPath}`);
  }

  const content = fs.readFileSync(agentsPath, 'utf-8');
  return parse(content) as AgentsYAML;
}

/**
 * Load and parse a workflow YAML file
 */
export function loadWorkflowYAML(workflowName: string, configDir?: string): WorkflowYAML {
  const dir = configDir || getConfigDir();
  const workflowPath = path.join(dir, 'workflows', `${workflowName}.yaml`);

  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow configuration not found: ${workflowPath}`);
  }

  const content = fs.readFileSync(workflowPath, 'utf-8');
  return parse(content) as WorkflowYAML;
}

/**
 * Convert YAML step to WorkflowStep interface
 */
function convertStep(step: StepYAML): WorkflowStep {
  return {
    name: step.name,
    agent: step.agent,
    action: step.action,
    parameters: step.parameters,
    dependencies: step.dependencies,
    timeout: step.timeout,
    condition: step.condition,
    phase: step.phase,        // For batch workflows
    operator: step.operator,  // Tree-KG operator
    tier: step.tier,          // Model tier
    substeps: step.substeps,  // Sub-step names for progress visibility
  };
}

/**
 * Load workflow from YAML and convert to WorkflowDefinition
 * This is the main function used by the Coordinator
 */
export function loadWorkflowFromYAML(workflowName: string, configDir?: string): WorkflowDefinition {
  const workflowYAML = loadWorkflowYAML(workflowName, configDir);
  const agentsYAML = loadAgentsYAML(configDir);

  // Extract unique agent IDs from steps
  const agentIds = [...new Set(workflowYAML.steps.map(s => s.agent))];

  return {
    name: workflowYAML.workflow.name,
    description: workflowYAML.workflow.description,
    agents: agentIds,
    steps: workflowYAML.steps.map(convertStep),
    config: workflowYAML.config,
    type: workflowYAML.workflow.type,  // Map type for batch/iterative workflows
  };
}

/**
 * Load all workflows from the config directory
 */
export function loadAllWorkflows(configDir?: string): Map<string, WorkflowDefinition> {
  const dir = configDir || getConfigDir();
  const workflowsDir = path.join(dir, 'workflows');
  const workflows = new Map<string, WorkflowDefinition>();

  if (!fs.existsSync(workflowsDir)) {
    console.error(`Workflows directory not found: ${workflowsDir}`);
    return workflows;
  }

  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yaml'));

  for (const file of files) {
    const workflowName = file.replace('.yaml', '');
    try {
      const definition = loadWorkflowFromYAML(workflowName, dir);
      workflows.set(workflowName, definition);
      console.error(`Loaded workflow: ${workflowName}`);
    } catch (error) {
      console.error(`Failed to load workflow ${workflowName}:`, error);
    }
  }

  return workflows;
}

/**
 * Load full workflow definition including agents (for dashboard/visualization)
 */
export function loadFullWorkflowDefinition(workflowName: string, configDir?: string): FullWorkflowDefinition {
  return {
    workflow: loadWorkflowYAML(workflowName, configDir),
    agents: loadAgentsYAML(configDir),
  };
}

/**
 * Get agent definition by ID
 */
export function getAgentById(agentId: string, agentsYAML: AgentsYAML): AgentDefinition | OrchestratorDefinition | undefined {
  if (agentId === 'orchestrator') {
    return agentsYAML.orchestrator;
  }
  return agentsYAML.agents.find(a => a.id === agentId);
}

/**
 * Resolve step name to agent ID using step_mappings
 */
export function resolveStepToAgent(stepName: string, agentsYAML: AgentsYAML): string | undefined {
  return agentsYAML.step_mappings[stepName];
}

/**
 * Validate workflow definition against agents
 */
export function validateWorkflow(workflowYAML: WorkflowYAML, agentsYAML: AgentsYAML): string[] {
  const errors: string[] = [];
  const validAgentIds = new Set([
    'orchestrator',
    ...agentsYAML.agents.map(a => a.id)
  ]);

  // Validate step agents exist
  for (const step of workflowYAML.steps) {
    if (!validAgentIds.has(step.agent)) {
      errors.push(`Step "${step.name}" references unknown agent: ${step.agent}`);
    }
  }

  // Validate edge agents exist
  for (const edge of workflowYAML.edges) {
    if (!validAgentIds.has(edge.from)) {
      errors.push(`Edge "from" references unknown agent: ${edge.from}`);
    }
    if (!validAgentIds.has(edge.to)) {
      errors.push(`Edge "to" references unknown agent: ${edge.to}`);
    }
  }

  // Validate step dependencies exist
  const stepNames = new Set(workflowYAML.steps.map(s => s.name));
  for (const step of workflowYAML.steps) {
    for (const dep of step.dependencies) {
      if (!stepNames.has(dep)) {
        errors.push(`Step "${step.name}" depends on unknown step: ${dep}`);
      }
    }
  }

  return errors;
}

// ============================================================================
// Config Loaders
// ============================================================================

/** Cached configs to avoid repeated file reads */
let _orchestratorConfig: OrchestratorConfig | null = null;
let _workflowRunnerConfig: WorkflowRunnerConfig | null = null;
let _agentTuningConfig: AgentTuningConfig | null = null;

/**
 * Load orchestrator.yaml configuration
 */
export function loadOrchestratorConfig(configDir?: string): OrchestratorConfig {
  if (_orchestratorConfig) return _orchestratorConfig;
  const dir = configDir || getConfigDir();
  const configPath = path.join(dir, 'orchestrator.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Orchestrator configuration not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  _orchestratorConfig = parse(content) as OrchestratorConfig;
  return _orchestratorConfig;
}

/**
 * Load workflow-runner.yaml configuration
 */
export function loadWorkflowRunnerConfig(configDir?: string): WorkflowRunnerConfig {
  if (_workflowRunnerConfig) return _workflowRunnerConfig;
  const dir = configDir || getConfigDir();
  const configPath = path.join(dir, 'workflow-runner.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Workflow runner configuration not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  _workflowRunnerConfig = parse(content) as WorkflowRunnerConfig;
  return _workflowRunnerConfig;
}

/**
 * Load agent-tuning.yaml configuration
 */
export function loadAgentTuningConfig(configDir?: string): AgentTuningConfig {
  if (_agentTuningConfig) return _agentTuningConfig;
  const dir = configDir || getConfigDir();
  const configPath = path.join(dir, 'agent-tuning.yaml');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Agent tuning configuration not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  _agentTuningConfig = parse(content) as AgentTuningConfig;
  return _agentTuningConfig;
}

/**
 * Clear cached configs (useful for testing or hot-reload)
 */
export function clearConfigCache(): void {
  _orchestratorConfig = null;
  _workflowRunnerConfig = null;
  _agentTuningConfig = null;
}

// ============================================================================
// Export for Dashboard API
// ============================================================================

/**
 * Get workflow definitions as JSON for API response
 */
export function getWorkflowDefinitionsForAPI(workflowName: string, configDir?: string): {
  agents: (AgentDefinition | OrchestratorDefinition)[];
  orchestrator: OrchestratorDefinition;
  workflow: WorkflowYAML;
  stepMappings: Record<string, string>;
} {
  const full = loadFullWorkflowDefinition(workflowName, configDir);

  return {
    agents: full.agents.agents,
    orchestrator: full.agents.orchestrator,
    workflow: full.workflow,
    stepMappings: full.agents.step_mappings,
  };
}

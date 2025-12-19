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
import { parse } from 'yaml';
import type { WorkflowDefinition, WorkflowStep } from '../agents/coordinator.js';

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
    console.warn(`Workflows directory not found: ${workflowsDir}`);
    return workflows;
  }

  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yaml'));

  for (const file of files) {
    const workflowName = file.replace('.yaml', '');
    try {
      const definition = loadWorkflowFromYAML(workflowName, dir);
      workflows.set(workflowName, definition);
      console.log(`Loaded workflow: ${workflowName}`);
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

#!/usr/bin/env npx tsx
/**
 * PlantUML Generator - Single Source of Truth
 *
 * Generates PlantUML diagrams from workflow YAML definitions.
 * This ensures documentation diagrams stay in sync with actual workflow structure.
 *
 * Usage:
 *   npx tsx scripts/generate-workflow-puml.ts
 *   npx tsx scripts/generate-workflow-puml.ts --workflow incremental-analysis
 *   npx tsx scripts/generate-workflow-puml.ts --output docs/images
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';

// Get script directory and config paths
const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const configDir = path.join(scriptDir, '../config');

interface AgentDefinition {
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

interface OrchestratorDefinition extends AgentDefinition {
  id: 'orchestrator';
}

interface EdgeDefinition {
  from: string;
  to: string;
  type?: 'dataflow' | 'dependency';
}

interface AgentsYAML {
  orchestrator: OrchestratorDefinition;
  agents: AgentDefinition[];
  step_mappings: Record<string, string>;
}

interface WorkflowYAML {
  workflow: {
    name: string;
    version: string;
    description: string;
  };
  config: Record<string, any>;
  steps: any[];
  edges: EdgeDefinition[];
}

function loadAgents(): AgentsYAML {
  const agentsPath = path.join(configDir, 'agents.yaml');
  const content = fs.readFileSync(agentsPath, 'utf-8');
  return parse(content) as AgentsYAML;
}

function loadWorkflow(workflowName: string): WorkflowYAML {
  const workflowPath = path.join(configDir, 'workflows', `${workflowName}.yaml`);
  const content = fs.readFileSync(workflowPath, 'utf-8');
  return parse(content) as WorkflowYAML;
}

function groupByPhase(agents: AgentDefinition[]): Map<number, AgentDefinition[]> {
  const phases = new Map<number, AgentDefinition[]>();

  for (const agent of agents) {
    const phase = agent.phase;
    if (!phases.has(phase)) {
      phases.set(phase, []);
    }
    phases.get(phase)!.push(agent);
  }

  // Sort by phase number
  return new Map([...phases.entries()].sort((a, b) => a[0] - b[0]));
}

function getPhaseLabel(phase: number): string {
  const labels: Record<number, string> = {
    0: 'Orchestration',
    1: 'Data Collection',
    1.5: 'Code Intelligence',
    2: 'Semantic Analysis',
    2.5: 'Web Research',
    3: 'Insight Generation',
    3.5: 'Observation',
    4: 'Classification',
    5: 'Quality Assurance',
    6: 'Persistence',
  };
  return labels[phase] || `Phase ${phase}`;
}

function generateArchitecturePuml(
  workflow: WorkflowYAML,
  agents: AgentsYAML
): string {
  const phases = groupByPhase(agents.agents);

  let puml = `@startuml ${workflow.workflow.name}-architecture
!include _standard-style.puml

title "${agents.agents.length + 1}-Agent Semantic Analysis System"
subtitle "${workflow.workflow.description}"

' Orchestrator at the top
package "Orchestration" <<Orchestrator>> {
  [${agents.orchestrator.shortName}] <<coordinator>> as orchestrator
}

`;

  // Generate packages for each phase
  for (const [phase, phaseAgents] of phases) {
    const label = getPhaseLabel(phase);
    puml += `package "${label}" <<Phase${phase}>> {\n`;

    for (const agent of phaseAgents) {
      const llmNote = agent.usesLLM ? '<<LLM>>' : '';
      puml += `  [${agent.shortName}] ${llmNote} as ${agent.id}\n`;
    }

    puml += `}\n\n`;
  }

  // Generate edges
  puml += `' Data flow edges\n`;
  for (const edge of workflow.edges) {
    const arrow = edge.type === 'dataflow' ? '..>' : '-->';
    puml += `${edge.from} ${arrow} ${edge.to}\n`;
  }

  puml += `
' Legend
legend right
  |= Icon |= Meaning |
  | <<LLM>> | Uses LLM for processing |
  | <<coordinator>> | Workflow orchestrator |
  | --> | Dependency (must complete) |
  | ..> | Dataflow (passes parameters) |
endlegend

@enduml`;

  return puml;
}

function generateSequencePuml(
  workflow: WorkflowYAML,
  agents: AgentsYAML
): string {
  let puml = `@startuml ${workflow.workflow.name}-sequence
!include _standard-style.puml

title "${workflow.workflow.name} Workflow Sequence"
subtitle "${workflow.workflow.description}"

participant "Coordinator" as orch <<Orchestrator>>

`;

  // Add participants for each agent used in the workflow
  const usedAgentIds = new Set<string>();
  for (const step of workflow.steps) {
    usedAgentIds.add(step.agent);
  }

  for (const agent of agents.agents) {
    if (usedAgentIds.has(agent.id)) {
      const llmNote = agent.usesLLM ? '<<LLM>>' : '';
      puml += `participant "${agent.shortName}" as ${agent.id} ${llmNote}\n`;
    }
  }

  puml += `\n== Workflow Execution ==\n\n`;

  // Generate sequence for each step
  for (const step of workflow.steps) {
    const deps = step.dependencies?.length > 0
      ? ` (after: ${step.dependencies.join(', ')})`
      : ' (parallel)';

    puml += `orch -> ${step.agent}: ${step.name}${deps}\n`;
    puml += `activate ${step.agent}\n`;
    puml += `${step.agent} --> orch: result\n`;
    puml += `deactivate ${step.agent}\n\n`;
  }

  puml += `@enduml`;

  return puml;
}

function generateUseCasesPuml(
  workflow: WorkflowYAML,
  agents: AgentsYAML
): string {
  let puml = `@startuml ${workflow.workflow.name}-use-cases
!include _standard-style.puml

title "${workflow.workflow.name} Use Cases"

actor "Developer" as dev
actor "CI/CD" as ci

rectangle "Knowledge Management" {
`;

  // Group agents by capability
  const llmAgents = agents.agents.filter(a => a.usesLLM);
  const nonLlmAgents = agents.agents.filter(a => !a.usesLLM);

  puml += `  rectangle "LLM-Powered Analysis" {\n`;
  for (const agent of llmAgents.slice(0, 6)) {
    puml += `    usecase "${agent.shortName}" as uc_${agent.id}\n`;
  }
  puml += `  }\n\n`;

  puml += `  rectangle "Infrastructure" {\n`;
  for (const agent of nonLlmAgents) {
    puml += `    usecase "${agent.shortName}" as uc_${agent.id}\n`;
  }
  puml += `  }\n`;

  puml += `}\n\n`;

  puml += `dev --> uc_git_history : Update Knowledge\n`;
  puml += `ci --> uc_persistence : Automated Analysis\n`;

  puml += `@enduml`;

  return puml;
}

function main() {
  const args = process.argv.slice(2);
  let workflowName = 'incremental-analysis';
  let outputDir = path.join(scriptDir, '../docs/puml');

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workflow' && args[i + 1]) {
      workflowName = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    }
  }

  console.log(`Generating PlantUML diagrams for workflow: ${workflowName}`);
  console.log(`Output directory: ${outputDir}`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Load definitions
  const agents = loadAgents();
  const workflow = loadWorkflow(workflowName);

  console.log(`Loaded ${agents.agents.length} agents and ${workflow.steps.length} workflow steps`);

  // Generate diagrams
  const architecturePuml = generateArchitecturePuml(workflow, agents);
  const sequencePuml = generateSequencePuml(workflow, agents);
  const useCasesPuml = generateUseCasesPuml(workflow, agents);

  // Write files
  const baseName = workflow.workflow.name;

  fs.writeFileSync(path.join(outputDir, `${baseName}-architecture.puml`), architecturePuml);
  console.log(`✅ Generated ${baseName}-architecture.puml`);

  fs.writeFileSync(path.join(outputDir, `${baseName}-sequence.puml`), sequencePuml);
  console.log(`✅ Generated ${baseName}-sequence.puml`);

  fs.writeFileSync(path.join(outputDir, `${baseName}-use-cases.puml`), useCasesPuml);
  console.log(`✅ Generated ${baseName}-use-cases.puml`);

  console.log(`\nDone! Generated 3 PlantUML diagrams from YAML workflow definition.`);
  console.log(`To render PNGs, run: plantuml ${outputDir}/*.puml`);
}

main();

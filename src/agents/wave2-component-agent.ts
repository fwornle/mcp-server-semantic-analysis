/**
 * Wave 2 Component Agent
 *
 * Receives an L1 Component entity and expands it into L2 SubComponent entities.
 * Processes both manifest-defined children (discovered=false) and code-discovered
 * children (discovered=true) via LLM analysis of scoped source files.
 *
 * Also produces a ChildManifestEntry[] for Wave 3 agent spawning.
 *
 * @module agents/wave2-component-agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { LLMService } from '../../../../lib/llm/dist/index.js';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import type { KGEntity, KGRelation } from './kg-operators.js';
import type { Wave2Input, WaveAgentOutput, ChildManifestEntry } from '../types/wave-types.js';

/** LLM response shape for L2 analysis */
interface L2AnalysisResponse {
  subComponents: Array<{
    name: string;
    description: string;
    observations: string[];
    discovered: boolean;
    suggestedL3Children: Array<{
      name: string;
      description: string;
    }>;
  }>;
}

export class Wave2ComponentAgent {
  private repositoryPath: string;
  private team: string;
  private llmService: LLMService;
  private llmInitialized: boolean = false;

  constructor(repositoryPath: string, team: string) {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.llmService = new LLMService();
  }

  private async ensureLLMInitialized(): Promise<void> {
    if (!this.llmInitialized) {
      await this.llmService.initialize();
      this.llmInitialized = true;
      const providers = this.llmService.getAvailableProviders();
      log(`[Wave2Agent] LLMService initialized with providers: ${providers.join(', ')}`, 'info');
    }
  }

  /**
   * Execute Wave 2 analysis for a single L1 Component.
   *
   * Flow:
   * 1. Read component files (scoped by WaveController via CGR)
   * 2. Process manifest-defined L2 children
   * 3. Discover additional L2 children via LLM
   * 4. Build entities with correct hierarchy fields
   * 5. Build parent-child relationships
   * 6. Identify L3 children for Wave 3
   */
  async execute(input: Wave2Input): Promise<WaveAgentOutput> {
    const startTime = Date.now();
    const parentName = input.l1Entity.name;
    log(`[Wave2Agent] Starting analysis for ${parentName}`, 'info');

    // Read component source files (already scoped by WaveController via CGR)
    const fileContents = await this.readComponentFiles(input.componentFiles, 10);

    let l2Entities: KGEntity[] = [];
    let childManifest: ChildManifestEntry[] = [];

    if (isMockLLMEnabled(this.repositoryPath)) {
      // Mock mode: generate synthetic L2 entities from manifest only, no LLM call
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));
      log(`[Wave2Agent] Mock mode: generating synthetic L2 entities for ${parentName}`, 'info');

      for (const child of input.manifestChildren) {
        const entity = this.buildL2Entity(
          child.name,
          child.description,
          [`${child.name} is a sub-component of ${parentName}`, `Handles ${child.description}`],
          input.l1Entity,
          false
        );
        l2Entities.push(entity);

        // Generate synthetic L3 manifest entries for mock mode
        childManifest.push({
          name: `${child.name}Core`,
          level: 3,
          parentId: child.name,
          description: `Core implementation of ${child.name}`,
          discovered: true,
        });
        childManifest.push({
          name: `${child.name}Config`,
          level: 3,
          parentId: child.name,
          description: `Configuration handling for ${child.name}`,
          discovered: true,
        });
      }
    } else {
      // Real LLM mode: analyze files and discover sub-components
      await this.ensureLLMInitialized();

      const analysisResult = await this.analyzeL2Components(input, fileContents);

      // Build L2 entities from LLM analysis with observation validation
      for (const subComp of analysisResult.subComponents) {
        const parentPath = input.l1Entity.hierarchyPath || input.l1Entity.name;
        const validatedObs = await this.ensureMinimumObservations(
          subComp.name,
          subComp.observations,
          {
            description: subComp.description,
            hierarchyPath: `${parentPath}/${subComp.name}`,
            parentName: input.l1Entity.name,
            sourceFiles: input.componentFiles,
          },
        );

        const entity = this.buildL2Entity(
          subComp.name,
          subComp.description,
          validatedObs,
          input.l1Entity,
          subComp.discovered
        );
        l2Entities.push(entity);

        // Build L3 child manifest entries from suggested children
        for (const l3Child of subComp.suggestedL3Children) {
          childManifest.push({
            name: l3Child.name,
            level: 3,
            parentId: subComp.name,
            description: l3Child.description,
            discovered: true, // L3 children are always discovered
          });
        }
      }
    }

    // Build parent-child relationships
    const relationships = this.buildRelationships(l2Entities, input.l1Entity);

    const durationMs = Date.now() - startTime;
    log(`[Wave2Agent] Completed ${parentName}: ${l2Entities.length} L2 entities, ${childManifest.length} L3 manifest entries (${durationMs}ms)`, 'info');

    return {
      entities: l2Entities,
      relationships,
      childManifest,
      discovered: false, // Wave2 agents are always manifest-spawned
      durationMs,
      parentId: parentName,
      agentName: `Wave2:${parentName}`,
    };
  }

  /**
   * Call LLM to analyze component files and identify L2 sub-components.
   * Handles both manifest-defined children and discovery of new ones.
   */
  private async analyzeL2Components(input: Wave2Input, fileContents: string): Promise<L2AnalysisResponse> {
    const manifestList = input.manifestChildren
      .map(c => `- ${c.name}: ${c.description}`)
      .join('\n');

    const parentDescription = input.l1Entity.observations.length > 0
      ? input.l1Entity.observations[0]
      : `Component ${input.l1Entity.name}`;

    const prompt = `You are analyzing the ${input.l1Entity.name} component to identify its sub-components (L2 nodes).

## Parent Component
Name: ${input.l1Entity.name}
Description: ${parentDescription}

## Known Sub-Components (from manifest)
${manifestList || '(none defined)'}

## Source Files
${fileContents || '(no source files available)'}

## Task
1. For each known sub-component, provide 5-7 specific observations. Each observation MUST:
   - Reference at least one specific code artifact (file path, class name, function name, or module)
   - Describe a concrete architectural decision, behavior, or pattern
   - Be self-contained (understandable without reading the source)

   GOOD observations (follow this style):
   - "BatchScheduler uses a DAG-based execution model with topological sort in batch-analysis.yaml steps, each step declaring explicit depends_on edges"
   - "PersistenceAgent.mapEntityToSharedMemory() pre-populates ontology metadata fields (entityType, metadata.ontologyClass) to prevent redundant LLM re-classification"
   - "WaveController.runWithConcurrency() implements work-stealing via shared nextIndex counter, allowing idle workers to pull tasks immediately"

   BAD observations (DO NOT write these):
   - "Processes data" (too generic, no code reference)
   - "Is responsible for handling logic" (vague, no artifact)
   - "Works with other components" (meaningless boilerplate)

2. Identify additional sub-components NOT in the known list:
   - Only suggest sub-components that represent real, distinct architectural areas
   - Each must have clear file/directory evidence in the source code

3. For ALL sub-components (known + discovered), suggest what Detail-level (L3) entities exist within them.

## Self-Sufficiency Standard
Each sub-component description and its observations MUST orient a new developer:
- What does this sub-component DO? (purpose and responsibility, not just existence)
- WHERE in the code does it live? (key files and directories)
- WHAT should the developer expect to find? (patterns, interfaces, key classes)
- A developer reading ONLY this node (not its children) should understand the scope.
Write as if this is the only documentation a new team member will read about this sub-component.

## Output (JSON only, no markdown fencing)
{
  "subComponents": [
    {
      "name": "PascalCaseName",
      "description": "1-2 sentences about what this sub-component covers",
      "observations": ["specific observation 1", "specific observation 2"],
      "discovered": false,
      "suggestedL3Children": [
        { "name": "PascalCaseName", "description": "what this detail covers" }
      ]
    }
  ]
}`;

    try {
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: prompt }],
        taskType: 'wave2_component_analysis',
        agentId: 'wave2_component',
        tier: 'standard',
        maxTokens: 4096,
        temperature: 0.7,
        timeout: 60_000,
      });

      log(`[Wave2Agent] LLM call for ${input.l1Entity.name} via ${result.provider}/${result.model} (${result.tokens.total} tokens, ${result.latencyMs}ms)`, 'info');

      return this.parseL2Response(result.content, input.manifestChildren);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log(`[Wave2Agent] LLM call failed for ${input.l1Entity.name}: ${errMsg}`, 'error');

      // Fallback: build minimal entities from manifest without LLM enrichment
      return {
        subComponents: input.manifestChildren.map(child => ({
          name: child.name,
          description: child.description,
          observations: [`${child.name} is a sub-component of ${input.l1Entity.name}`],
          discovered: false,
          suggestedL3Children: [],
        })),
      };
    }
  }

  /**
   * Parse LLM response into structured L2 analysis result.
   * Validates JSON and ensures manifest children retain discovered=false.
   */
  private parseL2Response(responseText: string, manifestChildren: ChildManifestEntry[]): L2AnalysisResponse {
    const manifestNames = new Set(manifestChildren.map(c => c.name));

    try {
      // Strip markdown code fences if present
      let cleaned = responseText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const parsed = JSON.parse(cleaned) as L2AnalysisResponse;

      if (!parsed.subComponents || !Array.isArray(parsed.subComponents)) {
        log('[Wave2Agent] Invalid LLM response: missing subComponents array', 'warning');
        return { subComponents: [] };
      }

      // Ensure discovered flag is correct: manifest children are NOT discovered
      for (const comp of parsed.subComponents) {
        comp.discovered = !manifestNames.has(comp.name);

        // Validate observations
        if (!Array.isArray(comp.observations) || comp.observations.length === 0) {
          comp.observations = [`${comp.name} is a sub-component of the parent entity`];
        }

        // Validate L3 children
        if (!Array.isArray(comp.suggestedL3Children)) {
          comp.suggestedL3Children = [];
        }
      }

      return parsed;
    } catch (parseError) {
      log(`[Wave2Agent] Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`, 'warning');
      return { subComponents: [] };
    }
  }

  /**
   * Build an L2 SubComponent entity with correct hierarchy fields.
   */
  private buildL2Entity(
    name: string,
    description: string,
    observations: string[],
    parentEntity: KGEntity,
    discovered: boolean
  ): KGEntity {
    const parentPath = parentEntity.hierarchyPath || parentEntity.name;
    return {
      id: name,
      name,
      type: 'SubComponent',
      observations: observations.length > 0 ? observations : [description],
      significance: 7,
      level: 2,
      parentId: parentEntity.name,
      hierarchyPath: `${parentPath}/${name}`,
      // Tag discovered entities in observations for traceability
      ...(discovered ? { batchId: `wave2-discovered` } : {}),
    };
  }

  /**
   * Build parent-child relationship edges from L1 parent to each L2 entity.
   */
  private buildRelationships(l2Entities: KGEntity[], parentEntity: KGEntity): KGRelation[] {
    return l2Entities.map(l2 => ({
      from: parentEntity.name,
      to: l2.name,
      type: 'contains',
      weight: 1.0,
      source: 'explicit' as const,
    }));
  }

  // --------------------------------------------------------------------------
  // Observation Validation
  // --------------------------------------------------------------------------

  /**
   * Check if an observation is specific enough (references code artifacts).
   * Lenient check: focus on rejecting clearly generic, not validating specific patterns.
   */
  private isSpecificObservation(obs: string): boolean {
    if (obs.length < 30) return false;

    // Long observations are likely specific enough
    if (obs.length >= 80) return true;

    // Check for code artifact indicators
    const hasCodeRef =
      /\.(ts|js|py|yaml|yml|json|md|puml)\b/i.test(obs) ||        // file extensions
      /[A-Z][a-z]+[A-Z]/.test(obs) ||                              // PascalCase/camelCase
      /\w+\.\w+\(/.test(obs) ||                                    // method calls
      /\/[\w-]+\//.test(obs) ||                                     // file paths
      /\b(class|function|interface|module|implements|extends|import|export|constructor|async)\b/i.test(obs);

    return hasCodeRef;
  }

  /**
   * Ensure an entity has at least 3 specific observations.
   * Strategy: filter -> retry LLM -> supplement from context.
   */
  private async ensureMinimumObservations(
    entityName: string,
    observations: string[],
    context: { description: string; hierarchyPath: string; parentName?: string; sourceFiles?: string[] },
  ): Promise<string[]> {
    const initial = observations.length;

    // Step 1: Filter to specific observations
    const specific = observations.filter(obs => this.isSpecificObservation(obs));
    const filtered = initial - specific.length;

    if (specific.length >= 3) {
      log(`[Wave2Agent] Observation validation for ${entityName}: ${initial} -> ${specific.length} (filtered: ${filtered}, retried: 0, supplemented: 0)`, 'info');
      return specific.slice(0, 7);
    }

    // Step 2: Retry with enriched prompt
    let retryAdded = 0;
    const needed = 3 - specific.length;

    try {
      const retryPrompt = `You are generating specific observations about the "${entityName}" sub-component.

Context:
- Description: ${context.description}
- Hierarchy: ${context.hierarchyPath}
- Parent component: ${context.parentName || 'unknown'}
${context.sourceFiles && context.sourceFiles.length > 0 ? `- Source files: ${context.sourceFiles.slice(0, 5).join(', ')}` : ''}

Generate exactly ${needed} specific observation(s) about this sub-component. Each observation MUST:
- Reference at least one specific code artifact (file path, class name, function name, or module)
- Be a complete, self-contained sentence

GOOD examples:
- "BatchScheduler uses a DAG-based execution model with topological sort in batch-analysis.yaml steps"
- "PersistenceAgent.mapEntityToSharedMemory() pre-populates ontology metadata to prevent re-classification"

Return a JSON array of strings, e.g. ["observation 1", "observation 2"]`;

      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: retryPrompt }],
        taskType: 'observation_retry',
        agentId: 'wave2_component',
        tier: 'standard',
        maxTokens: 512,
        temperature: 0.7,
        timeout: 30_000,
      });

      let retryObs: string[] = [];
      try {
        let cleaned = result.content.trim();
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
        }
        const parsed = JSON.parse(cleaned);
        retryObs = Array.isArray(parsed)
          ? parsed.filter((o: unknown): o is string => typeof o === 'string')
          : [];
      } catch {
        // Parse failed, skip retry results
      }

      // Combine and dedup
      const combined = [...specific, ...retryObs.filter(o => this.isSpecificObservation(o))];
      const deduped = [...new Set(combined)];
      retryAdded = deduped.length - specific.length;

      if (deduped.length >= 3) {
        log(`[Wave2Agent] Observation validation for ${entityName}: ${initial} -> ${deduped.length} (filtered: ${filtered}, retried: ${retryAdded}, supplemented: 0)`, 'info');
        return deduped.slice(0, 7);
      }

      specific.push(...deduped.slice(specific.length));
    } catch (retryError) {
      log(`[Wave2Agent] Observation retry failed for ${entityName}: ${retryError instanceof Error ? retryError.message : String(retryError)}`, 'warning');
    }

    // Step 3: Supplement from available data
    const supplements: string[] = [];

    // From description
    if (context.description && context.description.length > 10) {
      supplements.push(`Serves as ${context.description} within the ${context.parentName || 'parent'} component at hierarchy path ${context.hierarchyPath}`);
    }

    // From hierarchy
    supplements.push(`${entityName} is an L2 SubComponent entity under ${context.parentName || 'parent'} in the project knowledge hierarchy`);

    // From source files (code-graph-rag file analysis)
    if (context.sourceFiles && context.sourceFiles.length > 0) {
      supplements.push(`Primary implementation in ${context.sourceFiles[0]} with ${context.sourceFiles.length} related source file(s) including ${context.sourceFiles.slice(0, 3).join(', ')}`);
    } else {
      // Attempt CGR lookup as fallback
      try {
        const { CodeGraphAgent } = await import('./code-graph-agent.js');
        const cgrAgent = new CodeGraphAgent();
        const cypher = `MATCH (f:File) WHERE toLower(f.file_path) CONTAINS toLower('${entityName}') RETURN f.file_path AS path LIMIT 5`;
        const result = await cgrAgent.runCypherQuery(cypher);
        const files = Array.isArray(result) ? result.map((r: any) => r.path).filter(Boolean) : [];
        if (files.length > 0) {
          supplements.push(`Primary implementation in ${files[0]} with ${files.length} related source file(s)`);
        }
      } catch {
        // CGR unavailable -- skip this supplement source silently
      }
    }

    if (supplements.length === 0) {
      supplements.push(`${entityName} represents a distinct architectural concern within ${context.parentName || 'parent'}`);
    }

    const final = [...specific, ...supplements].slice(0, 7);
    while (final.length < 3) {
      final.push(`${entityName} represents a distinct architectural concern within ${context.parentName || 'parent'}`);
    }

    const supplementAdded = final.length - specific.length;
    log(`[Wave2Agent] Observation validation for ${entityName}: ${initial} -> ${final.length} (filtered: ${filtered}, retried: ${retryAdded}, supplemented: ${supplementAdded})`, 'info');
    return final;
  }

  /**
   * Read component source files, truncating each to maxLines.
   * Returns concatenated file contents with file path headers.
   */
  private async readComponentFiles(files: string[], maxFiles: number = 10): Promise<string> {
    const maxLines = 200;
    const filesToRead = files.slice(0, maxFiles);
    const contents: string[] = [];

    for (const filePath of filesToRead) {
      try {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(this.repositoryPath, filePath);

        if (!fs.existsSync(fullPath)) {
          continue;
        }

        const raw = fs.readFileSync(fullPath, 'utf-8');
        const lines = raw.split('\n');
        const truncated = lines.slice(0, maxLines).join('\n');
        const suffix = lines.length > maxLines ? `\n... (truncated, ${lines.length} total lines)` : '';

        contents.push(`### ${filePath}\n${truncated}${suffix}`);
      } catch (err) {
        log(`[Wave2Agent] Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      }
    }

    if (contents.length === 0) {
      log(`[Wave2Agent] No component files could be read (${files.length} paths provided)`, 'warning');
      return '';
    }

    log(`[Wave2Agent] Read ${contents.length}/${files.length} component files`, 'info');
    return contents.join('\n\n');
  }
}

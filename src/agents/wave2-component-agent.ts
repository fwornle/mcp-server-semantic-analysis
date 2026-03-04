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

      // Build L2 entities from LLM analysis
      for (const subComp of analysisResult.subComponents) {
        const entity = this.buildL2Entity(
          subComp.name,
          subComp.description,
          subComp.observations,
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
1. For each known sub-component, provide:
   - 3-7 specific observations about its architecture, patterns, and behavior
   - These must be specific to THIS sub-component, not generic statements

2. Identify additional sub-components NOT in the known list:
   - Only suggest sub-components that represent real, distinct architectural areas
   - Each must have clear file/directory evidence in the source code

3. For ALL sub-components (known + discovered), suggest what Detail-level (L3) entities exist within them.

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

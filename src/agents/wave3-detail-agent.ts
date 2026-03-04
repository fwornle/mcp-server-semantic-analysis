/**
 * Wave 3 Detail Agent
 *
 * Receives an L2 SubComponent entity and discovers L3 Detail entities via
 * pure LLM analysis. Wave 3 is the final wave -- no manifest seeds, all
 * entities are discovered from code analysis, and no child manifest is produced.
 *
 * @module agents/wave3-detail-agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { LLMService } from '../../../../lib/llm/dist/index.js';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import type { KGEntity, KGRelation } from './kg-operators.js';
import type { Wave3Input, WaveAgentOutput, ChildManifestEntry } from '../types/wave-types.js';

/** LLM response shape for L3 discovery */
interface L3DiscoveryResponse {
  details: Array<{
    name: string;
    description: string;
    observations: string[];
  }>;
}

export class Wave3DetailAgent {
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
      log(`[Wave3Agent] LLMService initialized with providers: ${providers.join(', ')}`, 'info');
    }
  }

  /**
   * Execute Wave 3 analysis for a single L2 SubComponent.
   *
   * Flow:
   * 1. Read scoped files relevant to this L2 entity
   * 2. Call LLM to discover L3 Detail entities
   * 3. Build entities with correct hierarchy fields
   * 4. Build parent-child relationships
   * 5. Return with empty childManifest (Wave 3 is the last wave)
   */
  async execute(input: Wave3Input): Promise<WaveAgentOutput> {
    const startTime = Date.now();
    const parentName = input.l2Entity.name;
    log(`[Wave3Agent] Starting detail analysis for ${parentName}`, 'info');

    // Read scoped source files
    const fileContents = await this.readScopedFiles(input.scopedFiles, 8);

    let l3Entities: KGEntity[] = [];

    if (isMockLLMEnabled(this.repositoryPath)) {
      // Mock mode: generate 2 synthetic L3 entities per L2 node
      const mockDelay = getMockDelay(this.repositoryPath);
      await new Promise(resolve => setTimeout(resolve, mockDelay));
      log(`[Wave3Agent] Mock mode: generating synthetic L3 entities for ${parentName}`, 'info');

      // Derive synthetic names from L2 parent name pattern
      const suffixes = ['Core', 'Handler'];
      for (const suffix of suffixes) {
        const detailName = `${parentName}${suffix}`;
        const entity = this.buildL3Entity(
          detailName,
          `${suffix} implementation of ${parentName}`,
          [
            `${detailName} handles the ${suffix.toLowerCase()} logic for ${parentName}`,
            `Part of the ${input.l1Entity.name} component hierarchy`,
          ],
          input.l2Entity,
          input.l1Entity
        );
        l3Entities.push(entity);
      }
    } else {
      // Real LLM mode: discover detail entities from code analysis
      await this.ensureLLMInitialized();

      const discoveryResult = await this.discoverL3Details(input, fileContents);

      for (const detail of discoveryResult.details) {
        const entity = this.buildL3Entity(
          detail.name,
          detail.description,
          detail.observations,
          input.l2Entity,
          input.l1Entity
        );
        l3Entities.push(entity);
      }
    }

    // Build parent-child relationships
    const relationships = this.buildRelationships(l3Entities, input.l2Entity);

    const durationMs = Date.now() - startTime;
    log(`[Wave3Agent] Completed ${parentName}: ${l3Entities.length} L3 entities (${durationMs}ms)`, 'info');

    return {
      entities: l3Entities,
      relationships,
      childManifest: [], // Wave 3 is the last wave -- no children to suggest
      discovered: true, // Wave 3 agents may be spawned from discovered L2 entities
      durationMs,
      parentId: parentName,
      agentName: `Wave3:${parentName}`,
    };
  }

  /**
   * Call LLM to discover L3 Detail entities within an L2 scope.
   * Uses parent and grandparent context for hierarchy orientation.
   */
  private async discoverL3Details(input: Wave3Input, fileContents: string): Promise<L3DiscoveryResponse> {
    const l2Description = input.l2Entity.observations.length > 0
      ? input.l2Entity.observations[0]
      : `SubComponent ${input.l2Entity.name}`;

    const l1Description = input.l1Entity.observations.length > 0
      ? input.l1Entity.observations[0]
      : `Component ${input.l1Entity.name}`;

    const hasFiles = fileContents.length > 0;
    const fileSection = hasFiles
      ? fileContents
      : '(no source files available -- analyze based on parent context only)';

    if (!hasFiles) {
      log(`[Wave3Agent] No scoped files for ${input.l2Entity.name}, using parent context only`, 'warning');
    }

    const prompt = `You are analyzing the ${input.l2Entity.name} sub-component to identify its detail-level knowledge nodes.

## Hierarchy Context
Project: Coding
Component (L1): ${input.l1Entity.name} - ${l1Description}
SubComponent (L2): ${input.l2Entity.name} - ${l2Description}

## Source Files
${fileSection}

## Task
Identify ${hasFiles ? '2-8' : '1-3'} Detail-level (L3) nodes that represent specific, notable aspects of this sub-component. Good L3 nodes are:
- Specific classes or modules with distinct behavior (e.g., "BatchScheduler", "LLMRetryPolicy")
- Key algorithms or processing patterns (e.g., "StreamingResponseParser", "DAGDependencyResolver")
- Important configuration or integration points (e.g., "ProviderFallbackConfig", "MemgraphConnection")
- Notable architectural decisions or design patterns (e.g., "EventDrivenPipeline", "SharedMemoryStore")

BAD L3 nodes (do NOT suggest these):
- Generic labels like "Configuration", "Utils", "Types", "Helpers"
- Nodes that just restate the L2 name with "Manager" or "Service" suffix
- Nodes with no specific code evidence

For each L3 node, provide:
- name: PascalCase, specific and descriptive
- description: 1-2 sentences about what it does
- observations: 3-5 specific observations about architecture, behavior, or design decisions. Each observation MUST:
  - Reference at least one specific code artifact (file path, class name, function name, or module)
  - Describe a concrete architectural decision, behavior, or pattern
  - Be self-contained (understandable without reading the source)

  GOOD observations (follow this style):
  - "SharedMemoryStore (kg-operators.ts:31) defines the KGEntity interface with hierarchy fields parentId, level, hierarchyPath added in Phase 4"
  - "LLMRetryPolicy in llm-service.ts implements exponential backoff with jitter, capping at 3 retries per provider before falling back to the next"

  BAD observations (DO NOT write these):
  - "Works well" (trivially generic, no code reference)
  - "Important implementation detail" (vague, no artifact mentioned)

## Output (JSON only, no markdown fencing)
{
  "details": [
    {
      "name": "PascalCaseName",
      "description": "1-2 sentences",
      "observations": ["specific observation 1", "specific observation 2"]
    }
  ]
}`;

    try {
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: prompt }],
        taskType: 'wave3_detail_discovery',
        agentId: 'wave3_detail',
        tier: 'standard',
        maxTokens: 4096,
        temperature: 0.7,
        timeout: 60_000,
      });

      log(`[Wave3Agent] LLM call for ${input.l2Entity.name} via ${result.provider}/${result.model} (${result.tokens.total} tokens, ${result.latencyMs}ms)`, 'info');

      return this.parseL3Response(result.content);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log(`[Wave3Agent] LLM call failed for ${input.l2Entity.name}: ${errMsg}`, 'error');

      // Return empty -- some L2 nodes may simply have no discoverable L3 children
      return { details: [] };
    }
  }

  /**
   * Parse LLM response into structured L3 discovery result.
   * Validates JSON and filters out invalid entries.
   */
  private parseL3Response(responseText: string): L3DiscoveryResponse {
    try {
      // Strip markdown code fences if present
      let cleaned = responseText.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const parsed = JSON.parse(cleaned) as L3DiscoveryResponse;

      if (!parsed.details || !Array.isArray(parsed.details)) {
        log('[Wave3Agent] Invalid LLM response: missing details array', 'warning');
        return { details: [] };
      }

      // Filter out generic or invalid entries
      const genericNames = new Set([
        'Configuration', 'Utils', 'Types', 'Helpers', 'Constants',
        'Index', 'Main', 'Base', 'Common', 'Shared', 'Core',
      ]);

      const validDetails = parsed.details.filter(detail => {
        if (!detail.name || genericNames.has(detail.name)) {
          log(`[Wave3Agent] Filtered out generic L3 name: ${detail.name || '(empty)'}`, 'info');
          return false;
        }

        // Validate observations
        if (!Array.isArray(detail.observations) || detail.observations.length === 0) {
          detail.observations = [detail.description || `Detail entity ${detail.name}`];
        }

        return true;
      });

      return { details: validDetails };
    } catch (parseError) {
      log(`[Wave3Agent] Failed to parse LLM response as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`, 'warning');
      return { details: [] };
    }
  }

  /**
   * Build an L3 Detail entity with correct hierarchy fields.
   * All L3 entities have discovered=true since Wave 3 is pure discovery.
   */
  private buildL3Entity(
    name: string,
    description: string,
    observations: string[],
    l2Entity: KGEntity,
    l1Entity: KGEntity
  ): KGEntity {
    const parentPath = l2Entity.hierarchyPath || `${l1Entity.name}/${l2Entity.name}`;
    return {
      id: name,
      name,
      type: 'Detail',
      observations: observations.length > 0 ? observations : [description],
      significance: 6,
      level: 3,
      parentId: l2Entity.name,
      hierarchyPath: `${parentPath}/${name}`,
      batchId: 'wave3-discovered',
    };
  }

  /**
   * Build parent-child relationship edges from L2 parent to each L3 entity.
   */
  private buildRelationships(l3Entities: KGEntity[], parentEntity: KGEntity): KGRelation[] {
    return l3Entities.map(l3 => ({
      from: parentEntity.name,
      to: l3.name,
      type: 'contains',
      weight: 1.0,
      source: 'explicit' as const,
    }));
  }

  /**
   * Read scoped source files, truncating each to maxLines.
   * Returns concatenated file contents with file path headers.
   */
  private async readScopedFiles(files: string[], maxFiles: number = 8): Promise<string> {
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
        log(`[Wave3Agent] Failed to read file ${filePath}: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      }
    }

    if (contents.length === 0 && files.length > 0) {
      log(`[Wave3Agent] No scoped files could be read (${files.length} paths provided)`, 'warning');
    }

    if (contents.length > 0) {
      log(`[Wave3Agent] Read ${contents.length}/${files.length} scoped files`, 'info');
    }

    return contents.join('\n\n');
  }
}

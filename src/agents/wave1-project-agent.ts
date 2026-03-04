/**
 * Wave1ProjectAgent - L0 Project + L1 Component Entity Producer
 *
 * The first wave agent in the hierarchical analysis pipeline.
 * Surveys the entire project using the component manifest as structure,
 * reads representative source files for each component, and calls
 * LLM for component summaries and observations.
 *
 * Produces:
 * - 1 L0 Project entity (root node)
 * - N L1 Component entities (one per manifest component)
 * - Parent-child relationships (L0 -> L1)
 * - Child manifest entries for Wave 2 (L2 suggestions)
 *
 * @module agents/wave1-project-agent
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { LLMService } from '../../../../lib/llm/dist/index.js';
import { isMockLLMEnabled, getMockDelay } from '../mock/llm-mock-service.js';
import type { KGEntity, KGRelation } from './kg-operators.js';
import type { ComponentManifest, ComponentManifestEntry } from '../types/component-manifest.js';
import type { Wave1Input, WaveAgentOutput, ChildManifestEntry } from '../types/wave-types.js';

// ============================================================================
// Wave1ProjectAgent
// ============================================================================

export class Wave1ProjectAgent {
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
      log(`[Wave1ProjectAgent] LLMService initialized with providers: ${providers.join(', ')}`, 'info');
    }
  }

  // --------------------------------------------------------------------------
  // Main entry point
  // --------------------------------------------------------------------------

  async execute(input: Wave1Input): Promise<WaveAgentOutput> {
    const startTime = Date.now();

    log('[Wave1ProjectAgent] Starting Wave 1 execution', 'info', {
      projectName: input.manifest.project.name,
      componentCount: input.manifest.components.length,
      existingEntityCount: input.existingEntities.length,
    });

    const isMock = isMockLLMEnabled(this.repositoryPath);
    if (!isMock) {
      await this.ensureLLMInitialized();
    }

    // Step 1: Scan directory structure for project overview
    const directoryStructure = await this.scanDirectoryStructure(input.repositoryPath);

    // Step 2: Format existing KG entities as context
    const existingEntitiesContext = this.formatExistingEntities(input.existingEntities);

    // Step 3: Analyze each L1 component
    const l1Entities: KGEntity[] = [];
    const allChildManifest: ChildManifestEntry[] = [];

    for (const component of input.manifest.components) {
      log(`[Wave1ProjectAgent] Analyzing component: ${component.name}`, 'info');

      // Read representative source files
      const fileContents = await this.readRepresentativeFiles(input.repositoryPath, component);

      // Get LLM analysis (or mock analysis)
      let analysis: ComponentAnalysis;
      if (isMock) {
        analysis = this.generateMockAnalysis(component, directoryStructure);
        const delay = getMockDelay(this.repositoryPath);
        if (delay > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      } else {
        analysis = await this.analyzeComponent(
          component,
          directoryStructure,
          existingEntitiesContext,
          fileContents,
        );
      }

      // Build L1 entity
      const l1Entity = this.buildL1Entity(
        component,
        analysis.summary,
        analysis.observations,
        input.manifest.project.name,
      );
      l1Entities.push(l1Entity);

      // Build child manifest entries for Wave 2
      const children = this.buildChildManifestForComponent(
        component,
        analysis.suggestedChildren,
      );
      allChildManifest.push(...children);
    }

    // Step 4: Build L0 Project entity
    const projectSummary = this.buildProjectSummary(input.manifest, l1Entities);
    const l0Entity = this.buildL0Entity(input.manifest, projectSummary);

    // Step 5: Build relationships
    const allEntities = [l0Entity, ...l1Entities];
    const relationships = this.buildRelationships(l0Entity, l1Entities);

    const durationMs = Date.now() - startTime;

    log('[Wave1ProjectAgent] Wave 1 complete', 'info', {
      l0Entities: 1,
      l1Entities: l1Entities.length,
      relationships: relationships.length,
      childManifestEntries: allChildManifest.length,
      durationMs,
    });

    return {
      entities: allEntities,
      relationships,
      childManifest: allChildManifest,
      discovered: false,
      durationMs,
      parentId: input.manifest.project.name,
      agentName: 'Wave1:Project',
    };
  }

  // --------------------------------------------------------------------------
  // LLM Analysis
  // --------------------------------------------------------------------------

  /**
   * Call LLM to analyze a component and produce summary, observations, and child suggestions.
   */
  private async analyzeComponent(
    component: ComponentManifestEntry,
    directoryStructure: string,
    existingEntitiesContext: string,
    representativeFiles: string[],
  ): Promise<ComponentAnalysis> {
    const fileContentsBlock = representativeFiles.length > 0
      ? representativeFiles.join('\n\n---\n\n')
      : '(No representative files found)';

    const prompt = `You are analyzing the ${component.name} component of the Coding project.

## Project Context
${directoryStructure}

## Existing Knowledge
${existingEntitiesContext}

## Component Definition
Name: ${component.name}
Description: ${component.description}
Keywords: ${component.keywords.join(', ')}

## Source Files
${fileContentsBlock}

## Task
1. Write a comprehensive summary (2-3 paragraphs) of what this component does, its architecture, and key patterns.
2. List 3-7 specific observations about this component. Each observation should be a detailed sentence about architecture, behavior, or design decisions. NOT generic boilerplate.
3. Suggest sub-components (L2 nodes) that exist within this component. For each, provide name (PascalCase), description, and whether it's a new discovery beyond the manifest.

## Output Format (JSON)
{
  "summary": "...",
  "observations": ["...", "..."],
  "suggestedChildren": [
    { "name": "...", "description": "...", "discovered": true }
  ]
}

IMPORTANT: Return ONLY the JSON object, no markdown code blocks or surrounding text.`;

    try {
      const result = await this.llmService.complete({
        messages: [{ role: 'user', content: prompt }],
        taskType: 'wave_component_analysis',
        agentId: 'wave1_project',
        tier: 'standard',
        maxTokens: 2048,
        temperature: 0.7,
        timeout: 60_000,
        responseFormat: { type: 'json_object' },
      });

      log(`[Wave1ProjectAgent] LLM analysis for ${component.name} via ${result.provider}/${result.model}`, 'info', {
        tokens: result.tokens.total,
      });

      return this.parseComponentAnalysis(result.content, component);
    } catch (error) {
      log(`[Wave1ProjectAgent] LLM call failed for ${component.name}, using fallback`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.generateMockAnalysis(component, directoryStructure);
    }
  }

  /**
   * Parse LLM JSON response into ComponentAnalysis.
   * Falls back to mock analysis on parse failure.
   */
  private parseComponentAnalysis(
    content: string,
    component: ComponentManifestEntry,
  ): ComponentAnalysis {
    try {
      // Strip potential markdown code fences
      let cleaned = content.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      const parsed = JSON.parse(cleaned);

      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : component.description,
        observations: Array.isArray(parsed.observations)
          ? parsed.observations.filter((o: unknown): o is string => typeof o === 'string')
          : [component.description],
        suggestedChildren: Array.isArray(parsed.suggestedChildren)
          ? parsed.suggestedChildren
              .filter((c: unknown): c is Record<string, unknown> => typeof c === 'object' && c !== null)
              .map((c: Record<string, unknown>) => ({
                name: String(c.name ?? 'Unknown'),
                description: String(c.description ?? ''),
                discovered: Boolean(c.discovered),
              }))
          : [],
      };
    } catch (error) {
      log(`[Wave1ProjectAgent] Failed to parse LLM response for ${component.name}`, 'warning', {
        error: error instanceof Error ? error.message : String(error),
        contentPreview: content.substring(0, 200),
      });
      return {
        summary: component.description,
        observations: [component.description],
        suggestedChildren: [],
      };
    }
  }

  // --------------------------------------------------------------------------
  // Entity Construction
  // --------------------------------------------------------------------------

  /**
   * Build the L0 Project entity (root node).
   */
  private buildL0Entity(manifest: ComponentManifest, projectSummary: string): KGEntity {
    return {
      id: manifest.project.name,
      name: manifest.project.name,
      type: 'Project',
      observations: [
        projectSummary,
        `Project contains ${manifest.components.length} L1 components: ${manifest.components.map(c => c.name).join(', ')}`,
      ],
      significance: 10,
      parentId: undefined,
      level: 0,
      hierarchyPath: manifest.project.name,
    };
  }

  /**
   * Build an L1 Component entity.
   */
  private buildL1Entity(
    component: ComponentManifestEntry,
    summary: string,
    observations: string[],
    projectName: string,
  ): KGEntity {
    return {
      id: component.name,
      name: component.name,
      type: 'Component',
      observations: [summary, ...observations],
      significance: 8,
      parentId: projectName,
      level: 1,
      hierarchyPath: `${projectName}/${component.name}`,
    };
  }

  /**
   * Build parent-child relationship edges from L0 to each L1.
   */
  private buildRelationships(projectEntity: KGEntity, l1Entities: KGEntity[]): KGRelation[] {
    return l1Entities.map(l1 => ({
      from: projectEntity.name,
      to: l1.name,
      type: 'parent-child',
      weight: 1.0,
      source: 'explicit' as const,
    }));
  }

  /**
   * Build child manifest entries for a component.
   * Combines manifest-defined L2 children with LLM-suggested discoveries.
   */
  private buildChildManifestForComponent(
    component: ComponentManifestEntry,
    suggestedChildren: Array<{ name: string; description: string; discovered: boolean }>,
  ): ChildManifestEntry[] {
    const entries: ChildManifestEntry[] = [];

    // Add manifest-defined L2 children
    if (component.children) {
      for (const child of component.children) {
        entries.push({
          name: child.name,
          level: 2,
          parentId: component.name,
          description: child.description,
          discovered: false,
          suggestedFiles: [],
          keywords: child.keywords,
        });
      }
    }

    // Add LLM-suggested L2 children (mark as discovered)
    for (const suggested of suggestedChildren) {
      // Skip if already in manifest
      const alreadyExists = entries.some(
        e => e.name.toLowerCase() === suggested.name.toLowerCase(),
      );
      if (!alreadyExists && suggested.discovered) {
        entries.push({
          name: suggested.name,
          level: 2,
          parentId: component.name,
          description: suggested.description,
          discovered: true,
          suggestedFiles: [],
          keywords: [suggested.name.toLowerCase()],
        });
      }
    }

    return entries;
  }

  // --------------------------------------------------------------------------
  // File Scanning
  // --------------------------------------------------------------------------

  /**
   * Scan the repository directory structure at depth 2-3 to get the overall project shape.
   * Returns a compact directory listing string.
   */
  private async scanDirectoryStructure(repoPath: string): Promise<string> {
    const lines: string[] = [];
    const maxDepth = 3;

    const scan = (dir: string, prefix: string, depth: number): void => {
      if (depth > maxDepth) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // Sort: directories first, then files
        const sorted = entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist')
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          });

        for (const entry of sorted) {
          if (entry.isDirectory()) {
            lines.push(`${prefix}${entry.name}/`);
            if (depth < maxDepth) {
              scan(path.join(dir, entry.name), prefix + '  ', depth + 1);
            }
          } else if (depth <= 2) {
            // Only list files at depth <= 2 to keep output compact
            lines.push(`${prefix}${entry.name}`);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    scan(repoPath, '', 0);

    // Truncate if too large
    const maxLines = 200;
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more entries)`;
    }

    return lines.join('\n');
  }

  /**
   * Read representative source files for a component.
   * Uses component keywords to locate relevant files, then reads up to 5 files
   * (truncated to first 200 lines each for structure + exports).
   */
  private async readRepresentativeFiles(
    repoPath: string,
    component: ComponentManifestEntry,
  ): Promise<string[]> {
    const fileContents: string[] = [];
    const maxFiles = 5;
    const maxLinesPerFile = 200;

    // Build search patterns from component keywords and aliases
    const searchTerms = [
      ...component.keywords.map(k => k.toLowerCase()),
      ...component.aliases.map(a => a.toLowerCase()),
      component.name.toLowerCase(),
    ];

    // Find candidate files by walking relevant directories
    const candidateFiles = this.findCandidateFiles(repoPath, searchTerms);

    // Prioritize: entry points > agents > configs > other source files
    const prioritized = candidateFiles.sort((a, b) => {
      const scoreA = this.fileRelevanceScore(a, component);
      const scoreB = this.fileRelevanceScore(b, component);
      return scoreB - scoreA;
    });

    // Read top files
    const filesToRead = prioritized.slice(0, maxFiles);
    for (const filePath of filesToRead) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.slice(0, maxLinesPerFile).join('\n');
        const relativePath = path.relative(repoPath, filePath);
        const header = `// === ${relativePath} (${lines.length} lines total) ===`;
        fileContents.push(`${header}\n${truncated}`);
      } catch {
        // Skip unreadable files
      }
    }

    log(`[Wave1ProjectAgent] Read ${fileContents.length} files for ${component.name}`, 'info');
    return fileContents;
  }

  /**
   * Find candidate source files matching search terms.
   */
  private findCandidateFiles(repoPath: string, searchTerms: string[]): string[] {
    const results: string[] = [];
    const maxResults = 50;

    // Common source directories to search
    const searchDirs = [
      path.join(repoPath, 'integrations', 'mcp-server-semantic-analysis', 'src'),
      path.join(repoPath, 'integrations', 'system-health-dashboard', 'src'),
      path.join(repoPath, 'integrations', 'code-graph-rag'),
      path.join(repoPath, 'lib'),
      path.join(repoPath, 'scripts'),
    ];

    const walkDir = (dir: string, depth: number): void => {
      if (depth > 4 || results.length >= maxResults) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) break;

          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Check if directory name matches any search term
            const dirLower = entry.name.toLowerCase();
            const dirMatches = searchTerms.some(term => dirLower.includes(term) || term.includes(dirLower));
            if (dirMatches || depth < 2) {
              walkDir(fullPath, depth + 1);
            }
          } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
            const nameLower = entry.name.toLowerCase();
            const matches = searchTerms.some(term => nameLower.includes(term));
            if (matches) {
              results.push(fullPath);
            }
          }
        }
      } catch {
        // Ignore permission/access errors
      }
    };

    for (const searchDir of searchDirs) {
      if (fs.existsSync(searchDir)) {
        walkDir(searchDir, 0);
      }
    }

    return results;
  }

  /**
   * Score file relevance for prioritization.
   * Entry points and main files score higher.
   */
  private fileRelevanceScore(filePath: string, component: ComponentManifestEntry): number {
    const name = path.basename(filePath).toLowerCase();
    let score = 0;

    // Entry point patterns
    if (name === 'index.ts' || name === 'index.js') score += 5;
    if (name.includes('agent')) score += 3;
    if (name.includes('config')) score += 2;
    if (name.includes('main') || name.includes('entry')) score += 4;
    if (name.includes('service')) score += 2;

    // Component name match
    const componentLower = component.name.toLowerCase();
    if (name.includes(componentLower)) score += 4;

    // Keyword match
    for (const keyword of component.keywords) {
      if (name.includes(keyword.toLowerCase())) score += 2;
    }

    // Prefer .ts over .js
    if (name.endsWith('.ts')) score += 1;

    return score;
  }

  // --------------------------------------------------------------------------
  // Mock Analysis (for debug mode)
  // --------------------------------------------------------------------------

  /**
   * Generate synthetic analysis from manifest data without LLM calls.
   * Used when isMockLLMEnabled() returns true (ukb full debug mode).
   */
  private generateMockAnalysis(
    component: ComponentManifestEntry,
    _directoryStructure: string,
  ): ComponentAnalysis {
    const childCount = component.children?.length ?? 0;
    const childNames = component.children?.map(c => c.name).join(', ') ?? 'none';

    return {
      summary: `${component.name} is a component of the Coding project. ${component.description}. It contains ${childCount} sub-components: ${childNames}.`,
      observations: [
        `${component.name} handles ${component.description.toLowerCase()}`,
        `Component uses keywords: ${component.keywords.join(', ')}`,
        `Known aliases: ${component.aliases.join(', ') || 'none'}`,
        ...(component.children ?? []).map(c => `Sub-component ${c.name}: ${c.description}`),
      ],
      suggestedChildren: (component.children ?? []).map(c => ({
        name: c.name,
        description: c.description,
        discovered: false,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Format existing KG entities as a context block for the LLM prompt.
   */
  private formatExistingEntities(entities: KGEntity[]): string {
    if (entities.length === 0) {
      return '(No existing entities in knowledge graph)';
    }

    const lines = entities.slice(0, 30).map(e => {
      const firstObs = e.observations[0] ?? '';
      const truncatedObs = firstObs.length > 100 ? firstObs.substring(0, 100) + '...' : firstObs;
      return `- ${e.name} [${e.type}]: ${truncatedObs}`;
    });

    return lines.join('\n');
  }

  /**
   * Build a project-level summary from the L1 entity analyses.
   */
  private buildProjectSummary(manifest: ComponentManifest, l1Entities: KGEntity[]): string {
    const componentSummaries = l1Entities.map(e => {
      const firstObs = e.observations[0] ?? e.name;
      return `${e.name}: ${firstObs.substring(0, 150)}`;
    });

    return `${manifest.project.description}. The project consists of ${l1Entities.length} major components: ${componentSummaries.join('; ')}.`;
  }
}

// ============================================================================
// Internal Types
// ============================================================================

interface ComponentAnalysis {
  summary: string;
  observations: string[];
  suggestedChildren: Array<{
    name: string;
    description: string;
    discovered: boolean;
  }>;
}

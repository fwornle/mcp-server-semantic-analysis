import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

export interface UkbEntityOptions {
  name: string;
  type: string;
  insights: string;
  significance: number;
  tags: string[];
  codeFiles?: string[];
  referenceUrls?: string[];
}

export interface UkbCreationResult {
  success: boolean;
  details: string;
  entityId?: string;
  error?: string;
}

export interface KnowledgeQuery {
  query: string;
  entityType?: string;
  maxResults?: number;
}

export interface KnowledgeSearchResult {
  entities: KnowledgeEntity[];
  totalCount: number;
}

export interface KnowledgeEntity {
  id?: string;
  name: string;
  type: string;
  significance: number;
  observations: string[];
  tags?: string[];
  description?: string;
  examples?: string[];
  references?: string[];
  applicability?: string[];
  metadata?: {
    source?: string;
    context?: string;
    created?: string;
    analysisType?: string;
    complexityScore?: number;
    problem?: any;
    solution?: any;
  };
}

export class KnowledgeManager {
  private codingToolsPath: string;
  private ukbPath: string;

  constructor() {
    this.codingToolsPath = process.env.CODING_TOOLS_PATH || '/Users/q284340/Agentic/coding';
    this.ukbPath = path.join(this.codingToolsPath, 'ukb');
    
    log("Knowledge Manager initialized", "info", {
      codingToolsPath: this.codingToolsPath,
      ukbPath: this.ukbPath,
    });
  }

  async createUkbEntity(options: UkbEntityOptions): Promise<UkbCreationResult> {
    const { name, type, insights, significance, tags, codeFiles, referenceUrls } = options;

    log(`Creating UKB entity: ${name}`, "info", {
      type,
      significance,
      tagsCount: tags.length,
    });

    try {
      // Validate inputs
      if (!name || !type || !insights) {
        throw new Error("Name, type, and insights are required");
      }

      if (significance < 1 || significance > 10) {
        throw new Error("Significance must be between 1 and 10");
      }

      // Check if ukb command exists
      if (!this.isUkbAvailable()) {
        throw new Error("UKB command not available. Ensure you're in the coding environment.");
      }

      // Prepare input for ukb interactive mode
      const ukbInput = this.prepareUkbInput({
        name,
        type,
        insights,
        significance,
        tags,
        codeFiles,
        referenceUrls,
      });

      // Execute ukb command
      const result = await this.executeUkbCommand(ukbInput);
      
      if (result.success) {
        log(`Successfully created UKB entity: ${name}`, "info");
        return {
          success: true,
          details: `Entity "${name}" created successfully with significance ${significance}/10`,
          entityId: name,
        };
      } else {
        throw new Error(result.error || "UKB command failed");
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log(`Failed to create UKB entity: ${errorMsg}`, "error", error);
      
      return {
        success: false,
        details: `Failed to create entity: ${errorMsg}`,
        error: errorMsg,
      };
    }
  }

  async searchKnowledge(query: KnowledgeQuery): Promise<KnowledgeSearchResult> {
    const { query: searchQuery, entityType, maxResults = 10 } = query;

    log(`Searching knowledge base: ${searchQuery}`, "info", {
      entityType,
      maxResults,
    });

    try {
      // Search using the knowledge base files directly
      const knowledgeBase = await this.loadKnowledgeBase();
      const results = this.searchInKnowledgeBase(knowledgeBase, searchQuery, entityType);
      
      return {
        entities: results.slice(0, maxResults),
        totalCount: results.length,
      };

    } catch (error) {
      log(`Knowledge search failed: ${error}`, "error", error);
      return {
        entities: [],
        totalCount: 0,
      };
    }
  }

  private isUkbAvailable(): boolean {
    try {
      // Check if ukb script exists
      const ukbScriptPath = path.join(this.codingToolsPath, 'ukb');
      return fs.existsSync(ukbScriptPath);
    } catch (error) {
      return false;
    }
  }

  private prepareUkbInput(options: UkbEntityOptions): string {
    const { insights, type, significance, tags, codeFiles, referenceUrls } = options;

    // Format for ukb interactive mode (9-line format)
    const lines = [
      insights.substring(0, 200), // Problem description (truncated)
      insights, // Full solution description  
      `Created via semantic analysis MCP server`, // Rationale
      `Automated insight extraction and analysis`, // Key learnings
      `Pattern applies to similar ${type.toLowerCase()} scenarios`, // Applicability
      tags.join(',') || 'semantic-analysis,automated', // Technologies
      referenceUrls?.join(',') || '', // Reference URLs
      codeFiles?.join(',') || '', // Code files
      significance.toString(), // Significance (1-10)
    ];

    return lines.join('\n') + '\n';
  }

  private async executeUkbCommand(input: string): Promise<{ success: boolean; error?: string; output?: string }> {
    return new Promise((resolve) => {
      const ukbProcess = spawn(this.ukbPath, ['--interactive'], {
        cwd: this.codingToolsPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      ukbProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ukbProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ukbProcess.on('close', (code) => {
        log(`UKB process exited with code ${code}`, "info", {
          stdout: stdout.substring(0, 500),
          stderr: stderr.substring(0, 500),
        });

        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({ 
            success: false, 
            error: stderr || `Process exited with code ${code}` 
          });
        }
      });

      ukbProcess.on('error', (error) => {
        log(`UKB process error: ${error}`, "error", error);
        resolve({ 
          success: false, 
          error: `Failed to execute ukb: ${error.message}` 
        });
      });

      // Send input to ukb
      ukbProcess.stdin.write(input);
      ukbProcess.stdin.end();

      // Set timeout
      setTimeout(() => {
        ukbProcess.kill('SIGTERM');
        resolve({ 
          success: false, 
          error: 'UKB command timed out' 
        });
      }, 30000); // 30 second timeout
    });
  }

  private async loadKnowledgeBase(): Promise<KnowledgeEntity[]> {
    const entities: KnowledgeEntity[] = [];
    
    try {
      // Look for shared-memory files
      const sharedMemoryFiles = [
        'shared-memory-coding.json',
        'shared-memory-ui.json', 
        'shared-memory-resi.json',
        'shared-memory-raas.json',
      ];

      for (const fileName of sharedMemoryFiles) {
        const filePath = path.join(this.codingToolsPath, fileName);
        
        if (fs.existsSync(filePath)) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content);
            
            if (data.entities && Array.isArray(data.entities)) {
              for (const entity of data.entities) {
                entities.push({
                  name: entity.name || 'Unknown',
                  type: entity.entityType || entity.type || 'Unknown',
                  significance: entity.significance || 5,
                  observations: Array.isArray(entity.observations) 
                    ? entity.observations.map((obs: any) => 
                        typeof obs === 'string' ? obs : obs.content || String(obs)
                      )
                    : [],
                  tags: entity.tags || [],
                });
              }
            }
          } catch (error) {
            log(`Error parsing knowledge base file ${fileName}:`, "warning", error);
          }
        }
      }
    } catch (error) {
      log("Error loading knowledge base:", "error", error);
    }

    return entities;
  }

  private searchInKnowledgeBase(
    entities: KnowledgeEntity[], 
    query: string, 
    entityType?: string
  ): KnowledgeEntity[] {
    const queryLower = query.toLowerCase();
    
    return entities
      .filter(entity => {
        // Filter by entity type if specified
        if (entityType && entity.type.toLowerCase() !== entityType.toLowerCase()) {
          return false;
        }
        
        // Search in name, type, and observations
        const searchText = [
          entity.name,
          entity.type,
          ...entity.observations,
          ...(entity.tags || []),
        ].join(' ').toLowerCase();
        
        return searchText.includes(queryLower);
      })
      .sort((a, b) => {
        // Sort by significance (descending) and then by name match relevance
        const aNameMatch = a.name.toLowerCase().includes(queryLower);
        const bNameMatch = b.name.toLowerCase().includes(queryLower);
        
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;
        
        return b.significance - a.significance;
      });
  }

  async getEntityDetails(entityName: string): Promise<KnowledgeEntity | null> {
    try {
      const knowledgeBase = await this.loadKnowledgeBase();
      return knowledgeBase.find(e => e.name.toLowerCase() === entityName.toLowerCase()) || null;
    } catch (error) {
      log(`Error getting entity details for ${entityName}:`, "error", error);
      return null;
    }
  }

  async listEntityTypes(): Promise<string[]> {
    try {
      const knowledgeBase = await this.loadKnowledgeBase();
      const types = new Set(knowledgeBase.map(e => e.type));
      return Array.from(types).sort();
    } catch (error) {
      log("Error listing entity types:", "error", error);
      return [];
    }
  }

  async getKnowledgeStats(): Promise<{ totalEntities: number; entityTypes: Record<string, number> }> {
    try {
      const knowledgeBase = await this.loadKnowledgeBase();
      const entityTypes: Record<string, number> = {};
      
      for (const entity of knowledgeBase) {
        entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;
      }
      
      return {
        totalEntities: knowledgeBase.length,
        entityTypes,
      };
    } catch (error) {
      log("Error getting knowledge stats:", "error", error);
      return { totalEntities: 0, entityTypes: {} };
    }
  }

  async saveEntity(entity: KnowledgeEntity): Promise<void> {
    try {
      log(`Saving knowledge entity: ${entity.name}`, "info", {
        type: entity.type,
        significance: entity.significance,
        tags: entity.tags
      });
      
      // Ensure entity has an ID
      if (!entity.id) {
        entity.id = `${entity.type.toLowerCase()}-${entity.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
      }
      
      // Update shared-memory-coding.json
      const sharedMemoryPath = '/Users/q284340/Agentic/coding/shared-memory-coding.json';
      
      // Read existing data
      let sharedMemory: any = { entities: [], relations: [] };
      try {
        const data = await fs.promises.readFile(sharedMemoryPath, 'utf-8');
        sharedMemory = JSON.parse(data);
      } catch (error) {
        log("Creating new shared-memory-coding.json", "info");
      }
      
      // Ensure entities array exists
      if (!sharedMemory.entities) {
        sharedMemory.entities = [];
      }
      
      // Check if entity already exists
      const existingIndex = sharedMemory.entities.findIndex((e: any) => e.name === entity.name);
      
      // Format entity for shared memory storage
      const formattedEntity = {
        name: entity.name,
        entityType: entity.type,
        observations: entity.observations.map(obs => ({
          type: "insight",
          content: obs,
          date: new Date().toISOString(),
          metadata: {}
        })),
        significance: entity.significance,
        problem: entity.metadata?.problem || {},
        solution: entity.metadata?.solution || {},
        metadata: {
          created_at: entity.metadata?.created || new Date().toISOString(),
          last_updated: new Date().toISOString(),
          tags: entity.tags || [],
          source: entity.metadata?.source || "semantic-analysis",
          context: entity.metadata?.context || ""
        },
        id: entity.id
      };
      
      if (existingIndex >= 0) {
        // Update existing entity
        sharedMemory.entities[existingIndex] = {
          ...sharedMemory.entities[existingIndex],
          ...formattedEntity,
          observations: [
            ...sharedMemory.entities[existingIndex].observations,
            ...formattedEntity.observations
          ]
        };
        log(`Updated existing entity: ${entity.name}`, "info");
      } else {
        // Add new entity
        sharedMemory.entities.push(formattedEntity);
        log(`Added new entity: ${entity.name}`, "info");
      }
      
      // Write back to file with proper formatting
      await fs.promises.writeFile(
        sharedMemoryPath, 
        JSON.stringify(sharedMemory, null, 2),
        'utf-8'
      );
      
      log(`Successfully saved entity to shared-memory-coding.json: ${entity.name}`, "info");
      
    } catch (error) {
      log("Failed to save entity", "error", error);
      throw error;
    }
  }

  async createEntities(analysisResults: any, context: string = ""): Promise<{created: KnowledgeEntity[], updated: string[]}> {
    log("Creating knowledge entities from analysis results", "info", { context });
    
    const created: KnowledgeEntity[] = [];
    const updated: string[] = [];
    
    try {
      // Extract patterns and insights from analysis results
      const patterns = this.extractPatternsFromResults(analysisResults);
      const insights = this.extractInsightsFromResults(analysisResults);
      const architecturalComponents = this.extractArchitecturalComponents(analysisResults);
      
      // Create entities for each pattern
      for (const pattern of patterns) {
        const entity: KnowledgeEntity = {
          id: `pattern-${pattern.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
          name: pattern.name,
          type: "ArchitecturalPattern",
          description: pattern.description,
          observations: [pattern.description || `Pattern: ${pattern.name}`],
          examples: pattern.examples || [],
          references: pattern.references || [],
          significance: pattern.significance || 7,
          applicability: pattern.applicability || [],
          tags: pattern.tags || ["pattern", "architecture"],
          metadata: {
            source: "semantic-analysis",
            context: context,
            created: new Date().toISOString(),
            analysisType: analysisResults.type || "repository-analysis",
            problem: pattern.problem,
            solution: pattern.solution
          }
        };
        
        await this.saveEntity(entity);
        await this.createInsightMarkdownFile(entity, analysisResults);
        created.push(entity);
      }
      
      // Create entities for architectural insights
      for (const insight of insights) {
        const entity: KnowledgeEntity = {
          id: `insight-${insight.title.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`,
          name: insight.title,
          type: "ArchitecturalInsight",
          description: insight.description,
          observations: [insight.description || `Insight: ${insight.title}`],
          examples: insight.examples || [],
          references: insight.references || [],
          significance: insight.significance || 8,
          applicability: insight.applicability || [],
          tags: insight.tags || ["insight", "architecture", "analysis"],
          metadata: {
            source: "semantic-analysis",
            context: context,
            created: new Date().toISOString(),
            analysisType: analysisResults.type || "repository-analysis",
            complexityScore: insight.complexityScore
          }
        };
        
        await this.saveEntity(entity);
        created.push(entity);
      }
      
      // Update shared memory with new entities
      await this.updateSharedMemory(created);
      
      log(`Created ${created.length} knowledge entities`, "info", {
        created: created.map(e => e.name),
        updated: updated.length
      });
      
      return { created, updated };
      
    } catch (error) {
      log("Failed to create knowledge entities", "error", error);
      throw error;
    }
  }

  private extractPatternsFromResults(results: any): any[] {
    const patterns = [];
    
    if (results.patterns) {
      for (const pattern of results.patterns) {
        patterns.push({
          name: pattern.name || pattern,
          description: pattern.description || `Architectural pattern identified in analysis: ${pattern}`,
          significance: pattern.significance || 7,
          examples: pattern.examples || [],
          tags: ["pattern", "architecture", "semantic-analysis"]
        });
      }
    }
    
    if (results.architectural_patterns) {
      patterns.push(...results.architectural_patterns);
    }
    
    return patterns;
  }

  private extractInsightsFromResults(results: any): any[] {
    const insights = [];
    
    if (results.insights) {
      if (typeof results.insights === 'string') {
        insights.push({
          title: "Repository Analysis Insight",
          description: results.insights,
          significance: 8,
          tags: ["insight", "analysis"]
        });
      } else if (Array.isArray(results.insights)) {
        insights.push(...results.insights);
      }
    }
    
    if (results.architectural_insights) {
      insights.push(...results.architectural_insights);
    }
    
    if (results.complexity_analysis) {
      insights.push({
        title: "Complexity Analysis",
        description: `System complexity analysis: ${JSON.stringify(results.complexity_analysis)}`,
        significance: 7,
        complexityScore: results.complexity_analysis.score,
        tags: ["complexity", "analysis", "metrics"]
      });
    }
    
    return insights;
  }

  private extractArchitecturalComponents(results: any): any[] {
    const components = [];
    
    if (results.components) {
      components.push(...results.components);
    }
    
    if (results.architecture && results.architecture.components) {
      components.push(...results.architecture.components);
    }
    
    return components;
  }

  private async updateSharedMemory(entities: KnowledgeEntity[]): Promise<void> {
    try {
      const sharedMemoryPath = '/Users/q284340/Agentic/coding/shared-memory-coding.json';
      let sharedMemory: any = {};
      
      // Read existing shared memory
      if (fs.existsSync(sharedMemoryPath)) {
        const content = fs.readFileSync(sharedMemoryPath, 'utf-8');
        sharedMemory = JSON.parse(content);
      }
      
      // Add new entities to shared memory
      if (!sharedMemory.entities) {
        sharedMemory.entities = {};
      }
      
      for (const entity of entities) {
        const entityId = entity.id || `${entity.type}-${entity.name}-${Date.now()}`;
        sharedMemory.entities[entityId] = {
          name: entity.name,
          type: entity.type,
          description: entity.description || '',
          significance: entity.significance,
          tags: entity.tags || [],
          created: entity.metadata?.created || new Date().toISOString(),
          lastUpdated: new Date().toISOString()
        };
      }
      
      // Update metadata
      sharedMemory.lastUpdated = new Date().toISOString();
      sharedMemory.version = (sharedMemory.version || 0) + 1;
      
      // Write back to file
      fs.writeFileSync(sharedMemoryPath, JSON.stringify(sharedMemory, null, 2));
      
      log(`Updated shared memory with ${entities.length} entities`, "info", {
        path: sharedMemoryPath,
        totalEntities: Object.keys(sharedMemory.entities).length
      });
      
    } catch (error) {
      log("Failed to update shared memory", "error", error);
      throw error;
    }
  }

  async createInsightMarkdownFile(entity: KnowledgeEntity, analysisResults: any): Promise<void> {
    try {
      const insightsDir = '/Users/q284340/Agentic/coding/knowledge-management/insights';
      const fileName = `${entity.name}.md`;
      const filePath = path.join(insightsDir, fileName);
      
      // Ensure directory exists
      await fs.promises.mkdir(insightsDir, { recursive: true });
      
      // Generate markdown content
      const content = this.generateInsightMarkdown(entity, analysisResults);
      
      // Write file
      await fs.promises.writeFile(filePath, content, 'utf-8');
      
      log(`Created insight markdown file: ${filePath}`, "info");
    } catch (error) {
      log("Failed to create insight markdown file", "error", error);
      // Don't throw - this is a nice-to-have feature
    }
  }
  
  private generateInsightMarkdown(entity: KnowledgeEntity, analysisResults: any): string {
    const sections = [];
    
    // Header
    sections.push(`# ${entity.name}`);
    sections.push('');
    
    // Overview
    sections.push('## Overview');
    sections.push('');
    sections.push(`**Pattern Type:** ${entity.type}`);
    sections.push(`**Significance:** ${entity.significance}/10`);
    sections.push(`**Tags:** ${entity.tags?.join(', ') || 'None'}`);
    sections.push(`**Created:** ${entity.metadata?.created || new Date().toISOString()}`);
    sections.push('');
    
    // Problem Statement
    if (entity.metadata?.problem) {
      sections.push('## Problem Statement');
      sections.push('');
      sections.push(entity.metadata.problem.description || entity.description || 'Problem analysis pending.');
      sections.push('');
    }
    
    // Solution Overview
    if (entity.metadata?.solution) {
      sections.push('## Solution Overview');
      sections.push('');
      sections.push(entity.metadata.solution.description || 'Solution implementation details.');
      sections.push('');
    }
    
    // Architecture Patterns
    sections.push('## Architecture Patterns');
    sections.push('');
    if (analysisResults.patterns && analysisResults.patterns.length > 0) {
      analysisResults.patterns.forEach((pattern: string) => {
        sections.push(`- ${pattern}`);
      });
    } else {
      sections.push('Architecture patterns analysis in progress.');
    }
    sections.push('');
    
    // Implementation Details
    sections.push('## Implementation Details');
    sections.push('');
    sections.push('### Key Components');
    sections.push('');
    if (entity.observations && entity.observations.length > 0) {
      entity.observations.forEach((obs: string) => {
        sections.push(`- ${obs}`);
      });
    }
    sections.push('');
    
    // Code Examples
    if (entity.examples && entity.examples.length > 0) {
      sections.push('### Code Examples');
      sections.push('');
      entity.examples.forEach((example: string) => {
        sections.push('```typescript');
        sections.push(example);
        sections.push('```');
        sections.push('');
      });
    }
    
    // PlantUML Diagrams
    sections.push('## Architecture Diagrams');
    sections.push('');
    
    const baseFileName = entity.name.toLowerCase();
    sections.push(`### System Architecture`);
    sections.push(`![${entity.name} Architecture](images/${baseFileName}-architecture.png)`);
    sections.push('');
    
    sections.push(`### Use Cases`);
    sections.push(`![${entity.name} Use Cases](images/${baseFileName}-use-cases.png)`);
    sections.push('');
    
    sections.push(`### Sequence Flow`);
    sections.push(`![${entity.name} Sequence](images/${baseFileName}-sequence.png)`);
    sections.push('');
    
    sections.push(`### Integration Points`);
    sections.push(`![${entity.name} Integration](images/${baseFileName}-integration.png)`);
    sections.push('');
    
    // Benefits
    sections.push('## Key Benefits');
    sections.push('');
    sections.push('- Improved system maintainability');
    sections.push('- Enhanced architectural clarity');
    sections.push('- Better separation of concerns');
    sections.push('- Scalable design patterns');
    sections.push('');
    
    // Applicability
    if (entity.applicability && entity.applicability.length > 0) {
      sections.push('## Applicability');
      sections.push('');
      entity.applicability.forEach((app: string) => {
        sections.push(`- ${app}`);
      });
      sections.push('');
    }
    
    // References
    if (entity.references && entity.references.length > 0) {
      sections.push('## References');
      sections.push('');
      entity.references.forEach((ref: string) => {
        sections.push(`- ${ref}`);
      });
      sections.push('');
    }
    
    // Footer
    sections.push('---');
    sections.push(`*Generated by Semantic Analysis System on ${new Date().toISOString()}*`);
    
    return sections.join('\n');
  }
}
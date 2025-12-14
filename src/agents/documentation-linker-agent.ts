/**
 * DocumentationLinkerAgent - Links documentation to code entities
 *
 * Scans markdown files and PlantUML diagrams to:
 * - Extract code references (backtick-quoted names, code blocks)
 * - Parse PlantUML files for component/class definitions
 * - Create DocumentationLink entities linking docs to code
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from '../logging.js';
import type { CodeEntity } from './code-graph-agent.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

export interface DocumentationLink {
  id: string;
  documentPath: string;
  documentTitle?: string;
  codeReference: string;
  referenceType: 'inline_code' | 'code_block' | 'class_diagram' | 'component_diagram' | 'sequence_diagram';
  context: string;
  lineNumber?: number;
  confidence: number;
}

export interface DocumentationAnalysisResult {
  links: DocumentationLink[];
  documents: DocumentMetadata[];
  statistics: {
    totalDocuments: number;
    totalLinks: number;
    linksByType: Record<string, number>;
    unresolvedReferences: string[];
  };
  analyzedAt: string;
}

export interface DocumentMetadata {
  path: string;
  title?: string;
  type: 'markdown' | 'plantuml' | 'mermaid';
  codeReferences: string[];
  lastModified: string;
}

export class DocumentationLinkerAgent {
  private repositoryPath: string;
  private knownCodeEntities: Map<string, CodeEntity>;
  private semanticAnalyzer: SemanticAnalyzer;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = path.resolve(repositoryPath);
    this.knownCodeEntities = new Map();
    this.semanticAnalyzer = new SemanticAnalyzer();

    log(`[DocumentationLinkerAgent] Initialized with repo: ${this.repositoryPath}`, 'info');
  }

  /**
   * Recursively find files matching a pattern
   */
  private async findFiles(
    dir: string,
    extensions: string[],
    excludePatterns: string[] = ['node_modules', 'dist', '.git']
  ): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip excluded directories
        if (excludePatterns.some(p => entry.name === p || entry.name.startsWith('.'))) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this.findFiles(fullPath, extensions, excludePatterns);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      log(`[DocumentationLinkerAgent] Error reading directory ${dir}: ${error}`, 'warning');
    }

    return files;
  }

  /**
   * Register known code entities for reference resolution
   */
  registerCodeEntities(entities: CodeEntity[]): void {
    for (const entity of entities) {
      this.knownCodeEntities.set(entity.name.toLowerCase(), entity);
    }
    log(`[DocumentationLinkerAgent] Registered ${entities.length} code entities`, 'info');
  }

  /**
   * Analyze all documentation in the repository
   */
  async analyzeDocumentation(options: {
    markdownPaths?: string[];
    plantumlPaths?: string[];
    includePatterns?: string[];
    excludePatterns?: string[];
  } = {}): Promise<DocumentationAnalysisResult> {
    log(`[DocumentationLinkerAgent] Analyzing documentation`, 'info');

    const links: DocumentationLink[] = [];
    const documents: DocumentMetadata[] = [];
    const unresolvedReferences: string[] = [];

    // Find all markdown files
    const excludeDirs = ['node_modules', 'dist', '.git', '.specstory', '.data'];
    const mdFiles = await this.findFiles(this.repositoryPath, ['.md'], excludeDirs);

    for (const mdFile of mdFiles) {
      try {
        const result = await this.analyzeMarkdownFile(mdFile);
        documents.push(result.metadata);
        links.push(...result.links);
        unresolvedReferences.push(...result.unresolvedReferences);
      } catch (error) {
        log(`[DocumentationLinkerAgent] Failed to analyze ${mdFile}: ${error}`, 'warning');
      }
    }

    // Find all PlantUML files
    const pumlFiles = await this.findFiles(this.repositoryPath, ['.puml', '.plantuml'], excludeDirs);

    for (const pumlFile of pumlFiles) {
      try {
        const result = await this.analyzePlantUMLFile(pumlFile);
        documents.push(result.metadata);
        links.push(...result.links);
        unresolvedReferences.push(...result.unresolvedReferences);
      } catch (error) {
        log(`[DocumentationLinkerAgent] Failed to analyze ${pumlFile}: ${error}`, 'warning');
      }
    }

    // Calculate statistics
    const linksByType: Record<string, number> = {};
    for (const link of links) {
      linksByType[link.referenceType] = (linksByType[link.referenceType] || 0) + 1;
    }

    const result: DocumentationAnalysisResult = {
      links,
      documents,
      statistics: {
        totalDocuments: documents.length,
        totalLinks: links.length,
        linksByType,
        unresolvedReferences: [...new Set(unresolvedReferences)],
      },
      analyzedAt: new Date().toISOString(),
    };

    log(`[DocumentationLinkerAgent] Found ${links.length} documentation links in ${documents.length} documents`, 'info');
    return result;
  }

  /**
   * Analyze a markdown file for code references
   */
  private async analyzeMarkdownFile(filePath: string): Promise<{
    metadata: DocumentMetadata;
    links: DocumentationLink[];
    unresolvedReferences: string[];
  }> {
    const content = await fs.readFile(filePath, 'utf-8');
    const relativePath = path.relative(this.repositoryPath, filePath);
    const links: DocumentationLink[] = [];
    const unresolvedReferences: string[] = [];
    const codeReferences: string[] = [];

    // Extract title from first H1
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1] : undefined;

    // Find inline code references (`code`)
    const inlineCodeRegex = /`([A-Z][a-zA-Z0-9_]+)`/g;
    let match;
    while ((match = inlineCodeRegex.exec(content)) !== null) {
      const codeName = match[1];
      codeReferences.push(codeName);

      // Calculate line number
      const lineNumber = content.slice(0, match.index).split('\n').length;

      // Get surrounding context
      const lines = content.split('\n');
      const contextStart = Math.max(0, lineNumber - 2);
      const contextEnd = Math.min(lines.length, lineNumber + 1);
      const context = lines.slice(contextStart, contextEnd).join('\n');

      // Check if we know this code entity
      const isResolved = this.knownCodeEntities.has(codeName.toLowerCase());
      if (!isResolved) {
        unresolvedReferences.push(codeName);
      }

      links.push({
        id: `${relativePath}:${lineNumber}:${codeName}`,
        documentPath: relativePath,
        documentTitle: title,
        codeReference: codeName,
        referenceType: 'inline_code',
        context,
        lineNumber,
        confidence: isResolved ? 0.9 : 0.5,
      });
    }

    // Find code blocks with language hints
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const language = match[1] || 'unknown';
      const codeContent = match[2];
      const lineNumber = content.slice(0, match.index).split('\n').length;

      // Extract potential class/function names from code blocks
      const classMatch = codeContent.match(/class\s+(\w+)/);
      const functionMatch = codeContent.match(/(?:function|def|fn)\s+(\w+)/);

      if (classMatch) {
        codeReferences.push(classMatch[1]);
        links.push({
          id: `${relativePath}:${lineNumber}:${classMatch[1]}:block`,
          documentPath: relativePath,
          documentTitle: title,
          codeReference: classMatch[1],
          referenceType: 'code_block',
          context: codeContent.slice(0, 200),
          lineNumber,
          confidence: 0.7,
        });
      }

      if (functionMatch) {
        codeReferences.push(functionMatch[1]);
        links.push({
          id: `${relativePath}:${lineNumber}:${functionMatch[1]}:block`,
          documentPath: relativePath,
          documentTitle: title,
          codeReference: functionMatch[1],
          referenceType: 'code_block',
          context: codeContent.slice(0, 200),
          lineNumber,
          confidence: 0.7,
        });
      }
    }

    const stats = await fs.stat(filePath);

    return {
      metadata: {
        path: relativePath,
        title,
        type: 'markdown',
        codeReferences: [...new Set(codeReferences)],
        lastModified: stats.mtime.toISOString(),
      },
      links,
      unresolvedReferences,
    };
  }

  /**
   * Analyze a PlantUML file for component/class definitions
   */
  private async analyzePlantUMLFile(filePath: string): Promise<{
    metadata: DocumentMetadata;
    links: DocumentationLink[];
    unresolvedReferences: string[];
  }> {
    const content = await fs.readFile(filePath, 'utf-8');
    const relativePath = path.relative(this.repositoryPath, filePath);
    const links: DocumentationLink[] = [];
    const unresolvedReferences: string[] = [];
    const codeReferences: string[] = [];

    // Extract diagram title
    const titleMatch = content.match(/title\s+(.+)/i);
    const title = titleMatch ? titleMatch[1] : undefined;

    // Determine diagram type
    let diagramType: 'class_diagram' | 'component_diagram' | 'sequence_diagram' = 'component_diagram';
    if (content.includes('@startuml') && content.includes('class ')) {
      diagramType = 'class_diagram';
    } else if (content.includes('@startsequence') || content.includes('->')) {
      diagramType = 'sequence_diagram';
    }

    // Find class definitions
    const classRegex = /class\s+(\w+)/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      codeReferences.push(className);
      const lineNumber = content.slice(0, match.index).split('\n').length;

      const isResolved = this.knownCodeEntities.has(className.toLowerCase());
      if (!isResolved) {
        unresolvedReferences.push(className);
      }

      links.push({
        id: `${relativePath}:${lineNumber}:${className}`,
        documentPath: relativePath,
        documentTitle: title,
        codeReference: className,
        referenceType: diagramType,
        context: `Class ${className} in PlantUML diagram`,
        lineNumber,
        confidence: isResolved ? 0.85 : 0.5,
      });
    }

    // Find component definitions
    const componentRegex = /\[([^\]]+)\]/g;
    while ((match = componentRegex.exec(content)) !== null) {
      const componentName = match[1];
      codeReferences.push(componentName);
      const lineNumber = content.slice(0, match.index).split('\n').length;

      links.push({
        id: `${relativePath}:${lineNumber}:${componentName}`,
        documentPath: relativePath,
        documentTitle: title,
        codeReference: componentName,
        referenceType: 'component_diagram',
        context: `Component ${componentName} in PlantUML diagram`,
        lineNumber,
        confidence: 0.6,
      });
    }

    // Find participant/actor definitions (sequence diagrams)
    const participantRegex = /(?:participant|actor)\s+"?(\w+)"?/g;
    while ((match = participantRegex.exec(content)) !== null) {
      const participantName = match[1];
      codeReferences.push(participantName);
      const lineNumber = content.slice(0, match.index).split('\n').length;

      links.push({
        id: `${relativePath}:${lineNumber}:${participantName}`,
        documentPath: relativePath,
        documentTitle: title,
        codeReference: participantName,
        referenceType: 'sequence_diagram',
        context: `Participant ${participantName} in sequence diagram`,
        lineNumber,
        confidence: 0.6,
      });
    }

    const stats = await fs.stat(filePath);

    return {
      metadata: {
        path: relativePath,
        title,
        type: 'plantuml',
        codeReferences: [...new Set(codeReferences)],
        lastModified: stats.mtime.toISOString(),
      },
      links,
      unresolvedReferences,
    };
  }

  /**
   * Transform documentation links to knowledge entities for persistence
   */
  async transformToKnowledgeEntities(docAnalysis: DocumentationAnalysisResult): Promise<Array<{
    name: string;
    entityType: string;
    observations: string[];
    significance: number;
  }>> {
    const knowledgeEntities: Array<{
      name: string;
      entityType: string;
      observations: string[];
      significance: number;
    }> = [];

    // Group links by code reference
    const linksByReference = new Map<string, DocumentationLink[]>();
    for (const link of docAnalysis.links) {
      if (!linksByReference.has(link.codeReference)) {
        linksByReference.set(link.codeReference, []);
      }
      linksByReference.get(link.codeReference)!.push(link);
    }

    // Create knowledge entities for well-documented code references
    for (const [codeRef, links] of linksByReference) {
      if (links.length >= 2 || links.some(l => l.confidence > 0.7)) {
        const docPaths = [...new Set(links.map(l => l.documentPath))];
        const observations = [
          `${codeRef} is documented in ${docPaths.length} file(s): ${docPaths.slice(0, 3).join(', ')}${docPaths.length > 3 ? '...' : ''}`,
          ...links.slice(0, 5).map(l => `Referenced in ${l.documentPath} (${l.referenceType}): ${l.context.slice(0, 100)}...`),
        ];

        knowledgeEntities.push({
          name: `${codeRef}Documentation`,
          entityType: 'DocumentationLink',
          observations,
          significance: Math.min(7, 3 + links.length),
        });
      }
    }

    log(`[DocumentationLinkerAgent] Transformed ${knowledgeEntities.length} documentation links to knowledge entities`, 'info');
    return knowledgeEntities;
  }

  /**
   * Use LLM to semantically match unresolved documentation references to code entities
   */
  async resolveReferencesWithLLM(
    unresolvedReferences: string[],
    availableEntities: CodeEntity[]
  ): Promise<Array<{
    reference: string;
    matchedEntity: string | null;
    confidence: number;
    reasoning: string;
  }>> {
    if (unresolvedReferences.length === 0 || availableEntities.length === 0) {
      return [];
    }

    const results: Array<{
      reference: string;
      matchedEntity: string | null;
      confidence: number;
      reasoning: string;
    }> = [];

    // Process in batches to avoid LLM overload
    const batchSize = 10;
    const entityNames = availableEntities.slice(0, 100).map(e => e.name).join(', ');

    for (let i = 0; i < unresolvedReferences.length; i += batchSize) {
      const batch = unresolvedReferences.slice(i, i + batchSize);

      try {
        const prompt = `Match these documentation references to the most likely code entity.

Documentation references to match:
${batch.map((ref, idx) => `${idx + 1}. "${ref}"`).join('\n')}

Available code entities:
${entityNames}

For each reference, find the best matching entity or null if no good match.
Respond with JSON array:
[
  {"reference": "<ref>", "matchedEntity": "<entity name or null>", "confidence": <0.0-1.0>, "reasoning": "<brief explanation>"}
]`;

        const response = await this.semanticAnalyzer.analyzeContent(prompt, {
          maxTokens: 1000,
          temperature: 0.3,
        });

        // Parse LLM response
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          results.push(...parsed);
        }
      } catch (error) {
        log(`[DocumentationLinkerAgent] LLM matching failed for batch: ${error}`, 'warning');
        // Add fallback results for failed batch
        for (const ref of batch) {
          results.push({
            reference: ref,
            matchedEntity: null,
            confidence: 0,
            reasoning: 'LLM matching failed',
          });
        }
      }
    }

    log(`[DocumentationLinkerAgent] LLM resolved ${results.filter(r => r.matchedEntity).length}/${unresolvedReferences.length} references`, 'info');
    return results;
  }

  /**
   * Analyze documentation with LLM-enhanced semantic matching
   */
  async analyzeDocumentationWithLLM(options: {
    markdownPaths?: string[];
    plantumlPaths?: string[];
    includePatterns?: string[];
    excludePatterns?: string[];
  } = {}): Promise<DocumentationAnalysisResult & { llmResolvedReferences?: number }> {
    // First do standard analysis
    const result = await this.analyzeDocumentation(options);

    // If there are unresolved references and known entities, try LLM matching
    if (result.statistics.unresolvedReferences.length > 0 && this.knownCodeEntities.size > 0) {
      const entities = Array.from(this.knownCodeEntities.values());
      const llmMatches = await this.resolveReferencesWithLLM(
        result.statistics.unresolvedReferences,
        entities
      );

      // Update links with LLM-resolved matches
      let resolvedCount = 0;
      for (const match of llmMatches) {
        if (match.matchedEntity && match.confidence > 0.6) {
          // Find and update the corresponding link
          const link = result.links.find(
            l => l.codeReference === match.reference && l.confidence < 0.7
          );
          if (link) {
            link.confidence = match.confidence;
            resolvedCount++;
          }
        }
      }

      // Remove resolved references from unresolved list
      const stillUnresolved = result.statistics.unresolvedReferences.filter(ref => {
        const match = llmMatches.find(m => m.reference === ref);
        return !match || !match.matchedEntity || match.confidence <= 0.6;
      });
      result.statistics.unresolvedReferences = stillUnresolved;

      return {
        ...result,
        llmResolvedReferences: resolvedCount,
      };
    }

    return result;
  }
}

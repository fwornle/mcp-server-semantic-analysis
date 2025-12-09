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
import { glob } from 'glob';
import { log } from '../logging.js';
import type { CodeEntity } from './code-graph-agent.js';

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

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = path.resolve(repositoryPath);
    this.knownCodeEntities = new Map();

    log(`[DocumentationLinkerAgent] Initialized with repo: ${this.repositoryPath}`, 'info');
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
    const mdPatterns = options.markdownPaths || ['**/*.md'];
    const mdExclude = options.excludePatterns || ['**/node_modules/**', '**/dist/**', '**/.git/**'];

    for (const pattern of mdPatterns) {
      const mdFiles = await glob(pattern, {
        cwd: this.repositoryPath,
        ignore: mdExclude,
        absolute: true,
      });

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
    }

    // Find all PlantUML files
    const pumlPatterns = options.plantumlPaths || ['**/*.puml', '**/*.plantuml'];

    for (const pattern of pumlPatterns) {
      const pumlFiles = await glob(pattern, {
        cwd: this.repositoryPath,
        ignore: mdExclude,
        absolute: true,
      });

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
}

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { FilenameTracer } from '../utils/filename-tracer.js';
import { ContentAgnosticAnalyzer } from '../utils/content-agnostic-analyzer.js';
import { RepositoryContextManager } from '../utils/repository-context.js';
import {
  SerenaCodeAnalyzer,
  extractCodeReferences,
  createSerenaAnalyzer,
  type SerenaAnalysisResult
} from '../utils/serena-code-analyzer.js';

export interface InsightDocument {
  name: string;
  title: string;
  content: string;
  filePath: string;
  diagrams: PlantUMLDiagram[];
  metadata: {
    significance: number;
    tags: string[];
    generatedAt: string;
    analysisTypes: string[];
    patternCount: number;
  };
}

export interface PlantUMLDiagram {
  type: 'architecture' | 'sequence' | 'use-cases' | 'class';
  name: string;
  content: string;
  pumlFile: string;
  pngFile?: string;
  success: boolean;
}

export interface PatternCatalog {
  patterns: IdentifiedPattern[];
  summary: {
    totalPatterns: number;
    byCategory: Record<string, number>;
    avgSignificance: number;
    topPatterns: string[];
  };
}

export interface IdentifiedPattern {
  name: string;
  category: string;
  description: string;
  significance: number;
  evidence: string[];
  relatedComponents: string[];
  implementation: {
    language: string;
    codeExample?: string;
    usageNotes: string[];
  };
}

export interface InsightGenerationResult {
  insightDocument: InsightDocument;
  insightDocuments?: InsightDocument[]; // Array of all generated documents
  patternCatalog: PatternCatalog;
  generationMetrics: {
    processingTime: number;
    documentsGenerated: number;
    diagramsGenerated: number;
    patternsIdentified: number;
    qualityScore: number;
  };
}


/**
 * Convert a name to kebab-case (lowercase with hyphens).
 * Per documentation-style requirements: only lowercase letters, hyphens, and numbers allowed.
 * Examples:
 *   "DecoratorPattern" -> "decorator-pattern"
 *   "MCPServerSetup" -> "mcp-server-setup"
 *   "Some_Name_Here" -> "some-name-here"
 */
function toKebabCase(name: string): string {
  return name
    // Insert hyphen before uppercase letters (for PascalCase/camelCase)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    // Replace underscores and spaces with hyphens
    .replace(/[_\s]+/g, '-')
    // Convert to lowercase
    .toLowerCase()
    // Remove any invalid characters (keep only lowercase, hyphens, numbers)
    .replace(/[^a-z0-9-]/g, '')
    // Remove consecutive hyphens
    .replace(/-+/g, '-')
    // Remove leading/trailing hyphens
    .replace(/^-|-$/g, '');
}

export class InsightGenerationAgent {
  private outputDir: string;
  private plantumlAvailable: boolean = false;
  private standardStylePath: string;
  private semanticAnalyzer: SemanticAnalyzer;
  private contentAnalyzer: ContentAgnosticAnalyzer;
  private contextManager: RepositoryContextManager;
  private serenaAnalyzer: SerenaCodeAnalyzer;
  private repositoryPath: string;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
    this.outputDir = path.join(repositoryPath, 'knowledge-management', 'insights');
    this.standardStylePath = path.join(repositoryPath, 'docs', 'puml', '_standard-style.puml');
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.contentAnalyzer = new ContentAgnosticAnalyzer(repositoryPath);
    this.contextManager = new RepositoryContextManager(repositoryPath);
    this.serenaAnalyzer = createSerenaAnalyzer(repositoryPath);
    this.initializeDirectories();
    this.checkPlantUMLAvailability();
  }

  /**
   * Generate technical documentation content from entity observations.
   * This is the PRIMARY method for creating insight documents - it uses observations
   * as the source of truth rather than generic git/vibe analysis.
   */
  private async generateTechnicalDocumentation(params: {
    entityName: string;
    entityType: string;
    observations: string[];
    relations?: Array<{ from: string; to: string; relationType: string }>;
    diagrams?: Array<{ name: string; type: string; success: boolean }>;
  }): Promise<string> {
    const { entityName, entityType, observations, relations = [], diagrams = [] } = params;

    log(`Generating technical documentation for ${entityName} from ${observations.length} observations`, 'info');

    // Extract code references from all observations
    const allCodeRefs = observations.flatMap(obs => extractCodeReferences(obs));
    log(`Found ${allCodeRefs.length} code references in observations`, 'info');

    // Analyze code references with Serena (if available)
    let serenaAnalysis: SerenaAnalysisResult | null = null;
    if (allCodeRefs.length > 0) {
      try {
        serenaAnalysis = await this.serenaAnalyzer.analyzeCodeReferences(allCodeRefs);
        log(`Serena analysis found ${serenaAnalysis.symbols.length} symbols, ${serenaAnalysis.fileStructures.length} file structures`, 'info');
      } catch (error) {
        log(`Serena analysis failed (continuing without it): ${error}`, 'warning');
      }
    }

    // DEEP INSIGHT GENERATION: Use LLM to synthesize meaningful insights from observations
    // This generates a coherent narrative rather than just listing observations
    let deepInsightContent: string | null = null;
    if (this.semanticAnalyzer && observations.length > 0) {
      try {
        deepInsightContent = await this.generateDeepInsight({
          entityName,
          entityType,
          observations,
          relations,
          serenaAnalysis
        });
        log(`Generated deep insight content (${deepInsightContent?.length || 0} chars)`, 'info');
      } catch (error) {
        log(`Deep insight generation failed (falling back to basic formatting): ${error}`, 'warning');
      }
    }

    // Synthesize overview from observations (first 2-3 most descriptive)
    const overview = this.synthesizeOverview(entityName, observations);

    // Categorize observations by type
    const categorized = this.categorizeObservations(observations);

    // Build the document sections
    const sections: string[] = [];

    // Header
    sections.push(`# ${entityName}\n`);
    sections.push(`**Type:** ${entityType}\n`);
    sections.push(`${overview}\n`);

    // USE DEEP INSIGHT CONTENT if available (LLM-generated analysis)
    // Otherwise fall back to simple bullet point formatting
    if (deepInsightContent) {
      // Deep insight already contains structured sections
      sections.push(deepInsightContent);
      sections.push('');
    } else {
      // FALLBACK: Simple bullet point formatting
      // What It Is - descriptions and implementations (avoid duplication with How It Works)
      const whatItIsItems = [...categorized.descriptions, ...categorized.implementations];
      if (whatItIsItems.length > 0) {
        sections.push(`## What It Is\n`);
        for (const item of whatItIsItems.slice(0, 4)) {
          sections.push(`- ${item}\n`);
        }
        sections.push('');
      }

      // How It Works - workflows only (not implementations, to avoid duplication)
      if (categorized.workflows.length > 0) {
        sections.push(`## How It Works\n`);
        for (const item of categorized.workflows.slice(0, 5)) {
          sections.push(`- ${item}\n`);
        }
        sections.push('');
      }

      // Other details (remaining uncategorized observations)
      if (categorized.other.length > 0) {
        sections.push(`## Additional Details\n`);
        for (const item of categorized.other.slice(0, 3)) {
          sections.push(`- ${item}\n`);
        }
        sections.push('');
      }

      // Code Structure (from Serena analysis)
      if (serenaAnalysis && (serenaAnalysis.symbols.length > 0 || serenaAnalysis.fileStructures.length > 0)) {
        sections.push(`## Code Structure\n`);
        sections.push(this.serenaAnalyzer.formatCodeStructureSummary(serenaAnalysis));
        sections.push('');
      }

      // Usage / Rules
      if (categorized.rules.length > 0) {
        sections.push(`## Usage Guidelines\n`);
        for (const rule of categorized.rules) {
          sections.push(`- ${rule}\n`);
        }
        sections.push('');
      }

      // Related Entities
      if (relations.length > 0) {
        sections.push(`## Related Entities\n`);
        const outgoing = relations.filter(r => r.from === entityName);
        const incoming = relations.filter(r => r.to === entityName);

        if (outgoing.length > 0) {
          sections.push(`### Dependencies\n`);
          for (const rel of outgoing.slice(0, 10)) {
            sections.push(`- **${rel.to}** (${rel.relationType})\n`);
          }
        }

        if (incoming.length > 0) {
          sections.push(`### Used By\n`);
          for (const rel of incoming.slice(0, 10)) {
            sections.push(`- **${rel.from}** (${rel.relationType})\n`);
          }
        }
        sections.push('');
      }
    }

    // Diagrams section - display all successful diagrams (always shown)
    const successfulDiagrams = diagrams.filter(d => d.success);
    if (successfulDiagrams.length > 0) {
      sections.push(`## Diagrams\n`);

      // Order: architecture first, then sequence, class, use-cases
      const diagramOrder = ['architecture', 'sequence', 'class', 'use-cases'];
      const orderedDiagrams = successfulDiagrams.sort((a, b) =>
        diagramOrder.indexOf(a.type) - diagramOrder.indexOf(b.type)
      );

      for (const diagram of orderedDiagrams) {
        const diagramTitle = diagram.type.charAt(0).toUpperCase() + diagram.type.slice(1).replace('-', ' ');
        sections.push(`### ${diagramTitle}\n`);
        sections.push(`![${entityName} ${diagramTitle}](images/${diagram.name}.png)\n`);
        sections.push('');
      }
    }

    // Footer
    sections.push(`---\n`);
    sections.push(`*Generated from ${observations.length} observations*\n`);

    return sections.join('\n');
  }

  /**
   * Synthesize a concise overview from observations
   */
  private synthesizeOverview(entityName: string, observations: string[]): string {
    // Find the most descriptive observation (longest that's not a rule/command)
    const descriptive = observations
      .filter(obs => !obs.toLowerCase().startsWith('use ') && !obs.toLowerCase().startsWith('never '))
      .sort((a, b) => b.length - a.length)
      .slice(0, 2);

    if (descriptive.length > 0) {
      // Take first 200 chars of the most descriptive observation
      const main = descriptive[0];
      if (main.length > 200) {
        return main.substring(0, 200) + '...';
      }
      return main;
    }

    return `Technical documentation for ${entityName}.`;
  }

  /**
   * Generate deep, meaningful insights from observations using LLM analysis.
   * This produces genuine analysis and understanding rather than just reformatting observations.
   */
  private async generateDeepInsight(params: {
    entityName: string;
    entityType: string;
    observations: string[];
    relations: Array<{ from: string; to: string; relationType: string }>;
    serenaAnalysis: SerenaAnalysisResult | null;
  }): Promise<string> {
    const { entityName, entityType, observations, relations, serenaAnalysis } = params;

    log(`Generating deep insight for ${entityName} with ${observations.length} observations`, 'info');

    // Build a comprehensive prompt for the LLM to analyze
    const observationsText = observations.map((obs, i) => `${i + 1}. ${obs}`).join('\n');

    const relationsText = relations.length > 0
      ? `\n\n**Related Entities:**\n${relations.map(r => `- ${r.from} ${r.relationType} ${r.to}`).join('\n')}`
      : '';

    const codeContextText = serenaAnalysis
      ? `\n\n**Code Structure:**\n- ${serenaAnalysis.symbols.length} code symbols found\n- Key files: ${serenaAnalysis.fileStructures.map(f => f.path).slice(0, 5).join(', ')}`
      : '';

    const prompt = `You are analyzing a knowledge entity called "${entityName}" (type: ${entityType}) to generate a deep, insightful technical document.

**Observations gathered about this entity:**
${observationsText}
${relationsText}
${codeContextText}

**Your task:**
Generate a comprehensive technical insight document that goes BEYOND just restating the observations. Instead:

1. **Synthesize Understanding**: What is this entity really about? What problem does it solve? What is its core purpose?

2. **Architecture & Design**: What architectural decisions are evident? What patterns are being used? What are the trade-offs?

3. **Implementation Details**: How is this implemented? What technologies and approaches are used? What are the key components?

4. **Integration Points**: How does this integrate with other parts of the system? What are the dependencies and interfaces?

5. **Best Practices & Guidelines**: What are the important rules or conventions for using this correctly?

**Format your response as markdown sections (## headers) with meaningful prose paragraphs, not just bullet point lists.
Write in a technical documentation style - clear, precise, and informative.
DO NOT just repeat the observations - ANALYZE and SYNTHESIZE them into coherent understanding.
Each section should provide genuine insight, not just reformatted input.**`;

    try {
      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: 'architecture',
        context: `Deep insight generation for ${entityName}`,
        provider: 'auto'
      });

      if (result && result.insights) {
        // Clean up the response - remove any markdown code blocks if LLM wrapped it
        let content = result.insights;
        if (content.startsWith('```markdown')) {
          content = content.slice(11);
        }
        if (content.startsWith('```')) {
          content = content.slice(3);
        }
        if (content.endsWith('```')) {
          content = content.slice(0, -3);
        }

        log(`Deep insight generated successfully (${content.length} chars, provider: ${result.provider})`, 'info');
        return content.trim();
      }

      log('LLM returned empty insights', 'warning');
      return '';
    } catch (error) {
      log(`Deep insight generation failed: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Categorize observations by their type/intent
   */
  private categorizeObservations(observations: string[]): {
    descriptions: string[];
    implementations: string[];
    workflows: string[];
    rules: string[];
    other: string[];
  } {
    const result = {
      descriptions: [] as string[],
      implementations: [] as string[],
      workflows: [] as string[],
      rules: [] as string[],
      other: [] as string[]
    };

    for (const obs of observations) {
      const lower = obs.toLowerCase();

      // Rules/guidelines
      if (lower.startsWith('use ') || lower.startsWith('never ') ||
          lower.startsWith('always ') || lower.includes('should ') ||
          lower.includes('must ') || lower.includes('not ')) {
        result.rules.push(obs);
      }
      // Implementation details
      else if (lower.includes('uses ') || lower.includes('implements ') ||
               lower.includes('class ') || lower.includes('function ') ||
               lower.includes('method ') || lower.includes('service')) {
        result.implementations.push(obs);
      }
      // Workflow/process
      else if (lower.includes('when ') || lower.includes('then ') ||
               lower.includes('after ') || lower.includes('before ') ||
               lower.includes('flow') || lower.includes('process') ||
               lower.includes('step')) {
        result.workflows.push(obs);
      }
      // General descriptions (longer observations)
      else if (obs.length > 50) {
        result.descriptions.push(obs);
      }
      else {
        result.other.push(obs);
      }
    }

    return result;
  }

  async generateComprehensiveInsights(params: any): Promise<InsightGenerationResult> {
    log('generateComprehensiveInsights called', 'info');
    const startTime = Date.now();

    // ULTRA DEBUG: Write input parameters to trace file
    const insightInputTrace = `${process.cwd()}/logs/insight-generation-input-${Date.now()}.json`;
    await fs.promises.writeFile(insightInputTrace, JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: 'INSIGHT_GENERATION_INPUT',
      params: {
        keys: Object.keys(params || {}),
        fullParams: params
      }
    }, null, 2));
    log(`🔍 TRACE: Insight generation input written to ${insightInputTrace}`, 'info');

    // Extract parameters from the params object
    const gitAnalysis = params.git_analysis_results || params.gitAnalysis;
    const vibeAnalysis = params.vibe_analysis_results || params.vibeAnalysis;
    const semanticAnalysis = params.semantic_analysis_results || params.semanticAnalysis;
    const webResults = params.web_search_results || params.webResults;

    log('Data availability checked', 'debug', {
      gitAnalysis: !!gitAnalysis,
      vibeAnalysis: !!vibeAnalysis,
      semanticAnalysis: !!semanticAnalysis,
      webResults: !!webResults
    });
    
    log('Starting comprehensive insight generation', 'info', {
      receivedParams: Object.keys(params || {}),
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasSemanticAnalysis: !!semanticAnalysis,
      hasWebResults: !!webResults,
      gitCommitCount: gitAnalysis?.commits?.length || 0
    });

    try {
      // Filter git commits to focus on meaningful development work
      // Accept most commits but reject only truly trivial changes
      let filteredGitAnalysis = gitAnalysis;
      if (gitAnalysis?.commits) {
        const originalCommitCount = gitAnalysis.commits.length;
        const significantCommits = gitAnalysis.commits.filter((commit: any) => {
          const msg = commit.message.toLowerCase();
          const changeSize = commit.additions + commit.deletions;

          // Reject only very trivial changes (typos, formatting)
          if (changeSize < 5 && msg.match(/^(style|typo|format):/)) {
            return false;
          }

          // Reject merge commits without meaningful content
          if (msg.startsWith('merge ') && changeSize < 10) {
            return false;
          }

          // Accept all other commits - infrastructure, fixes, features, docs, etc.
          // In infrastructure projects, ALL meaningful work should be analyzed
          return true;
        });

        log(`Filtered commits from ${originalCommitCount} to ${significantCommits.length} meaningful commits`, 'info');

        // Only skip if there are literally no commits at all
        if (significantCommits.length === 0) {
          log('No commits found - skipping pattern extraction', 'info');
          throw new Error('SKIP_INSIGHT_GENERATION: No commits found');
        }

        filteredGitAnalysis = {
          ...gitAnalysis,
          commits: significantCommits
        };
      }

      // Extract patterns from all analyses
      const patternCatalog = await this.generatePatternCatalog(
        filteredGitAnalysis, vibeAnalysis, semanticAnalysis, webResults
      );

      // DEBUGGING: Log all pattern significance scores BEFORE filtering
      log(`\n━━━ SIGNIFICANCE GRADING ANALYSIS ━━━`, 'info');
      log(`Total patterns extracted: ${patternCatalog.patterns.length}`, 'info');

      if (patternCatalog.patterns.length > 0) {
        // Group patterns by significance score for analysis
        const significanceDistribution = patternCatalog.patterns.reduce((acc, p) => {
          const sig = p.significance || 0;
          acc[sig] = (acc[sig] || 0) + 1;
          return acc;
        }, {} as Record<number, number>);

        log(`Significance distribution:`, 'info');
        Object.keys(significanceDistribution)
          .sort((a, b) => Number(b) - Number(a))
          .forEach(sig => {
            const count = significanceDistribution[Number(sig)];
            const bar = '█'.repeat(Math.min(count, 50));
            log(`  ${sig}: ${count} patterns ${bar}`, 'info');
          });

        // Log top 10 patterns with their scores
        log(`\nTop 10 patterns by significance:`, 'info');
        const sortedPatterns = [...patternCatalog.patterns]
          .sort((a, b) => (b.significance || 0) - (a.significance || 0))
          .slice(0, 10);

        sortedPatterns.forEach((p, i) => {
          log(`  ${i + 1}. [${p.significance || 0}] ${p.name} (${p.category})`, 'info');
        });

        // Log patterns that would be filtered out
        const filteredOut = patternCatalog.patterns.filter(p => (p.significance || 0) < 5);
        if (filteredOut.length > 0) {
          log(`\n⚠️  ${filteredOut.length} patterns will be FILTERED OUT (significance < 5):`, 'info');
          filteredOut.slice(0, 5).forEach(p => {
            log(`     [${p.significance || 0}] ${p.name}`, 'info');
          });
          if (filteredOut.length > 5) {
            log(`     ... and ${filteredOut.length - 5} more`, 'info');
          }
        }
      }
      log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`, 'info');

      // Solution 1: Skip insight generation when no real patterns found
      // LOWERED THRESHOLD: Changed from ≥7 to ≥5 to include standard infrastructure patterns
      const significantPatterns = patternCatalog.patterns
        .filter(p => p.significance >= 5) // Include standard significance patterns (was >=7)
        .sort((a, b) => b.significance - a.significance);

      // If no significant patterns found, skip insight generation
      if (significantPatterns.length === 0) {
        log('No significant patterns found - skipping insight generation', 'info');
        log(`DIAGNOSIS: All ${patternCatalog.patterns.length} patterns had significance < 5`, 'error');
        log(`This suggests the significance calculation needs adjustment for this repository type`, 'error');
        throw new Error('SKIP_INSIGHT_GENERATION: No patterns with sufficient significance (≥5) found');
      }

      const insightDocuments: InsightDocument[] = [];

      if (significantPatterns.length >= 1 && significantPatterns.length <= 5) {
        // PERFORMANCE OPTIMIZATION: Generate insights in parallel instead of sequentially
        log(`Generating separate insights for ${significantPatterns.length} significant patterns (≥5 significance) IN PARALLEL`, 'info');
        
        // Create insight generation tasks for parallel execution
        const insightTasks = significantPatterns.map(pattern => {
          const singlePatternCatalog: PatternCatalog = {
            patterns: [pattern],
            summary: {
              totalPatterns: 1,
              byCategory: { [pattern.category]: 1 },
              avgSignificance: pattern.significance,
              topPatterns: [pattern.name]
            }
          };
          
          return this.generateInsightDocument(
            gitAnalysis, vibeAnalysis, semanticAnalysis, singlePatternCatalog, webResults
          );
        });
        
        // Execute all insight generation tasks in parallel
        const parallelResults = await Promise.all(insightTasks);
        insightDocuments.push(...parallelResults);
      } else {
        // Generate single comprehensive insight document
        const insightDocument = await this.generateInsightDocument(
          gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog, webResults
        );
        insightDocuments.push(insightDocument);
      }

      const processingTime = Date.now() - startTime;
      
      // For backward compatibility, use the first document as the main one
      const mainDocument = insightDocuments[0];
      
      const result: InsightGenerationResult = {
        insightDocument: mainDocument,
        insightDocuments, // Include all documents
        patternCatalog,
        generationMetrics: {
          processingTime,
          documentsGenerated: insightDocuments.length,
          diagramsGenerated: insightDocuments.reduce((sum, doc) => 
            sum + doc.diagrams.filter(d => d.success).length, 0),
          patternsIdentified: patternCatalog.patterns.length,
          qualityScore: this.calculateQualityScore(mainDocument, patternCatalog)
        }
      };

      log('Comprehensive insight generation completed', 'info', {
        processingTime,
        documentsGenerated: result.generationMetrics.documentsGenerated,
        diagramsGenerated: result.generationMetrics.diagramsGenerated,
        patternsIdentified: result.generationMetrics.patternsIdentified,
        qualityScore: result.generationMetrics.qualityScore
      });

      return result;

    } catch (error) {
      log('Insight generation failed', 'error', error);
      throw error;
    }
  }

  private async generatePatternCatalog(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    webResults?: any
  ): Promise<PatternCatalog> {
    FilenameTracer.trace('PATTERN_CATALOG_START', 'generatePatternCatalog',
      { hasGit: !!gitAnalysis, hasVibe: !!vibeAnalysis, hasSemantic: !!semanticAnalysis },
      'Starting pattern catalog generation'
    );
    
    const patterns: IdentifiedPattern[] = [];

    // Generate REAL architectural patterns based on actual code analysis
    // This should analyze actual code commits and file changes to identify meaningful patterns
    
    // Analyze git commits for architectural patterns
    try {
      if (gitAnalysis?.commits && gitAnalysis.commits.length > 0) {
        FilenameTracer.trace('EXTRACTING_ARCH_PATTERNS', 'generatePatternCatalog',
          gitAnalysis.commits.length, 'Extracting architectural patterns from commits'
        );
        
        const architecturalPatterns = await this.extractArchitecturalPatternsFromCommits(gitAnalysis.commits);
        
        FilenameTracer.trace('ARCH_PATTERNS_EXTRACTED', 'generatePatternCatalog',
          architecturalPatterns.map(p => p.name), 
          `Extracted ${architecturalPatterns.length} architectural patterns`
        );
        
        patterns.push(...architecturalPatterns);
      }
    } catch (error) {
      console.warn('Error extracting architectural patterns:', error);
    }

    // Analyze code changes for implementation patterns  
    try {
      if (gitAnalysis?.codeEvolution && gitAnalysis.codeEvolution.length > 0) {
        const implementationPatterns = this.extractImplementationPatterns(gitAnalysis.codeEvolution);
        patterns.push(...implementationPatterns);
      }
    } catch (error) {
      console.warn('Error extracting implementation patterns:', error);
    }

    // Analyze semantic code structure for design patterns
    try {
      if (semanticAnalysis?.codeAnalysis) {
        const designPatterns = this.extractDesignPatterns(semanticAnalysis.codeAnalysis);
        patterns.push(...designPatterns);
      }
    } catch (error) {
      console.warn('Error extracting design patterns:', error);
    }

    // Only analyze conversation patterns if they relate to actual code solutions
    try {
      if (vibeAnalysis?.problemSolutionPairs) {
        const codeSolutionPatterns = this.extractCodeSolutionPatterns(vibeAnalysis.problemSolutionPairs);
        patterns.push(...codeSolutionPatterns);
      }
    } catch (error) {
      console.warn('Error extracting solution patterns:', error);
    }

    // Analyze and summarize patterns
    const byCategory: Record<string, number> = {};
    let totalSignificance = 0;

    patterns.forEach(pattern => {
      byCategory[pattern.category] = (byCategory[pattern.category] || 0) + 1;
      totalSignificance += pattern.significance;
    });

    const topPatterns = patterns
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 5)
      .map(p => p.name);

    return {
      patterns,
      summary: {
        totalPatterns: patterns.length,
        byCategory,
        avgSignificance: patterns.length > 0 ? Math.round(totalSignificance / patterns.length) : 0,
        topPatterns
      }
    };
  }

  private generateMeaningfulNameAndTitle(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    patternCatalog: PatternCatalog
  ): { name: string; title: string } {

    FilenameTracer.trace('START', 'generateMeaningfulNameAndTitle',
      { patternsCount: patternCatalog?.patterns?.length },
      'Starting filename generation'
    );

    const topPattern = patternCatalog?.patterns
      ?.sort((a: any, b: any) => b.significance - a.significance)?.[0];

    FilenameTracer.trace('PATTERN_SELECTION', 'generateMeaningfulNameAndTitle',
      {
        allPatterns: patternCatalog?.patterns?.map((p: any) => p.name),
        topPattern: topPattern?.name
      },
      topPattern?.name || 'NO_PATTERN_FOUND'
    );

    let filename: string;

    if (topPattern?.name) {
      FilenameTracer.trace('PATTERN_INPUT', 'generateMeaningfulNameAndTitle',
        topPattern.name,
        'Raw pattern name input'
      );

      // Use actual pattern name directly (no hard-coded fallbacks)
      // Remove spaces and ensure proper casing
      filename = topPattern.name.replace(/\s+/g, '');

      // Ensure it ends with 'Pattern' if not already present
      if (!filename.endsWith('Pattern') && !filename.endsWith('Implementation')) {
        filename += 'Pattern';
      }

      FilenameTracer.trace('PATTERN_NAME_USED', 'generateMeaningfulNameAndTitle',
        topPattern.name, filename
      );
    } else {
      filename = 'SemanticAnalysisPattern';
      FilenameTracer.trace('FALLBACK', 'generateMeaningfulNameAndTitle',
        'NO_PATTERN', filename
      );
    }

    const title = `${filename} - Implementation Analysis`;

    FilenameTracer.trace('FINAL_OUTPUT', 'generateMeaningfulNameAndTitle',
      { originalPattern: topPattern?.name, filename, title },
      { name: filename, title }
    );

    // Add breakpoint opportunity
    debugger; // Will pause here when running with debugger

    return { name: filename, title };
  }


  private async generateInsightDocument(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    patternCatalog: PatternCatalog,
    webResults?: any,
    entityInfo?: { name: string; type: string; observations: string[] },
    relations?: Array<{ from: string; to: string; relationType: string }>
  ): Promise<InsightDocument> {
    // Use entity name if provided, otherwise generate from analysis
    // CONVENTION: .md files use PascalCase (entity name), diagrams use kebab-case
    let name: string;           // PascalCase for .md file
    let diagramBaseName: string; // kebab-case for diagram files
    let title: string;

    if (entityInfo?.name) {
      // .md files use PascalCase (entity name as-is)
      name = entityInfo.name;
      // Diagram files use kebab-case
      diagramBaseName = toKebabCase(entityInfo.name);
      title = entityInfo.name;
      log(`Using entity name for document: ${name} (diagrams: ${diagramBaseName})`, 'info');
    } else {
      // Generate meaningful name based on analysis content
      const generated = this.generateMeaningfulNameAndTitle(
        gitAnalysis,
        vibeAnalysis,
        semanticAnalysis,
        patternCatalog
      );
      name = generated.name;
      diagramBaseName = toKebabCase(generated.name);
      title = generated.title;
    }

    const timestamp = new Date().toISOString();

    // FIX: Validate content generation BEFORE creating diagrams to prevent orphan PNGs
    // This ensures we don't create diagram files if content generation will fail
    log('Pre-validating content generation before diagrams...', 'info');
    let content: string;
    let diagrams: PlantUMLDiagram[] = [];

    try {
      // First, generate content WITHOUT diagrams to validate it will succeed
      content = await this.generateInsightContent({
        title,
        timestamp,
        gitAnalysis,
        vibeAnalysis,
        semanticAnalysis,
        patternCatalog,
        webResults,
        diagrams: [], // Empty initially for validation
        entityInfo,  // NEW: Pass entity info for observation-based generation
        relations    // NEW: Pass relations for entity connections
      });
      log(`Content validation passed, content length: ${content.length}`, 'info');
    } catch (contentError: any) {
      // Content generation failed - don't create any diagrams
      log(`Content validation failed - skipping diagram generation: ${contentError.message}`, 'error');
      throw contentError;
    }

    // Content validated successfully - now generate ONE diagram (simplified)
    // Diagrams use kebab-case naming
    FilenameTracer.trace('DIAGRAM_INPUT', 'generateInsightDocument',
      diagramBaseName, 'Using kebab-case for diagram files'
    );

    try {
      // Generate ALL 4 diagram types for entity refreshes (architecture, sequence, class, use-cases)
      // This ensures comprehensive documentation with multiple perspectives
      diagrams = await this.generateAllDiagrams(diagramBaseName, {
        gitAnalysis,
        vibeAnalysis,
        semanticAnalysis,
        patternCatalog,
        entityInfo  // Pass entity observations for better diagram generation
      });
    } catch (diagramError: any) {
      log(`Diagram generation failed, continuing without diagrams: ${diagramError.message}`, 'warning');
      diagrams = [];
    }

    // Re-generate content with actual diagram references
    log('Regenerating content with diagram references...', 'info');
    content = await this.generateInsightContent({
      title,
      timestamp,
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog,
      webResults,
      diagrams,
      entityInfo,  // NEW: Pass entity info
      relations    // NEW: Pass relations
    });

    console.log('✅ generateInsightContent completed, content length:', content.length);

    // Save the document with tracing
    FilenameTracer.trace('FILE_WRITE_INPUT', 'generateInsightDocument',
      name, 'Filename for file write operation'
    );

    // Use the pattern name directly (no corruption fixes needed)
    FilenameTracer.trace('FILE_PATH_GENERATION', 'generateInsightDocument',
      name, 'Using pattern name directly for file path'
    );

    const filePath = path.join(this.outputDir, `${name}.md`);

    FilenameTracer.trace('FILE_PATH_FINAL', 'generateInsightDocument',
      { name, outputDir: this.outputDir }, filePath
    );

    // Clean up old kebab-case file if it exists (from previous incorrect naming)
    // CONVENTION: .md files should be PascalCase, not kebab-case
    if (entityInfo?.name && diagramBaseName !== entityInfo.name) {
      const oldKebabFilePath = path.join(this.outputDir, `${diagramBaseName}.md`);
      try {
        await fs.promises.access(oldKebabFilePath);
        log(`Removing old kebab-case file: ${oldKebabFilePath}`, 'info');
        await fs.promises.unlink(oldKebabFilePath);
      } catch {
        // Old file doesn't exist, that's fine
      }
    }

    try {
      await fs.promises.writeFile(filePath, content, 'utf8');
      FilenameTracer.trace('FILE_WRITTEN', 'generateInsightDocument',
        filePath, 'File successfully written'
      );
    } catch (writeError: any) {
      // If MD file write fails, clean up orphan diagram files
      console.error('❌ Failed to write MD file, cleaning up diagram files...');
      await this.cleanupOrphanDiagrams(diagrams);
      throw writeError;
    }

    FilenameTracer.printSummary();

    // Calculate significance based on analysis richness
    const significance = this.calculateInsightSignificance(
      gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog
    );

    // Extract analysis types
    const analysisTypes: string[] = [];
    if (gitAnalysis) analysisTypes.push('git-history');
    if (vibeAnalysis) analysisTypes.push('conversation-analysis');
    if (semanticAnalysis) analysisTypes.push('semantic-analysis');
    if (webResults) analysisTypes.push('web-research');

    return {
      name,  // Use actual pattern name from analysis
      title,
      content,
      filePath,
      diagrams,
      metadata: {
        significance,
        tags: ['semantic-analysis', 'comprehensive', ...analysisTypes],
        generatedAt: timestamp,
        analysisTypes,
        patternCount: patternCatalog.patterns.length
      }
    };
  }

  /**
   * Clean up orphan diagram files when insight document creation fails
   */
  private async cleanupOrphanDiagrams(diagrams: PlantUMLDiagram[]): Promise<void> {
    for (const diagram of diagrams) {
      if (diagram.success && diagram.pngFile) {
        try {
          await fs.promises.unlink(diagram.pngFile);
          console.log(`  Cleaned up: ${diagram.pngFile}`);
          // Also try to clean up the PUML source file
          if (diagram.pumlFile) {
            try {
              await fs.promises.unlink(diagram.pumlFile);
              console.log(`  Cleaned up: ${diagram.pumlFile}`);
            } catch {
              // PUML file may not exist, ignore
            }
          }
        } catch (err) {
          console.error(`  Failed to clean up ${diagram.pngFile}:`, err);
        }
      }
    }
  }

  private async generateAllDiagrams(name: string, data: any): Promise<PlantUMLDiagram[]> {
    const diagrams: PlantUMLDiagram[] = [];
    const diagramTypes: PlantUMLDiagram['type'][] = ['architecture', 'sequence', 'use-cases', 'class'];

    // PERFORMANCE OPTIMIZATION: Generate diagrams in parallel instead of sequentially
    log(`Generating ${diagramTypes.length} diagrams IN PARALLEL for ${name}`, 'info');
    
    // Create diagram generation tasks for parallel execution
    const diagramTasks = diagramTypes.map(async (type): Promise<PlantUMLDiagram> => {
      try {
        return await this.generatePlantUMLDiagram(type, name, data);
      } catch (error) {
        // Write error details to file for debugging
        const errorDetails = {
          type,
          name,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
          dataKeys: Object.keys(data || {}),
          dataTypes: data ? Object.keys(data).reduce((acc, key) => ({ ...acc, [key]: typeof data[key] }), {}) : {}
        };
        
        // PERFORMANCE OPTIMIZATION: Use async file operations
        const errorFile = path.join(this.outputDir, 'plantuml_errors.json');
        await fs.promises.writeFile(errorFile, JSON.stringify(errorDetails, null, 2)).catch(e => 
          log('Failed to write error file', 'warning', e)
        );
        
        log(`Failed to generate ${type} diagram`, 'warning', error);
        return {
          type,
          name: `${toKebabCase(name)}-${type}`,
          content: '',
          pumlFile: '',
          success: false
        };
      }
    });
    
    // Execute all diagram generation tasks in parallel and collect results
    const parallelDiagrams = await Promise.all(diagramTasks);
    diagrams.push(...parallelDiagrams);
    
    log(`Completed parallel diagram generation for ${name}: ${diagrams.filter(d => d.success).length}/${diagrams.length} successful`, 'info');

    return diagrams;
  }

  private async generatePlantUMLDiagram(
    type: PlantUMLDiagram['type'],
    name: string,
    data: any
  ): Promise<PlantUMLDiagram> {
    if (!this.plantumlAvailable) {
      return {
        type,
        name: `${toKebabCase(name)}-${type}`,
        content: '',
        pumlFile: '',
        success: false
      };
    }

    let diagramContent = '';
    
    // Try LLM-enhanced diagram generation first
    if (this.semanticAnalyzer) {
      // Extract only relevant data to prevent LLM timeouts from 2MB+ payload
      // FIX: Include entityInfo if present for observation-based diagram generation
      const cleanData: any = {
        patternCatalog: data.patternCatalog || data.semanticAnalysis || data,
        content: `${name} architectural analysis`,
        name: name
      };

      // NEW: Include entityInfo for entity-specific diagrams
      if (data.entityInfo) {
        cleanData.entityInfo = data.entityInfo;
        log(`Including entityInfo with ${data.entityInfo.observations?.length || 0} observations for diagram generation`, 'info');
        // Log first few observations to verify they're being passed
        if (data.entityInfo.observations?.length > 0) {
          log(`First observation: ${data.entityInfo.observations[0]?.substring(0, 100)}...`, 'info');
        }
      } else {
        log(`No entityInfo found in data. Keys: ${Object.keys(data).join(', ')}`, 'warning');
      }

      log(`🔍 DEBUG: Cleaned data for LLM (original size: ${JSON.stringify(data).length}, cleaned size: ${JSON.stringify(cleanData).length})`, 'debug');

      diagramContent = await this.generateLLMEnhancedDiagram(type, cleanData);
    }
    
    // ERROR: No fallback - force debugging of LLM generation failure
    if (!diagramContent) {
      const debugInfo = {
        type,
        dataKeys: Object.keys(data || {}),
        dataTypes: data ? Object.keys(data).reduce((acc, key) => ({ ...acc, [key]: typeof data[key] }), {}) : {},
        semanticAnalyzerExists: !!this.semanticAnalyzer,
        hasData: !!data,
        dataSize: JSON.stringify(data || {}).length
      };
      
      throw new Error(`LLM-enhanced diagram generation failed completely. Debug info: ${JSON.stringify(debugInfo, null, 2)}`);
    }

    // Validate and fix PlantUML content before writing
    let validatedContent = this.validateAndFixPlantUML(diagramContent);
    if (!validatedContent) {
      log(`PlantUML validation failed for ${type} diagram - content has unfixable errors`, 'error');
      return {
        type,
        name: `${toKebabCase(name)}-${type}`,
        content: diagramContent,
        pumlFile: '',
        success: false
      };
    }

    // Write PlantUML file
    const pumlDir = path.join(this.outputDir, 'puml');
    const pumlFile = path.join(pumlDir, `${toKebabCase(name)}-${type}.puml`);

    try {
      await fs.promises.writeFile(pumlFile, validatedContent, 'utf8');

      // Validate with plantuml -checkonly before attempting PNG generation
      const { spawn } = await import('child_process');

      // Run syntax check first
      const checkResult = await new Promise<{ valid: boolean; error?: string }>((resolve) => {
        const check = spawn('plantuml', ['-checkonly', pumlFile]);
        let stderr = '';
        check.stderr?.on('data', (data) => { stderr += data.toString(); });
        check.on('close', (code) => {
          if (code === 0) {
            resolve({ valid: true });
          } else {
            resolve({ valid: false, error: stderr || `Exit code ${code}` });
          }
        });
        check.on('error', (err) => resolve({ valid: false, error: err.message }));
      });

      if (!checkResult.valid) {
        log(`PlantUML syntax check failed for ${pumlFile}: ${checkResult.error}`, 'warning');

        // Attempt LLM-based repair (up to 2 retries)
        let repairedContent = validatedContent;
        let repairAttempt = 0;
        const maxRepairAttempts = 2;

        while (!checkResult.valid && repairAttempt < maxRepairAttempts) {
          repairAttempt++;
          log(`Attempting LLM-based PlantUML repair (attempt ${repairAttempt}/${maxRepairAttempts})`, 'info');

          const repairResult = await this.repairPlantUMLWithLLM(repairedContent, checkResult.error || 'Unknown syntax error', type);

          if (repairResult) {
            repairedContent = repairResult;
            await fs.promises.writeFile(pumlFile, repairedContent, 'utf8');

            // Re-validate
            const recheck = await new Promise<{ valid: boolean; error?: string }>((resolve) => {
              const check = spawn('plantuml', ['-checkonly', pumlFile]);
              let stderr = '';
              check.stderr?.on('data', (d) => { stderr += d.toString(); });
              check.on('close', (code) => {
                resolve(code === 0 ? { valid: true } : { valid: false, error: stderr || `Exit code ${code}` });
              });
              check.on('error', (err) => resolve({ valid: false, error: err.message }));
            });

            if (recheck.valid) {
              log(`✅ PlantUML repair successful on attempt ${repairAttempt}`, 'info');
              checkResult.valid = true;
              checkResult.error = undefined;
            } else {
              log(`PlantUML repair attempt ${repairAttempt} still has errors: ${recheck.error}`, 'warning');
              checkResult.error = recheck.error;
            }
          } else {
            log(`LLM repair attempt ${repairAttempt} returned no result`, 'warning');
            break;
          }
        }

        if (!checkResult.valid) {
          log(`PlantUML repair failed after ${repairAttempt} attempts`, 'warning');
          return {
            type,
            name: `${toKebabCase(name)}-${type}`,
            content: repairedContent,
            pumlFile,
            success: false  // Mark as failed due to unfixable syntax error
          };
        }

        // Update validatedContent with the repaired version for PNG generation
        validatedContent = repairedContent;
      }

      // Generate PNG if PlantUML is available and syntax is valid
      let pngFile: string | undefined;
      try {
        const imagesDir = path.join(this.outputDir, 'images');
        pngFile = path.join(imagesDir, `${toKebabCase(name)}-${type}.png`);

        // Use -tpng to specify PNG output and direct output to correct images directory
        // Use relative path to avoid nested directory creation
        const relativePath = path.relative(path.dirname(pumlFile), imagesDir);
        const plantuml = spawn('plantuml', ['-tpng', pumlFile, '-o', relativePath]);

        await new Promise<void>((resolve, reject) => {
          plantuml.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`PlantUML process exited with code ${code}`));
          });
          plantuml.on('error', reject);
        });

        // Verify PNG was actually created (PlantUML may succeed but not create file)
        if (!fs.existsSync(pngFile)) {
          log(`PlantUML succeeded but PNG not found at ${pngFile}`, 'warning');
          pngFile = undefined;
        }
      } catch (error) {
        log(`Failed to generate PNG for ${type} diagram`, 'warning', error);
        pngFile = undefined;
      }

      return {
        type,
        name: `${toKebabCase(name)}-${type}`,
        content: validatedContent,
        pumlFile,
        pngFile,
        success: true
      };

    } catch (error) {
      log(`Failed to create PlantUML diagram: ${type}`, 'error', error);
      return {
        type,
        name: `${toKebabCase(name)}-${type}`,
        content: validatedContent,
        pumlFile: '',
        success: false
      };
    }
  }

  public async generateLLMEnhancedDiagram(type: PlantUMLDiagram['type'], data: any): Promise<string> {
    if (!this.semanticAnalyzer) {
      log(`🚨 DEBUG: No semanticAnalyzer available for LLM diagram generation`, 'debug');
      return '';
    }

    try {
      // 🔍 TRACE: Log what data we're receiving
      log(`🔍 DEBUG: generateLLMEnhancedDiagram called with:`, 'debug', {
        type,
        dataKeys: Object.keys(data || {}),
        dataTypes: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, typeof v])),
        patternCatalogExists: !!data.patternCatalog,
        patternCount: data.patternCatalog?.patterns?.length || 0,
        dataStringified: JSON.stringify(data, null, 2).substring(0, 500) + '...'
      });
      
      // 🚨 SPECIAL WORKFLOW DEBUG: Log a more detailed breakdown
      console.error(`🔥 WORKFLOW DEBUG: generateLLMEnhancedDiagram for ${type}`);
      console.error(`🔥 Data keys: ${Object.keys(data || {}).join(', ')}`);
      console.error(`🔥 Pattern catalog: ${data.patternCatalog ? 'EXISTS' : 'MISSING'}`);
      console.error(`🔥 Git analysis: ${data.gitAnalysis ? 'EXISTS' : 'MISSING'}`);
      console.error(`🔥 Semantic analyzer: ${this.semanticAnalyzer ? 'EXISTS' : 'MISSING'}`);
      if (data.gitAnalysis) {
        console.error(`🔥 Git commits: ${data.gitAnalysis.commits?.length || 'NO COMMITS'}`);
      }

      const diagramPrompt = this.buildDiagramPrompt(type, data);
      log(`🔍 DEBUG: Built diagram prompt (${diagramPrompt.length} chars)`, 'debug');
      log(`Generating LLM-enhanced ${type} diagram`, 'info');
      
      const analysisResult = await this.semanticAnalyzer.analyzeContent(diagramPrompt, {
        analysisType: 'diagram',
        context: `PlantUML ${type} diagram generation`,
        provider: 'auto'
      });

      // 🔍 TRACE: Log the LLM response
      log(`🔍 DEBUG: LLM response received:`, 'debug', {
        hasAnalysisResult: !!analysisResult,
        provider: analysisResult?.provider,
        hasInsights: !!analysisResult?.insights,
        insightsLength: analysisResult?.insights?.length || 0,
        containsStartuml: analysisResult?.insights?.includes('@startuml') || false,
        insightsPreview: analysisResult?.insights?.substring(0, 200) + '...'
      });

      if (analysisResult?.insights && analysisResult.insights.includes('@startuml')) {
        // Extract PlantUML content from LLM response
        const pumlMatch = analysisResult.insights.match(/@startuml[\s\S]*?@enduml/);
        if (pumlMatch) {
          // Validate and fix common LLM syntax errors before using
          const validatedPuml = this.validateAndFixPlantUML(pumlMatch[0]);
          if (validatedPuml) {
            log(`✅ LLM-enhanced ${type} diagram generated and validated`, 'info', {
              provider: analysisResult.provider,
              contentLength: validatedPuml.length
            });
            return validatedPuml;
          } else {
            log(`❌ LLM diagram had unfixable syntax errors`, 'warning');
          }
        } else {
          log(`🚨 DEBUG: Found @startuml but no valid match in response`, 'debug');
        }
      }
      
      log(`❌ LLM diagram generation failed for ${type} - no valid PlantUML found`, 'warning');
      return '';
    } catch (error) {
      log(`LLM diagram generation failed for ${type}`, 'warning', error);
      return '';
    }
  }

  /**
   * Validate and fix common PlantUML syntax errors from LLM generation.
   * Returns null if the diagram has unfixable errors.
   */
  private validateAndFixPlantUML(puml: string): string | null {
    let fixed = puml;

    // Fix 1: Remove newlines from alias strings (as "X\nY" is invalid syntax)
    // Pattern: as "something\nsomething" -> as "something something"
    fixed = fixed.replace(/as\s+"([^"]*?)\\n([^"]*?)"/g, 'as "$1 $2"');

    // Fix 2: Remove empty node/rectangle bodies like "node X {}"
    // These cause syntax errors - replace with simple node declarations
    fixed = fixed.replace(/\b(node|rectangle|package|frame|folder|database|cloud)\s+"([^"]+)"\s+as\s+"([^"]+)"\s*\{\s*\}/g, '$1 "$2" as $3');
    fixed = fixed.replace(/\b(node|rectangle|package|frame|folder|database|cloud)\s+"([^"]+)"\s*\{\s*\}/g, '$1 "$2"');

    // Fix 3: Remove problematic multi-line string syntax in component aliases
    fixed = fixed.replace(/\s+as\s+"[^"]*\\n[^"]*"/g, (match) => {
      // Just use a simple cleaned-up version without newlines
      return match.replace(/\\n/g, ' ');
    });

    // Fix 4: Missing space after keywords (LLM sometimes generates "participantFoo" instead of "participant Foo")
    // Handle: participant, actor, component, interface, database, entity, boundary, control, collections
    const keywords = ['participant', 'actor', 'component', 'interface', 'database', 'entity', 'boundary', 'control', 'collections', 'queue', 'node', 'rectangle', 'package'];
    for (const keyword of keywords) {
      // Match keyword immediately followed by uppercase letter (no space) - common LLM error
      const regex = new RegExp(`\\b(${keyword})([A-Z][a-zA-Z0-9_]*)\\b`, 'g');
      fixed = fixed.replace(regex, '$1 $2');
    }

    // Fix 5: Inline notes with \n escape sequences - convert to multi-line note blocks
    // Match: note "text with \n in it" -> note as N1 \n text \n end note
    let noteCounter = 1;
    fixed = fixed.replace(/\bnote\s+"([^"]*\\n[^"]*)"/g, (_match, content) => {
      // Expand \n to newlines, then trim and clean up
      const expanded = content.replace(/\\n/g, '\n');
      // Remove leading/trailing whitespace and blank lines
      const lines = expanded.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
      const cleanContent = lines.map((l: string) => `  ${l}`).join('\n');
      const noteId = `AutoNote${noteCounter++}`;
      return `note as ${noteId}\n${cleanContent}\nend note`;
    });

    // Fix 6: Floating notes with \n at end of file - also needs multi-line format
    fixed = fixed.replace(/\bnote\s+"([^"]*)\\n([^"]*)"/g, (_match, part1, part2) => {
      const noteId = `AutoNote${noteCounter++}`;
      const trimmedPart1 = part1.trim();
      const trimmedPart2 = part2.trim();
      // Only include non-empty parts
      const parts = [trimmedPart1, trimmedPart2].filter(p => p.length > 0);
      const cleanContent = parts.map(p => `  ${p}`).join('\n');
      return `note as ${noteId}\n${cleanContent}\nend note`;
    });

    // Fix 7: Standalone notes without position - LLM generates 'note "text"' which is invalid
    // Must be either 'note right of X "text"' or 'note as N1 ... end note'
    // Convert to floating note block format
    fixed = fixed.replace(/^(\s*)note\s+"([^"]+)"(\s*)$/gm, (_match, leadingWs, content, trailingWs) => {
      const noteId = `AutoNote${noteCounter++}`;
      const trimmedContent = content.trim();
      if (trimmedContent.length === 0) return ''; // Skip empty notes entirely
      return `${leadingWs}note as ${noteId}\n${leadingWs}  ${trimmedContent}\n${leadingWs}end note${trailingWs}`;
    });

    // Fix 8: Invalid 'end note as X' syntax - should just be 'end note'
    // LLM sometimes generates 'end note as noteId' which is invalid
    fixed = fixed.replace(/\bend\s+note\s+as\s+\w+/g, 'end note');

    // Fix 9: Component blocks with class-style member lists (+ method, - field)
    // PlantUML components don't support member definitions - only classes do
    // Remove lines inside component blocks that start with +, -, #, ~
    fixed = fixed.replace(/(\bcomponent\s+[^\{]+\{)([^}]*?)(\})/g, (_match, open, body, close) => {
      // Remove member definition lines (lines starting with +, -, #, ~ after whitespace)
      const cleanedBody = body.replace(/^\s*[+\-#~]\s+[^\n]+$/gm, '');
      // Also remove resulting empty lines
      const trimmedBody = cleanedBody.replace(/\n\s*\n/g, '\n');
      return open + trimmedBody + close;
    });

    // Fix 10: Clean up blank lines inside existing note blocks (note as X ... end note)
    // Non-sequence diagrams can use floating notes with `note as X ... end note`
    fixed = fixed.replace(/(\bnote\s+as\s+\w+)\n([\s\S]*?)\n(\s*end\s+note)/g, (_match, noteStart, noteBody, noteEnd) => {
      // Split body into lines, trim each, filter empty, rejoin with proper indentation
      const lines = noteBody.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
      const cleanedBody = lines.map((l: string) => `  ${l}`).join('\n');
      return `${noteStart}\n${cleanedBody}\n${noteEnd}`;
    });

    // Fix 11: Sequence diagram floating notes - convert `note as X ... end note` to `note over`
    // Sequence diagrams do NOT support `note as X` syntax - must be attached to participant
    // Detect sequence diagrams by presence of participant/actor declarations and ->> or -> arrows
    const isSequenceDiagram = /\b(participant|actor)\b/.test(fixed) && /->/.test(fixed);
    if (isSequenceDiagram) {
      // Find the first participant declared to attach notes to
      const participantMatch = fixed.match(/\b(?:participant|actor)\s+(\w+)/);
      const firstParticipant = participantMatch ? participantMatch[1] : 'Unknown';

      // Convert floating note blocks to note over syntax
      fixed = fixed.replace(/\bnote\s+as\s+\w+\n([\s\S]*?)\nend\s+note/g, (_match, noteBody) => {
        const lines = noteBody.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
        const noteText = lines.join(' ');
        return `note over ${firstParticipant}: ${noteText}`;
      });
    }

    // Validate: Must have both start and end tags
    if (!fixed.includes('@startuml') || !fixed.includes('@enduml')) {
      log('PlantUML validation failed: missing @startuml/@enduml tags', 'warning');
      return null;
    }

    // Validate: Check for common unbalanced structures
    const openBraces = (fixed.match(/\{/g) || []).length;
    const closeBraces = (fixed.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      log(`PlantUML validation failed: unbalanced braces (${openBraces} open, ${closeBraces} close)`, 'warning');
      return null;
    }

    return fixed;
  }

  /**
   * Attempt to repair a PlantUML diagram using LLM when regex-based fixes fail.
   * The LLM receives the broken PUML content plus the specific error message from PlantUML,
   * enabling it to make targeted fixes based on the actual syntax error.
   */
  private async repairPlantUMLWithLLM(
    brokenPuml: string,
    errorMessage: string,
    diagramType: PlantUMLDiagram['type']
  ): Promise<string | null> {
    try {
      const repairPrompt = `You are a PlantUML syntax expert. A PlantUML ${diagramType} diagram has a syntax error.

**ERROR FROM PLANTUML:**
${errorMessage}

**BROKEN PLANTUML CONTENT:**
\`\`\`plantuml
${brokenPuml}
\`\`\`

**YOUR TASK:**
Fix the syntax error and return ONLY the corrected PlantUML code. No explanations.

**COMMON FIXES FOR ${diagramType.toUpperCase()} DIAGRAMS:**
${diagramType === 'sequence' ? `
- Sequence diagrams do NOT support 'note as X ... end note' floating notes
- Use 'note over Participant: text' or 'note right of Participant: text' instead
- Ensure all participants are declared before use
- Arrow syntax: -> for solid, --> for dashed, ->> for async` : ''}
${diagramType === 'architecture' ? `
- Use proper component/package nesting
- Notes inside packages use 'note as X ... end note' format
- Ensure braces { } are balanced` : ''}
${diagramType === 'class' ? `
- Class members use +public, -private, #protected prefixes
- Relationships: --|> extends, ..|> implements, --> association` : ''}
${diagramType === 'use-cases' ? `
- Actors are defined with 'actor Name'
- Use cases are defined with 'usecase "Name" as UC1' or '(Name)'
- Relationships: --> for association` : ''}

**CRITICAL RULES:**
1. Keep the same @startuml and @enduml tags
2. Keep the !include line for the style sheet unchanged
3. Do NOT add skinparam - styles come from the include
4. Return ONLY valid PlantUML code starting with @startuml

Return the fixed PlantUML code now:`;

      const repairResult = await this.semanticAnalyzer.analyzeContent(repairPrompt, {
        analysisType: 'code',  // Use 'code' for syntax-focused task
        context: `PlantUML ${diagramType} diagram repair`,
        provider: 'auto'
      });

      if (repairResult?.insights) {
        // Extract the PUML from the response
        const pumlMatch = repairResult.insights.match(/@startuml[\s\S]*?@enduml/);
        if (pumlMatch) {
          // Apply regex fixes to the LLM output as well (belt and suspenders)
          const repairedAndValidated = this.validateAndFixPlantUML(pumlMatch[0]);
          if (repairedAndValidated) {
            log(`LLM repair produced valid PlantUML`, 'info', {
              originalLength: brokenPuml.length,
              repairedLength: repairedAndValidated.length,
              provider: repairResult.provider
            });
            return repairedAndValidated;
          }
        }
        log(`LLM repair response did not contain valid PlantUML block`, 'warning');
      }

      return null;
    } catch (error) {
      log(`LLM PlantUML repair failed`, 'warning', error);
      return null;
    }
  }

  private buildDiagramPrompt(type: PlantUMLDiagram['type'], data: any): string {
    const patternCount = data.patternCatalog?.patterns?.length || 0;

    // NEW: Check if we have entity observations to use instead of generic pattern data
    const entityInfo = data.entityInfo;
    const hasEntityObservations = entityInfo?.observations && entityInfo.observations.length > 0;

    log(`buildDiagramPrompt: hasEntityObservations=${hasEntityObservations}, observationCount=${entityInfo?.observations?.length || 0}`, 'info');

    // Build context based on available data - prefer entity observations
    let analysisContext: string;
    if (hasEntityObservations) {
      // Entity-specific diagram: use observations to understand the actual architecture
      analysisContext = `**Entity:** ${entityInfo.name}
**Type:** ${entityInfo.type || 'Pattern'}

**Observations (use these to understand the architecture):**
${entityInfo.observations.map((obs: string, i: number) => `${i + 1}. ${obs}`).join('\n')}`;
    } else {
      // Fallback to generic analysis data
      analysisContext = `**Analysis Data:**
${JSON.stringify(data, null, 2)}`;
    }

    let prompt = `Generate a professional PlantUML ${type} diagram based on the following:

${analysisContext}

**CRITICAL REQUIREMENTS (MUST FOLLOW EXACTLY):**
1. Start with @startuml on the first line
2. IMMEDIATELY after @startuml (on the SECOND line), include this EXACT line:
   !include /Users/q284340/Agentic/coding/docs/puml/_standard-style.puml
3. Do NOT define any skinparam settings - the style sheet handles all styling
4. Use proper PlantUML syntax for the diagram type
5. Make the diagram visually clear and informative
6. Include meaningful relationships and annotations
7. End with @enduml on the last line

**Example structure:**
\`\`\`
@startuml
!include /Users/q284340/Agentic/coding/docs/puml/_standard-style.puml

' Your diagram content here (NO skinparam definitions)

@enduml
\`\`\``;

    if (type === 'architecture') {
      if (hasEntityObservations) {
        // Entity-specific architecture diagram instructions
        prompt += `

**Architecture Diagram Specifics for "${entityInfo.name}":**
- Extract ACTUAL components mentioned in the observations (e.g., GraphDatabase, LevelDB, MCP tools, agents, etc.)
- Show these real components as PlantUML components with appropriate stereotypes
- Use stereotypes like <<storage>> for databases, <<api>> for interfaces, <<core>> for main logic, <<agent>> for agents
- Show relationships between components based on what the observations describe
- Group related components into meaningful packages
- Include a brief summary note about the entity's purpose
- PREFER vertical layout (top-to-bottom) over horizontal to avoid excessive width
- DO NOT use generic placeholder names - use the actual names from the observations`;
      } else {
        prompt += `

**Architecture Diagram Specifics:**
- Show ${patternCount} identified patterns as components
- Group related patterns into packages by category
- Use stereotypes like <<api>>, <<core>>, <<storage>>, <<agent>> for different component types (defined in style sheet)
- Show relationships between related components
- Include a summary note with key metrics
- Use component diagram syntax with packages, components, and interfaces
- PREFER vertical layout (top-to-bottom) over horizontal to avoid excessive width`;
      }

    } else if (type === 'class') {
      prompt += `

**Class Diagram Specifics:**
- Create classes representing the main architectural patterns
- Show inheritance and composition relationships
- Include key methods and properties where relevant
- Group related classes into packages
- Use proper UML class diagram syntax
- Show dependencies and associations between classes
- PREFER vertical layout to avoid excessive width

**VALID class diagram elements ONLY:**
- class ClassName { ... } - for classes
- interface InterfaceName { ... } - for interfaces
- enum EnumName { ... } - for enumerations
- abstract class AbstractName { ... } - for abstract classes
- package "Name" { ... } - for grouping
- <<stereotype>> - for stereotypes like <<service>>, <<file>>, <<interface>>
- Relationships: --|>, ..|>, --*, --o, -->, ..>

**DO NOT USE these elements (they are for OTHER diagram types):**
- folder, artifact, node, component, database, cloud, queue, storage
- rectangle (use package instead for grouping)
- These are deployment/component elements and will cause syntax errors

**Syntax rules:**
- Property/field names must NOT contain spaces (use camelCase)
- Example: -databaseAdapter: Type (correct), NOT: -database Adapter: Type (wrong)`;

    } else if (type === 'sequence') {
      prompt += `

**Sequence Diagram Specifics:**
- Show interaction between key components/actors
- Use proper participant declarations
- Show meaningful message exchanges
- Group related sequences with alt/opt/loop blocks where appropriate
- Keep diagram focused and readable`;

    } else if (type === 'use-cases') {
      prompt += `

**Use Case Diagram Specifics:**
- Define clear actors (users, systems)
- Show use cases as ovals
- Show include/extend relationships where appropriate
- Group related use cases with rectangles/packages
- Keep actor relationships clear`;
    }

    prompt += `

**Output Format:** Valid PlantUML code only, starting with @startuml and ending with @enduml. No explanatory text outside the diagram. The SECOND LINE must be the !include directive.`;

    return prompt;
  }

  private generateArchitectureDiagram(data: any): string {
    const patterns = data.patternCatalog?.patterns || [];
    
    // If no patterns found, create a meaningful default based on git/semantic analysis
    if (patterns.length === 0) {
      return this.generateDefaultArchitectureDiagram(data);
    }
    
    // Enhanced architecture diagram with better component relationships
    let components = '';
    let relationships = '';
    
    // Group patterns by category for better organization
    const patternsByCategory: Record<string, any[]> = {};
    patterns.slice(0, 15).forEach((pattern: any) => {
      const category = pattern.category || 'General';
      if (!patternsByCategory[category]) {
        patternsByCategory[category] = [];
      }
      patternsByCategory[category].push(pattern);
    });

    // Generate components grouped by category with better naming
    Object.entries(patternsByCategory).forEach(([category, categoryPatterns]) => {
      components += `\n  package "${category}" {\n`;
      categoryPatterns.forEach((pattern, index) => {
        const significance = pattern.significance || 5;
        const style = significance >= 8 ? '<<critical>>' : significance >= 6 ? '<<important>>' : '<<standard>>';
        const cleanName = pattern.name.replace(/Pattern$/, '').replace(/Implementation$/, '');
        const componentId = `${category.replace(/\s+/g, '')}_${index}`;
        components += `    component "${cleanName}" as ${componentId} ${style}\n`;
      });
      components += `  }\n`;
    });

    // Generate meaningful relationships based on actual analysis
    if (data.gitAnalysis || data.semanticAnalysis) {
      // Add cross-analysis relationships
      const categories = Object.keys(patternsByCategory);
      if (categories.includes('Architecture') && categories.includes('Implementation')) {
        relationships += `  Architecture_0 ..> Implementation_0 : guides\n`;
      }
      if (categories.includes('Design') && categories.includes('Implementation')) {
        relationships += `  Design_0 --> Implementation_0 : implements\n`;
      }
    }

    const totalPatterns = patterns.length;
    const avgSignificance = patterns.reduce((sum: number, p: any) => sum + (p.significance || 5), 0) / totalPatterns || 0;
    const gitCommits = data.gitAnalysis?.commits?.length || 0;
    const conversations = data.vibeAnalysis?.sessions?.length || 0;

    return `@startuml
${this.getStandardStyle()}

title Repository Pattern Analysis - System Architecture

${components}

${relationships}

note top of ${Object.keys(patternsByCategory)[0]?.replace(/\s+/g, '') || 'General'}_0
  Analysis Summary:
  - Total Patterns: ${totalPatterns}
  - Avg Significance: ${avgSignificance.toFixed(1)}/10
  - Git Commits: ${gitCommits}
  - Conversations: ${conversations}
  
  Legend:
  <<critical>> High Impact (8-10)
  <<important>> Medium Impact (6-7)  
  <<standard>> Standard Impact (1-5)
end note

@enduml`;
  }

  private generateDefaultArchitectureDiagram(data: any): string {
    // Create meaningful architecture even without patterns
    const gitCommits = data.gitAnalysis?.commits?.length || 0;
    const semanticFiles = data.semanticAnalysis?.codeAnalysis?.filesAnalyzed || 0;
    const conversations = data.vibeAnalysis?.sessions?.length || 0;

    let components = `
  package "Code Repository" {
    component "Git History" as git <<important>>
    component "Source Files" as files <<standard>>
  }

  package "Analysis Results" {
    component "Semantic Analysis" as semantic <<important>>`;
    
    if (conversations > 0) {
      components += `\n    component "Conversation Analysis" as conversations <<standard>>`;
    }
    
    components += `\n  }

  package "Generated Insights" {
    component "Pattern Catalog" as patterns <<critical>>
    component "Documentation" as docs <<standard>>
  }`;

    const relationships = `
  git --> semantic : analyzes
  files --> semantic : processes
  semantic --> patterns : generates`;

    const additionalRel = conversations > 0 ? `\n  conversations --> patterns : enriches` : '';

    return `@startuml
${this.getStandardStyle()}

title System Architecture - Analysis Pipeline

${components}

${relationships}${additionalRel}
  patterns --> docs : produces

note right of patterns
  Analysis Results:
  - Git Commits: ${gitCommits}
  - Files Analyzed: ${semanticFiles} 
  - Conversations: ${conversations}
  - Generated: ${new Date().toISOString().split('T')[0]}
end note

@enduml`;
  }

  private generateSequenceDiagram(data: any): string {
    const patternCount = data.patternCatalog?.patterns?.length || 0;
    const avgSignificance = data.patternCatalog?.summary?.avgSignificance || 0;
    const gitCommits = data.gitAnalysis?.commits?.length || 0;
    const vibeData = data.vibeAnalysis?.sessions?.length || 0;
    const topPattern = data.patternCatalog?.patterns?.sort((a: any, b: any) => b.significance - a.significance)[0];

    // Generate meaningful sequence based on the actual analysis performed
    const title = topPattern ? `${topPattern.name} Implementation Flow` : 'Repository Pattern Analysis Flow';

    return `@startuml
${this.getStandardStyle()}

title ${title}

actor "Developer" as dev
participant "Repository Layer" as repo
participant "Service Layer" as service  
participant "Data Access" as data
participant "Business Logic" as logic
participant "UI Components" as ui

dev -> repo: Request data operation
activate repo

repo -> data: validateRequest()
activate data
data --> repo: validation result
deactivate data

alt successful validation
  repo -> data: executeQuery()
  activate data
  data --> repo: raw data
  deactivate data
  
  repo -> service: processData()
  activate service
  service -> logic: applyBusinessRules()
  activate logic
  logic --> service: processed result
  deactivate logic
  service --> repo: formatted data
  deactivate service
  
  repo --> dev: structured result
else validation failed
  repo --> dev: error response
end

deactivate repo

dev -> ui: updateInterface()
activate ui
ui -> repo: getLatestData()
activate repo
repo --> ui: current state
deactivate repo
ui --> dev: interface updated
deactivate ui

note right of repo
  Pattern Implementation:
  - ${topPattern?.name || 'Repository Pattern'}
  - Significance: ${topPattern?.significance || 'N/A'}/10
  - Files: ${gitCommits} commits analyzed
  - Confidence: ${topPattern?.evidence?.[0] || 'High confidence'}
end note

note right of service
  Analysis Results:
  - Patterns: ${patternCount}
  - Avg Score: ${avgSignificance.toFixed(1)}/10
  - Code Quality: Processing
end note

@enduml`;
  }

  private generateUseCasesDiagram(data: any): string {
    const patterns = data.patternCatalog?.patterns || [];
    const gitCommits = data.gitAnalysis?.commits?.length || 0;
    const topPattern = patterns.sort((a: any, b: any) => b.significance - a.significance)[0];
    const patternType = topPattern?.category || 'Pattern';
    
    // Generate meaningful use cases based on actual analysis data
    const useCases = [];
    const actorConnections = [];
    
    // Core use cases based on patterns found
    if (topPattern?.name.toLowerCase().includes('repository')) {
      useCases.push(`  usecase "Implement Repository Pattern" as UC1`);
      useCases.push(`  usecase "Encapsulate Data Access" as UC2`);
      useCases.push(`  usecase "Separate Business Logic" as UC3`);
      actorConnections.push(`Developer --> UC1`);
      actorConnections.push(`Developer --> UC2`);
      actorConnections.push(`Architect --> UC1`);
      actorConnections.push(`Architect --> UC3`);
    } else {
      useCases.push(`  usecase "Apply ${topPattern?.name || 'Design Pattern'}" as UC1`);
      useCases.push(`  usecase "Improve Code Structure" as UC2`);
      useCases.push(`  usecase "Enhance Maintainability" as UC3`);
      actorConnections.push(`Developer --> UC1`);
      actorConnections.push(`Developer --> UC2`);
      actorConnections.push(`Architect --> UC3`);
    }
    
    // Additional use cases based on available data
    if (gitCommits > 0) {
      useCases.push(`  usecase "Track Code Evolution" as UC4`);
      actorConnections.push(`Lead --> UC4`);
    }
    
    if (patterns.length > 1) {
      useCases.push(`  usecase "Manage Pattern Dependencies" as UC5`);
      actorConnections.push(`Architect --> UC5`);
    }
    
    useCases.push(`  usecase "Generate Documentation" as UC6`);
    useCases.push(`  usecase "Validate Implementation" as UC7`);
    actorConnections.push(`Lead --> UC6`);
    actorConnections.push(`QA --> UC7`);

    // Add relationships between use cases
    const relationships = [];
    if (useCases.length >= 3) {
      relationships.push(`UC1 ..> UC2 : includes`);
      relationships.push(`UC2 ..> UC3 : enables`);
    }
    if (useCases.length >= 6) {
      relationships.push(`UC1 ..> UC6 : generates`);
      relationships.push(`UC3 ..> UC7 : requires`);
    }

    return `@startuml
${this.getStandardStyle()}

title ${topPattern?.name || 'Repository Pattern'} Use Cases

left to right direction

actor Developer
actor "Team Lead" as Lead  
actor "Architect" as Architect
actor "QA Engineer" as QA

package "${topPattern?.name || 'Pattern'} Implementation" {
${useCases.join('\n')}
}

${actorConnections.join('\n')}

${relationships.join('\n')}

note top of UC1
  Pattern: ${topPattern?.name || 'Repository Pattern'}
  Significance: ${topPattern?.significance || 'N/A'}/10
  Category: ${topPattern?.category || 'Design'}
  Files Analyzed: ${gitCommits}
end note

note bottom of UC6
  Generated Artifacts:
  - Pattern documentation
  - Architecture diagrams  
  - Implementation guide
  - Quality metrics
end note

@enduml`;
  }

  private generateClassDiagram(data: any): string {
    return `@startuml
${this.getStandardStyle()}

title Semantic Analysis Class Structure

class GitHistoryAgent {
  +analyzeGitHistory()
  +extractArchitecturalDecisions()
  +trackCodeEvolution()
}

class VibeHistoryAgent {
  +analyzeConversations()
  +extractProblemSolutionPairs()
  +identifyPatterns()
}

class SemanticAnalysisAgent {
  +correlateAnalyses()
  +generateInsights()
  +assessCodeQuality()
}

class InsightGenerationAgent {
  +generateComprehensiveInsights()
  +createPatternCatalog()
  +generateDocumentation()
}

GitHistoryAgent --> SemanticAnalysisAgent
VibeHistoryAgent --> SemanticAnalysisAgent
SemanticAnalysisAgent --> InsightGenerationAgent

@enduml`;
  }

  private async generateInsightContent(data: any): Promise<string> {
    const {
      title,
      timestamp,
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog,
      webResults,
      diagrams,
      // NEW: Entity-specific data for observation-based generation
      entityInfo,
      relations
    } = data;

    // CHECK: If we have entity observations, use the new technical documentation approach
    // This prioritizes actual entity data over generic git/vibe analysis
    if (entityInfo?.observations && entityInfo.observations.length > 0) {
      log(`Using observation-based documentation for ${entityInfo.name} (${entityInfo.observations.length} observations)`, 'info');

      // Pass all successful diagrams to the documentation generator
      const successfulDiagrams = diagrams?.filter((d: PlantUMLDiagram) => d.success)
        .map((d: PlantUMLDiagram) => ({ name: d.name, type: d.type, success: d.success })) || [];

      return await this.generateTechnicalDocumentation({
        entityName: entityInfo.name,
        entityType: entityInfo.type || 'Pattern',
        observations: entityInfo.observations,
        relations: relations || [],
        diagrams: successfulDiagrams
      });
    }

    // FALLBACK: Legacy content-agnostic analysis (for backward compatibility)
    log('No entity observations found, falling back to content-agnostic analysis', 'info');

    let contentInsight;
    try {
      contentInsight = await this.contentAnalyzer.analyzeWithContext(
        gitAnalysis, vibeAnalysis, semanticAnalysis
      );
    } catch (error: any) {
      log(`Content analysis failed: ${error.message}`, 'error');
      throw error;
    }

    // Get repository context for specific details
    const repositoryContext = await this.contextManager.getRepositoryContext();

    // Determine main pattern for title
    const mainPattern = patternCatalog?.patterns?.sort((a: any, b: any) => b.significance - a.significance)[0];
    const patternName = mainPattern?.name || this.generateContextualPatternName(contentInsight, repositoryContext);

    const patternType = this.determinePatternType(contentInsight, repositoryContext);
    const significance = contentInsight.significance;

    // SIMPLIFIED FALLBACK TEMPLATE (less verbose than before)
    return `# ${patternName}

**Type:** ${patternType}

${contentInsight.problem.description}

## Implementation

${contentInsight.solution.approach}

${contentInsight.solution.implementation.map((impl: string) => `- ${impl}`).join('\n')}

## Technologies

${contentInsight.solution.technologies.map((tech: string) => `- ${tech}`).join('\n')}

${diagrams?.find((d: PlantUMLDiagram) => d.type === 'architecture' && d.success) ?
  `## Architecture\n\n![Architecture](images/${diagrams.find((d: PlantUMLDiagram) => d.type === 'architecture' && d.success)?.name}.png)\n` : ''}

---
*Generated via fallback analysis*`;
  }


  // Helper methods for content generation
  private generateExecutiveSummary(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any, patternCatalog: PatternCatalog): string {
    const parts = [];
    
    if (gitAnalysis) {
      parts.push(`**Git Analysis:** Examined ${gitAnalysis.commits?.length || 0} commits revealing ${gitAnalysis.architecturalDecisions?.length || 0} architectural decisions.`);
    }
    
    if (vibeAnalysis) {
      parts.push(`**Conversation Analysis:** Analyzed ${vibeAnalysis.sessions?.length || 0} sessions identifying ${vibeAnalysis.problemSolutionPairs?.length || 0} problem-solution patterns.`);
    }
    
    if (semanticAnalysis) {
      parts.push(`**Semantic Analysis:** Processed code structure revealing ${semanticAnalysis.codeAnalysis?.architecturalPatterns?.length || 0} architectural patterns.`);
    }
    
    parts.push(`**Pattern Identification:** Discovered ${patternCatalog.patterns.length} distinct patterns with average significance of ${patternCatalog.summary.avgSignificance}/10.`);
    
    return parts.join(' ');
  }

  private generateKeyInsights(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any, patternCatalog: PatternCatalog): string {
    const insights = [];
    
    // Top patterns by significance
    const topPatterns = patternCatalog.patterns
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 5);
    
    if (topPatterns.length > 0) {
      insights.push(`**Top Pattern**: ${topPatterns[0].name} - ${topPatterns[0].description} (Significance: ${topPatterns[0].significance}/10)`);
    }
    
    // Development focus from vibe analysis
    if (vibeAnalysis?.summary?.primaryFocus) {
      insights.push(`**Development Focus**: ${vibeAnalysis.summary.primaryFocus} emerged as the primary development theme`);
    }
    
    // Code quality from semantic analysis
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.score) {
      insights.push(`**Code Quality**: Overall quality score of ${semanticAnalysis.codeAnalysis.codeQuality.score}/100 with ${semanticAnalysis.codeAnalysis.codeQuality.issues.length} identified issues`);
    }
    
    // Cross-analysis correlation
    if (gitAnalysis && vibeAnalysis) {
      insights.push(`**Alignment**: Strong correlation observed between git activity patterns and conversation development themes`);
    }
    
    return insights.length > 0 ? insights.map(insight => `- ${insight}`).join('\n') : '- No key insights identified';
  }

  private formatPatternCatalog(patternCatalog: PatternCatalog): string {
    if (patternCatalog.patterns.length === 0) {
      return 'No patterns identified in the current analysis.';
    }

    let output = `**Pattern Summary:**
- Total Patterns: ${patternCatalog.summary.totalPatterns}
- Average Significance: ${patternCatalog.summary.avgSignificance}/10
- Pattern Categories: ${Object.keys(patternCatalog.summary.byCategory).join(', ')}

**Detailed Patterns:**

`;

    patternCatalog.patterns
      .sort((a, b) => b.significance - a.significance)
      .forEach((pattern, index) => {
        output += `### ${index + 1}. ${pattern.name}

**Category:** ${pattern.category}  
**Significance:** ${pattern.significance}/10  
**Description:** ${pattern.description}

**Evidence:**
${pattern.evidence.map(e => `- ${e}`).join('\n')}

**Implementation Notes:**
- Language: ${pattern.implementation.language}
${pattern.implementation.usageNotes.map(note => `- ${note}`).join('\n')}

---

`;
      });

    return output;
  }

  // Additional helper methods for various content sections
  private generateTechnicalFindings(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): string {
    const findings = [];
    
    if (semanticAnalysis?.codeAnalysis?.complexityMetrics) {
      const metrics = semanticAnalysis.codeAnalysis.complexityMetrics;
      findings.push(`**Code Complexity:** Average complexity of ${metrics.averageComplexity} with ${metrics.highComplexityFiles.length} high-complexity files`);
      findings.push(`**Function Analysis:** ${metrics.totalFunctions} functions analyzed across ${semanticAnalysis.codeAnalysis.filesAnalyzed} files`);
    }
    
    if (semanticAnalysis?.codeAnalysis?.languageDistribution) {
      const languages = Object.entries(semanticAnalysis.codeAnalysis.languageDistribution)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .slice(0, 3)
        .map(([lang, count]) => `${lang}: ${count}`);
      findings.push(`**Language Distribution:** ${languages.join(', ')}`);
    }
    
    return findings.length > 0 ? findings.map(f => `- ${f}`).join('\n') : '- No specific technical findings to report';
  }

  private generateArchitectureInsights(gitAnalysis: any, semanticAnalysis: any): string {
    const insights = [];
    
    if (gitAnalysis?.architecturalDecisions) {
      const decisions = gitAnalysis.architecturalDecisions;
      const highImpactDecisions = decisions.filter((d: any) => d.impact === 'high').length;
      insights.push(`**Architectural Decisions:** ${decisions.length} total decisions with ${highImpactDecisions} high-impact changes`);
    }
    
    if (semanticAnalysis?.codeAnalysis?.architecturalPatterns) {
      const patterns = semanticAnalysis.codeAnalysis.architecturalPatterns;
      const topPattern = patterns.sort((a: any, b: any) => b.confidence - a.confidence)[0];
      if (topPattern) {
        insights.push(`**Dominant Pattern:** ${topPattern.name} with ${Math.round(topPattern.confidence * 100)}% confidence`);
      }
    }
    
    return insights.length > 0 ? insights.map(i => `- ${i}`).join('\n') : '- No architectural insights available';
  }

  private generateDevelopmentProcessAnalysis(vibeAnalysis: any): string {
    if (!vibeAnalysis) return '- No conversation analysis data available';
    
    const insights = [];
    
    if (vibeAnalysis.summary) {
      insights.push(`**Primary Focus:** ${vibeAnalysis.summary.primaryFocus}`);
      insights.push(`**Total Exchanges:** ${vibeAnalysis.summary.totalExchanges} across ${vibeAnalysis.sessions?.length || 0} sessions`);
    }
    
    if (vibeAnalysis.patterns?.toolUsage) {
      const topTool = vibeAnalysis.patterns.toolUsage[0];
      if (topTool) {
        insights.push(`**Most Used Tool:** ${topTool.tool} (${topTool.frequency} uses)`);
      }
    }
    
    if (vibeAnalysis.patterns?.developmentThemes) {
      const themes = vibeAnalysis.patterns.developmentThemes.slice(0, 3).map((t: any) => t.theme);
      insights.push(`**Key Themes:** ${themes.join(', ')}`);
    }
    
    return insights.map(i => `- ${i}`).join('\n');
  }

  private generateCrossAnalysisInsights(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): string {
    const insights = [];
    
    if (gitAnalysis && vibeAnalysis) {
      insights.push('- Git commit patterns align with conversation development themes, indicating consistent focus');
    }
    
    if (semanticAnalysis?.crossAnalysisInsights) {
      const crossInsights = semanticAnalysis.crossAnalysisInsights;
      if (crossInsights.gitCodeCorrelation?.length > 0) {
        insights.push(`- ${crossInsights.gitCodeCorrelation.length} correlations found between git patterns and code structure`);
      }
      if (crossInsights.vibeCodeCorrelation?.length > 0) {
        insights.push(`- ${crossInsights.vibeCodeCorrelation.length} correlations found between conversations and implementation`);
      }
    }
    
    return insights.length > 0 ? insights.join('\n') : '- Cross-analysis correlations not available';
  }

  private generateQualityAssessment(semanticAnalysis: any): string {
    if (!semanticAnalysis?.codeAnalysis?.codeQuality) {
      return '- No code quality assessment available';
    }
    
    const quality = semanticAnalysis.codeAnalysis.codeQuality;
    const assessment = [];
    
    assessment.push(`**Overall Score:** ${quality.score}/100`);
    
    if (quality.issues && quality.issues.length > 0) {
      assessment.push(`**Issues Identified:** ${quality.issues.length}`);
      quality.issues.forEach((issue: string) => {
        assessment.push(`  - ${issue}`);
      });
    }
    
    if (quality.recommendations && quality.recommendations.length > 0) {
      assessment.push(`**Recommendations:**`);
      quality.recommendations.forEach((rec: string) => {
        assessment.push(`  - ${rec}`);
      });
    }
    
    return assessment.join('\n');
  }

  private generateRecommendations(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any, patternCatalog: PatternCatalog): string {
    const recommendations = [];
    
    // High significance patterns deserve attention
    const highSigPatterns = patternCatalog.patterns.filter(p => p.significance >= 8);
    if (highSigPatterns.length > 0) {
      recommendations.push(`Focus on implementing the ${highSigPatterns.length} high-significance patterns identified`);
    }
    
    // Code quality recommendations
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.recommendations) {
      recommendations.push(...semanticAnalysis.codeAnalysis.codeQuality.recommendations);
    }
    
    // Pattern-based recommendations
    const patternCategories = Object.keys(patternCatalog.summary.byCategory);
    if (patternCategories.includes('Solution')) {
      recommendations.push('Leverage successful problem-solution patterns for similar future challenges');
    }
    
    if (patternCategories.includes('Architecture')) {
      recommendations.push('Document and standardize architectural decision patterns for team consistency');
    }
    
    // Default recommendations if none found
    if (recommendations.length === 0) {
      recommendations.push('Continue monitoring development patterns and maintaining code quality standards');
      recommendations.push('Regularly conduct semantic analysis to identify emerging patterns and insights');
    }
    
    return recommendations.map((rec, index) => `${index + 1}. ${rec}`).join('\n');
  }

  private generateImplementationGuidance(patternCatalog: PatternCatalog): string {
    if (patternCatalog.patterns.length === 0) {
      return 'No specific implementation guidance available based on current patterns.';
    }
    
    const guidance = [];
    
    // Prioritize by significance
    const sortedPatterns = patternCatalog.patterns
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 3);
    
    guidance.push('**Implementation Priority Order:**');
    sortedPatterns.forEach((pattern, index) => {
      guidance.push(`${index + 1}. **${pattern.name}** (Significance: ${pattern.significance}/10)`);
      guidance.push(`   - Category: ${pattern.category}`);
      guidance.push(`   - Language: ${pattern.implementation.language}`);
      if (pattern.implementation.usageNotes.length > 0) {
        guidance.push(`   - Notes: ${pattern.implementation.usageNotes[0]}`);
      }
    });
    
    guidance.push('');
    guidance.push('**General Implementation Strategy:**');
    guidance.push('- Start with highest significance patterns for maximum impact');
    guidance.push('- Consider cross-pattern dependencies and implementation order');
    guidance.push('- Monitor effectiveness through continued semantic analysis');
    
    return guidance.join('\n');
  }

  private formatDiagramReferences(diagrams: PlantUMLDiagram[]): string {
    const successful = diagrams.filter(d => d.success);

    if (successful.length === 0) {
      return 'No diagrams were successfully generated.';
    }

    const references = successful.map(diagram => {
      const diagramTitle = diagram.type.charAt(0).toUpperCase() + diagram.type.slice(1);
      const lines = [`### ${diagramTitle} Diagram`];

      // Try multiple ways to find the PNG file
      let pngExists = false;
      let pngFileName = '';

      if (diagram.pngFile && fs.existsSync(diagram.pngFile)) {
        pngExists = true;
        pngFileName = path.basename(diagram.pngFile);
      } else {
        // Fallback: construct expected PNG path from diagram name
        const expectedPngName = `${diagram.name}.png`;
        const expectedPngPath = path.join(this.outputDir, 'images', expectedPngName);
        if (fs.existsSync(expectedPngPath)) {
          pngExists = true;
          pngFileName = expectedPngName;
          log(`Found PNG via fallback path: ${expectedPngPath}`, 'debug');
        }
      }

      if (pngExists && pngFileName) {
        // Embed PNG image using markdown image syntax
        lines.push(`![${diagramTitle} Architecture](images/${pngFileName})`);
        lines.push(''); // Empty line for spacing
        // Add reference to PlantUML source for those who want to see/modify it
        lines.push(`*PlantUML source: [${path.basename(diagram.pumlFile)}](puml/${path.basename(diagram.pumlFile)})*`);
      } else {
        // If PNG doesn't exist, link directly to PUML but note it's a source file
        log(`PNG not found for ${diagram.name}: pngFile=${diagram.pngFile}, checked fallback`, 'warning');
        lines.push(`📄 **[View ${diagramTitle} Diagram Source](puml/${path.basename(diagram.pumlFile)})**`);
        lines.push(`*(PlantUML source file - use PlantUML viewer or generate PNG)*`);
      }

      return lines.join('\n');
    });

    return references.join('\n\n');
  }

  private formatWebResults(webResults: any): string {
    if (!webResults) {
      return 'No web research was conducted for this analysis.';
    }
    
    const sections = [];
    
    if (webResults.patterns) {
      sections.push(`**Patterns from Web Research:** ${webResults.patterns.length} patterns identified`);
    }
    
    if (webResults.references) {
      sections.push(`**External References:** ${webResults.references.length} relevant resources found`);
    }
    
    if (webResults.insights) {
      sections.push(`**Web-Sourced Insights:** ${webResults.insights}`);
    }
    
    return sections.length > 0 ? sections.join('\n') : 'Web research data available but not structured.';
  }


  // Utility methods
  private initializeDirectories(): void {
    // PERFORMANCE OPTIMIZATION: Use async directory creation to avoid blocking
    const dirs = [
      this.outputDir,
      path.join(this.outputDir, 'puml'),
      path.join(this.outputDir, 'images')
    ];
    
    // Create directories asynchronously in parallel
    Promise.all(dirs.map(async dir => {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
      } catch (error) {
        // Directory might already exist, ignore EEXIST errors
        if ((error as any).code !== 'EEXIST') {
          log(`Failed to create directory ${dir}`, 'warning', error);
        }
      }
    })).catch(error => {
      log('Directory initialization failed', 'warning', error);
    });
  }

  private async checkPlantUMLAvailability(): Promise<void> {
    try {
      const { spawn } = await import('child_process');
      const plantuml = spawn('plantuml', ['-version']);
      
      plantuml.on('close', (code) => {
        this.plantumlAvailable = code === 0;
        log(`PlantUML availability: ${this.plantumlAvailable}`, 'info');
      });
      
      plantuml.on('error', () => {
        this.plantumlAvailable = false;
        log('PlantUML not available - diagram generation disabled', 'warning');
      });
    } catch (error) {
      this.plantumlAvailable = false;
      log('Could not check PlantUML availability', 'warning', error);
    }
  }

  private getStandardStyle(): string {
    // Check for standard style in multiple locations
    const possiblePaths = [
      this.standardStylePath, // docs/puml/_standard-style.puml
      path.join(this.outputDir, 'puml', '_standard-style.puml'), // insights/puml/_standard-style.puml
      path.join(process.cwd(), 'knowledge-management', 'insights', 'puml', '_standard-style.puml')
    ];
    
    for (const stylePath of possiblePaths) {
      if (fs.existsSync(stylePath)) {
        // Use relative path from the PUML file location
        const relativePath = path.relative(path.join(this.outputDir, 'puml'), stylePath);
        return `!include ${relativePath}`;
      }
    }
    
    // Fallback: use the standard style content directly
    return `!theme plain
skinparam backgroundColor white
skinparam defaultFontName Arial
skinparam defaultFontSize 12

' Component styling with professional colors
skinparam component {
  BackgroundColor<<api>> #E8F4FD
  BackgroundColor<<core>> #E8F5E8
  BackgroundColor<<storage>> #FFF9E6
  BackgroundColor<<cli>> #FFE8F4
  BackgroundColor<<util>> #F0F0F0
  BackgroundColor<<agent>> #E6F3FF
  BackgroundColor<<infra>> #FFF2E6
  BackgroundColor<<external>> #F5F5F5
  BackgroundColor<<critical>> #FFE8F4
  BackgroundColor<<important>> #E8F4FD
  BackgroundColor<<standard>> #F0F0F0
  FontSize 12
  FontColor #000000
}

' Package styling
skinparam package {
  BackgroundColor #FAFAFA
  BorderColor #CCCCCC
  FontSize 14
  FontColor #333333
  FontStyle bold
}

' Note styling
skinparam note {
  BackgroundColor #FFFACD
  BorderColor #DDD
  FontSize 10
  FontColor #333333
}

' Arrow styling with distinct colors
skinparam arrow {
  FontSize 10
  FontColor #666666
  Color #4A90E2
}

' Database styling
skinparam database {
  BackgroundColor #E1F5FE
  BorderColor #0277BD
}

' Cloud styling
skinparam cloud {
  BackgroundColor #F3E5F5
  BorderColor #7B1FA2
}

' Actor styling
skinparam actor {
  BackgroundColor #C8E6C9
  BorderColor #388E3C
}

' Interface styling
skinparam interface {
  BackgroundColor #FFF3E0
  BorderColor #F57C00
}

' Rectangle styling for grouping
skinparam rectangle {
  BackgroundColor #F9F9F9
  BorderColor #BDBDBD
}

' Sequence diagram styling
skinparam sequence {
  ArrowColor #4A90E2
  ActorBorderColor #333333
  LifeLineBorderColor #666666
  ParticipantBorderColor #333333
  ParticipantBackgroundColor #F5F5F5
}`;
  }

  private mapImpactToSignificance(impact: string): number {
    switch (impact?.toLowerCase()) {
      case 'high': return 8;
      case 'medium': return 5;
      case 'low': return 3;
      default: return 5;
    }
  }

  private mapDifficultyToSignificance(difficulty: string): number {
    switch (difficulty) {
      case 'high': return 8;
      case 'medium': return 5;
      case 'low': return 3;
      default: return 5;
    }
  }

  private detectLanguageFromFiles(files: string[]): string {
    const extensions = files.map(f => path.extname(f).toLowerCase());
    const langMap: Record<string, string> = {
      '.ts': 'TypeScript',
      '.js': 'JavaScript',
      '.py': 'Python',
      '.java': 'Java',
      '.go': 'Go'
    };
    
    for (const ext of extensions) {
      if (langMap[ext]) return langMap[ext];
    }
    
    return 'Unknown';
  }

  private detectLanguageFromTechnologies(technologies: string[]): string {
    const techMap: Record<string, string> = {
      'typescript': 'TypeScript',
      'javascript': 'JavaScript',
      'python': 'Python',
      'java': 'Java',
      'go': 'Go'
    };
    
    for (const tech of technologies) {
      const lower = tech.toLowerCase();
      if (techMap[lower]) return techMap[lower];
    }
    
    return 'Mixed';
  }

  private calculateInsightSignificance(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    patternCatalog: PatternCatalog
  ): number {
    let significance = 5; // Base significance
    
    // Add points for data richness
    if (gitAnalysis?.commits?.length > 10) significance += 1;
    if (vibeAnalysis?.sessions?.length > 5) significance += 1;
    if (semanticAnalysis?.codeAnalysis) significance += 1;
    
    // Add points for pattern quality
    if (patternCatalog.summary.avgSignificance > 7) significance += 1;
    if (patternCatalog.patterns.length > 5) significance += 1;
    
    return Math.min(significance, 10);
  }

  private calculateQualityScore(insightDocument: InsightDocument, patternCatalog: PatternCatalog): number {
    let score = 50; // Base score
    
    // Content quality
    if (insightDocument.content.length > 5000) score += 10;
    if (insightDocument.diagrams.filter(d => d.success).length > 2) score += 15;
    
    // Pattern quality
    if (patternCatalog.patterns.length > 3) score += 10;
    if (patternCatalog.summary.avgSignificance > 6) score += 15;
    
    return Math.min(score, 100);
  }

  private formatGitAnalysisSummary(gitAnalysis: any): string {
    return `- Commits analyzed: ${gitAnalysis.commits?.length || 0}
- Architectural decisions: ${gitAnalysis.architecturalDecisions?.length || 0}
- Code evolution patterns: ${gitAnalysis.codeEvolution?.length || 0}`;
  }

  private formatVibeAnalysisSummary(vibeAnalysis: any): string {
    return `- Sessions analyzed: ${vibeAnalysis.sessions?.length || 0}
- Problem-solution pairs: ${vibeAnalysis.problemSolutionPairs?.length || 0}
- Development contexts: ${vibeAnalysis.developmentContexts?.length || 0}
- Primary focus: ${vibeAnalysis.summary?.primaryFocus || 'N/A'}`;
  }

  private formatSemanticAnalysisSummary(semanticAnalysis: any): string {
    const codeAnalysis = semanticAnalysis?.codeAnalysis;
    if (!codeAnalysis) return 'No semantic analysis data available';
    
    return `- Files analyzed: ${codeAnalysis.filesAnalyzed || 0}
- Lines of code: ${codeAnalysis.totalLinesOfCode || 0}
- Architectural patterns: ${codeAnalysis.architecturalPatterns?.length || 0}
- Code quality score: ${codeAnalysis.codeQuality?.score || 0}/100
- Average complexity: ${codeAnalysis.complexityMetrics?.averageComplexity || 0}`;
  }

  // NEW METHODS FOR REAL PATTERN ANALYSIS
  private async extractArchitecturalPatternsFromCommits(commits: any[]): Promise<IdentifiedPattern[]> {
    const patterns: IdentifiedPattern[] = [];

    // Limit processing to prevent performance issues
    const limitedCommits = commits.slice(0, 50);

    // Solution 4: Only analyze commits with architectural significance
    // Filter out infrastructure/config/bug fix commits
    const significantCommits = limitedCommits.filter(commit => {
      const msg = commit.message.toLowerCase();

      // Reject infrastructure/config commits
      if (msg.match(/^(fix|chore|docs|style|refactor|test):/)) {
        return false;
      }

      // Reject small changes (likely bug fixes)
      if (commit.additions + commit.deletions < 50) {
        return false;
      }

      // Accept feature commits with significant changes
      if (msg.match(/^feat:/) && commit.additions + commit.deletions > 100) {
        return true;
      }

      // Accept commits with architectural keywords
      return this.isArchitecturalCommit(commit.message);
    });

    if (significantCommits.length === 0) {
      log('No architecturally significant commits found', 'info');
      return patterns;
    }

    try {
      // Use LLM to analyze commit patterns
      const commitSummary = significantCommits.map(c => ({
        message: c.message,
        files: c.files.map((f: any) => f.path),
        changes: c.additions + c.deletions
      }));

      // Solution 2: Improve LLM prompt to avoid generic names
      const prompt = `Analyze these git commits and extract SPECIFIC architectural patterns.

COMMITS:
${JSON.stringify(commitSummary, null, 2)}

REQUIREMENTS:
- Pattern names must be SPECIFIC and DESCRIPTIVE based on actual implementation details
- Names should describe WHAT the pattern does, not just the technology
- Avoid generic names like "JavascriptDevelopmentPattern" or "ConfigurationChangesPattern"
- Examples of GOOD pattern names:
  * "GraphDatabasePersistencePattern" (describes the specific technology + purpose)
  * "MultiAgentCoordinationPattern" (describes specific architectural approach)
  * "OntologyClassificationWorkflow" (describes specific domain + process)
- Examples of BAD pattern names (DO NOT USE):
  * "JavascriptDevelopmentPattern" (too generic)
  * "ConfigurationChangesPattern" (just describes commit type)
  * "ImplementationPattern" (meaningless)

OUTPUT FORMAT:
For each pattern found, use this format:
Pattern: [Specific Descriptive Name]
Description: [What this pattern specifically accomplishes]
Significance: [1-10]`;

      // ULTRA DEBUG: Write pattern extraction prompt to trace file
      const patternPromptTrace = `${process.cwd()}/logs/pattern-extraction-prompt-${Date.now()}.txt`;
      await fs.promises.writeFile(patternPromptTrace, `=== PATTERN EXTRACTION PROMPT ===\n${prompt}\n\n=== COMMIT SUMMARY ===\n${JSON.stringify(commitSummary, null, 2)}\n\n=== END ===\n`);
      log(`🔍 TRACE: Pattern extraction prompt written to ${patternPromptTrace}`, 'info');

      const analysisResult = await this.semanticAnalyzer.analyzeContent(
        prompt,
        {
          analysisType: 'patterns',
          context: 'Git commit history analysis - extract specific architectural patterns with meaningful names',
          provider: 'auto'
        }
      );

      // ULTRA DEBUG: Write pattern extraction result to trace file
      const patternResultTrace = `${process.cwd()}/logs/pattern-extraction-result-${Date.now()}.json`;
      await fs.promises.writeFile(patternResultTrace, JSON.stringify({
        timestamp: new Date().toISOString(),
        phase: 'PATTERN_EXTRACTION_RESULT',
        analysisResult
      }, null, 2));
      log(`🔍 TRACE: Pattern extraction result written to ${patternResultTrace}`, 'info');

      // Extract patterns from LLM response
      if (analysisResult.insights) {
        const extractedPatterns = await this.parseArchitecturalPatternsFromLLM(
          analysisResult.insights,
          significantCommits
        );
        patterns.push(...extractedPatterns);
      }
    } catch (error) {
      log('Failed to use LLM for pattern extraction, falling back to basic analysis', 'warning', error);
      // Fallback to basic pattern extraction if LLM fails
      const themeGroups = this.groupCommitsByTheme(significantCommits);
      let patternCount = 0;
      themeGroups.forEach((commits, theme) => {
        if (commits.length >= 2 && patternCount < 10) {
          const pattern = this.createArchitecturalPattern(theme, commits);
          if (pattern) {
            patterns.push(pattern);
            patternCount++;
          }
        }
      });
    }

    return patterns;
  }

  private extractImplementationPatterns(codeEvolution: any[]): IdentifiedPattern[] {
    const patterns: IdentifiedPattern[] = [];
    
    // Limit processing to prevent performance issues
    const limitedEvolution = codeEvolution.slice(0, 20);
    
    limitedEvolution.forEach(evolution => {
      if (evolution.occurrences >= 3 && patterns.length < 5) {
        const pattern = this.createImplementationPattern(evolution);
        if (pattern) patterns.push(pattern);
      }
    });

    return patterns;
  }

  private extractDesignPatterns(codeAnalysis: any): IdentifiedPattern[] {
    const patterns: IdentifiedPattern[] = [];
    
    if (codeAnalysis.architecturalPatterns) {
      codeAnalysis.architecturalPatterns.forEach((archPattern: any) => {
        if (archPattern.confidence > 0.7) {
          const pattern = this.createDesignPattern(archPattern);
          if (pattern) patterns.push(pattern);
        }
      });
    }

    return patterns;
  }

  private extractCodeSolutionPatterns(problemSolutionPairs: any[]): IdentifiedPattern[] {
    const patterns: IdentifiedPattern[] = [];
    
    // Limit processing to prevent performance issues
    const limitedPairs = problemSolutionPairs.slice(0, 10);
    
    const codeSolutions = limitedPairs.filter(pair => 
      this.isCodeRelatedSolution(pair.solution) && this.isSignificantSolution(pair)
    );

    codeSolutions.forEach((pair, index) => {
      if (patterns.length < 5) {
        const pattern = this.createCodeSolutionPattern(pair, index);
        if (pattern) patterns.push(pattern);
      }
    });

    return patterns;
  }

  private isArchitecturalCommit(message: string): boolean {
    const keywords = ['refactor', 'restructure', 'architecture', 'design', 'pattern', 'framework', 'system'];
    return keywords.some(k => message.toLowerCase().includes(k));
  }

  private groupCommitsByTheme(commits: any[]): Map<string, any[]> {
    const themes = new Map();
    commits.forEach(commit => {
      const theme = this.extractThemeFromCommit(commit);
      if (!themes.has(theme)) themes.set(theme, []);
      themes.get(theme).push(commit);
    });
    return themes;
  }

  private extractThemeFromCommit(commit: any): string {
    const message = commit.message.toLowerCase();

    // Extract actual themes from commit messages based on common patterns
    if (message.match(/\b(refactor|restructure|reorganize)\b/)) return 'Code Refactoring';
    if (message.match(/\b(fix|bug|error|issue|resolve)\b/)) return 'Bug Fix';
    if (message.match(/\b(test|spec|coverage)\b/)) return 'Test Coverage';
    if (message.match(/\b(doc|documentation|readme|comment)\b/)) return 'Documentation';
    if (message.match(/\b(config|configuration|setup|env)\b/)) return 'Configuration Management';
    if (message.match(/\b(api|endpoint|route|controller)\b/)) return 'API Development';
    if (message.match(/\b(component|ui|interface|view)\b/)) return 'Component Architecture';
    if (message.match(/\b(database|schema|migration|model)\b/)) return 'Database Design';
    if (message.match(/\b(performance|optimize|speed|cache)\b/)) return 'Performance Optimization';
    if (message.match(/\b(security|auth|permission|access)\b/)) return 'Security Enhancement';
    if (message.match(/\b(feature|add|implement|new)\b/)) return 'Feature Implementation';
    if (message.match(/\b(typescript|type|interface)\b/)) return 'TypeScript Migration';
    if (message.match(/\b(agent|mcp|workflow)\b/)) return 'Agent Architecture';

    // Extract theme from conventional commit format (e.g., "feat:", "fix:", "chore:")
    const conventionalMatch = message.match(/^(\w+)(?:\([^)]+\))?:/);
    if (conventionalMatch) {
      const type = conventionalMatch[1];
      const typeMap: Record<string, string> = {
        'feat': 'Feature Implementation',
        'fix': 'Bug Fix',
        'docs': 'Documentation',
        'style': 'Code Style',
        'refactor': 'Code Refactoring',
        'test': 'Test Coverage',
        'chore': 'Maintenance',
        'perf': 'Performance Optimization'
      };
      if (typeMap[type]) return typeMap[type];
    }

    return 'Architecture Evolution';
  }

  private createArchitecturalPattern(theme: string, commits: any[]): IdentifiedPattern | null {
    if (commits.length === 0) return null;

    const allFiles = new Set();
    commits.forEach(commit => commit.files?.forEach((f: string) => allFiles.add(f)));

    return {
      name: this.generateMeaningfulPatternName(theme),
      category: 'Architecture',
      description: `${theme} pattern from ${commits.length} commits affecting ${allFiles.size} files`,
      significance: Math.min(8, 4 + commits.length),
      evidence: [
        `Commits: ${commits.length}`,
        `Files: ${allFiles.size}`,
        `Example: ${commits[0].message.substring(0, 50)}...`
      ],
      relatedComponents: Array.from(allFiles) as string[],
      implementation: {
        language: this.detectLanguageFromFiles(Array.from(allFiles).map((f: any) => typeof f === 'string' ? f : f.path)),
        usageNotes: [`Applied across ${allFiles.size} files`, `${commits.length} related commits`]
      }
    };
  }

  private createImplementationPattern(evolution: any): IdentifiedPattern | null {
    if (!evolution.pattern) return null;

    // FIXED: Generate meaningful pattern names instead of corrupted concatenations
    const cleanPatternName = this.generateMeaningfulPatternName(evolution.pattern);

    return {
      name: cleanPatternName,
      category: 'Implementation',
      description: `${evolution.pattern} with ${evolution.occurrences} occurrences`,
      significance: Math.min(9, Math.ceil(evolution.occurrences / 2)),
      evidence: [`Occurrences: ${evolution.occurrences}`, `Trend: ${evolution.trend}`],
      relatedComponents: evolution.files || [],
      implementation: {
        language: this.detectLanguageFromFiles(evolution.files || []),
        usageNotes: [`${evolution.occurrences} occurrences`, `Trend: ${evolution.trend}`]
      }
    };
  }

  /**
   * Removed: cleanCorruptedPatternName
   * Hard-coded pattern name fixes removed - now using actual pattern names from analysis
   */

  /**
   * Generate meaningful pattern names instead of corrupted concatenations
   */
  private generateMeaningfulPatternName(rawPattern: string): string {
    // Clean and normalize the pattern name
    const words = rawPattern.trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .filter(word => word.length > 0);

    // Handle common pattern transformations
    if (words.length === 1) {
      return `${words[0]}Pattern`;
    }

    // Create camelCase for multi-word patterns
    const camelCase = words[0] + words.slice(1).join('');
    
    // Ensure it doesn't end with redundant suffixes
    let finalName = camelCase;
    if (!finalName.endsWith('Pattern') && !finalName.endsWith('Implementation')) {
      finalName += 'Pattern';
    }

    // Validate length and meaningfulness
    if (finalName.length > 50) {
      // Use acronym for very long names
      const acronym = words.map(w => w[0]).join('').toUpperCase();
      finalName = `${acronym}Pattern`;
    }

    log(`Generated pattern name: "${rawPattern}" -> "${finalName}"`, 'info');
    return finalName;
  }

  private createDesignPattern(archPattern: any): IdentifiedPattern | null {
    return {
      name: this.generateMeaningfulPatternName(archPattern.name),
      category: 'Design',
      description: archPattern.description || `${archPattern.name} design pattern`,
      significance: Math.round(archPattern.confidence * 10),
      evidence: [`Confidence: ${Math.round(archPattern.confidence * 100)}%`],
      relatedComponents: archPattern.files || [],
      implementation: {
        language: this.detectLanguageFromFiles(archPattern.files || []),
        usageNotes: [`High confidence: ${Math.round(archPattern.confidence * 100)}%`]
      }
    };
  }

  private createCodeSolutionPattern(pair: any, index: number): IdentifiedPattern | null {
    const patternName = this.generatePatternNameFromSolution(pair.solution, index);
    
    return {
      name: patternName,  
      category: 'Solution',
      description: `Code solution: ${pair.problem.description.substring(0, 80)}`,
      significance: this.calculateSolutionSignificance(pair),
      evidence: [
        `Approach: ${pair.solution.approach}`,
        `Technologies: ${pair.solution.technologies?.join(', ') || 'Mixed'}`,
        `Outcome: ${pair.solution.outcome}`
      ],
      relatedComponents: pair.solution.technologies || [],
      implementation: {
        language: this.detectLanguageFromTechnologies(pair.solution.technologies || []),
        usageNotes: [`Solution for: ${pair.problem.description.substring(0, 50)}`]
      }
    };
  }

  private isCodeRelatedSolution(solution: any): boolean {
    if (!solution) return false;
    const text = (solution.approach + ' ' + (solution.outcome || '')).toLowerCase();
    return ['code', 'function', 'class', 'component', 'api', 'refactor'].some(k => text.includes(k));
  }

  async generateDocumentation(templateName: string, data: any): Promise<{
    title: string;
    content: string;
    generatedAt: string;
  }> {
    log(`Generating LLM-enhanced documentation using template: ${templateName}`, 'info', {
      templateName,
      hasData: !!data,
      useSemanticAnalyzer: !!this.semanticAnalyzer
    });

    const generatedAt = new Date().toISOString();
    const title = data.analysis_title || 'Generated Documentation';
    
    let content: string;
    
    // Try to use LLM for enhanced documentation generation
    if (this.semanticAnalyzer) {
      try {
        const documentationPrompt = this.buildDocumentationPrompt(data, templateName);
        const analysisResult = await this.semanticAnalyzer.analyzeContent(documentationPrompt, {
          analysisType: 'architecture',
          context: `Documentation generation for ${title}`,
          provider: 'auto'
        });
        
        if (analysisResult?.insights && analysisResult.insights.length > 500) {
          // LLM generated good documentation
          content = `# ${title}

**Generated:** ${generatedAt} (LLM-Enhanced)
**Scope:** ${data.scope || 'Analysis'}
**Duration:** ${data.duration || 'N/A'}

${analysisResult.insights}

---

*Generated by AI-Enhanced Semantic Analysis System at ${generatedAt}*
*Provider: ${analysisResult.provider}*
`;
          log('LLM-enhanced documentation generated successfully', 'info', {
            contentLength: content.length,
            provider: analysisResult.provider
          });
        } else {
          throw new Error('LLM analysis returned insufficient content');
        }
      } catch (error) {
        log('LLM documentation generation failed, falling back to template', 'warning', error);
        content = this.generateTemplateDocumentation(data, title, generatedAt);
      }
    } else {
      content = this.generateTemplateDocumentation(data, title, generatedAt);
    }

    return {
      title,
      content,
      generatedAt
    };
  }

  private buildDocumentationPrompt(data: any, templateName: string): string {
    return `Generate comprehensive technical documentation based on the following semantic analysis results:

**Analysis Data:**
${JSON.stringify(data, null, 2)}

**Documentation Requirements:**
- Create a professional technical document with clear structure
- Include executive summary, detailed findings, and actionable recommendations
- Focus on architectural insights and patterns discovered
- Provide specific metrics and quality assessments where available
- Include technical implementation details and best practices
- Make recommendations concrete and actionable

**Format:** Markdown with professional structure including:
1. Executive Summary (2-3 paragraphs)
2. Analysis Overview and Methodology
3. Detailed Findings (with subsections as needed)
4. Quality Metrics and Scores
5. Architectural Insights
6. Pattern Analysis
7. Recommendations (prioritized list)
8. Technical Implementation Notes
9. Appendices (metadata, references)

Please generate a comprehensive, professional technical document that would be valuable for developers and architects.`;
  }

  private generateTemplateDocumentation(data: any, title: string, generatedAt: string): string {
    return `# ${title}

**Generated:** ${generatedAt}
**Scope:** ${data.scope || 'Analysis'}
**Duration:** ${data.duration || 'N/A'}

## Executive Summary

${data.results_summary || 'Documentation generated from semantic analysis results.'}

## Analysis Overview

**Items Analyzed:** ${data.analyzed_items || 'Multiple components'}
**Methodology:** ${data.methodology || 'Semantic analysis with AI-powered insights'}

## Detailed Findings

${data.detailed_findings || 'Analysis findings pending detailed review.'}

## Quality Metrics

${data.quality_metrics || 'Quality metrics under assessment.'}

## Architectural Insights

${data.architecture_insights || 'Architectural analysis in progress.'}

## Pattern Analysis

${data.pattern_analysis || 'Pattern detection and documentation pending.'}

## Recommendations

${data.recommendations || 'Recommendations based on analysis results pending.'}

## Appendices

${data.appendices || 'Additional metadata and references.'}

---

*Generated by Semantic Analysis System at ${generatedAt}*
`;
  }

  async saveDocumentation(docResult: any, filePath: string): Promise<void> {
    try {
      log(`Saving documentation to: ${filePath}`, 'info', {
        title: docResult.title,
        contentLength: docResult.content.length
      });

      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });

      // Write documentation file
      await fs.promises.writeFile(filePath, docResult.content, 'utf8');

      log(`Documentation saved successfully: ${filePath}`, 'info');
    } catch (error) {
      log(`Failed to save documentation: ${filePath}`, 'error', error);
      throw error;
    }
  }

  private isSignificantSolution(pair: any): boolean {
    return pair.solution && pair.solution.approach && pair.solution.approach.length > 20;
  }

  private generatePatternNameFromSolution(solution: any, index: number): string {
    const approach = solution.approach?.toLowerCase() || '';
    if (approach.includes('refactor')) return `RefactoringPattern${index + 1}`;
    if (approach.includes('component')) return `ComponentPattern${index + 1}`;
    if (approach.includes('api')) return `APIPattern${index + 1}`;
    return `SolutionPattern${index + 1}`;
  }

  private calculateSolutionSignificance(pair: any): number {
    let sig = 3;
    if (pair.solution.technologies?.length > 2) sig += 1;
    if (pair.solution.approach?.length > 50) sig += 1;
    if (pair.solution.outcome?.includes('success')) sig += 2;
    return Math.min(sig, 8);
  }

  private async parseArchitecturalPatternsFromLLM(
    llmInsights: string, 
    commits: any[]
  ): Promise<IdentifiedPattern[]> {
    const patterns: IdentifiedPattern[] = [];
    
    try {
      // Try to extract structured patterns from LLM response
      const lines = llmInsights.split('\n');
      let currentPattern: Partial<IdentifiedPattern> | null = null;
      
      for (const line of lines) {
        const trimmed = line.trim();
        
        // Look for pattern headers
        if (trimmed.match(/^(Pattern|Architecture|Design):\s*(.+)/i)) {
          if (currentPattern && currentPattern.name) {
            patterns.push(this.finalizePattern(currentPattern, commits));
          }
          const patternName = RegExp.$2.trim();
          currentPattern = {
            name: this.formatPatternName(patternName),
            category: 'Architecture',
            description: '',
            significance: 7,
            evidence: [],
            relatedComponents: [],
            implementation: {
              language: 'TypeScript',
              usageNotes: []
            }
          };
        }
        // Look for descriptions
        else if (currentPattern && trimmed.match(/^(Description|Purpose|Summary):\s*(.+)/i)) {
          currentPattern.description = RegExp.$2.trim();
        }
        // Look for significance indicators
        else if (currentPattern && trimmed.match(/^(Significance|Importance|Impact):\s*(\d+)/i)) {
          currentPattern.significance = Math.min(10, Math.max(1, parseInt(RegExp.$2)));
        }
        // Look for code examples or implementation notes
        else if (currentPattern && trimmed.match(/^(Implementation|Code|Example):/i)) {
          currentPattern.implementation = currentPattern.implementation || { language: 'TypeScript', usageNotes: [] };
          currentPattern.implementation.usageNotes?.push(trimmed);
        }
        // Collect evidence
        else if (currentPattern && trimmed.length > 20) {
          currentPattern.evidence = currentPattern.evidence || [];
          currentPattern.evidence.push(trimmed);
        }
      }
      
      // Don't forget the last pattern
      if (currentPattern && currentPattern.name) {
        patterns.push(this.finalizePattern(currentPattern, commits));
      }
      
      // If no structured patterns found, create a general one
      if (patterns.length === 0 && llmInsights.length > 100) {
        patterns.push({
          name: 'ArchitecturalEvolutionPattern',
          category: 'Architecture',
          description: llmInsights.substring(0, 200) + '...',
          significance: 6,
          evidence: [llmInsights],
          relatedComponents: commits.flatMap(c => c.files?.map((f: any) => f.path) || []).slice(0, 5),
          implementation: {
            language: 'TypeScript',
            usageNotes: ['See detailed analysis in the insight document']
          }
        });
      }
    } catch (error) {
      log('Error parsing LLM insights into patterns', 'error', error);
    }
    
    return patterns;
  }

  private formatPatternName(rawName: string): string {
    // Convert to PascalCase and ensure it ends with "Pattern"
    const words = rawName.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
    const pascalCase = words
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
    
    return pascalCase.endsWith('Pattern') ? pascalCase : pascalCase + 'Pattern';
  }

  private finalizePattern(partial: Partial<IdentifiedPattern>, commits: any[]): IdentifiedPattern {
    return {
      name: partial.name || 'UnnamedPattern',
      category: partial.category || 'Architecture',
      description: partial.description || 'Pattern identified through commit analysis',
      significance: partial.significance || 5,
      evidence: partial.evidence || [`Found in ${commits.length} commits`],
      relatedComponents: partial.relatedComponents || commits.flatMap(c => c.files?.map((f: any) => f.path) || []).slice(0, 10),
      implementation: partial.implementation || {
        language: 'TypeScript',
        usageNotes: ['Pattern extracted from commit history']
      }
    };
  }

  // New helper methods for improved insight structure
  private getSignificanceDescription(significance: number): string {
    if (significance >= 9) return 'Critical architecture pattern for system success';
    if (significance >= 7) return 'Important pattern with significant impact';
    if (significance >= 5) return 'Useful pattern for specific scenarios';
    return 'Basic pattern with limited scope';
  }

  private async extractMainProblem(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): Promise<string> {
    // Collect structured data for LLM analysis
    const analysisContext = {
      gitPatterns: gitAnalysis?.summary?.focusAreas || [],
      codeIssues: semanticAnalysis?.codeAnalysis?.codeQuality?.issues || [],
      complexityMetrics: semanticAnalysis?.codeAnalysis?.complexity || {},
      commitTrends: gitAnalysis?.summary?.trends || [],
      conversationThemes: vibeAnalysis?.themes || []
    };

    // Generate intelligent problem statement based on analysis data
    try {
      // Create structured problem statement from analysis context
      const problemElements = [];
      
      if (analysisContext.codeIssues.length > 0) {
        problemElements.push(`Code quality challenges identified across ${analysisContext.codeIssues.length} areas`);
      }
      
      if (analysisContext.complexityMetrics.averageComplexity > 15) {
        problemElements.push(`High code complexity (avg: ${analysisContext.complexityMetrics.averageComplexity.toFixed(1)}) requiring refactoring`);
      }
      
      if (analysisContext.gitPatterns.length > 0) {
        problemElements.push(`Managing ${analysisContext.gitPatterns.join(', ')} patterns across evolving architecture`);
      }
      
      if (analysisContext.conversationThemes.length > 0) {
        problemElements.push(`Addressing recurring development themes and architectural decisions`);
      }
      
      if (problemElements.length > 0) {
        return problemElements.join('. ') + '.';
      }
    } catch (error) {
      console.warn('Failed to generate structured problem statement, using fallback', { error: error instanceof Error ? error.message : String(error) });
    }

    // Fallback to structured analysis if LLM fails
    if (analysisContext.codeIssues.length > 0) {
      return 'Code quality and architectural consistency challenges identified requiring systematic refactoring';
    }
    if (analysisContext.gitPatterns.length > 0) {
      return `Managing ${analysisContext.gitPatterns.join(', ')} patterns across complex codebase evolution`;
    }
    return 'System architecture requires structured approach to maintainability and scalability';
  }

  private extractMainSolution(patternCatalog: PatternCatalog, gitAnalysis: any, semanticAnalysis: any): string {
    const topPattern = patternCatalog?.patterns?.sort((a, b) => b.significance - a.significance)[0];
    if (topPattern) {
      return topPattern.description + ' through systematic implementation of architectural patterns';
    }
    if (gitAnalysis?.commits?.length > 0) {
      return 'Implement systematic architectural patterns based on development history analysis';
    }
    return 'Apply structured architectural patterns for improved code organization';
  }

  private extractBenefits(patternCatalog: PatternCatalog, semanticAnalysis: any): string {
    const benefits = [];
    if (patternCatalog?.patterns?.length > 0) {
      benefits.push('Improved architectural consistency');
    }
    if (semanticAnalysis?.codeAnalysis) {
      benefits.push('Enhanced code maintainability');
    }
    benefits.push('Better development team alignment');
    benefits.push('Reduced technical debt');
    return benefits.join(', ');
  }

  private generateProblemStatement(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): string {
    const problems = [];
    
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.score < 70) {
      problems.push('- Code quality metrics indicate architectural improvements needed');
    }
    if (gitAnalysis?.commits?.length > 20) {
      problems.push('- Complex development history suggests need for consistent patterns');
    }
    if (vibeAnalysis?.sessions?.length > 5) {
      problems.push('- Multiple development conversations indicate recurring architectural challenges');
    }
    
    if (problems.length === 0) {
      problems.push('- System complexity requires systematic architectural approach');
    }
    
    return problems.join('\n');
  }

  private generateSolutionApproach(patternCatalog: PatternCatalog, semanticAnalysis: any): string {
    const approaches = [];
    
    if (patternCatalog?.patterns?.length > 0) {
      const topPattern = patternCatalog.patterns.sort((a, b) => b.significance - a.significance)[0];
      approaches.push(`- Implement ${topPattern.name} as primary architectural pattern`);
    }
    
    approaches.push('- Apply systematic code organization principles');
    approaches.push('- Establish consistent development patterns');
    approaches.push('- Implement quality monitoring and improvement processes');
    
    return approaches.join('\n');
  }

  private generateArchitectureDescription(gitAnalysis: any, semanticAnalysis: any, patternCatalog: PatternCatalog): string {
    const desc = [];
    
    if (patternCatalog?.patterns?.length > 0) {
      desc.push(`The architecture implements ${patternCatalog.patterns.length} identified patterns with ${patternCatalog.summary.avgSignificance}/10 average significance.`);
    }
    
    if (gitAnalysis?.commits?.length > 0) {
      desc.push(`Analysis of ${gitAnalysis.commits.length} commits reveals evolutionary development approach.`);
    }
    
    if (semanticAnalysis?.codeAnalysis?.filesAnalyzed > 0) {
      desc.push(`Code analysis across ${semanticAnalysis.codeAnalysis.filesAnalyzed} files shows ${semanticAnalysis.codeAnalysis.architecturalPatterns?.length || 0} architectural patterns.`);
    }
    
    return desc.join(' ');
  }

  private formatPatternCatalogStructured(patternCatalog: PatternCatalog): string {
    if (!patternCatalog?.patterns?.length) {
      return 'No specific patterns identified in current analysis.';
    }

    const patterns = patternCatalog.patterns
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 5);

    return patterns.map((pattern, index) => {
      return `### ${index + 1}. ${pattern.name}

**Category:** ${pattern.category}  
**Significance:** ${pattern.significance}/10  

${pattern.description}

**Implementation Language:** ${pattern.implementation.language}  
**Evidence:** ${pattern.evidence.slice(0, 2).join(', ')}`;
    }).join('\n\n');
  }

  private detectMainLanguage(gitAnalysis: any, semanticAnalysis: any): string {
    if (semanticAnalysis?.codeAnalysis?.languageDistribution) {
      const langs = Object.entries(semanticAnalysis.codeAnalysis.languageDistribution);
      const topLang = langs.sort(([,a], [,b]) => (b as number) - (a as number))[0];
      if (topLang) return topLang[0];
    }
    return 'typescript';
  }

  private generateCodeExample(patternCatalog: PatternCatalog, semanticAnalysis: any): string {
    const topPattern = patternCatalog?.patterns?.[0];
    if (topPattern?.implementation?.codeExample) {
      return topPattern.implementation.codeExample;
    }
    
    // Generate a meaningful example based on pattern type
    if (topPattern?.name.toLowerCase().includes('repository')) {
      return `// Repository Pattern Implementation
interface UserRepository {
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<void>;
}

class DatabaseUserRepository implements UserRepository {
  async findById(id: string): Promise<User | null> {
    // Database implementation
    return await this.db.users.findUnique({ where: { id } });
  }
  
  async save(user: User): Promise<void> {
    // Save implementation
    await this.db.users.upsert({
      where: { id: user.id },
      create: user,
      update: user
    });
  }
}`;
    }
    
    return `// Pattern Implementation Example
class ${topPattern?.name || 'PatternExample'} {
  // Implementation based on analysis results
  private data: any;
  
  constructor(config: Config) {
    this.data = config;
  }
  
  execute(): Result {
    // Core pattern logic
    return this.processData();
  }
}`;
  }

  private generateUsageExample(patternCatalog: PatternCatalog): string {
    const topPattern = patternCatalog?.patterns?.[0];
    return `**Usage Context:** ${topPattern?.description || 'Apply pattern for architectural consistency'}

**Implementation Steps:**
1. Analyze current architecture
2. Identify pattern application points  
3. Implement pattern systematically
4. Validate pattern effectiveness`;
  }

  private generateUsageGuidelines(patternCatalog: PatternCatalog, semanticAnalysis: any, isPositive: boolean): string {
    if (isPositive) {
      return `- System requires structured architectural approach
- Code complexity needs systematic organization
- Team needs consistent development patterns
- Quality metrics indicate improvement opportunity`;
    } else {
      return `- Simple applications with minimal complexity
- Prototype or proof-of-concept development
- Single-developer projects with limited scope
- Systems with established architectural patterns`;
    }
  }

  private generateRelatedPatterns(patternCatalog: PatternCatalog): string {
    if (patternCatalog?.patterns?.length <= 1) {
      return 'No related patterns identified in current analysis.';
    }
    
    return patternCatalog.patterns
      .slice(1, 4)
      .map(p => `- **${p.name}**: ${p.description} (${p.significance}/10)`)
      .join('\n');
  }

  private generateProcessDescription(vibeAnalysis: any, gitAnalysis: any): string {
    const steps = [];
    
    if (gitAnalysis?.commits?.length > 0) {
      steps.push(`1. **Analysis Phase**: Process ${gitAnalysis.commits.length} commits for patterns`);
    }
    
    if (vibeAnalysis?.sessions?.length > 0) {
      steps.push(`2. **Context Phase**: Analyze ${vibeAnalysis.sessions.length} development sessions`);
    }
    
    steps.push('3. **Pattern Extraction**: Identify and catalog architectural patterns');
    steps.push('4. **Validation Phase**: Assess pattern significance and applicability');
    steps.push('5. **Documentation Phase**: Generate comprehensive pattern documentation');
    
    return steps.join('\n');
  }

  private generateReferences(webResults: any, gitAnalysis: any): string {
    const refs = [];
    
    if (webResults?.references?.length > 0) {
      refs.push('**External References:**');
      webResults.references.slice(0, 3).forEach((ref: any) => {
        refs.push(`- [${ref.title}](${ref.url})`);
      });
    }
    
    if (gitAnalysis?.commits?.length > 0) {
      refs.push('**Internal References:**');
      refs.push(`- Git commit history (${gitAnalysis.commits.length} commits analyzed)`);
      refs.push('- Code evolution patterns');
    }
    
    refs.push('**Generated Documentation:**');
    refs.push('- Architectural diagrams (PlantUML)');
    refs.push('- Pattern analysis results');
    
    return refs.join('\n');
  }

  // New content-agnostic helper methods
  private generateContextualPatternName(contentInsight: any, repositoryContext: any): string {
    const { projectType, domain, primaryLanguages } = repositoryContext;
    const problemKeywords = contentInsight.problem.description.toLowerCase();
    
    // Generate specific pattern names based on actual context
    if (problemKeywords.includes('performance')) {
      return `${projectType === 'api' ? 'API' : 'Application'} Performance Optimization Pattern`;
    } else if (problemKeywords.includes('scale')) {
      return `${domain} Scalability Enhancement Pattern`;
    } else if (problemKeywords.includes('refactor') || problemKeywords.includes('maintain')) {
      return `${primaryLanguages[0] || 'Code'} Maintainability Improvement Pattern`;
    } else if (problemKeywords.includes('integration')) {
      return `${projectType} Integration Architecture Pattern`;
    } else if (problemKeywords.includes('test')) {
      return `${domain} Quality Assurance Pattern`;
    }
    
    return `${domain} Development Pattern`;
  }

  private determinePatternType(contentInsight: any, repositoryContext: any): string {
    const solution = contentInsight.solution.approach.toLowerCase();
    
    if (solution.includes('architect') || solution.includes('structure')) {
      return 'Architectural Pattern';
    } else if (solution.includes('design') || solution.includes('component')) {
      return 'Design Pattern';
    } else if (solution.includes('process') || solution.includes('workflow')) {
      return 'Process Pattern';
    } else if (solution.includes('performance') || solution.includes('optimize')) {
      return 'Performance Pattern';
    } else if (solution.includes('integration') || solution.includes('api')) {
      return 'Integration Pattern';
    }
    
    return 'Technical Pattern';
  }

  private getConfidenceDescription(confidence: number): string {
    if (confidence >= 0.8) return 'High confidence based on strong data correlation';
    if (confidence >= 0.6) return 'Moderate confidence with good data coverage';
    if (confidence >= 0.4) return 'Fair confidence with limited data correlation';
    return 'Low confidence due to insufficient data correlation';
  }

  private generateEvolutionAnalysis(gitAnalysis: any, vibeAnalysis: any, contentInsight: any): string {
    const analysis = [];
    
    if (gitAnalysis?.commits?.length > 0) {
      analysis.push(`**Git Evolution:** Analysis of ${gitAnalysis.commits.length} commits shows focused development in the following areas:`);
      
      // Analyze commit patterns
      const commitTypes = this.categorizeCommits(gitAnalysis.commits);
      for (const [type, count] of Object.entries(commitTypes)) {
        if (count > 0) {
          analysis.push(`- ${type}: ${count} commits`);
        }
      }
    }
    
    if (vibeAnalysis?.sessions?.length > 0) {
      analysis.push(`\n**Conversation Evolution:** ${vibeAnalysis.sessions.length} development sessions reveal decision-making process:`);
      analysis.push(`- Problem identification and solution discussion`);
      analysis.push(`- Technical decision rationale and tradeoffs`);
      analysis.push(`- Implementation approach and concerns`);
    }
    
    analysis.push(`\n**Impact Timeline:** ${contentInsight.problem.description} was addressed through ${contentInsight.solution.approach.toLowerCase()}, resulting in ${contentInsight.outcome.improvements.join(' and ')}.`);
    
    return analysis.join('\n');
  }

  private generateContextualImplementation(contentInsight: any, gitAnalysis: any, semanticAnalysis: any): string {
    const implementation = [];
    
    implementation.push(`**Implementation Approach:** ${contentInsight.solution.approach}`);
    
    if (contentInsight.solution.implementation.length > 0) {
      implementation.push(`\n**Key Changes:**`);
      contentInsight.solution.implementation.forEach((change: string) => {
        implementation.push(`- ${change}`);
      });
    }
    
    if (semanticAnalysis?.codeAnalysis?.architecturalPatterns?.length > 0) {
      implementation.push(`\n**Architectural Patterns Applied:**`);
      semanticAnalysis.codeAnalysis.architecturalPatterns.forEach((pattern: any) => {
        implementation.push(`- **${pattern.name}**: ${pattern.description} (Confidence: ${Math.round(pattern.confidence * 100)}%)`);
      });
    }
    
    return implementation.join('\n');
  }

  private generateRealCodeExample(contentInsight: any, semanticAnalysis: any, repositoryContext: any): string {
    const { primaryLanguages, frameworks } = repositoryContext;
    const mainLanguage = primaryLanguages[0] || 'JavaScript';
    
    // Generate contextual code examples based on the actual solution
    const solution = contentInsight.solution.approach.toLowerCase();
    
    if (solution.includes('api') || solution.includes('endpoint')) {
      return this.generateAPIExample(mainLanguage, frameworks);
    } else if (solution.includes('component') || solution.includes('ui')) {
      return this.generateComponentExample(mainLanguage, frameworks);
    } else if (solution.includes('database') || solution.includes('query')) {
      return this.generateDatabaseExample(mainLanguage, frameworks);
    } else if (solution.includes('performance') || solution.includes('optimize')) {
      return this.generatePerformanceExample(mainLanguage);
    }
    
    return this.generateGenericExample(mainLanguage, contentInsight);
  }

  private generateAPIExample(language: string, frameworks: string[]): string {
    if (frameworks.includes('Express.js')) {
      return `// Express.js API optimization
app.get('/api/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await userService.findById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    logger.error('User fetch error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});`;
    }
    
    return `// API implementation
async function handleRequest(request) {
  const { id } = request.params;
  const result = await service.process(id);
  return { success: true, data: result };
}`;
  }

  private generateComponentExample(language: string, frameworks: string[]): string {
    if (frameworks.includes('React')) {
      return `// React component optimization
import React, { memo, useCallback } from 'react';

const UserCard = memo(({ user, onEdit }) => {
  const handleEdit = useCallback(() => {
    onEdit(user.id);
  }, [user.id, onEdit]);

  return (
    <div className="user-card">
      <h3>{user.name}</h3>
      <button onClick={handleEdit}>Edit</button>
    </div>
  );
});

export default UserCard;`;
    }
    
    return `// Component implementation
class Component {
  constructor(props) {
    this.props = props;
  }
  
  render() {
    return this.props.children;
  }
}`;
  }

  private generateDatabaseExample(language: string, frameworks: string[]): string {
    return `// Database query optimization
const findUsersWithPagination = async (page = 1, limit = 20) => {
  const offset = (page - 1) * limit;
  
  const [users, total] = await Promise.all([
    db.users.findMany({
      skip: offset,
      take: limit,
      select: { id: true, name: true, email: true }
    }),
    db.users.count()
  ]);
  
  return {
    users,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};`;
  }

  private generatePerformanceExample(language: string): string {
    return `// Performance optimization implementation
const memoizedExpensiveOperation = useMemo(() => {
  return data.map(item => ({
    ...item,
    computed: expensiveCalculation(item)
  }));
}, [data]);

// Lazy loading implementation
const LazyComponent = lazy(() => import('./HeavyComponent'));`;
  }

  private generateGenericExample(language: string, contentInsight: any): string {
    return `// Solution implementation
class SolutionPattern {
  constructor(config) {
    this.config = config;
  }
  
  execute() {
    // Implementation based on: ${contentInsight.solution.approach}
    return this.process(this.config);
  }
  
  process(config) {
    // Core logic implementation
    return { success: true, result: config };
  }
}`;
  }

  private generateContextualUsageGuidelines(contentInsight: any, repositoryContext: any, isPositive: boolean): string {
    const guidelines = [];
    const { projectType, domain, architecturalStyle } = repositoryContext;
    
    if (isPositive) {
      guidelines.push(`- ${projectType} projects experiencing similar challenges`);
      guidelines.push(`- ${domain} domain applications requiring reliability`);
      guidelines.push(`- ${architecturalStyle} architectures needing optimization`);
      
      if (contentInsight.solution.technologies.length > 0) {
        guidelines.push(`- Teams using ${contentInsight.solution.technologies.join(', ')}`);
      }
    } else {
      guidelines.push(`- Simple ${projectType} projects without complexity needs`);
      guidelines.push(`- Prototype or proof-of-concept development`);
      guidelines.push(`- Systems with fundamentally different architecture than ${architecturalStyle}`);
      
      if (contentInsight.solution.tradeoffs.length > 0) {
        guidelines.push(`- When ${contentInsight.solution.tradeoffs[0].toLowerCase()}`);
      }
    }
    
    return guidelines.join('\n');
  }

  private generateRealProcessDescription(contentInsight: any, vibeAnalysis: any, gitAnalysis: any): string {
    const process = [];
    
    process.push(`1. **Problem Identification**: ${contentInsight.problem.description}`);
    process.push(`2. **Solution Design**: ${contentInsight.solution.approach}`);
    
    if (contentInsight.solution.implementation.length > 0) {
      process.push(`3. **Implementation Phase**:`);
      contentInsight.solution.implementation.forEach((impl: string, index: number) => {
        process.push(`   ${index + 1}. ${impl}`);
      });
    }
    
    process.push(`4. **Outcome Assessment**: ${contentInsight.outcome.improvements.join(', ')}`);
    
    if (contentInsight.outcome.newChallenges.length > 0) {
      process.push(`5. **Emerging Considerations**: ${contentInsight.outcome.newChallenges.join(', ')}`);
    }
    
    return process.join('\n');
  }

  private categorizeCommits(commits: any[]): Record<string, number> {
    const categories = {
      'Feature Development': 0,
      'Bug Fixes': 0,
      'Refactoring': 0,
      'Performance': 0,
      'Documentation': 0,
      'Configuration': 0,
      'Testing': 0
    };
    
    commits.forEach(commit => {
      const message = commit.message.toLowerCase();
      
      if (message.includes('feat') || message.includes('add') || message.includes('implement')) {
        categories['Feature Development']++;
      } else if (message.includes('fix') || message.includes('bug')) {
        categories['Bug Fixes']++;
      } else if (message.includes('refactor') || message.includes('restructure')) {
        categories['Refactoring']++;
      } else if (message.includes('perf') || message.includes('optimize')) {
        categories['Performance']++;
      } else if (message.includes('doc') || message.includes('readme')) {
        categories['Documentation']++;
      } else if (message.includes('config') || message.includes('setup')) {
        categories['Configuration']++;
      } else if (message.includes('test') || message.includes('spec')) {
        categories['Testing']++;
      }
    });
    
    return categories;
  }

  /**
   * Refresh entity insights based on validation report
   * Called by entity-refresh workflow to regenerate stale content
   */
  async refreshEntityInsights(params: {
    validation_report: any;
    current_analysis: any;
    entityName: string;
    regenerate_diagrams?: boolean;
    regenerate_all_diagrams?: boolean;  // Generate all 4 diagram types (architecture, sequence, class, use-cases)
  }): Promise<{
    success: boolean;
    refreshedInsightPath?: string;
    regeneratedDiagrams: string[];
    removedObservations: string[];
    updatedObservations: string[];
    summary: string;
  }> {
    const {
      validation_report,
      current_analysis,
      entityName,
      regenerate_diagrams = true,
      regenerate_all_diagrams = false
    } = params;

    log(`Refreshing insights for entity: ${entityName}`, 'info', {
      regenerate_diagrams,
      regenerate_all_diagrams
    });

    const result = {
      success: false,
      refreshedInsightPath: undefined as string | undefined,
      regeneratedDiagrams: [] as string[],
      removedObservations: [] as string[],
      updatedObservations: [] as string[],
      summary: ''
    };

    try {
      // Regenerate diagrams if requested
      if (regenerate_diagrams || regenerate_all_diagrams) {
        // COMPLETE REFRESH: Generate ALL 4 diagram types
        if (regenerate_all_diagrams) {
          log(`Generating ALL diagram types for ${entityName}`, 'info');
          const allDiagramTypes: Array<'architecture' | 'sequence' | 'class' | 'use-cases'> = [
            'architecture',
            'sequence',
            'class',
            'use-cases'
          ];

          for (const diagramType of allDiagramTypes) {
            try {
              const freshDiagram = await this.generateDiagramFromCurrentState(
                entityName,
                diagramType,
                current_analysis
              );

              if (freshDiagram) {
                result.regeneratedDiagrams.push(freshDiagram);
                log(`Generated ${diagramType} diagram: ${freshDiagram}`, 'info');
              }
            } catch (error) {
              log(`Failed to generate ${diagramType} diagram: ${error}`, 'warning');
            }
          }
        } else {
          // If validation report specifies specific diagrams to regenerate, use those
          const diagramsToRegenerate = validation_report?.suggestedActions?.regenerateDiagrams || [];

          if (diagramsToRegenerate.length > 0) {
            // Regenerate specific diagrams flagged by validation
            for (const diagramPath of diagramsToRegenerate) {
              try {
                const diagramName = path.basename(diagramPath, path.extname(diagramPath));
                const diagramType = this.inferDiagramType(diagramName);

                const freshDiagram = await this.generateDiagramFromCurrentState(
                  entityName,
                  diagramType,
                  current_analysis
                );

                if (freshDiagram) {
                  result.regeneratedDiagrams.push(freshDiagram);
                  log(`Regenerated diagram: ${freshDiagram}`, 'info');
                }
              } catch (error) {
                log(`Failed to regenerate diagram ${diagramPath}: ${error}`, 'warning');
              }
            }
          } else {
            // Default: generate architecture diagram at minimum
            log(`Generating architecture diagram for ${entityName}`, 'info');
            try {
              const freshDiagram = await this.generateDiagramFromCurrentState(
                entityName,
                'architecture',
                current_analysis
              );

              if (freshDiagram) {
                result.regeneratedDiagrams.push(freshDiagram);
                log(`Generated architecture diagram: ${freshDiagram}`, 'info');
              }
            } catch (error) {
              log(`Failed to generate architecture diagram: ${error}`, 'warning');
            }
          }
        }
      }

      // Track observations to remove/update based on validation
      if (validation_report?.suggestedActions?.removeObservations) {
        result.removedObservations = validation_report.suggestedActions.removeObservations;
      }

      if (validation_report?.suggestedActions?.updateObservations) {
        result.updatedObservations = validation_report.suggestedActions.updateObservations;
      }

      // If insight refresh is needed, regenerate the insight document
      if (validation_report?.suggestedActions?.refreshInsight) {
        const insightResult = await this.generateRefreshedInsightDocument(
          entityName,
          current_analysis,
          result.regeneratedDiagrams
        );

        if (insightResult) {
          result.refreshedInsightPath = insightResult.path;
        }
      }

      result.success = true;
      result.summary = this.generateRefreshSummary(result, validation_report);

      log(`Entity insights refreshed successfully`, 'info', {
        entityName,
        regeneratedDiagrams: result.regeneratedDiagrams.length,
        removedObservations: result.removedObservations.length,
        updatedObservations: result.updatedObservations.length
      });

    } catch (error) {
      log(`Failed to refresh entity insights: ${error}`, 'error');
      result.summary = `Failed to refresh insights: ${error}`;
    }

    return result;
  }

  /**
   * Infer diagram type from filename
   */
  private inferDiagramType(diagramName: string): 'architecture' | 'sequence' | 'class' | 'use-cases' {
    const nameLower = diagramName.toLowerCase();
    if (nameLower.includes('arch')) return 'architecture';
    if (nameLower.includes('seq')) return 'sequence';
    if (nameLower.includes('class')) return 'class';
    if (nameLower.includes('use')) return 'use-cases';
    return 'architecture'; // Default
  }

  /**
   * Generate a diagram based on current codebase state
   * Uses generatePlantUMLDiagram to properly save PUML files and generate PNGs
   */
  private async generateDiagramFromCurrentState(
    entityName: string,
    diagramType: 'architecture' | 'sequence' | 'class' | 'use-cases',
    currentAnalysis: any
  ): Promise<string | null> {
    try {
      // Build context from current analysis for diagram generation
      const diagramData = {
        patternCatalog: {
          patterns: currentAnalysis?.patterns || [],
          summary: {
            totalPatterns: currentAnalysis?.patterns?.length || 0,
            byCategory: {},
            avgSignificance: 7,
            topPatterns: []
          }
        },
        components: currentAnalysis?.components || [],
        relationships: currentAnalysis?.relationships || [],
        files: currentAnalysis?.files || [],
        entityInfo: currentAnalysis?.entity_info || {
          name: entityName,
          type: 'Pattern',
          observations: currentAnalysis?.observations || []
        },
        name: entityName
      };

      // Use generatePlantUMLDiagram which properly saves PUML and generates PNG
      const diagram = await this.generatePlantUMLDiagram(
        diagramType,
        entityName,
        diagramData
      );

      if (diagram && diagram.success) {
        log(`Successfully generated ${diagramType} diagram: ${diagram.pumlFile}`, 'info', {
          pngGenerated: !!diagram.pngFile
        });
        return diagram.pngFile || diagram.pumlFile || diagram.name;
      } else {
        log(`Diagram generation returned but was not successful for ${entityName}`, 'warning');
      }
    } catch (error) {
      log(`Error generating ${diagramType} diagram: ${error}`, 'warning');
    }

    return null;
  }

  /**
   * Generate a refreshed insight document with current state
   */
  private async generateRefreshedInsightDocument(
    entityName: string,
    currentAnalysis: any,
    regeneratedDiagrams: string[]
  ): Promise<{ path: string; content: string } | null> {
    try {
      // Extract entity info from current analysis
      const entityInfo = currentAnalysis?.entity_info ? {
        name: currentAnalysis.entity_info.name || entityName,
        type: currentAnalysis.entity_info.type || 'Pattern',
        observations: currentAnalysis.entity_info.observations || []
      } : {
        name: entityName,
        type: 'Pattern',
        observations: []
      };

      log(`Refreshing insight document for ${entityInfo.name} with ${entityInfo.observations.length} observations and ${regeneratedDiagrams.length} pre-generated diagrams`, 'info');

      // Convert regeneratedDiagrams paths to the format expected by generateTechnicalDocumentation
      // Diagram paths are like: /path/to/images/entity-name-type.png
      const diagrams: Array<{ name: string; type: string; success: boolean }> = [];
      for (const diagramPath of regeneratedDiagrams) {
        const basename = path.basename(diagramPath, path.extname(diagramPath));
        // Infer type from filename suffix (e.g., entity-name-architecture -> architecture)
        const diagramType = this.inferDiagramType(basename);
        diagrams.push({
          name: basename,
          type: diagramType,
          success: true // Already generated successfully
        });
        log(`Including pre-generated diagram: ${basename} (${diagramType})`, 'debug');
      }

      // Generate content directly with the pre-generated diagrams
      // This avoids duplicate diagram generation
      const content = await this.generateTechnicalDocumentation({
        entityName: entityInfo.name,
        entityType: entityInfo.type || 'Pattern',
        observations: entityInfo.observations,
        relations: currentAnalysis?.relations || [],
        diagrams
      });

      // Save the document
      // CONVENTION: .md files use PascalCase (entity name)
      const filePath = path.join(this.outputDir, `${entityInfo.name}.md`);

      await fs.promises.writeFile(filePath, content, 'utf8');
      log(`Insight document saved to ${filePath}`, 'info');

      return {
        path: filePath,
        content
      };
    } catch (error) {
      log(`Error generating refreshed insight document: ${error}`, 'warning');
    }

    return null;
  }

  /**
   * Generate a summary of the refresh operation
   */
  private generateRefreshSummary(
    result: {
      regeneratedDiagrams: string[];
      removedObservations: string[];
      updatedObservations: string[];
      refreshedInsightPath?: string;
    },
    validationReport: any
  ): string {
    const parts = [];

    if (result.regeneratedDiagrams.length > 0) {
      parts.push(`Regenerated ${result.regeneratedDiagrams.length} diagrams`);
    }

    if (result.removedObservations.length > 0) {
      parts.push(`Flagged ${result.removedObservations.length} observations for removal`);
    }

    if (result.updatedObservations.length > 0) {
      parts.push(`Flagged ${result.updatedObservations.length} observations for update`);
    }

    if (result.refreshedInsightPath) {
      parts.push(`Refreshed insight document at ${result.refreshedInsightPath}`);
    }

    const originalScore = validationReport?.overallScore || 0;
    parts.push(`Original validation score: ${originalScore}/100`);

    return parts.length > 0
      ? parts.join('. ') + '.'
      : 'No refresh actions were necessary.';
  }
}
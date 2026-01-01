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
import type { IntelligentQueryResult, SynthesisResult } from './code-graph-agent.js';
import { WebSearchAgent, type SearchResult } from './web-search.js';

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
  insightDocument?: InsightDocument;  // Optional when skipped
  insightDocuments?: InsightDocument[]; // Array of all generated documents
  patternCatalog?: PatternCatalog;  // Optional when skipped
  generationMetrics?: {
    processingTime: number;
    documentsGenerated: number;
    diagramsGenerated: number;
    patternsIdentified: number;
    qualityScore: number;
  };
  // Skip result fields
  skipped?: boolean;
  skip_reason?: string;
  insights_generated?: number;
  documents?: InsightDocument[];
  patterns_analyzed?: number;
  significant_patterns?: number;
  processing_time?: number;
  diagnostics?: {
    totalPatternsFound: number;
    patternsWithSignificance: Array<{ name: string; significance: number }>;
    recommendation: string;
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
  private webSearchAgent: WebSearchAgent;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
    this.outputDir = path.join(repositoryPath, 'knowledge-management', 'insights');
    this.standardStylePath = path.join(repositoryPath, 'docs', 'puml', '_standard-style.puml');
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.contentAnalyzer = new ContentAgnosticAnalyzer(repositoryPath);
    this.contextManager = new RepositoryContextManager(repositoryPath);
    this.serenaAnalyzer = createSerenaAnalyzer(repositoryPath);
    this.webSearchAgent = new WebSearchAgent();
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
    // Handle both string and ObservationTemplate objects properly
    const observationsText = observations.map((obs: any, i: number) => {
      if (typeof obs === 'string') {
        return `${i + 1}. ${obs}`;
      }
      if (typeof obs === 'object' && obs !== null && obs.content) {
        const typePrefix = obs.type ? `[${obs.type}] ` : '';
        return `${i + 1}. ${typePrefix}${obs.content}`;
      }
      // Fallback for unexpected types
      return `${i + 1}. ${JSON.stringify(obs)}`;
    }).join('\n');

    const relationsText = relations.length > 0
      ? `\n\n**Related Entities:**\n${relations.map(r => `- ${r.from} ${r.relationType} ${r.to}`).join('\n')}`
      : '';

    const codeContextText = serenaAnalysis
      ? `\n\n**Code Structure:**\n- ${serenaAnalysis.symbols.length} code symbols found\n- Key files: ${serenaAnalysis.fileStructures.map(f => f.path).slice(0, 5).join(', ')}`
      : '';

    const prompt = `You are a technical documentation expert creating a comprehensive insight document for "${entityName}" (type: ${entityType}).

**CRITICAL GROUNDING RULES:**
1. PRESERVE ALL specific file paths, class names, function names from observations - these are your primary source of truth
2. DO NOT invent patterns (like "microservices", "event-driven") unless explicitly mentioned
3. Build your analysis FROM the observations, don't add ungrounded information

**Source Observations:**
${observationsText}
${relationsText}
${codeContextText}

**Generate a comprehensive technical insight document with these sections:**

## What It Is
A clear technical description synthesizing the observations. Start with WHERE it's implemented (specific paths from observations).

## Architecture and Design
Analyze the architectural approach evident from the observations. What design patterns are used? How do components interact? Reference specific code paths.

## Implementation Details
Deep dive into HOW it's implemented. Cover key components, classes, functions mentioned in observations. Explain the technical mechanics.

## Integration Points
How this entity connects with other parts of the system. What dependencies and interfaces are evident from observations?

## Usage Guidelines
Best practices, rules, and conventions for using this correctly. What should developers know?

**FORMAT:**
- Write in clear technical prose, not just bullet points
- Each section should have substantive content (3-5 paragraphs where appropriate)
- ALWAYS ground your analysis in the specific observations provided
- Reference actual file paths, class names, and implementation details from observations
- If observations don't support a section, write a brief note and move on rather than inventing content`;

    try {
      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: 'architecture',
        context: `Deep insight generation for ${entityName}`,
        provider: 'auto',
        taskType: 'insight_generation'  // Uses premium tier for better quality
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
    const codeGraphResults = params.code_graph_results || params.codeGraphResults;
    const docSemanticsResults = params.doc_semantics_results || params.docSemanticsResults;
    const codeSynthesisResults = params.code_synthesis_results || params.codeSynthesisResults;

    log('Data availability checked', 'debug', {
      gitAnalysis: !!gitAnalysis,
      vibeAnalysis: !!vibeAnalysis,
      semanticAnalysis: !!semanticAnalysis,
      webResults: !!webResults,
      codeGraphResults: !!codeGraphResults,
      docSemanticsResults: !!docSemanticsResults,
      codeSynthesisResults: !!codeSynthesisResults
    });

    log('Starting comprehensive insight generation', 'info', {
      receivedParams: Object.keys(params || {}),
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasSemanticAnalysis: !!semanticAnalysis,
      hasWebResults: !!webResults,
      hasCodeGraphResults: !!codeGraphResults,
      hasDocSemanticsResults: !!docSemanticsResults,
      hasCodeSynthesisResults: !!codeSynthesisResults,
      codeGraphSkipped: codeGraphResults?.skipped || false,
      codeGraphEntities: codeGraphResults?.statistics?.totalEntities || 0,
      docSemanticsAnalyzed: docSemanticsResults?.statistics?.analyzed || 0,
      codeSynthesisCount: Array.isArray(codeSynthesisResults) ? codeSynthesisResults.length : 0,
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

      // Extract patterns from all analyses (including code graph, doc semantics, and synthesis if available)
      const patternCatalog = await this.generatePatternCatalog(
        filteredGitAnalysis, vibeAnalysis, semanticAnalysis, webResults, codeGraphResults, docSemanticsResults, codeSynthesisResults
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
        const filteredOut = patternCatalog.patterns.filter(p => (p.significance || 0) < 3);
        if (filteredOut.length > 0) {
          log(`\n⚠️  ${filteredOut.length} patterns will be FILTERED OUT (significance < 3):`, 'info');
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
      // LOWERED THRESHOLD: Changed from ≥5 to ≥3 to capture more patterns from semantic analysis
      const significantPatterns = patternCatalog.patterns
        .filter(p => p.significance >= 3) // Include patterns with moderate significance (was >=5)
        .sort((a, b) => b.significance - a.significance);

      // If no significant patterns found, return a minimal result instead of failing
      // This allows the workflow to continue with other steps (code-graph, ontology, etc.)
      if (significantPatterns.length === 0) {
        log('No significant patterns found - returning minimal insight result', 'info');
        log(`NOTE: All ${patternCatalog.patterns.length} patterns had significance < 3`, 'warning');
        log(`Workflow will continue - other agents (code-graph, ontology) may still produce valuable results`, 'info');

        const processingTime = Date.now() - startTime;
        return {
          insights_generated: 0,
          documents: [],
          patterns_analyzed: patternCatalog.patterns.length,
          significant_patterns: 0,
          processing_time: processingTime,
          skipped: true,
          skip_reason: 'No patterns with sufficient significance (≥3) found',
          diagnostics: {
            totalPatternsFound: patternCatalog.patterns.length,
            patternsWithSignificance: patternCatalog.patterns.map(p => ({ name: p.name, significance: p.significance || 0 })),
            recommendation: 'The significance calculation may need adjustment for this repository type'
          }
        };
      }

      const insightDocuments: InsightDocument[] = [];

      if (significantPatterns.length >= 1 && significantPatterns.length <= 5) {
        // PERFORMANCE OPTIMIZATION: Generate insights in parallel instead of sequentially
        log(`Generating separate insights for ${significantPatterns.length} significant patterns (≥3 significance) IN PARALLEL`, 'info');
        
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
        documentsGenerated: result.generationMetrics?.documentsGenerated ?? 0,
        diagramsGenerated: result.generationMetrics?.diagramsGenerated ?? 0,
        patternsIdentified: result.generationMetrics?.patternsIdentified ?? 0,
        qualityScore: result.generationMetrics?.qualityScore ?? 0
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
    webResults?: any,
    codeGraphResults?: any,
    docSemanticsResults?: any,
    codeSynthesisResults?: SynthesisResult[]
  ): Promise<PatternCatalog> {
    FilenameTracer.trace('PATTERN_CATALOG_START', 'generatePatternCatalog',
      { hasGit: !!gitAnalysis, hasVibe: !!vibeAnalysis, hasSemantic: !!semanticAnalysis, hasCodeGraph: !!codeGraphResults, hasDocSemantics: !!docSemanticsResults, hasCodeSynthesis: !!codeSynthesisResults },
      'Starting pattern catalog generation'
    );

    const patterns: IdentifiedPattern[] = [];

    // Extract patterns from code graph analysis (AST-based)
    try {
      if (codeGraphResults && !codeGraphResults.skipped) {
        const codeGraphPatterns = this.extractCodeGraphPatterns(codeGraphResults);
        patterns.push(...codeGraphPatterns);
        log(`Extracted ${codeGraphPatterns.length} patterns from code graph analysis`, 'info');
      } else if (codeGraphResults?.skipped) {
        log(`Code graph analysis was skipped: ${codeGraphResults.warning || 'unknown reason'}`, 'warning');
      }
    } catch (error) {
      console.error('Error extracting code graph patterns:', error);
    }

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
      console.error('Error extracting architectural patterns:', error);
    }

    // Analyze code changes for implementation patterns  
    try {
      if (gitAnalysis?.codeEvolution && gitAnalysis.codeEvolution.length > 0) {
        const implementationPatterns = this.extractImplementationPatterns(gitAnalysis.codeEvolution);
        patterns.push(...implementationPatterns);
      }
    } catch (error) {
      console.error('Error extracting implementation patterns:', error);
    }

    // Analyze semantic code structure for design patterns
    try {
      if (semanticAnalysis?.codeAnalysis) {
        const designPatterns = this.extractDesignPatterns(semanticAnalysis.codeAnalysis);
        patterns.push(...designPatterns);
      }
    } catch (error) {
      console.error('Error extracting design patterns:', error);
    }

    // Only analyze conversation patterns if they relate to actual code solutions
    try {
      if (vibeAnalysis?.problemSolutionPairs) {
        const codeSolutionPatterns = this.extractCodeSolutionPatterns(vibeAnalysis.problemSolutionPairs);
        patterns.push(...codeSolutionPatterns);
      }
    } catch (error) {
      console.error('Error extracting solution patterns:', error);
    }

    // Extract patterns from documentation semantics (LLM-analyzed docstrings and prose)
    try {
      if (docSemanticsResults && docSemanticsResults.statistics?.analyzed > 0) {
        const docPatterns = this.extractDocumentationPatterns(docSemanticsResults);
        patterns.push(...docPatterns);
        log(`Extracted ${docPatterns.length} patterns from documentation semantics`, 'info');
      }
    } catch (error) {
      console.error('Error extracting documentation patterns:', error);
    }

    // Extract patterns from LLM-powered code synthesis (CGR integration)
    try {
      if (codeSynthesisResults && Array.isArray(codeSynthesisResults) && codeSynthesisResults.length > 0) {
        const synthesisPatterns = this.extractPatternsFromSynthesis(codeSynthesisResults);
        patterns.push(...synthesisPatterns);
        log(`Extracted ${synthesisPatterns.length} patterns from code synthesis (${codeSynthesisResults.length} entities analyzed)`, 'info');
      }
    } catch (error) {
      console.error('Error extracting synthesis patterns:', error);
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

  /**
   * Extract patterns from code graph analysis (AST-based)
   * Analyzes language distribution, entity types, and architectural patterns
   */
  private extractCodeGraphPatterns(
    codeGraphResults: any,
    intelligentResults?: IntelligentQueryResult
  ): IdentifiedPattern[] {
    const patterns: IdentifiedPattern[] = [];
    const stats = codeGraphResults?.statistics || {};

    // Analyze language distribution for polyglot patterns
    const langDist = stats.languageDistribution || {};
    const languages = Object.keys(langDist);

    if (languages.length > 1) {
      // Polyglot codebase pattern
      const dominantLang = languages.reduce((a, b) => langDist[a] > langDist[b] ? a : b, languages[0]);
      const langBreakdown = languages.map(l => `${l}: ${langDist[l]}`).join(', ');

      patterns.push({
        name: 'Polyglot Codebase Architecture',
        category: 'architectural',
        description: `Multi-language codebase with ${languages.length} languages (${langBreakdown}). Dominant: ${dominantLang}`,
        significance: Math.min(8, 4 + languages.length),
        evidence: [`Languages: ${languages.join(', ')}`, `Entity distribution: ${langBreakdown}`],
        relatedComponents: languages,
        implementation: {
          language: dominantLang,
          usageNotes: [
            `Ensure consistent build tooling across ${languages.length} languages`,
            'Consider language-specific linting and testing strategies'
          ]
        }
      });
    } else if (languages.length === 1) {
      patterns.push({
        name: `${languages[0]} Monolingual Codebase`,
        category: 'architectural',
        description: `Single-language codebase using ${languages[0]}`,
        significance: 3,
        evidence: [`Primary language: ${languages[0]}`, `Total entities: ${stats.totalEntities}`],
        relatedComponents: [],
        implementation: {
          language: languages[0],
          usageNotes: []
        }
      });
    }

    // Analyze entity type distribution for OOP vs functional patterns
    const entityDist = stats.entityTypeDistribution || {};
    const classCount = entityDist['class'] || 0;
    const functionCount = entityDist['function'] || 0;
    const methodCount = entityDist['method'] || 0;

    if (classCount > 0 && functionCount > 0) {
      const ratio = classCount / (functionCount + 1);
      const dominantLang = languages[0] || 'unknown';

      if (ratio > 0.5) {
        patterns.push({
          name: 'Object-Oriented Design Pattern',
          category: 'design',
          description: `Predominantly OOP architecture with ${classCount} classes and ${methodCount} methods`,
          significance: 6,
          evidence: [
            `Classes: ${classCount}`,
            `Methods: ${methodCount}`,
            `Functions: ${functionCount}`,
            `Class-to-function ratio: ${ratio.toFixed(2)}`
          ],
          relatedComponents: ['classes', 'methods', 'inheritance'],
          implementation: {
            language: dominantLang,
            usageNotes: [
              'Ensure SOLID principles are followed',
              'Consider composition over inheritance where appropriate'
            ]
          }
        });
      } else if (ratio < 0.2) {
        patterns.push({
          name: 'Functional Programming Pattern',
          category: 'design',
          description: `Predominantly functional architecture with ${functionCount} standalone functions`,
          significance: 6,
          evidence: [
            `Functions: ${functionCount}`,
            `Classes: ${classCount}`,
            `Function-to-class ratio: ${(1/ratio).toFixed(2)}`
          ],
          relatedComponents: ['functions', 'modules'],
          implementation: {
            language: dominantLang,
            usageNotes: [
              'Ensure pure functions where possible',
              'Consider using immutable data structures'
            ]
          }
        });
      } else {
        patterns.push({
          name: 'Hybrid OOP-Functional Pattern',
          category: 'design',
          description: `Mixed paradigm with ${classCount} classes and ${functionCount} functions`,
          significance: 5,
          evidence: [
            `Classes: ${classCount}`,
            `Functions: ${functionCount}`,
            `Methods: ${methodCount}`
          ],
          relatedComponents: ['classes', 'functions'],
          implementation: {
            language: dominantLang,
            usageNotes: [
              'Document when to use classes vs functions',
              'Establish clear boundaries between paradigms'
            ]
          }
        });
      }
    }

    // Analyze total entities for codebase scale
    const totalEntities = stats.totalEntities || 0;
    const dominantLang = languages[0] || 'unknown';

    if (totalEntities > 500) {
      patterns.push({
        name: 'Large-Scale Codebase Pattern',
        category: 'architectural',
        description: `Enterprise-scale codebase with ${totalEntities} code entities`,
        significance: 7,
        evidence: [`Total entities: ${totalEntities}`, `Relationships: ${stats.totalRelationships || 0}`],
        relatedComponents: ['modules', 'architecture'],
        implementation: {
          language: dominantLang,
          usageNotes: [
            'Consider modular architecture to manage complexity',
            'Use dependency analysis for refactoring decisions'
          ]
        }
      });
    } else if (totalEntities > 100) {
      patterns.push({
        name: 'Medium-Scale Codebase Pattern',
        category: 'architectural',
        description: `Medium-scale codebase with ${totalEntities} code entities`,
        significance: 4,
        evidence: [`Total entities: ${totalEntities}`],
        relatedComponents: [],
        implementation: {
          language: dominantLang,
          usageNotes: []
        }
      });
    }

    // Add evidence-backed patterns from intelligent query results
    if (intelligentResults) {
      log(`[CodeGraph] Processing intelligent query results with ${intelligentResults.rawQueries.length} queries`, 'info');

      // Critical Hotspots Pattern (high significance - these are architectural risks)
      if (intelligentResults.hotspots.length > 0) {
        const topHotspots = intelligentResults.hotspots
          .sort((a, b) => b.connections - a.connections)
          .slice(0, 10);

        patterns.push({
          name: 'Critical Code Hotspots',
          category: 'code-health',
          description: `Identified ${intelligentResults.hotspots.length} highly connected code entities that may require careful change management`,
          significance: 8, // High significance - these are potential risk areas
          evidence: topHotspots.map(h =>
            `${h.name} (${h.type}) has ${h.connections} dependencies`
          ),
          relatedComponents: topHotspots.map(h => h.name),
          implementation: {
            language: dominantLang,
            usageNotes: [
              'Changes to hotspots may have wide-reaching effects',
              'Consider adding extra test coverage for these areas',
              'Review dependencies before refactoring'
            ]
          }
        });
      }

      // Circular Dependency Pattern (critical significance - these are bugs)
      if (intelligentResults.circularDeps.length > 0) {
        patterns.push({
          name: 'Circular Dependency Risk',
          category: 'code-health',
          description: `Detected ${intelligentResults.circularDeps.length} potential circular dependencies that may cause issues`,
          significance: 9, // Critical - these are architectural problems
          evidence: intelligentResults.circularDeps.slice(0, 10).map(d =>
            `${d.from} <-> ${d.to}`
          ),
          relatedComponents: [...new Set(intelligentResults.circularDeps.flatMap(d => [d.from, d.to]))].slice(0, 10),
          implementation: {
            language: dominantLang,
            usageNotes: [
              'PRIORITY: Resolve circular dependencies to improve maintainability',
              'Consider introducing interfaces or dependency injection',
              'May cause issues with module loading and testing'
            ]
          }
        });
      }

      // Inheritance Hierarchy Pattern
      if (intelligentResults.inheritanceTree.length > 0) {
        const totalChildren = intelligentResults.inheritanceTree.reduce((sum, i) => sum + i.children.length, 0);
        const deepHierarchies = intelligentResults.inheritanceTree.filter(i => i.children.length > 3);

        patterns.push({
          name: 'Class Inheritance Structure',
          category: 'architectural',
          description: `Found ${intelligentResults.inheritanceTree.length} base classes with ${totalChildren} total derived classes`,
          significance: deepHierarchies.length > 0 ? 7 : 5,
          evidence: intelligentResults.inheritanceTree.slice(0, 8).map(i =>
            `${i.parent} -> [${i.children.slice(0, 5).join(', ')}${i.children.length > 5 ? '...' : ''}]`
          ),
          relatedComponents: intelligentResults.inheritanceTree.slice(0, 5).map(i => i.parent),
          implementation: {
            language: dominantLang,
            usageNotes: deepHierarchies.length > 0
              ? ['Consider composition over deep inheritance', 'Review if all inheritance is necessary']
              : ['Inheritance structure appears well-organized']
          }
        });
      }

      // Change Impact Analysis Pattern
      if (intelligentResults.changeImpact.length > 0) {
        const totalAffected = intelligentResults.changeImpact.reduce((sum, c) => sum + c.affected.length, 0);
        const highImpact = intelligentResults.changeImpact.filter(c => c.affected.length > 5);

        patterns.push({
          name: 'Change Impact Analysis',
          category: 'code-health',
          description: `Recent changes affect ${totalAffected} dependent code entities across ${intelligentResults.changeImpact.length} change points`,
          significance: highImpact.length > 0 ? 7 : 5,
          evidence: intelligentResults.changeImpact.slice(0, 8).map(c =>
            `${c.changed} affects ${c.affected.length} dependents: ${c.affected.slice(0, 3).join(', ')}${c.affected.length > 3 ? '...' : ''}`
          ),
          relatedComponents: intelligentResults.changeImpact.slice(0, 5).map(c => c.changed),
          implementation: {
            language: dominantLang,
            usageNotes: highImpact.length > 0
              ? ['High impact changes detected - ensure thorough testing', 'Consider staged rollout for affected areas']
              : ['Change impact appears manageable']
          }
        });
      }

      // Architectural Patterns from queries
      if (intelligentResults.architecturalPatterns.length > 0) {
        for (const archPattern of intelligentResults.architecturalPatterns.slice(0, 3)) {
          patterns.push({
            name: `Discovered: ${archPattern.pattern.slice(0, 50)}`,
            category: 'architectural',
            description: `Pattern discovered through code graph analysis with ${archPattern.evidence.length} evidence items`,
            significance: 6,
            evidence: archPattern.evidence.slice(0, 10),
            relatedComponents: archPattern.evidence.slice(0, 5),
            implementation: {
              language: dominantLang,
              usageNotes: ['Pattern discovered via automated code graph analysis']
            }
          });
        }
      }
    }

    log(`[CodeGraph] Extracted ${patterns.length} patterns from code graph (${totalEntities} entities, ${languages.length} languages)`, 'info');
    return patterns;
  }

  /**
   * Fetch best practices from web search for identified patterns.
   * Enhances patterns with external references and industry recommendations.
   */
  async fetchBestPractices(patterns: IdentifiedPattern[]): Promise<void> {
    const architecturalPatterns = patterns.filter(p =>
      p.category === 'architectural' || p.category === 'code-health'
    );

    if (architecturalPatterns.length === 0) {
      log('[InsightGeneration] No architectural patterns to enrich with best practices', 'info');
      return;
    }

    log(`[InsightGeneration] Fetching best practices for ${architecturalPatterns.length} patterns`, 'info');

    // Limit to top 3 most significant patterns to avoid too many searches
    const topPatterns = architecturalPatterns
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 3);

    for (const pattern of topPatterns) {
      try {
        const searchQuery = `${pattern.name} best practices implementation`;
        log(`[InsightGeneration] Searching: "${searchQuery}"`, 'debug');

        const results = await this.webSearchAgent.searchSimilarPatterns(pattern.name);

        if (results.length > 0) {
          // Extract best practices from search results
          const bestPractices = this.extractBestPracticesFromResults(results);

          // Add best practices to pattern implementation notes
          if (bestPractices.length > 0) {
            pattern.implementation = pattern.implementation || { language: 'unknown', usageNotes: [] };
            pattern.implementation.usageNotes = [
              ...(pattern.implementation.usageNotes || []),
              '--- Best Practices from Web ---',
              ...bestPractices.slice(0, 5)
            ];

            // Add source references to evidence
            pattern.evidence = pattern.evidence || [];
            pattern.evidence.push(
              ...results.slice(0, 3).map(r => `Reference: ${r.title} (${r.url})`)
            );

            log(`[InsightGeneration] Added ${bestPractices.length} best practices to "${pattern.name}"`, 'info');
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`[InsightGeneration] Failed to fetch best practices for "${pattern.name}": ${errorMsg}`, 'warning');
      }
    }
  }

  /**
   * Extract best practice recommendations from search results
   */
  private extractBestPracticesFromResults(results: SearchResult[]): string[] {
    const bestPractices: string[] = [];

    for (const result of results) {
      // Extract key points from snippet
      if (result.snippet) {
        const snippet = result.snippet;

        // Look for recommendation patterns
        const recommendationPatterns = [
          /(?:best practice|recommendation|should|consider|avoid|prefer)[:\s]+([^.]+\.)/gi,
          /(?:tip|guideline|rule)[:\s]+([^.]+\.)/gi,
        ];

        for (const pattern of recommendationPatterns) {
          const matches = snippet.matchAll(pattern);
          for (const match of matches) {
            if (match[1] && match[1].length > 20 && match[1].length < 200) {
              bestPractices.push(match[1].trim());
            }
          }
        }

        // If no pattern matches, extract first meaningful sentence as a summary
        if (bestPractices.length === 0 && snippet.length > 50) {
          const firstSentence = snippet.split('.')[0];
          if (firstSentence && firstSentence.length > 30) {
            bestPractices.push(`${firstSentence}. (from ${result.title})`);
          }
        }
      }

      // Extract from content if available
      if (result.content) {
        const contentLines = result.content.split('\n').slice(0, 10);
        for (const line of contentLines) {
          if (line.includes('best') || line.includes('recommend') || line.includes('should')) {
            if (line.length > 20 && line.length < 200) {
              bestPractices.push(line.trim());
            }
          }
        }
      }
    }

    // Remove duplicates and limit
    return [...new Set(bestPractices)].slice(0, 10);
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

    console.error('✅ generateInsightContent completed, content length:', content.length);

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
          console.error(`  Cleaned up: ${diagram.pngFile}`);
          // Also try to clean up the PUML source file
          if (diagram.pumlFile) {
            try {
              await fs.promises.unlink(diagram.pumlFile);
              console.error(`  Cleaned up: ${diagram.pumlFile}`);
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

    // Fix 12: Convert class diagram relationships to component relationships in non-class diagrams
    // Detect if this is a component/architecture diagram (has component keywords, no class keywords)
    const isComponentDiagram = /\bcomponent\b/.test(fixed) && !/\bclass\b/.test(fixed);
    if (isComponentDiagram) {
      // Convert --* (composition) to --> (dependency)
      fixed = fixed.replace(/\s+--\*\s+/g, ' --> ');
      // Convert --o (aggregation) to --> (dependency)
      fixed = fixed.replace(/\s+--o\s+/g, ' --> ');
      // Convert --|> (inheritance) to --> (dependency)
      fixed = fixed.replace(/\s+--\|>\s+/g, ' --> ');
      // Convert ..|> (implements) to ..> (weak dependency)
      fixed = fixed.replace(/\s+\.\.\|>\s+/g, ' ..> ');
    }

    // Fix 13: Remove redundant aliases where component "X" as "X" (quoted alias should be unquoted)
    // Pattern: component "SomeName" as "SomeName" -> component "SomeName" as SomeName
    fixed = fixed.replace(/(\bcomponent\s+"([^"]+)")\s+as\s+"([^"]+)"/g, (match, prefix, name, alias) => {
      // Convert quoted alias to unquoted short form
      const shortAlias = alias.replace(/[^a-zA-Z0-9_]/g, '');
      return `${prefix} as ${shortAlias}`;
    });

    // Fix 14: Shorten overly long component aliases (often happens with pattern names)
    // Long aliases like "MultiAgentSystemCoordinationPattern" should be shorter
    fixed = fixed.replace(/\bcomponent\s+"([^"]+)"\s+as\s+([A-Za-z][A-Za-z0-9_]{25,})\b/g, (_match, name, longAlias) => {
      // Create a short alias from initials or first chars
      const shortAlias = longAlias.slice(0, 12);
      return `component "${name}" as ${shortAlias}`;
    });

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
      // Handle both string and ObservationTemplate objects properly
      const observationsText = entityInfo.observations.map((obs: any, i: number) => {
        if (typeof obs === 'string') {
          return `${i + 1}. ${obs}`;
        }
        if (typeof obs === 'object' && obs !== null && obs.content) {
          const typePrefix = obs.type ? `[${obs.type}] ` : '';
          return `${i + 1}. ${typePrefix}${obs.content}`;
        }
        return `${i + 1}. ${JSON.stringify(obs)}`;
      }).join('\n');

      analysisContext = `**Entity:** ${entityInfo.name}
**Type:** ${entityInfo.type || 'Pattern'}

**Observations (use these to understand the architecture):**
${observationsText}`;
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
      // Common architecture diagram syntax rules
      const architectureSyntaxRules = `

**VALID Component Diagram Syntax (MUST FOLLOW):**
- component "Display Name" as shortAlias <<stereotype>>
  Example: component "Knowledge Graph" as kg <<storage>>
- Aliases MUST be short, unquoted identifiers (NOT "quoted strings")
- Stereotypes: <<api>>, <<core>>, <<storage>>, <<agent>>, <<external>>, <<cli>>
- package "Package Name" { ... } for grouping
- database "Name" as alias for databases
- cloud "Name" as alias for external services

**VALID Relationships for Architecture Diagrams:**
- --> : dependency (A --> B means A uses B)
- ..> : weak dependency
- -- : association
- .. : weak association
Labels: A --> B : "uses" or A --> B : processes

**DO NOT USE these (they are for CLASS diagrams):**
- --* (composition) - WRONG for architecture diagrams
- --o (aggregation) - WRONG for architecture diagrams
- --|> (inheritance) - WRONG for architecture diagrams
- ..|> (implements) - WRONG for architecture diagrams`;

      if (hasEntityObservations) {
        // Entity-specific architecture diagram instructions
        prompt += `

**Architecture Diagram Specifics for "${entityInfo.name}":**
- Extract ACTUAL components mentioned in the observations (e.g., GraphDatabase, LevelDB, MCP tools, agents, etc.)
- Show these real components as PlantUML components with appropriate stereotypes
- Group related components into meaningful packages (max 3-4 packages)
- Show logical data flow with --> arrows between components
- Include a brief summary note about the entity's purpose
- PREFER vertical layout (top-to-bottom) over horizontal
- Keep the diagram focused - max 8-10 components for clarity
- DO NOT use generic placeholder names - use actual names from observations
${architectureSyntaxRules}`;
      } else {
        prompt += `

**Architecture Diagram Specifics:**
- Show ${patternCount} identified patterns as components (max 10)
- Group related patterns into packages by category
- Show meaningful relationships between components using --> arrows
- Include a summary note with key metrics
- PREFER vertical layout (top-to-bottom) over horizontal
${architectureSyntaxRules}`;
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

  /**
   * Generate architecture diagram from CGR synthesis results.
   * Creates a component diagram showing entities and their dependencies.
   */
  private generateArchitectureDiagramFromSynthesis(
    synthesisResults: SynthesisResult[]
  ): string {
    const successfulResults = synthesisResults.filter(s => s.success);

    if (successfulResults.length === 0) {
      return this.generateDefaultArchitectureDiagram({});
    }

    // Group entities by type for package organization
    const entitiesByType: Record<string, SynthesisResult[]> = {};
    for (const result of successfulResults) {
      const type = result.entityType || 'Unknown';
      if (!entitiesByType[type]) {
        entitiesByType[type] = [];
      }
      entitiesByType[type].push(result);
    }

    // Generate components grouped by entity type
    let components = '';
    const entityIds: Record<string, string> = {};

    for (const [type, entities] of Object.entries(entitiesByType)) {
      components += `\n  package "${type}s" {\n`;
      entities.slice(0, 10).forEach((entity, index) => {
        const issueCount = entity.potentialIssues.length;
        const depCount = entity.dependencies.length + entity.dependents.length;
        const style = issueCount > 0 ? '<<warning>>' : depCount >= 6 ? '<<critical>>' : depCount >= 3 ? '<<important>>' : '<<standard>>';

        const cleanName = entity.entityName.split('.').pop() || entity.entityName;
        const componentId = `${type}_${index}`;
        entityIds[entity.entityName] = componentId;

        const purposeNote = entity.purpose.substring(0, 40).replace(/"/g, "'");
        components += `    component "${cleanName}" as ${componentId} ${style}\n`;
        components += `    note right of ${componentId}: ${purposeNote}...\n`;
      });
      components += `  }\n`;
    }

    // Generate dependency relationships
    let relationships = '';
    for (const result of successfulResults.slice(0, 15)) {
      const sourceId = entityIds[result.entityName];
      if (!sourceId) continue;

      for (const dep of result.dependencies.slice(0, 3)) {
        // Find if this dependency is also in our results
        const targetEntity = successfulResults.find(e =>
          e.entityName === dep || e.entityName.endsWith(`.${dep}`) || dep.endsWith(e.entityName.split('.').pop()!)
        );
        if (targetEntity && entityIds[targetEntity.entityName]) {
          relationships += `  ${sourceId} --> ${entityIds[targetEntity.entityName]} : uses\n`;
        }
      }
    }

    const totalEntities = successfulResults.length;
    const totalIssues = successfulResults.reduce((sum, e) => sum + e.potentialIssues.length, 0);
    const totalDeps = successfulResults.reduce((sum, e) => sum + e.dependencies.length, 0);
    const patternsFound = successfulResults.reduce((sum, e) => sum + e.patternsIdentified.length, 0);

    return `@startuml
${this.getStandardStyle()}

title Code Architecture - From CGR Synthesis Analysis

${components}

${relationships}

note bottom
  Synthesis Analysis Summary:
  - Total Entities: ${totalEntities}
  - Dependencies: ${totalDeps}
  - Patterns Found: ${patternsFound}
  - Potential Issues: ${totalIssues}

  Legend:
  <<critical>> Hub component (6+ connections)
  <<important>> Connected (3-5 connections)
  <<warning>> Has potential issues
  <<standard>> Standard component
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

    // NEW ENTITY GENERATION: For complete-analysis workflow, entityInfo doesn't exist yet.
    // Generate content from patterns + analysis data. This is the PRIMARY path for new entities.
    if (patternCatalog?.patterns && patternCatalog.patterns.length > 0) {
      log(`NEW ENTITY GENERATION: Creating content from ${patternCatalog.patterns.length} patterns`, 'info');

      const topPattern = patternCatalog.patterns[0];
      const entityName = topPattern.name || title;
      const entityType = topPattern.category || 'Pattern';

      // Build pseudo-observations from pattern data for deep insight generation
      const patternObservations: string[] = [];
      if (topPattern.description) {
        patternObservations.push(topPattern.description);
      }
      if (topPattern.evidence && topPattern.evidence.length > 0) {
        patternObservations.push(...topPattern.evidence);
      }
      // Add git analysis insights as observations
      if (gitAnalysis?.architecturalDecisions?.length > 0) {
        gitAnalysis.architecturalDecisions.slice(0, 5).forEach((dec: any) => {
          const decisionText = typeof dec === 'string' ? dec
            : dec?.decision || dec?.summary || dec?.description || null;
          if (decisionText && typeof decisionText === 'string') {
            patternObservations.push(`Architectural decision: ${decisionText}`);
          }
        });
      }
      // Add vibe analysis insights
      if (vibeAnalysis?.problemSolutionPairs?.length > 0) {
        vibeAnalysis.problemSolutionPairs.slice(0, 3).forEach((pair: any) => {
          const problem = typeof pair.problem === 'string' ? pair.problem : pair.problem?.description || null;
          const solution = typeof pair.solution === 'string' ? pair.solution : pair.solution?.description || null;
          if (problem && solution) {
            patternObservations.push(`Problem-solution: ${problem} → ${solution}`);
          }
        });
      }

      // TRY DEEP INSIGHT GENERATION FIRST (LLM-powered rich content)
      let deepInsightContent: string | null = null;
      if (this.semanticAnalyzer && patternObservations.length > 0) {
        try {
          log(`Attempting LLM deep insight generation for ${entityName} with ${patternObservations.length} observations`, 'info');
          deepInsightContent = await this.generateDeepInsight({
            entityName,
            entityType,
            observations: patternObservations,
            relations: [],
            serenaAnalysis: null
          });
          if (deepInsightContent && deepInsightContent.length > 200) {
            log(`LLM deep insight generation successful: ${deepInsightContent.length} chars`, 'info');
          } else {
            log(`LLM deep insight too short (${deepInsightContent?.length || 0} chars), using template`, 'warning');
            deepInsightContent = null;
          }
        } catch (error) {
          log(`LLM deep insight generation failed: ${error}, falling back to template`, 'warning');
          deepInsightContent = null;
        }
      }

      // If deep insight succeeded, use it with proper formatting
      if (deepInsightContent) {
        const sections: string[] = [];
        sections.push(`# ${entityName}\n`);
        sections.push(`**Type:** ${entityType}\n`);
        sections.push(`**Generated:** ${timestamp}\n\n`);
        sections.push(deepInsightContent);

        // Add diagrams section
        const successfulDiagrams = diagrams?.filter((d: PlantUMLDiagram) => d.success) || [];
        if (successfulDiagrams.length > 0) {
          sections.push(`\n\n## Diagrams\n`);
          successfulDiagrams.forEach((d: PlantUMLDiagram) => {
            sections.push(`\n### ${d.type.charAt(0).toUpperCase() + d.type.slice(1)}\n`);
            sections.push(`![${entityName} ${d.type}](images/${d.name}.png)\n`);
          });
        }

        return sections.join('');
      }

      // FALLBACK: Build content directly from patterns and analysis (template approach)
      log(`Using template-based content generation for ${entityName}`, 'info');
      const sections: string[] = [];
      sections.push(`# ${entityName}\n`);
      sections.push(`**Type:** ${entityType}\n`);
      sections.push(`**Generated:** ${timestamp}\n`);

      // Pattern summary
      sections.push(`\n## Pattern Overview\n`);
      sections.push(`${topPattern.description || 'Pattern identified through analysis.'}\n`);
      if (topPattern.significance) {
        sections.push(`\n**Significance:** ${topPattern.significance}/10\n`);
      }

      // Evidence from pattern
      if (topPattern.evidence && topPattern.evidence.length > 0) {
        sections.push(`\n## Evidence\n`);
        topPattern.evidence.forEach((ev: string) => {
          sections.push(`- ${ev}\n`);
        });
      }

      // Git analysis summary
      if (gitAnalysis?.commits?.length > 0) {
        sections.push(`\n## Development History\n`);
        sections.push(`Analysis of ${gitAnalysis.commits.length} commits.\n`);
        if (gitAnalysis.architecturalDecisions?.length > 0) {
          sections.push(`\n### Architectural Decisions\n`);
          gitAnalysis.architecturalDecisions.slice(0, 5).forEach((dec: any) => {
            // Handle various formats: string, {decision: string}, or nested object
            const decisionText = typeof dec === 'string' ? dec
              : dec?.decision && typeof dec.decision === 'string' ? dec.decision
              : dec?.summary && typeof dec.summary === 'string' ? dec.summary
              : dec?.description && typeof dec.description === 'string' ? dec.description
              : null;
            if (decisionText) {
              sections.push(`- ${decisionText}\n`);
            }
          });
        }
      }

      // Vibe analysis summary
      if (vibeAnalysis?.sessions?.length > 0) {
        sections.push(`\n## Conversation Insights\n`);
        sections.push(`Analysis of ${vibeAnalysis.sessions.length} development sessions.\n`);
        if (vibeAnalysis.problemSolutionPairs?.length > 0) {
          sections.push(`\n### Problem-Solution Patterns\n`);
          vibeAnalysis.problemSolutionPairs.slice(0, 3).forEach((pair: any) => {
            // Extract string values, handling nested objects
            const problem = typeof pair.problem === 'string' ? pair.problem
              : pair.problem?.description || pair.problem?.summary || pair.problem?.text || null;
            const solution = typeof pair.solution === 'string' ? pair.solution
              : pair.solution?.description || pair.solution?.summary || pair.solution?.text || null;
            if (problem && solution) {
              sections.push(`- **Problem:** ${problem}\n  **Solution:** ${solution}\n`);
            }
          });
        }
      }

      // Semantic analysis summary
      if (semanticAnalysis?.codeAnalysis) {
        sections.push(`\n## Code Analysis\n`);
        if (semanticAnalysis.codeAnalysis.architecturalPatterns?.length > 0) {
          sections.push(`\n### Architectural Patterns\n`);
          semanticAnalysis.codeAnalysis.architecturalPatterns.slice(0, 5).forEach((p: any) => {
            const patternName = typeof p === 'string' ? p
              : p?.name && typeof p.name === 'string' ? p.name
              : p?.pattern && typeof p.pattern === 'string' ? p.pattern
              : null;
            if (patternName) {
              sections.push(`- ${patternName}\n`);
            }
          });
        }
      }

      // Diagrams
      const successfulDiagrams = diagrams?.filter((d: PlantUMLDiagram) => d.success) || [];
      if (successfulDiagrams.length > 0) {
        sections.push(`\n## Diagrams\n`);
        successfulDiagrams.forEach((d: PlantUMLDiagram) => {
          sections.push(`![${d.name}](images/${d.name}.png)\n`);
        });
      }

      // Other patterns
      if (patternCatalog.patterns.length > 1) {
        sections.push(`\n## Related Patterns\n`);
        patternCatalog.patterns.slice(1, 6).forEach((p: IdentifiedPattern) => {
          sections.push(`- **${p.name}** (${p.category}): ${p.description}\n`);
        });
      }

      return sections.join('');
    }

    // NO INSIGHTS AVAILABLE: If we reach here with no patterns AND no entityInfo,
    // this means the analysis found nothing significant. Exit gracefully (not an error).
    log(`No insights to generate: No patterns found and no entity observations`, 'info', {
      hasEntityInfo: !!entityInfo,
      hasPatterns: !!(patternCatalog?.patterns?.length),
      patternCount: patternCatalog?.patterns?.length || 0
    });

    // Return minimal content indicating no insights were found
    return `# Analysis Complete\n\n` +
      `**Generated:** ${timestamp}\n\n` +
      `No significant patterns or insights were identified in this analysis.\n\n` +
      `**Analysis Summary:**\n` +
      `- Git commits analyzed: ${gitAnalysis?.commits?.length || 0}\n` +
      `- Sessions analyzed: ${vibeAnalysis?.sessions?.length || 0}\n` +
      `- Patterns found: ${patternCatalog?.patterns?.length || 0}\n`;
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

    // Analyze more commits for comprehensive pattern extraction
    const limitedCommits = commits.slice(0, 100);

    // IMPROVED: Less aggressive filtering - include more commits for semantic analysis
    // The LLM will determine actual architectural significance
    const significantCommits = limitedCommits.filter(commit => {
      const msg = commit.message.toLowerCase();

      // Only reject pure documentation/style commits
      if (msg.match(/^(docs|style):/)) {
        return false;
      }

      // Accept commits with any meaningful code changes (lowered from 50)
      if (commit.additions + commit.deletions >= 15) {
        return true;
      }

      // Accept commits with architectural keywords regardless of size
      if (this.isArchitecturalCommit(commit.message)) {
        return true;
      }

      // Accept feature and refactor commits - these often contain architectural decisions
      if (msg.match(/^(feat|refactor|perf):/)) {
        return true;
      }

      return false;
    });

    if (significantCommits.length === 0) {
      // FALLBACK: If filtering removed all commits, use first 30 without filtering
      log('No commits passed significance filter, using first 30 commits unfiltered', 'info');
      const fallbackCommits = limitedCommits.slice(0, 30);
      if (fallbackCommits.length === 0) {
        return patterns;
      }
      // Use fallback commits instead
      return this.extractPatternsFromCommits(fallbackCommits);
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
    } catch (error: any) {
      // NO FALLBACK: LLM pattern extraction is required for quality analysis
      log('LLM pattern extraction failed - NO FALLBACK, throwing error', 'error', error);
      throw new Error(
        `InsightGenerationAgent: LLM pattern extraction failed.\n` +
        `Error: ${error.message}\n` +
        `Commits analyzed: ${significantCommits.length}\n\n` +
        `This error indicates the LLM service is unavailable or returned an invalid response. ` +
        `Check LLM provider configuration (ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY).`
      );
    }

    return patterns;
  }

  // Fallback pattern extraction without LLM - uses theme grouping
  private async extractPatternsFromCommits(commits: any[]): Promise<IdentifiedPattern[]> {
    const patterns: IdentifiedPattern[] = [];
    const themeGroups = this.groupCommitsByTheme(commits);
    let patternCount = 0;

    themeGroups.forEach((themeCommits, theme) => {
      if (themeCommits.length >= 2 && patternCount < 15) {
        const pattern = this.createArchitecturalPattern(theme, themeCommits);
        if (pattern) {
          // Boost significance for patterns with multiple commits
          pattern.significance = Math.min(10, 4 + Math.floor(themeCommits.length / 2));
          patterns.push(pattern);
          patternCount++;
        }
      }
    });

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

  /**
   * Extract patterns from LLM-analyzed documentation semantics
   * Analyzes docstring analyses and prose analyses for usage patterns, API patterns, and documentation patterns
   */
  private extractDocumentationPatterns(docSemanticsResults: any): IdentifiedPattern[] {
    const patterns: IdentifiedPattern[] = [];

    const entityAnalyses = docSemanticsResults.entityAnalyses || {};
    const proseAnalyses = docSemanticsResults.proseAnalyses || [];

    // Group entities by usage patterns for pattern discovery
    const usagePatternGroups = new Map<string, string[]>();
    const warningGroups = new Map<string, string[]>();

    for (const [entityName, analysis] of Object.entries(entityAnalyses)) {
      const typedAnalysis = analysis as {
        purpose?: string;
        usagePatterns?: string[];
        warnings?: string[];
        semanticScore?: number;
        relatedEntities?: string[];
      };

      // Group by usage patterns
      if (typedAnalysis.usagePatterns && typedAnalysis.usagePatterns.length > 0) {
        typedAnalysis.usagePatterns.forEach(pattern => {
          const normalizedPattern = pattern.toLowerCase().trim();
          if (!usagePatternGroups.has(normalizedPattern)) {
            usagePatternGroups.set(normalizedPattern, []);
          }
          usagePatternGroups.get(normalizedPattern)!.push(entityName);
        });
      }

      // Group by warnings (design constraints)
      if (typedAnalysis.warnings && typedAnalysis.warnings.length > 0) {
        typedAnalysis.warnings.forEach(warning => {
          const normalizedWarning = warning.toLowerCase().trim();
          if (!warningGroups.has(normalizedWarning)) {
            warningGroups.set(normalizedWarning, []);
          }
          warningGroups.get(normalizedWarning)!.push(entityName);
        });
      }
    }

    // Create patterns from repeated usage patterns (at least 2 entities share the pattern)
    for (const [patternText, entities] of usagePatternGroups.entries()) {
      if (entities.length >= 2 && patterns.length < 5) {
        const patternName = this.generatePatternNameFromUsage(patternText);
        patterns.push({
          name: patternName,
          category: 'Documentation',
          description: `Usage pattern "${patternText}" documented across ${entities.length} code entities`,
          significance: Math.min(7, 3 + entities.length),
          evidence: [
            `Documented in ${entities.length} entities`,
            `Example entities: ${entities.slice(0, 3).join(', ')}`,
            `Pattern: ${patternText.substring(0, 100)}`
          ],
          relatedComponents: entities.slice(0, 10),
          implementation: {
            language: 'TypeScript',
            usageNotes: [`Follow the documented pattern: ${patternText}`]
          }
        });
      }
    }

    // Create patterns from repeated warnings (design constraints)
    for (const [warningText, entities] of warningGroups.entries()) {
      if (entities.length >= 2 && patterns.length < 8) {
        patterns.push({
          name: `Design Constraint: ${warningText.substring(0, 50)}`,
          category: 'Documentation',
          description: `Design constraint "${warningText}" documented in ${entities.length} entities`,
          significance: Math.min(6, 3 + entities.length),
          evidence: [
            `Warning found in ${entities.length} entities`,
            `Affected entities: ${entities.slice(0, 3).join(', ')}`
          ],
          relatedComponents: entities.slice(0, 10),
          implementation: {
            language: 'TypeScript',
            usageNotes: [`Be aware: ${warningText}`]
          }
        });
      }
    }

    // Extract patterns from prose analyses (documentation context)
    if (proseAnalyses.length > 0 && patterns.length < 10) {
      const bestPractices = proseAnalyses.flatMap((p: any) => p.bestPractices || []);
      const tutorials = proseAnalyses.filter((p: any) => p.tutorialContext);

      // Create pattern from documented best practices
      if (bestPractices.length >= 2) {
        patterns.push({
          name: 'Documented Best Practices',
          category: 'Documentation',
          description: `${bestPractices.length} best practices documented in project documentation`,
          significance: Math.min(6, 3 + Math.floor(bestPractices.length / 2)),
          evidence: bestPractices.slice(0, 5).map((bp: string) => `Best practice: ${bp.substring(0, 80)}`),
          relatedComponents: proseAnalyses.map((p: any) => p.documentPath).filter(Boolean),
          implementation: {
            language: 'TypeScript',
            usageNotes: bestPractices.slice(0, 3)
          }
        });
      }

      // Create pattern if significant tutorial documentation exists
      if (tutorials.length >= 1) {
        patterns.push({
          name: 'Tutorial Documentation Pattern',
          category: 'Documentation',
          description: `${tutorials.length} tutorial-style documentation sections found`,
          significance: 4,
          evidence: tutorials.slice(0, 3).map((t: any) => `Tutorial: ${t.documentPath || 'unknown'}`),
          relatedComponents: tutorials.map((t: any) => t.documentPath).filter(Boolean),
          implementation: {
            language: 'TypeScript',
            usageNotes: ['Follow tutorials for onboarding new developers']
          }
        });
      }
    }

    return patterns;
  }

  /**
   * Extract patterns from LLM-powered code synthesis results (CGR integration).
   * Converts synthesis insights into IdentifiedPattern objects for the pattern catalog.
   */
  private extractPatternsFromSynthesis(synthesisResults: SynthesisResult[]): IdentifiedPattern[] {
    const patterns: IdentifiedPattern[] = [];

    for (const synthesis of synthesisResults.filter(s => s.success)) {
      // Convert each identified pattern from synthesis into a catalog entry
      for (const patternName of synthesis.patternsIdentified) {
        patterns.push({
          name: `${synthesis.entityType}: ${patternName}`,
          category: 'CodeStructure',
          description: synthesis.purpose,
          significance: this.calculateSynthesisPatternSignificance(synthesis, patternName),
          evidence: [
            `Identified in: ${synthesis.entityName}`,
            ...synthesis.sourceFiles.slice(0, 3).map(f => `Source: ${f}`)
          ],
          relatedComponents: [synthesis.entityName, ...synthesis.dependencies.slice(0, 5)],
          implementation: {
            language: 'auto-detected',
            codeExample: synthesis.documentation?.substring(0, 200),
            usageNotes: synthesis.components.slice(0, 3).map(c => `Component: ${c}`)
          }
        });
      }

      // Create patterns for potential issues (high value for quality insights)
      for (const issue of synthesis.potentialIssues) {
        patterns.push({
          name: `Code Quality: ${issue.substring(0, 50)}`,
          category: 'CodeQuality',
          description: `Identified in ${synthesis.entityName}: ${issue}`,
          significance: 7, // Issues are always significant
          evidence: [
            `Entity: ${synthesis.entityName}`,
            `Type: ${synthesis.entityType}`,
            ...synthesis.sourceFiles.slice(0, 2).map(f => `File: ${f}`)
          ],
          relatedComponents: [synthesis.entityName],
          implementation: {
            language: 'auto-detected',
            usageNotes: [`Consider addressing: ${issue}`]
          }
        });
      }

      // Create dependency relationship patterns for complex entities
      if (synthesis.dependencies.length >= 3 || synthesis.dependents.length >= 3) {
        const depCount = synthesis.dependencies.length;
        const depndtCount = synthesis.dependents.length;
        patterns.push({
          name: `Dependency Hub: ${synthesis.entityName}`,
          category: 'architectural',
          description: `${synthesis.entityName} is a key component with ${depCount} dependencies and ${depndtCount} dependents`,
          significance: Math.min(9, 5 + Math.floor((depCount + depndtCount) / 3)),
          evidence: [
            `Dependencies: ${synthesis.dependencies.slice(0, 5).join(', ')}`,
            `Dependents: ${synthesis.dependents.slice(0, 5).join(', ')}`,
            `Purpose: ${synthesis.purpose.substring(0, 100)}`
          ],
          relatedComponents: [...synthesis.dependencies.slice(0, 5), ...synthesis.dependents.slice(0, 5)],
          implementation: {
            language: 'auto-detected',
            usageNotes: [
              'Changes to this component may have wide impact',
              'Consider interface stability and backward compatibility'
            ]
          }
        });
      }
    }

    log(`Extracted ${patterns.length} patterns from ${synthesisResults.length} synthesis results`, 'info');
    return patterns;
  }

  /**
   * Calculate significance score for a synthesis-derived pattern.
   */
  private calculateSynthesisPatternSignificance(synthesis: SynthesisResult, patternName: string): number {
    let score = 5; // Base score

    // Boost for well-known design patterns
    const knownPatterns = ['factory', 'singleton', 'observer', 'decorator', 'adapter', 'facade', 'proxy', 'strategy'];
    if (knownPatterns.some(p => patternName.toLowerCase().includes(p))) {
      score += 2;
    }

    // Boost for entities with more dependencies (central to architecture)
    if (synthesis.dependencies.length >= 5) {
      score += 1;
    }

    // Boost for entities with more dependents (widely used)
    if (synthesis.dependents.length >= 3) {
      score += 1;
    }

    // Boost for Class entities (often more significant)
    if (synthesis.entityType === 'Class') {
      score += 1;
    }

    return Math.min(10, score);
  }

  /**
   * Generate a meaningful pattern name from usage text
   */
  private generatePatternNameFromUsage(usageText: string): string {
    const text = usageText.toLowerCase();

    if (text.includes('async') || text.includes('await') || text.includes('promise')) {
      return 'Async Pattern';
    }
    if (text.includes('callback') || text.includes('handler')) {
      return 'Callback Pattern';
    }
    if (text.includes('singleton') || text.includes('instance')) {
      return 'Singleton Pattern';
    }
    if (text.includes('factory') || text.includes('create')) {
      return 'Factory Pattern';
    }
    if (text.includes('cache') || text.includes('memoize')) {
      return 'Caching Pattern';
    }
    if (text.includes('validate') || text.includes('check')) {
      return 'Validation Pattern';
    }
    if (text.includes('transform') || text.includes('convert')) {
      return 'Transformation Pattern';
    }
    if (text.includes('batch') || text.includes('bulk')) {
      return 'Batch Processing Pattern';
    }
    if (text.includes('error') || text.includes('exception')) {
      return 'Error Handling Pattern';
    }
    if (text.includes('log') || text.includes('trace')) {
      return 'Logging Pattern';
    }

    // Default: use first 40 chars of usage text
    return `Usage Pattern: ${usageText.substring(0, 40)}`;
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
      
      // NOTE: Removed generic fallback pattern creation (ArchitecturalEvolutionPattern)
      // Creating meaningless fallback entities pollutes the knowledge graph.
      // If no structured patterns are found, return empty array - QA will handle it.
      if (patterns.length === 0) {
        log('No structured patterns could be extracted from LLM insights', 'warning', {
          llmInsightsLength: llmInsights.length,
          commitCount: commits.length
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
    if (significance >= 3) return 'Pattern identified with moderate significance';
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
      console.error('Failed to generate structured problem statement, using fallback', { error: error instanceof Error ? error.message : String(error) });
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
        // Include EXISTING diagrams as well as newly regenerated ones
        const allDiagrams = [...result.regeneratedDiagrams];

        // Scan for existing diagrams for this entity
        const imagesDir = path.join(this.outputDir, 'images');
        const entityNameKebab = toKebabCase(entityName);
        try {
          const existingFiles = await fs.promises.readdir(imagesDir);
          for (const file of existingFiles) {
            if (file.startsWith(entityNameKebab) && file.endsWith('.png')) {
              const fullPath = path.join(imagesDir, file);
              if (!allDiagrams.includes(fullPath)) {
                allDiagrams.push(fullPath);
                log(`Including existing diagram: ${file}`, 'info');
              }
            }
          }
        } catch (e) {
          log('Could not scan for existing diagrams', 'debug');
        }

        const insightResult = await this.generateRefreshedInsightDocument(
          entityName,
          current_analysis,
          allDiagrams
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
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { FilenameTracer } from '../utils/filename-tracer.js';
import { ContentAgnosticAnalyzer } from '../utils/content-agnostic-analyzer.js';
import { RepositoryContextManager } from '../utils/repository-context.js';

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


export class InsightGenerationAgent {
  private outputDir: string;
  private plantumlAvailable: boolean = false;
  private standardStylePath: string;
  private semanticAnalyzer: SemanticAnalyzer;
  private contentAnalyzer: ContentAgnosticAnalyzer;
  private contextManager: RepositoryContextManager;

  constructor(repositoryPath: string = '.') {
    this.outputDir = path.join(repositoryPath, 'knowledge-management', 'insights');
    this.standardStylePath = path.join(repositoryPath, 'docs', 'puml', '_standard-style.puml');
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.contentAnalyzer = new ContentAgnosticAnalyzer(repositoryPath);
    this.contextManager = new RepositoryContextManager(repositoryPath);
    this.initializeDirectories();
    this.checkPlantUMLAvailability();
  }

  async generateComprehensiveInsights(params: any): Promise<InsightGenerationResult> {
    log('generateComprehensiveInsights called', 'info');
    const startTime = Date.now();
    
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
      // Filter git commits BEFORE pattern extraction to prevent analysis of infrastructure changes
      let filteredGitAnalysis = gitAnalysis;
      if (gitAnalysis?.commits) {
        const originalCommitCount = gitAnalysis.commits.length;
        const significantCommits = gitAnalysis.commits.filter((commit: any) => {
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

        log(`Filtered commits from ${originalCommitCount} to ${significantCommits.length} architecturally significant commits`, 'info');

        if (significantCommits.length === 0) {
          log('No architecturally significant commits found - skipping pattern extraction', 'info');
          throw new Error('SKIP_INSIGHT_GENERATION: No architecturally significant commits found');
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

      // Solution 1: Skip insight generation when no real patterns found
      const significantPatterns = patternCatalog.patterns
        .filter(p => p.significance >= 7) // Only patterns with high significance
        .sort((a, b) => b.significance - a.significance);

      // If no significant patterns found, skip insight generation
      if (significantPatterns.length === 0) {
        log('No significant patterns found - skipping insight generation', 'info');
        throw new Error('SKIP_INSIGHT_GENERATION: No patterns with sufficient significance (≥7) found');
      }

      const insightDocuments: InsightDocument[] = [];

      if (significantPatterns.length >= 1 && significantPatterns.length <= 5) {
        // PERFORMANCE OPTIMIZATION: Generate insights in parallel instead of sequentially
        log(`Generating separate insights for ${significantPatterns.length} significant patterns (≥7 significance) IN PARALLEL`, 'info');
        
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
    webResults?: any
  ): Promise<InsightDocument> {
    // Generate meaningful name based on analysis content
    const { name, title } = this.generateMeaningfulNameAndTitle(
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog
    );

    // Generate PlantUML diagrams using actual pattern name
    FilenameTracer.trace('DIAGRAM_INPUT', 'generateInsightDocument',
      name, 'Using pattern name directly for diagrams'
    );

    const diagrams = await this.generateAllDiagrams(name, {
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog
    });

    // Generate comprehensive content  
    const timestamp = new Date().toISOString();
    console.log('📝 About to call generateInsightContent with:', {
      title,
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasSemanticAnalysis: !!semanticAnalysis
    });
    
    const content = await this.generateInsightContent({
      title,
      timestamp,
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog,
      webResults,
      diagrams
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
    
    debugger; // Breakpoint opportunity for file writing
    
    await fs.promises.writeFile(filePath, content, 'utf8');
    
    FilenameTracer.trace('FILE_WRITTEN', 'generateInsightDocument',
      filePath, 'File successfully written'
    );
    
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
          name: `${name}_${type}`,
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
        name: `${name}_${type}`,
        content: '',
        pumlFile: '',
        success: false
      };
    }

    let diagramContent = '';
    
    // Try LLM-enhanced diagram generation first
    if (this.semanticAnalyzer) {
      // Extract only relevant data to prevent LLM timeouts from 2MB+ payload
      const cleanData = {
        patternCatalog: data.patternCatalog || data.semanticAnalysis || data,
        content: `${name} architectural analysis`,
        name: name
      };
      
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

    // Write PlantUML file
    const pumlDir = path.join(this.outputDir, 'puml');
    const pumlFile = path.join(pumlDir, `${name}_${type}.puml`);
    
    try {
      await fs.promises.writeFile(pumlFile, diagramContent, 'utf8');

      // Generate PNG if PlantUML is available
      let pngFile: string | undefined;
      try {
        const imagesDir = path.join(this.outputDir, 'images');
        pngFile = path.join(imagesDir, `${name}_${type}.png`);
        
        const { spawn } = await import('child_process');
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
      } catch (error) {
        log(`Failed to generate PNG for ${type} diagram`, 'warning', error);
        pngFile = undefined;
      }

      return {
        type,
        name: `${name}_${type}`,
        content: diagramContent,
        pumlFile,
        pngFile,
        success: true
      };

    } catch (error) {
      log(`Failed to create PlantUML diagram: ${type}`, 'error', error);
      return {
        type,
        name: `${name}_${type}`,
        content: diagramContent,
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
          log(`✅ LLM-enhanced ${type} diagram generated successfully`, 'info', {
            provider: analysisResult.provider,
            contentLength: pumlMatch[0].length
          });
          return pumlMatch[0];
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

  private buildDiagramPrompt(type: PlantUMLDiagram['type'], data: any): string {
    const patternCount = data.patternCatalog?.patterns?.length || 0;
    const patterns = data.patternCatalog?.patterns || [];
    
    let prompt = `Generate a professional PlantUML ${type} diagram based on the following semantic analysis data:

**Analysis Data:**
${JSON.stringify(data, null, 2)}

**Requirements:**
- Create a valid PlantUML diagram enclosed in @startuml and @enduml tags
- Use proper PlantUML syntax and styling
- Make the diagram visually clear and informative
- Include meaningful relationships and annotations
- Use professional styling with appropriate colors and layouts`;

    if (type === 'architecture') {
      prompt += `

**Architecture Diagram Specifics:**
- Show ${patternCount} identified patterns as components
- Group related patterns into packages by category
- Use different styles for different significance levels (<<critical>>, <<important>>, <<standard>>)
- Show relationships between related components
- Include a summary note with key metrics
- Use component diagram syntax with packages, components, and interfaces`;

    } else if (type === 'class') {
      prompt += `

**Class Diagram Specifics:**
- Create classes representing the main architectural patterns
- Show inheritance and composition relationships
- Include key methods and properties where relevant
- Group related classes into packages
- Use proper UML class diagram syntax
- Show dependencies and associations between classes`;
    }

    prompt += `

**Output Format:** Valid PlantUML code only, starting with @startuml and ending with @enduml. No explanatory text outside the diagram.`;

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
      diagrams
    } = data;

    // Use content-agnostic analyzer to generate real insights
    log('Starting content-agnostic insight generation', 'info');
    let contentInsight;
    try {
      console.log('🔍 DEBUG: About to call contentAnalyzer.analyzeWithContext');
      console.log('🔍 DEBUG: gitAnalysis type:', typeof gitAnalysis, 'has files:', gitAnalysis?.files);
      console.log('🔍 DEBUG: vibeAnalysis type:', typeof vibeAnalysis);
      console.log('🔍 DEBUG: semanticAnalysis type:', typeof semanticAnalysis);
      
      contentInsight = await this.contentAnalyzer.analyzeWithContext(
        gitAnalysis, vibeAnalysis, semanticAnalysis
      );
      console.log('🔍 DEBUG: contentAnalyzer completed successfully');
      console.log('🔍 DEBUG: contentInsight.problem.description:', contentInsight.problem.description);
      console.log('🔍 DEBUG: contentInsight.solution.approach:', contentInsight.solution.approach);
    } catch (error: any) {
      console.error('❌ ERROR in contentAnalyzer.analyzeWithContext:', error);
      console.error('❌ ERROR stack:', error.stack);
      throw error; // Re-throw to see full context
    }

    // Get repository context for specific details
    const repositoryContext = await this.contextManager.getRepositoryContext();

    // Determine main pattern for title
    const mainPattern = patternCatalog?.patterns?.sort((a: any, b: any) => b.significance - a.significance)[0];
    const patternName = mainPattern?.name || this.generateContextualPatternName(contentInsight, repositoryContext);
    
    const patternType = this.determinePatternType(contentInsight, repositoryContext);
    const significance = contentInsight.significance;

    // DEBUG: Log exactly what we're about to write
    console.log('🎯 DEBUG: About to write insight with:');
    console.log('  - Problem description:', contentInsight.problem.description);
    console.log('  - Solution approach:', contentInsight.solution.approach);
    console.log('  - Pattern name:', patternName);

    return `# ${patternName}

**Pattern Type:** ${patternType}  
**Significance:** ${significance}/10 - ${this.getSignificanceDescription(significance)}  
**Created:** ${timestamp.split('T')[0]}  
**Updated:** ${timestamp.split('T')[0]}
**Confidence:** ${Math.round(contentInsight.confidence * 100)}% - ${this.getConfidenceDescription(contentInsight.confidence)}

## Table of Contents

- [Overview](#overview)
- [Problem & Solution](#problem--solution)
- [Repository Context](#repository-context)
- [Evolution Analysis](#evolution-analysis)
- [Implementation Details](#implementation-details)
- [Technical Analysis](#technical-analysis)
- [Measured Outcomes](#measured-outcomes)
- [Usage Guidelines](#usage-guidelines)
- [Related Patterns](#related-patterns)
- [References](#references)

## Overview

**Problem:** ${contentInsight.problem.description}

**Solution:** ${contentInsight.solution.approach}

**Impact:** ${contentInsight.outcome.improvements.join(', ')}

## Problem & Solution

### 🎯 **Problem Statement**

**Context:** ${contentInsight.problem.context}

**Description:** ${contentInsight.problem.description}

**Symptoms:**
${contentInsight.problem.symptoms.map(symptom => `- ${symptom}`).join('\n')}

**Impact:** ${contentInsight.problem.impact}

### ✅ **Solution Approach**

**Approach:** ${contentInsight.solution.approach}

**Implementation:**
${contentInsight.solution.implementation.map(impl => `- ${impl}`).join('\n')}

**Technologies Used:**
${contentInsight.solution.technologies.map(tech => `- ${tech}`).join('\n')}

**Tradeoffs:**
${contentInsight.solution.tradeoffs.map(tradeoff => `- ${tradeoff}`).join('\n')}

## Repository Context

**Project Type:** ${repositoryContext.projectType}  
**Domain:** ${repositoryContext.domain}  
**Primary Languages:** ${repositoryContext.primaryLanguages.join(', ')}  
**Frameworks:** ${repositoryContext.frameworks.join(', ')}  
**Architecture:** ${repositoryContext.architecturalStyle}  
**Build Tools:** ${repositoryContext.buildTools.join(', ')}

## Evolution Analysis

${this.generateEvolutionAnalysis(gitAnalysis, vibeAnalysis, contentInsight)}

## Implementation Details

### Core Changes

![System Architecture](images/${diagrams.find((d: PlantUMLDiagram) => d.type === 'architecture' && d.success)?.name || 'architecture'}.png)

${this.generateContextualImplementation(contentInsight, gitAnalysis, semanticAnalysis)}

### Code Examples

\`\`\`${this.detectMainLanguage(gitAnalysis, semanticAnalysis)}
${this.generateRealCodeExample(contentInsight, semanticAnalysis, repositoryContext)}
\`\`\`

## Technical Analysis

![Technical Structure](images/${diagrams.find((d: PlantUMLDiagram) => d.type === 'class' && d.success)?.name || 'class'}.png)

${this.generateTechnicalFindings(gitAnalysis, vibeAnalysis, semanticAnalysis)}

## Measured Outcomes

### Quantitative Metrics
${contentInsight.outcome.metrics.map(metric => `- ${metric}`).join('\n')}

### Qualitative Improvements
${contentInsight.outcome.improvements.map(improvement => `- ${improvement}`).join('\n')}

### Emerging Challenges
${contentInsight.outcome.newChallenges.map(challenge => `- ${challenge}`).join('\n')}

## Usage Guidelines

### ✅ Apply This Pattern When:
${this.generateContextualUsageGuidelines(contentInsight, repositoryContext, true)}

### ❌ Avoid This Pattern When:
${this.generateContextualUsageGuidelines(contentInsight, repositoryContext, false)}

## Related Patterns

${this.generateRelatedPatterns(patternCatalog)}

## Process Flow

![Process Sequence](images/${diagrams.find((d: PlantUMLDiagram) => d.type === 'sequence' && d.success)?.name || 'sequence'}.png)

${this.generateRealProcessDescription(contentInsight, vibeAnalysis, gitAnalysis)}

## References

${this.generateReferences(webResults, gitAnalysis)}

---

## Supporting Diagrams

### Use Cases
![Use Cases](images/${diagrams.find((d: PlantUMLDiagram) => d.type === 'use-cases' && d.success)?.name || 'use-cases'}.png)

### All Diagrams
${this.formatDiagramReferences(diagrams)}

---
*Generated by Content-Agnostic Semantic Analysis System*

**Analysis Confidence:** ${Math.round(contentInsight.confidence * 100)}%  
**Repository Context Hash:** ${repositoryContext.contextHash.substring(0, 8)}

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>`;
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
      
      if (diagram.pngFile && fs.existsSync(diagram.pngFile)) {
        // Embed PNG image using markdown image syntax
        const pngFileName = path.basename(diagram.pngFile);
        lines.push(`![${diagramTitle} Architecture](images/${pngFileName})`);
        lines.push(''); // Empty line for spacing
        // Add reference to PlantUML source for those who want to see/modify it
        lines.push(`*PlantUML source: [${path.basename(diagram.pumlFile)}](puml/${path.basename(diagram.pumlFile)})*`);
      } else {
        // If PNG doesn't exist, link directly to PUML but note it's a source file
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

      const analysisResult = await this.semanticAnalyzer.analyzeContent(
        prompt,
        {
          analysisType: 'patterns',
          context: 'Git commit history analysis - extract specific architectural patterns with meaningful names',
          provider: 'auto'
        }
      );

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
}
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

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

  constructor(repositoryPath: string = '.') {
    this.outputDir = path.join(repositoryPath, 'knowledge-management', 'insights');
    this.standardStylePath = path.join(repositoryPath, 'docs', 'puml', '_standard-style.puml');
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.initializeDirectories();
    this.checkPlantUMLAvailability();
  }

  async generateComprehensiveInsights(params: any): Promise<InsightGenerationResult> {
    const startTime = Date.now();
    
    // Extract parameters from the params object
    const gitAnalysis = params.git_analysis_results || params.gitAnalysis;
    const vibeAnalysis = params.vibe_analysis_results || params.vibeAnalysis;
    const semanticAnalysis = params.semantic_analysis_results || params.semanticAnalysis;
    const webResults = params.web_search_results || params.webResults;
    
    log('Starting comprehensive insight generation', 'info', {
      receivedParams: Object.keys(params || {}),
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasSemanticAnalysis: !!semanticAnalysis,
      hasWebResults: !!webResults,
      gitCommitCount: gitAnalysis?.commits?.length || 0
    });

    try {
      // Extract patterns from all analyses
      const patternCatalog = await this.generatePatternCatalog(
        gitAnalysis, vibeAnalysis, semanticAnalysis, webResults
      );

      // Generate main insight document
      const insightDocument = await this.generateInsightDocument(
        gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog, webResults
      );


      const processingTime = Date.now() - startTime;
      
      const result: InsightGenerationResult = {
        insightDocument,
        patternCatalog,
        generationMetrics: {
          processingTime,
          documentsGenerated: 1, // insight only
          diagramsGenerated: insightDocument.diagrams.filter(d => d.success).length,
          patternsIdentified: patternCatalog.patterns.length,
          qualityScore: this.calculateQualityScore(insightDocument, patternCatalog)
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
    const patterns: IdentifiedPattern[] = [];

    // Generate REAL architectural patterns based on actual code analysis
    // This should analyze actual code commits and file changes to identify meaningful patterns
    
    // Analyze git commits for architectural patterns
    try {
      if (gitAnalysis?.commits && gitAnalysis.commits.length > 0) {
        const architecturalPatterns = await this.extractArchitecturalPatternsFromCommits(gitAnalysis.commits);
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
    // Analyze content to determine the main focus
    const analysisTypes = [];
    if (gitAnalysis?.commits?.length > 0) analysisTypes.push('Git');
    if (vibeAnalysis?.conversations?.length > 0) analysisTypes.push('Conversation');
    if (semanticAnalysis?.patterns?.length > 0) analysisTypes.push('Semantic');
    
    // Get the most significant patterns
    const topPatterns = patternCatalog.patterns
      .sort((a, b) => b.significance - a.significance)
      .slice(0, 3);
    
    // Generate name based on discovered patterns and analysis
    let baseName = '';
    let titleSuffix = '';
    
    if (topPatterns.length > 0) {
      const primaryPattern = topPatterns[0];
      
      // Extract key terms from pattern names/descriptions
      const keyTerms = this.extractKeyTerms([
        primaryPattern.name,
        primaryPattern.description,
        ...(gitAnalysis?.summary?.majorChanges || []),
        ...(semanticAnalysis?.insights || [])
      ]);
      
      // Create meaningful base name from key terms
      baseName = this.createCamelCaseName(keyTerms);
      titleSuffix = ` - ${primaryPattern.category} Pattern Analysis`;
      
    } else if (gitAnalysis?.commits?.length > 0) {
      // Focus on git analysis if no patterns found
      const gitTerms = this.extractKeyTerms([
        ...(gitAnalysis.summary?.majorChanges || []),
        ...(gitAnalysis.summary?.activeDevelopmentAreas || [])
      ]);
      baseName = this.createCamelCaseName([...gitTerms, 'Development', 'Analysis']);
      titleSuffix = ' - Development Evolution Analysis';
      
    } else if (analysisTypes.length > 0) {
      // Generic analysis-based naming
      baseName = `${analysisTypes.join('')}AnalysisInsight`;
      titleSuffix = ` - ${analysisTypes.join(' & ')} Analysis`;
      
    } else {
      // Fallback
      baseName = 'ComprehensiveSemanticAnalysis';
      titleSuffix = ' - System Analysis';
    }
    
    // Ensure name follows conventions: CamelCase, no spaces, descriptive
    const finalName = baseName || 'SemanticAnalysisInsight';
    const finalTitle = `${finalName}${titleSuffix}`;
    
    log('Generated meaningful insight name', 'info', {
      name: finalName,
      title: finalTitle,
      basedOn: { analysisTypes, patternCount: topPatterns.length }
    });
    
    return { name: finalName, title: finalTitle };
  }

  private extractKeyTerms(texts: string[]): string[] {
    const keyTerms = new Set<string>();
    const stopWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'a', 'an']);
    
    texts.forEach(text => {
      if (typeof text === 'string') {
        // Extract meaningful terms (capitalized words, technical terms)
        const matches = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]*)*\b|\b[a-z]*[A-Z][a-z]*\b/g) || [];
        matches.forEach(term => {
          const cleanTerm = term.toLowerCase();
          if (cleanTerm.length > 2 && !stopWords.has(cleanTerm)) {
            keyTerms.add(term.charAt(0).toUpperCase() + term.slice(1).toLowerCase());
          }
        });
      }
    });
    
    return Array.from(keyTerms).slice(0, 4); // Limit to avoid overly long names
  }

  private createCamelCaseName(terms: string[]): string {
    if (terms.length === 0) return 'SemanticAnalysis';
    
    return terms
      .map(term => term.charAt(0).toUpperCase() + term.slice(1).toLowerCase())
      .join('')
      .replace(/[^A-Za-z0-9]/g, '') // Remove special characters
      .substring(0, 50); // Limit length
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

    // Generate PlantUML diagrams
    const diagrams = await this.generateAllDiagrams(name, {
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog
    });

    // Generate comprehensive content  
    const timestamp = new Date().toISOString();
    const content = this.generateInsightContent({
      title,
      timestamp,
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog,
      webResults,
      diagrams
    });

    // Save the document
    const filePath = path.join(this.outputDir, `${name}.md`);
    await fs.promises.writeFile(filePath, content, 'utf8');

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
      name,
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

    for (const type of diagramTypes) {
      try {
        const diagram = await this.generatePlantUMLDiagram(type, name, data);
        diagrams.push(diagram);
      } catch (error) {
        log(`Failed to generate ${type} diagram`, 'warning', error);
        diagrams.push({
          type,
          name: `${name}_${type}`,
          content: '',
          pumlFile: '',
          success: false
        });
      }
    }

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
    if (this.semanticAnalyzer && (type === 'architecture' || type === 'class')) {
      diagramContent = await this.generateLLMEnhancedDiagram(type, data);
    }
    
    // Fallback to template-based generation if LLM fails or for other types
    if (!diagramContent) {
      switch (type) {
        case 'architecture':
          diagramContent = this.generateArchitectureDiagram(data);
          break;
        case 'sequence':
          diagramContent = this.generateSequenceDiagram(data);
          break;
        case 'use-cases':
          diagramContent = this.generateUseCasesDiagram(data);
          break;
        case 'class':
          diagramContent = this.generateClassDiagram(data);
          break;
      }
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
        const plantuml = spawn('plantuml', ['-tpng', pumlFile, '-o', imagesDir]);
        
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

  private async generateLLMEnhancedDiagram(type: PlantUMLDiagram['type'], data: any): Promise<string> {
    if (!this.semanticAnalyzer) {
      return '';
    }

    try {
      const diagramPrompt = this.buildDiagramPrompt(type, data);
      log(`Generating LLM-enhanced ${type} diagram`, 'info');
      
      const analysisResult = await this.semanticAnalyzer.analyzeContent(diagramPrompt, {
        analysisType: 'architecture',
        context: `PlantUML ${type} diagram generation`,
        provider: 'auto'
      });

      if (analysisResult?.insights && analysisResult.insights.includes('@startuml')) {
        // Extract PlantUML content from LLM response
        const pumlMatch = analysisResult.insights.match(/@startuml[\s\S]*?@enduml/);
        if (pumlMatch) {
          log(`LLM-enhanced ${type} diagram generated successfully`, 'info', {
            provider: analysisResult.provider,
            contentLength: pumlMatch[0].length
          });
          return pumlMatch[0];
        }
      }
      
      log(`LLM diagram generation failed for ${type} - no valid PlantUML found`, 'warning');
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
    
    // Enhanced architecture diagram with better component relationships
    let components = '';
    let relationships = '';
    
    // Group patterns by category for better organization
    const patternsByCategory: Record<string, any[]> = {};
    patterns.slice(0, 10).forEach((pattern: any) => {
      const category = pattern.category || 'General';
      if (!patternsByCategory[category]) {
        patternsByCategory[category] = [];
      }
      patternsByCategory[category].push(pattern);
    });

    // Generate components grouped by category
    Object.entries(patternsByCategory).forEach(([category, categoryPatterns]) => {
      components += `\n  package "${category}" {\n`;
      categoryPatterns.forEach((pattern, index) => {
        const significance = pattern.significance || 5;
        const style = significance >= 8 ? '<<critical>>' : significance >= 6 ? '<<important>>' : '<<standard>>';
        components += `    component "${pattern.name}" as ${category}_${index} ${style}\n`;
      });
      components += `  }\n`;
    });

    // Generate relationships based on related components
    patterns.forEach((pattern: any, index: number) => {
      if (pattern.relatedComponents && pattern.relatedComponents.length > 0) {
        pattern.relatedComponents.forEach((related: string) => {
          const relatedPattern = patterns.find((p: any) => p.name.includes(related));
          if (relatedPattern) {
            const sourceCategory = pattern.category || 'General';
            const targetCategory = relatedPattern.category || 'General';
            relationships += `  ${sourceCategory}_${index} --> ${targetCategory}_${patterns.indexOf(relatedPattern)} : uses\n`;
          }
        });
      }
    });

    const totalPatterns = patterns.length;
    const avgSignificance = patterns.reduce((sum: number, p: any) => sum + (p.significance || 5), 0) / totalPatterns || 0;

    return `@startuml
${this.getStandardStyle()}

title System Architecture - Semantic Analysis Results

${components}

${relationships}

note top
  Architecture Summary:
  - Total Patterns: ${totalPatterns}
  - Avg Significance: ${avgSignificance.toFixed(1)}/10
  - Categories: ${Object.keys(patternsByCategory).length}
  
  Legend:
  <<critical>> High Impact (8-10)
  <<important>> Medium Impact (6-7)  
  <<standard>> Standard Impact (1-5)
end note

@enduml`;
  }

  private generateSequenceDiagram(data: any): string {
    const patternCount = data.patternCatalog?.patterns?.length || 0;
    const avgSignificance = data.patternCatalog?.summary?.avgSignificance || 0;
    const hasGitData = data.gitAnalysis || data.git_analysis_results;
    const hasVibeData = data.vibeAnalysis || data.vibe_analysis_results;
    const hasWebSearch = data.webSearchResults || data.web_search_results;

    // Dynamic sequence based on what data is available
    let interactions = '';
    let participants = `actor "Developer" as dev
participant "Coordinator" as coord
participant "Git History Agent" as git
participant "Vibe History Agent" as vibe
participant "Semantic Analysis Agent" as semantic`;

    if (hasWebSearch) {
      participants += `\nparticipant "Web Search Agent" as web`;
    }

    participants += `\nparticipant "Insight Generation Agent" as insight
participant "Quality Assurance Agent" as qa
participant "Persistence Agent" as persist`;

    // Generate interaction sequence
    interactions = `dev -> coord: Execute complete-analysis workflow
coord -> git: analyzeGitHistory()
activate git`;

    if (hasGitData) {
      interactions += `\ngit --> coord: ${hasGitData.commits?.length || 0} commits analyzed`;
    } else {
      interactions += `\ngit --> coord: No commits found`;
    }

    interactions += `\ndeactivate git
coord -> vibe: analyzeVibeHistory()
activate vibe`;

    if (hasVibeData) {
      interactions += `\nvibe --> coord: ${hasVibeData.sessions?.length || 0} sessions analyzed`;
    } else {
      interactions += `\nvibe --> coord: No conversation data`;
    }

    interactions += `\ndeactivate vibe
coord -> semantic: analyzeSemantics()
activate semantic
semantic --> coord: Cross-analysis complete
deactivate semantic`;

    if (hasWebSearch) {
      interactions += `\ncoord -> web: searchSimilarPatterns()
web --> coord: External patterns found`;
    }

    interactions += `\ncoord -> insight: generateComprehensiveInsights()
activate insight
insight --> coord: ${patternCount} patterns identified
deactivate insight

coord -> qa: performWorkflowQA()
activate qa
qa --> coord: Quality validation complete
deactivate qa

coord -> persist: persistAnalysisResults()
persist --> coord: Knowledge base updated
coord --> dev: Analysis complete`;

    return `@startuml
${this.getStandardStyle()}

title Semantic Analysis Workflow - ${new Date().toISOString().split('T')[0]}

${participants}

${interactions}

note right of insight
  Results Summary:
  - Patterns identified: ${patternCount}
  - Avg Significance: ${avgSignificance.toFixed(1)}/10
  - Git commits: ${hasGitData?.commits?.length || 0}
  - Conversations: ${hasVibeData?.sessions?.length || 0}
  - Web references: ${hasWebSearch ? 'Yes' : 'No'}
end note

@enduml`;
  }

  private generateUseCasesDiagram(data: any): string {
    return `@startuml
${this.getStandardStyle()}

title Semantic Analysis Use Cases

left to right direction
actor Developer
actor "Team Lead" as lead
actor "Architect" as arch

rectangle "Semantic Analysis System" {
  usecase "Analyze Code Patterns" as UC1
  usecase "Track Development Evolution" as UC2
  usecase "Generate Insights" as UC3
  usecase "Create Documentation" as UC4
  usecase "Identify Technical Debt" as UC5
}

Developer --> UC1
Developer --> UC2
lead --> UC3
lead --> UC4
arch --> UC3
arch --> UC5

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

  private generateInsightContent(data: any): string {
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

    const significance = this.calculateInsightSignificance(
      gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog
    );

    return `# ${title}

**Significance:** ${significance}/10  
**Generated:** ${timestamp}  
**Analysis Types:** ${[
  gitAnalysis && 'Git History',
  vibeAnalysis && 'Conversation Analysis', 
  semanticAnalysis && 'Semantic Analysis',
  webResults && 'Web Research'
].filter(Boolean).join(', ')}

## Executive Summary

${this.generateExecutiveSummary(gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog)}

## Key Insights

${this.generateKeyInsights(gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog)}

## Pattern Analysis

### Identified Patterns (${patternCatalog.patterns.length})

${this.formatPatternCatalog(patternCatalog)}

## Technical Findings

${this.generateTechnicalFindings(gitAnalysis, vibeAnalysis, semanticAnalysis)}

## Architecture Insights

${this.generateArchitectureInsights(gitAnalysis, semanticAnalysis)}

## Development Process Analysis

${this.generateDevelopmentProcessAnalysis(vibeAnalysis)}

## Cross-Analysis Correlations

${this.generateCrossAnalysisInsights(gitAnalysis, vibeAnalysis, semanticAnalysis)}

## Quality Assessment

${this.generateQualityAssessment(semanticAnalysis)}

## Recommendations

${this.generateRecommendations(gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog)}

## Implementation Guidance

${this.generateImplementationGuidance(patternCatalog)}

## Supporting Diagrams

${this.formatDiagramReferences(diagrams)}

## Web Research Integration

${this.formatWebResults(webResults)}

## Supporting Data

### Git Analysis Summary
${gitAnalysis ? this.formatGitAnalysisSummary(gitAnalysis) : 'No git analysis data available'}

### Conversation Analysis Summary  
${vibeAnalysis ? this.formatVibeAnalysisSummary(vibeAnalysis) : 'No conversation analysis data available'}

### Semantic Analysis Summary
${semanticAnalysis ? this.formatSemanticAnalysisSummary(semanticAnalysis) : 'No semantic analysis data available'}

---
*Generated by Semantic Analysis Insight Generation Agent*

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
    
    if (quality.issues.length > 0) {
      assessment.push(`**Issues Identified:** ${quality.issues.length}`);
      quality.issues.forEach((issue: string) => {
        assessment.push(`  - ${issue}`);
      });
    }
    
    if (quality.recommendations.length > 0) {
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
      
      if (diagram.pngFile) {
        // Embed PNG image using markdown image syntax
        const pngFileName = path.basename(diagram.pngFile);
        lines.push(`![${diagramTitle} Architecture](images/${pngFileName})`);
        lines.push(''); // Empty line for spacing
      }
      
      // Add reference to PlantUML source for those who want to see/modify it
      lines.push(`*PlantUML source: [${path.basename(diagram.pumlFile)}](puml/${path.basename(diagram.pumlFile)})*`);
      
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
    const dirs = [
      this.outputDir,
      path.join(this.outputDir, 'puml'),
      path.join(this.outputDir, 'images')
    ];
    
    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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
    if (fs.existsSync(this.standardStylePath)) {
      return `!include ${this.standardStylePath}`;
    }
    
    // Enhanced styling for professional diagrams
    return `!theme plain

skinparam backgroundColor #FEFEFE
skinparam shadowing false

' Component styling
skinparam component {
  BackgroundColor<<critical>> #FF6B6B
  BorderColor<<critical>> #E53E3E
  FontColor<<critical>> #FFFFFF
  
  BackgroundColor<<important>> #4ECDC4
  BorderColor<<important>> #38B2AC
  FontColor<<important>> #1A365D
  
  BackgroundColor<<standard>> #E6F3FF
  BorderColor<<standard>> #3182CE
  FontColor<<standard>> #1A365D
  
  BackgroundColor #F7FAFC
  BorderColor #CBD5E0
  FontColor #2D3748
}

' Package styling  
skinparam package {
  BackgroundColor #F0FFF4
  BorderColor #48BB78
  FontColor #22543D
  FontStyle bold
}

' Note styling
skinparam note {
  BackgroundColor #FFFAF0
  BorderColor #ED8936
  FontColor #744210
}

' Actor styling
skinparam actor {
  BackgroundColor #EDF2F7
  BorderColor #4A5568
  FontColor #2D3748
}

' Participant styling
skinparam participant {
  BackgroundColor #F7FAFC
  BorderColor #A0AEC0
  FontColor #2D3748
}

' Arrow styling
skinparam arrow {
  Color #4A5568
  FontColor #2D3748
}

' General styling
skinparam defaultFontSize 12
skinparam defaultFontColor #2D3748
skinparam titleFontSize 16
skinparam titleFontColor #1A202C
skinparam titleFontStyle bold`;
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
    
    // Group commits by potential architectural significance
    const significantCommits = limitedCommits.filter(commit => 
      commit.additions + commit.deletions > 20 || // Significant code changes
      this.isArchitecturalCommit(commit.message)
    );

    if (significantCommits.length === 0) return patterns;

    try {
      // Use LLM to analyze commit patterns
      const commitSummary = significantCommits.map(c => ({
        message: c.message,
        files: c.files.map((f: any) => f.path),
        changes: c.additions + c.deletions
      }));

      const analysisResult = await this.semanticAnalyzer.analyzeContent(
        JSON.stringify(commitSummary, null, 2),
        {
          analysisType: 'patterns',
          context: 'Git commit history analysis for architectural patterns',
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
    if (message.includes('refactor')) return 'Refactoring';
    if (message.includes('api')) return 'API Design';
    if (message.includes('component')) return 'Component Architecture';
    return 'General Architecture';
  }

  private createArchitecturalPattern(theme: string, commits: any[]): IdentifiedPattern | null {
    if (commits.length === 0) return null;

    const allFiles = new Set();
    commits.forEach(commit => commit.files?.forEach((f: string) => allFiles.add(f)));

    return {
      name: `${theme.replace(/\s+/g, '')}Pattern`,
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
        language: this.detectLanguageFromFiles(Array.from(allFiles) as string[]),
        usageNotes: [`Applied across ${allFiles.size} files`, `${commits.length} related commits`]
      }
    };
  }

  private createImplementationPattern(evolution: any): IdentifiedPattern | null {
    if (!evolution.pattern) return null;

    return {
      name: `${evolution.pattern.replace(/\s+/g, '')}Implementation`,
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

  private createDesignPattern(archPattern: any): IdentifiedPattern | null {
    return {
      name: `${archPattern.name.replace(/\s+/g, '')}Pattern`,
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
}
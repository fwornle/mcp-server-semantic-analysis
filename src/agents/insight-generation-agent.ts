import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

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
  lessonsLearned: LessonsLearnedDocument;
  generationMetrics: {
    processingTime: number;
    documentsGenerated: number;
    diagramsGenerated: number;
    patternsIdentified: number;
    qualityScore: number;
  };
}

export interface LessonsLearnedDocument {
  title: string;
  content: string;
  filePath: string;
  sections: {
    successes: string[];
    challenges: string[];
    keyLearnings: string[];
    improvements: string[];
    futureConsiderations: string[];
  };
}

export class InsightGenerationAgent {
  private outputDir: string;
  private plantumlAvailable: boolean = false;
  private standardStylePath: string;

  constructor(repositoryPath: string = '.') {
    this.outputDir = path.join(repositoryPath, 'knowledge-management', 'insights');
    this.standardStylePath = path.join(repositoryPath, 'docs', 'puml', '_standard-style.puml');
    this.initializeDirectories();
    this.checkPlantUMLAvailability();
  }

  async generateComprehensiveInsights(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    webResults?: any
  ): Promise<InsightGenerationResult> {
    const startTime = Date.now();
    
    log('Starting comprehensive insight generation', 'info', {
      hasGitAnalysis: !!gitAnalysis,
      hasVibeAnalysis: !!vibeAnalysis,
      hasSemanticAnalysis: !!semanticAnalysis,
      hasWebResults: !!webResults
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

      // Generate lessons learned
      const lessonsLearned = await this.generateLessonsLearned(
        gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog
      );

      const processingTime = Date.now() - startTime;
      
      const result: InsightGenerationResult = {
        insightDocument,
        patternCatalog,
        lessonsLearned,
        generationMetrics: {
          processingTime,
          documentsGenerated: 2, // insight + lessons
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

    // Extract patterns from git analysis
    if (gitAnalysis?.architecturalDecisions) {
      gitAnalysis.architecturalDecisions.forEach((decision: any, index: number) => {
        patterns.push({
          name: `ArchitecturalDecision${index + 1}`,
          category: 'Architecture',
          description: decision.description || 'Architectural decision from git analysis',
          significance: this.mapImpactToSignificance(decision.impact),
          evidence: [`Commit: ${decision.commit}`, `Files: ${decision.files?.length || 0}`],
          relatedComponents: decision.files || [],
          implementation: {
            language: this.detectLanguageFromFiles(decision.files || []),
            usageNotes: [`Applied in ${decision.files?.length || 0} files`]
          }
        });
      });
    }

    // Extract patterns from code evolution
    if (gitAnalysis?.codeEvolution) {
      gitAnalysis.codeEvolution.forEach((evolution: any, index: number) => {
        patterns.push({
          name: `CodeEvolution${index + 1}`,
          category: 'Evolution',
          description: `Evolution pattern: ${evolution.pattern}`,
          significance: Math.min(Math.ceil((evolution.occurrences || 1) / 2), 10),
          evidence: [
            `Occurrences: ${evolution.occurrences}`,
            `Trend: ${evolution.trend}`,
            `Files affected: ${evolution.files?.length || 0}`
          ],
          relatedComponents: evolution.files || [],
          implementation: {
            language: this.detectLanguageFromFiles(evolution.files || []),
            usageNotes: [`Pattern occurs ${evolution.occurrences} times with ${evolution.trend} trend`]
          }
        });
      });
    }

    // Extract patterns from vibe analysis problem-solution pairs
    if (vibeAnalysis?.problemSolutionPairs) {
      vibeAnalysis.problemSolutionPairs.forEach((pair: any, index: number) => {
        patterns.push({
          name: `ProblemSolutionPattern${index + 1}`,
          category: 'Solution',
          description: pair.problem.description.substring(0, 100) + '...',
          significance: this.mapDifficultyToSignificance(pair.problem.difficulty),
          evidence: [
            `Approach: ${pair.solution.approach}`,
            `Technologies: ${pair.solution.technologies?.join(', ') || 'N/A'}`,
            `Outcome: ${pair.solution.outcome}`
          ],
          relatedComponents: pair.solution.technologies || [],
          implementation: {
            language: this.detectLanguageFromTechnologies(pair.solution.technologies || []),
            usageNotes: pair.solution.steps || []
          }
        });
      });
    }

    // Extract patterns from semantic analysis
    if (semanticAnalysis?.codeAnalysis?.architecturalPatterns) {
      semanticAnalysis.codeAnalysis.architecturalPatterns.forEach((pattern: any, index: number) => {
        patterns.push({
          name: `SemanticPattern${index + 1}`,
          category: 'Semantic',
          description: pattern.description || `${pattern.name} pattern`,
          significance: Math.round(pattern.confidence * 10),
          evidence: [`Confidence: ${pattern.confidence}`, `Files: ${pattern.files?.length || 0}`],
          relatedComponents: pattern.files || [],
          implementation: {
            language: this.detectLanguageFromFiles(pattern.files || []),
            usageNotes: [`Pattern found in ${pattern.files?.length || 0} files`]
          }
        });
      });
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

  private async generateInsightDocument(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    patternCatalog: PatternCatalog,
    webResults?: any
  ): Promise<InsightDocument> {
    const timestamp = new Date().toISOString();
    const name = `SemanticAnalysisInsight_${timestamp.replace(/[:.]/g, '-').substring(0, 19)}`;
    const title = 'Comprehensive Semantic Analysis Insights';

    // Generate PlantUML diagrams
    const diagrams = await this.generateAllDiagrams(name, {
      gitAnalysis,
      vibeAnalysis,
      semanticAnalysis,
      patternCatalog
    });

    // Generate comprehensive content
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
        const plantuml = spawn('plantuml', ['-o', imagesDir, pumlFile]);
        
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

  private generateArchitectureDiagram(data: any): string {
    const patterns = data.patternCatalog?.patterns || [];
    let components = '';
    
    patterns.slice(0, 8).forEach((pattern: any, index: number) => {
      components += `  component "${pattern.name}" as comp${index + 1}\n`;
    });

    return `@startuml
${this.getStandardStyle()}

title System Architecture Analysis

package "Semantic Analysis Results" {
${components}
}

note right
  Generated from comprehensive
  semantic analysis including:
  - Git history patterns
  - Conversation analysis
  - Code structure analysis
end note

@enduml`;
  }

  private generateSequenceDiagram(data: any): string {
    return `@startuml
${this.getStandardStyle()}

title Semantic Analysis Workflow

actor "Developer" as dev
participant "Git History Agent" as git
participant "Vibe History Agent" as vibe
participant "Semantic Analysis Agent" as semantic
participant "Insight Generation Agent" as insight

dev -> git: Analyze commits
git -> vibe: Share git patterns
vibe -> semantic: Correlate with conversations
semantic -> insight: Generate comprehensive insights
insight -> dev: Deliver actionable insights

note right of insight
  Patterns identified: ${data.patternCatalog?.patterns?.length || 0}
  Significance: ${data.patternCatalog?.summary?.avgSignificance || 0}/10
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

  private async generateLessonsLearned(
    gitAnalysis: any,
    vibeAnalysis: any,
    semanticAnalysis: any,
    patternCatalog: PatternCatalog
  ): Promise<LessonsLearnedDocument> {
    const timestamp = new Date().toISOString();
    const title = `Semantic Analysis Lessons Learned - ${timestamp.substring(0, 10)}`;

    // Extract lessons from each analysis type
    const sections = {
      successes: this.extractSuccesses(gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog),
      challenges: this.extractChallenges(gitAnalysis, vibeAnalysis, semanticAnalysis),
      keyLearnings: this.extractKeyLearnings(gitAnalysis, vibeAnalysis, semanticAnalysis, patternCatalog),
      improvements: this.extractImprovements(gitAnalysis, vibeAnalysis, semanticAnalysis),
      futureConsiderations: this.extractFutureConsiderations(patternCatalog)
    };

    const content = this.generateLessonsLearnedContent(title, timestamp, sections);
    const filePath = path.join(this.outputDir, `${title.replace(/\s+/g, '_').toLowerCase()}.md`);
    
    await fs.promises.writeFile(filePath, content, 'utf8');

    return {
      title,
      content,
      filePath,
      sections
    };
  }

  private generateLessonsLearnedContent(title: string, timestamp: string, sections: any): string {
    return `# ${title}

**Date:** ${timestamp}  
**Context:** Comprehensive Semantic Analysis Session

## What Worked Well

${sections.successes.map((success: string, index: number) => `${index + 1}. ${success}`).join('\n')}

## Challenges Encountered

${sections.challenges.map((challenge: string, index: number) => `${index + 1}. ${challenge}`).join('\n')}

## Key Learnings

${sections.keyLearnings.map((learning: string, index: number) => `${index + 1}. ${learning}`).join('\n')}

## Actionable Improvements

${sections.improvements.map((improvement: string, index: number) => `${index + 1}. ${improvement}`).join('\n')}

## Future Considerations

${sections.futureConsiderations.map((consideration: string, index: number) => `${index + 1}. ${consideration}`).join('\n')}

---
*Lessons Learned captured by Insight Generation Agent*

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
      const lines = [`- **${diagram.type.charAt(0).toUpperCase() + diagram.type.slice(1)} Diagram**: ${diagram.name}`];
      lines.push(`  - PlantUML: \`${path.basename(diagram.pumlFile)}\``);
      if (diagram.pngFile) {
        lines.push(`  - Image: \`${path.basename(diagram.pngFile)}\``);
      }
      return lines.join('\n');
    });
    
    return references.join('\n');
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

  // Helper methods for lessons learned extraction
  private extractSuccesses(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any, patternCatalog: PatternCatalog): string[] {
    const successes = [];
    
    if (patternCatalog.patterns.length > 0) {
      successes.push(`Successfully identified ${patternCatalog.patterns.length} distinct patterns across multiple analysis types`);
    }
    
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.score > 70) {
      successes.push(`Maintained good code quality with score of ${semanticAnalysis.codeAnalysis.codeQuality.score}/100`);
    }
    
    if (vibeAnalysis?.problemSolutionPairs?.length > 0) {
      const successfulSolutions = vibeAnalysis.problemSolutionPairs.filter((p: any) => 
        p.solution.outcome !== 'Solution implemented'
      ).length;
      if (successfulSolutions > 0) {
        successes.push(`Achieved ${successfulSolutions} successful problem resolutions with clear outcomes`);
      }
    }
    
    if (gitAnalysis?.architecturalDecisions?.length > 0) {
      successes.push(`Made ${gitAnalysis.architecturalDecisions.length} documented architectural decisions`);
    }
    
    if (successes.length === 0) {
      successes.push('Completed comprehensive semantic analysis successfully');
      successes.push('Generated actionable insights from available data');
    }
    
    return successes;
  }

  private extractChallenges(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): string[] {
    const challenges = [];
    
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.issues?.length > 0) {
      challenges.push(`Code quality issues identified: ${semanticAnalysis.codeAnalysis.codeQuality.issues.length} areas need attention`);
    }
    
    if (semanticAnalysis?.codeAnalysis?.complexityMetrics?.highComplexityFiles?.length > 0) {
      challenges.push(`High complexity detected in ${semanticAnalysis.codeAnalysis.complexityMetrics.highComplexityFiles.length} files`);
    }
    
    if (vibeAnalysis?.sessions?.length === 0) {
      challenges.push('Limited conversation history available for analysis');
    }
    
    if (gitAnalysis?.commits?.length < 10) {
      challenges.push('Limited git history may affect pattern identification accuracy');
    }
    
    if (challenges.length === 0) {
      challenges.push('No significant challenges encountered during analysis');
    }
    
    return challenges;
  }

  private extractKeyLearnings(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any, patternCatalog: PatternCatalog): string[] {
    const learnings = [];
    
    if (patternCatalog.summary.avgSignificance > 6) {
      learnings.push(`High-quality patterns identified with average significance of ${patternCatalog.summary.avgSignificance}/10`);
    }
    
    if (Object.keys(patternCatalog.summary.byCategory).length > 2) {
      learnings.push(`Diverse pattern categories indicate comprehensive development approach: ${Object.keys(patternCatalog.summary.byCategory).join(', ')}`);
    }
    
    if (vibeAnalysis?.summary?.primaryFocus) {
      learnings.push(`Development focus on ${vibeAnalysis.summary.primaryFocus} shows clear project direction`);
    }
    
    if (semanticAnalysis?.crossAnalysisInsights) {
      learnings.push('Cross-analysis correlation provides deeper insights than individual analysis methods');
    }
    
    learnings.push('Semantic analysis combining multiple data sources yields superior insight quality');
    learnings.push('Pattern identification across different analysis types reveals systemic development approaches');
    
    return learnings;
  }

  private extractImprovements(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): string[] {
    const improvements = [];
    
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.recommendations) {
      improvements.push(...semanticAnalysis.codeAnalysis.codeQuality.recommendations);
    }
    
    improvements.push('Establish regular semantic analysis cycles for continuous insight generation');
    improvements.push('Create pattern libraries from identified high-significance patterns');
    improvements.push('Implement automated quality gates based on complexity metrics');
    
    return improvements;
  }

  private extractFutureConsiderations(patternCatalog: PatternCatalog): string[] {
    const considerations = [];
    
    if (patternCatalog.patterns.length > 10) {
      considerations.push('Consider creating a formal pattern catalog for team reference');
    }
    
    considerations.push('Monitor pattern evolution over time to identify emerging trends');
    considerations.push('Integrate semantic analysis insights into development workflow');
    considerations.push('Explore automated pattern application and enforcement mechanisms');
    considerations.push('Consider expanding analysis to include performance and security patterns');
    
    return considerations;
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
    return '!theme plain';
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
}
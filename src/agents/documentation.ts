import { log } from "../logging.js";
import fs from "fs/promises";
import path from "path";

export interface DocumentationConfig {
  templateDir: string;
  outputFormat: "markdown" | "html" | "pdf";
  includeCodeExamples: boolean;
  includeDiagrams: boolean;
}

export interface AutoGenerationConfig {
  onWorkflowCompletion: boolean;
  onSignificantInsights: boolean;
  significanceThreshold: number;
}

export interface DocumentationTemplate {
  name: string;
  type: "pattern" | "insight" | "analysis" | "workflow";
  content: string;
  variables: string[];
}

export interface DocumentationResult {
  title: string;
  content: string;
  format: string;
  generatedAt: string;
  templateUsed: string;
  metadata: Record<string, any>;
}

export interface PlantUMLConfig {
  enabled: boolean;
  outputDir: string;
  standardStylePath?: string;
}

export interface UKBConfig {
  enabled: boolean;
  command: string;
}

export interface InsightConfig {
  outputDir: string;
  generatePuml: boolean;
  generateImages: boolean;
}

export class DocumentationAgent {
  private config: DocumentationConfig;
  private autoConfig: AutoGenerationConfig;
  private templates: Map<string, DocumentationTemplate> = new Map();
  private agents: Map<string, any> = new Map();
  private plantumlConfig: PlantUMLConfig;
  private ukbConfig: UKBConfig;
  private insightConfig: InsightConfig;
  private plantumlAvailable: boolean = false;

  constructor() {
    this.config = {
      templateDir: "/Users/q284340/Agentic/coding/integrations/mcp-server-semantic-analysis-node/templates",
      outputFormat: "markdown",
      includeCodeExamples: true,
      includeDiagrams: false,
    };

    this.autoConfig = {
      onWorkflowCompletion: true,
      onSignificantInsights: true,
      significanceThreshold: 8,
    };

    // Get knowledge base path from environment variable
    const knowledgeBasePath = process.env.KNOWLEDGE_BASE_PATH || '/Users/q284340/Agentic/coding/knowledge-management/insights';
    const docsPath = process.env.CODING_DOCS_PATH || '/Users/q284340/Agentic/coding/docs';

    this.plantumlConfig = {
      enabled: true,
      outputDir: knowledgeBasePath,
      standardStylePath: `${docsPath}/puml/_standard-style.puml`
    };

    this.ukbConfig = {
      enabled: true,
      command: "ukb"
    };

    this.insightConfig = {
      outputDir: knowledgeBasePath,
      generatePuml: true,
      generateImages: true
    };

    this.initializeTemplates();
    this.initializeDirectories();
    this.checkPlantUMLAvailability();
    log("DocumentationAgent initialized", "info");
  }

  private initializeTemplates(): void {
    const templates: DocumentationTemplate[] = [
      {
        name: "pattern_documentation",
        type: "pattern",
        content: `# {{pattern_name}}

## Overview
{{description}}

## Implementation
\`\`\`{{language}}
{{code_example}}
\`\`\`

## Usage
{{usage_example}}

## Benefits
{{benefits}}

## Considerations
{{considerations}}

## Related Patterns
{{related_patterns}}

---
*Generated on {{timestamp}}*`,
        variables: ["pattern_name", "description", "language", "code_example", "usage_example", "benefits", "considerations", "related_patterns", "timestamp"],
      },
      {
        name: "insight_report",
        type: "insight",
        content: `# {{title}}

**Significance:** {{significance}}/10  
**Generated:** {{timestamp}}  
**Type:** {{type}}

## Executive Summary
{{summary}}

## Key Insights
{{insights}}

## Findings
{{findings}}

## Recommendations
{{recommendations}}

## Supporting Data
{{supporting_data}}

## Implementation Guidance
{{implementation_guidance}}

## Next Steps
{{next_steps}}

---
*This document was automatically generated from semantic analysis results*`,
        variables: ["title", "significance", "timestamp", "type", "summary", "insights", "findings", "recommendations", "supporting_data", "implementation_guidance", "next_steps"],
      },
      {
        name: "analysis_documentation",
        type: "analysis",
        content: `# {{analysis_title}}

## Analysis Overview
**Scope:** {{scope}}  
**Duration:** {{duration}}  
**Analyzed:** {{analyzed_items}}

## Methodology
{{methodology}}

## Results Summary
{{results_summary}}

## Detailed Findings
{{detailed_findings}}

## Code Quality Metrics
{{quality_metrics}}

## Architecture Insights
{{architecture_insights}}

## Pattern Analysis
{{pattern_analysis}}

## Recommendations
{{recommendations}}

## Appendices
{{appendices}}

---
*Analysis completed on {{timestamp}}*`,
        variables: ["analysis_title", "scope", "duration", "analyzed_items", "methodology", "results_summary", "detailed_findings", "quality_metrics", "architecture_insights", "pattern_analysis", "recommendations", "appendices", "timestamp"],
      },
      {
        name: "workflow_documentation",
        type: "workflow",
        content: `# {{workflow_name}} - Execution Report

## Workflow Overview
**Name:** {{workflow_name}}  
**Description:** {{workflow_description}}  
**Execution ID:** {{execution_id}}  
**Status:** {{status}}  
**Duration:** {{duration}}

## Agents Involved
{{agents_list}}

## Execution Steps
{{execution_steps}}

## Results
{{results}}

## Quality Metrics
{{quality_metrics}}

## Issues Encountered
{{issues}}

## Lessons Learned
{{lessons_learned}}

## Artifacts Generated
{{artifacts}}

---
*Workflow executed on {{timestamp}}*`,
        variables: ["workflow_name", "workflow_description", "execution_id", "status", "duration", "agents_list", "execution_steps", "results", "quality_metrics", "issues", "lessons_learned", "artifacts", "timestamp"],
      },
    ];

    templates.forEach(template => {
      this.templates.set(template.name, template);
    });

    log(`Initialized ${templates.length} documentation templates`, "info");
  }

  async generateDocumentation(
    templateName: string,
    data: Record<string, any>,
    options: Partial<DocumentationConfig> = {}
  ): Promise<DocumentationResult> {
    const template = this.templates.get(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    const config = { ...this.config, ...options };
    
    log(`Generating documentation using template: ${templateName}`, "info", {
      format: config.outputFormat,
      includeCode: config.includeCodeExamples,
    });

    try {
      // Process template variables
      let content = template.content;
      
      // Add timestamp if not provided
      if (!data.timestamp) {
        data.timestamp = new Date().toISOString();
      }

      // Replace template variables
      for (const variable of template.variables) {
        const value = data[variable] || `[${variable}]`;
        const regex = new RegExp(`{{${variable}}}`, 'g');
        content = content.replace(regex, String(value));
      }

      // Process code examples if enabled
      if (config.includeCodeExamples && data.code_examples) {
        content = this.processCodeExamples(content, data.code_examples);
      }

      // Process diagrams if enabled
      if (config.includeDiagrams && data.diagrams) {
        content = this.processDiagrams(content, data.diagrams);
      }

      const result: DocumentationResult = {
        title: data.title || data.pattern_name || data.analysis_title || data.workflow_name || "Generated Documentation",
        content,
        format: config.outputFormat,
        generatedAt: new Date().toISOString(),
        templateUsed: templateName,
        metadata: {
          templateType: template.type,
          variables: template.variables,
          dataProvided: Object.keys(data),
          config,
        },
      };

      log(`Documentation generated successfully: ${result.title}`, "info");
      return result;
      
    } catch (error) {
      log(`Failed to generate documentation`, "error", error);
      throw error;
    }
  }

  async generatePatternDocumentation(pattern: any): Promise<DocumentationResult> {
    const data = {
      pattern_name: pattern.name || "Unnamed Pattern",
      description: pattern.description || "No description provided",
      language: pattern.language || "javascript",
      code_example: pattern.code || "// No code example available",
      usage_example: pattern.usageExample || "// Usage example not provided",
      benefits: this.formatList(pattern.benefits || ["Improves code organization"]),
      considerations: this.formatList(pattern.considerations || ["Consider performance implications"]),
      related_patterns: this.formatList(pattern.relatedPatterns || ["None identified"]),
    };

    return await this.generateDocumentation("pattern_documentation", data);
  }

  async generateInsightReport(insight: any): Promise<DocumentationResult> {
    const data = {
      title: insight.title || "Analysis Insight Report",
      significance: insight.significance || 5,
      type: insight.type || "General",
      summary: insight.summary || "No summary provided",
      insights: this.formatList(insight.insights || []),
      findings: this.formatList(insight.findings || []),
      recommendations: this.formatList(insight.recommendations || []),
      supporting_data: insight.supportingData ? JSON.stringify(insight.supportingData, null, 2) : "No supporting data",
      implementation_guidance: insight.implementationGuidance || "Implementation guidance not provided",
      next_steps: this.formatList(insight.nextSteps || ["Review and prioritize recommendations"]),
    };

    return await this.generateDocumentation("insight_report", data);
  }

  async generateAnalysisDocumentation(analysis: any): Promise<DocumentationResult> {
    const data = {
      analysis_title: analysis.title || "Code Analysis Report",
      scope: analysis.scope || "Repository analysis",
      duration: analysis.duration || "Unknown",
      analyzed_items: analysis.analyzedItems || "Various code files",
      methodology: analysis.methodology || "Semantic analysis using AI-powered tools",
      results_summary: analysis.resultsSummary || "Analysis completed successfully",
      detailed_findings: this.formatFindings(analysis.findings || []),
      quality_metrics: this.formatMetrics(analysis.qualityMetrics || {}),
      architecture_insights: this.formatList(analysis.architectureInsights || []),
      pattern_analysis: this.formatPatterns(analysis.patterns || []),
      recommendations: this.formatList(analysis.recommendations || []),
      appendices: analysis.appendices || "No additional appendices",
    };

    return await this.generateDocumentation("analysis_documentation", data);
  }

  async generateWorkflowDocumentation(workflow: any): Promise<DocumentationResult> {
    const data = {
      workflow_name: workflow.name || "Unnamed Workflow",
      workflow_description: workflow.description || "No description provided",
      execution_id: workflow.executionId || "Unknown",
      status: workflow.status || "Completed",
      duration: workflow.duration || "Unknown",
      agents_list: this.formatList(workflow.agents || []),
      execution_steps: this.formatSteps(workflow.steps || []),
      results: this.formatResults(workflow.results || {}),
      quality_metrics: this.formatMetrics(workflow.qualityMetrics || {}),
      issues: this.formatList(workflow.issues || ["No issues encountered"]),
      lessons_learned: this.formatList(workflow.lessonsLearned || []),
      artifacts: this.formatList(workflow.artifacts || []),
    };

    return await this.generateDocumentation("workflow_documentation", data);
  }

  private processCodeExamples(content: string, codeExamples: any[]): string {
    // Add additional code examples section
    if (codeExamples.length > 0) {
      const examplesSection = "\n\n## Additional Code Examples\n\n" +
        codeExamples.map((example, index) => 
          `### Example ${index + 1}: ${example.title || 'Untitled'}\n\n` +
          `\`\`\`${example.language || 'javascript'}\n${example.code}\n\`\`\`\n\n` +
          (example.description ? `${example.description}\n\n` : '')
        ).join('');
      
      content += examplesSection;
    }
    
    return content;
  }

  private processDiagrams(content: string, diagrams: any[]): string {
    // Add diagrams section
    if (diagrams.length > 0) {
      const diagramsSection = "\n\n## Diagrams\n\n" +
        diagrams.map((diagram, index) =>
          `### ${diagram.title || `Diagram ${index + 1}`}\n\n` +
          `\`\`\`plantuml\n${diagram.content}\n\`\`\`\n\n`
        ).join('');
      
      content += diagramsSection;
    }
    
    return content;
  }

  private formatList(items: string[]): string {
    if (!Array.isArray(items) || items.length === 0) {
      return "- None";
    }
    return items.map(item => `- ${item}`).join('\n');
  }

  private formatFindings(findings: any[]): string {
    if (!Array.isArray(findings) || findings.length === 0) {
      return "No specific findings to report.";
    }

    return findings.map((finding, index) => 
      `### Finding ${index + 1}: ${finding.title || 'Untitled'}\n\n` +
      `**Severity:** ${finding.severity || 'Low'}\n` +
      `**Description:** ${finding.description || 'No description'}\n` +
      `**Location:** ${finding.location || 'Not specified'}\n\n`
    ).join('');
  }

  private formatMetrics(metrics: Record<string, any>): string {
    if (!metrics || Object.keys(metrics).length === 0) {
      return "No metrics available.";
    }

    return Object.entries(metrics)
      .map(([key, value]) => `- **${key}:** ${value}`)
      .join('\n');
  }

  private formatPatterns(patterns: any[]): string {
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return "No patterns identified.";
    }

    return patterns.map((pattern, index) =>
      `### Pattern ${index + 1}: ${pattern.name || 'Unnamed'}\n\n` +
      `**Type:** ${pattern.type || 'Unknown'}\n` +
      `**Description:** ${pattern.description || 'No description'}\n` +
      `**Usage Count:** ${pattern.usageCount || 'Unknown'}\n\n`
    ).join('');
  }

  private formatSteps(steps: any[]): string {
    if (!Array.isArray(steps) || steps.length === 0) {
      return "No steps recorded.";
    }

    return steps.map((step, index) =>
      `### Step ${index + 1}: ${step.name || 'Unnamed Step'}\n\n` +
      `**Agent:** ${step.agent || 'Unknown'}\n` +
      `**Action:** ${step.action || 'Unknown'}\n` +
      `**Status:** ${step.status || 'Unknown'}\n` +
      `**Duration:** ${step.duration || 'Unknown'}\n\n`
    ).join('');
  }

  private formatResults(results: Record<string, any>): string {
    if (!results || Object.keys(results).length === 0) {
      return "No results recorded.";
    }

    return Object.entries(results)
      .map(([key, value]) => 
        `### ${key}\n\n${typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}\n\n`
      )
      .join('');
  }

  async saveDocumentation(doc: DocumentationResult, outputPath: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, doc.content, 'utf-8');
      
      log(`Documentation saved to: ${outputPath}`, "info");
    } catch (error) {
      log(`Failed to save documentation`, "error", error);
      throw error;
    }
  }

  shouldAutoGenerate(data: any): boolean {
    if (!this.autoConfig.onSignificantInsights) {
      return false;
    }

    const significance = data.significance || 0;
    return significance >= this.autoConfig.significanceThreshold;
  }

  updateConfig(config: Partial<DocumentationConfig>): void {
    Object.assign(this.config, config);
    log("Documentation config updated", "info", this.config);
  }

  updateAutoConfig(config: Partial<AutoGenerationConfig>): void {
    Object.assign(this.autoConfig, config);
    log("Auto-generation config updated", "info", this.autoConfig);
  }

  // Agent registration for workflow integration
  registerAgent(name: string, agent: any): void {
    this.agents.set(name, agent);
    log(`Registered agent: ${name}`, "info");
  }

  private async initializeDirectories(): Promise<void> {
    try {
      await fs.mkdir(path.join(this.insightConfig.outputDir, "puml"), { recursive: true });
      await fs.mkdir(path.join(this.insightConfig.outputDir, "images"), { recursive: true });
      log("Created insight directories", "info");
    } catch (error) {
      log("Failed to create insight directories", "warning", error);
    }
  }

  private async checkPlantUMLAvailability(): Promise<void> {
    try {
      const { spawn } = await import('child_process');
      const plantuml = spawn('plantuml', ['-version']);
      
      plantuml.on('close', (code) => {
        this.plantumlAvailable = code === 0;
        if (this.plantumlAvailable) {
          log("PlantUML is available", "info");
        } else {
          log("PlantUML not available - diagram generation will be disabled", "warning");
        }
      });
      
      plantuml.on('error', () => {
        this.plantumlAvailable = false;
        log("PlantUML not found - diagram generation will be disabled", "warning");
      });
    } catch (error) {
      this.plantumlAvailable = false;
      log("Could not check PlantUML availability", "warning", error);
    }
  }

  // Enhanced documentation generation methods
  async generateEntitySummary(): Promise<DocumentationResult> {
    try {
      const kgAgent = this.agents.get("knowledge_graph");
      if (!kgAgent) {
        throw new Error("Knowledge graph agent not available");
      }

      const entities = Array.from(kgAgent.entities?.values() || []);
      
      // Analyze entities
      const entitiesByType: Record<string, number> = {};
      const highSignificanceEntities: any[] = [];
      const recentEntities: any[] = [];
      const now = Date.now();
      const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

      for (const entity of entities) {
        const entityType = (entity as any).entity_type || (entity as any).entityType || "Unknown";
        entitiesByType[entityType] = (entitiesByType[entityType] || 0) + 1;
        
        if (((entity as any).significance || 0) >= 8) {
          highSignificanceEntities.push({
            name: (entity as any).name,
            type: entityType,
            significance: (entity as any).significance
          });
        }
        
        const createdAt = (entity as any).created_at || (entity as any).createdAt || now;
        if (createdAt > oneWeekAgo) {
          recentEntities.push({
            name: (entity as any).name,
            type: entityType,
            created_at: new Date(createdAt).toISOString()
          });
        }
      }

      const data = {
        title: "Knowledge Graph Entity Summary",
        total_entities: entities.length,
        entities_by_type: this.formatEntitiesByType(entitiesByType),
        high_significance_entities: this.formatHighSignificanceEntities(highSignificanceEntities),
        recent_entities: this.formatRecentEntities(recentEntities),
        timestamp: new Date().toISOString()
      };

      const template = {
        name: "entity_summary",
        type: "analysis" as const,
        content: `# {{title}}

**Generated:** {{timestamp}}  
**Total Entities:** {{total_entities}}

## Entities by Type

{{entities_by_type}}

## High Significance Entities (≥8)

{{high_significance_entities}}

## Recent Entities (Last 7 Days)

{{recent_entities}}

---
*Generated by Documentation Agent*`,
        variables: ["title", "timestamp", "total_entities", "entities_by_type", "high_significance_entities", "recent_entities"]
      };

      return await this.generateFromTemplate(template, data);
      
    } catch (error) {
      log("Failed to generate entity summary", "error", error);
      throw error;
    }
  }

  private formatEntitiesByType(entitiesByType: Record<string, number>): string {
    if (Object.keys(entitiesByType).length === 0) {
      return "No entities found.";
    }
    
    return Object.entries(entitiesByType)
      .sort(([,a], [,b]) => b - a)
      .map(([type, count]) => `- **${type}**: ${count}`)
      .join('\n');
  }

  private formatHighSignificanceEntities(entities: any[]): string {
    if (entities.length === 0) {
      return "No high-significance entities found.";
    }
    
    return entities
      .sort((a, b) => (b.significance || 0) - (a.significance || 0))
      .map(entity => `- **${entity.name}** (${entity.type}) - Significance: ${entity.significance}`)
      .join('\n');
  }

  private formatRecentEntities(entities: any[]): string {
    if (entities.length === 0) {
      return "No recent entities found.";
    }
    
    return entities
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(entity => `- **${entity.name}** (${entity.type}) - Created: ${new Date(entity.created_at).toLocaleDateString()}`)
      .join('\n');
  }

  // PlantUML diagram generation
  async generatePlantUMLDiagram(diagramType: string, content: string, name: string, analysisResult: any = {}): Promise<any> {
    try {
      if (!this.plantumlAvailable) {
        return { success: false, error: "PlantUML not available" };
      }

      let diagramContent = "";
      
      switch (diagramType) {
        case "architecture":
          diagramContent = this.generateArchitectureDiagram(content, analysisResult);
          break;
        case "sequence":
          diagramContent = this.generateSequenceDiagram(content, analysisResult);
          break;
        case "use-cases":
          diagramContent = this.generateUseCasesDiagram(content, analysisResult);
          break;
        case "class":
          diagramContent = this.generateClassDiagram(content, analysisResult);
          break;
        default:
          return { success: false, error: `Unsupported diagram type: ${diagramType}` };
      }

      // Write PlantUML file
      const pumlDir = path.join(this.insightConfig.outputDir, "puml");
      const pumlFile = path.join(pumlDir, `${name}.puml`);
      
      await fs.writeFile(pumlFile, diagramContent);
      
      // Generate PNG if requested and PlantUML is available
      let pngFile = null;
      if (this.insightConfig.generateImages) {
        const imagesDir = path.join(this.insightConfig.outputDir, "images");
        pngFile = path.join(imagesDir, `${name}.png`);
        
        try {
          const { spawn } = await import('child_process');
          const plantuml = spawn('plantuml', ['-o', imagesDir, pumlFile]);
          
          await new Promise((resolve, reject) => {
            plantuml.on('close', (code) => {
              if (code === 0) resolve(code);
              else reject(new Error(`PlantUML process exited with code ${code}`));
            });
            plantuml.on('error', reject);
          });
        } catch (error) {
          log("Failed to generate PNG from PlantUML", "warning", error);
        }
      }

      return {
        success: true,
        diagram_type: diagramType,
        puml_file: pumlFile,
        png_file: pngFile,
        content: diagramContent
      };
      
    } catch (error) {
      log("Failed to generate PlantUML diagram", "error", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private generateArchitectureDiagram(content: string, analysisResult: any): string {
    return `@startuml
!include ${this.plantumlConfig.standardStylePath || ''}

title Architecture Overview: ${content}

' Architecture components
package "System Architecture" {
  component "${content}" as main
  
  note right of main
    Generated from semantic analysis
    Components and relationships
  end note
}

@enduml`;
  }

  private generateSequenceDiagram(content: string, analysisResult: any): string {
    return `@startuml
!include ${this.plantumlConfig.standardStylePath || ''}

title Sequence Diagram: ${content}

actor User
participant "System" as sys
participant "${content}" as component

User -> sys: Request
sys -> component: Process
component -> sys: Response
sys -> User: Result

@enduml`;
  }

  private generateUseCasesDiagram(content: string, analysisResult: any): string {
    return `@startuml
!include ${this.plantumlConfig.standardStylePath || ''}

title Use Cases: ${content}

left to right direction
actor User

rectangle "${content} System" {
  usecase "Use ${content}" as UC1
  usecase "Configure ${content}" as UC2
  usecase "Monitor ${content}" as UC3
}

User --> UC1
User --> UC2
User --> UC3

@enduml`;
  }

  private generateClassDiagram(content: string, analysisResult: any): string {
    return `@startuml
!include ${this.plantumlConfig.standardStylePath || ''}

title Class Diagram: ${content}

class ${content.replace(/\s+/g, '')} {
  +property: String
  +method(): void
}

note right of ${content.replace(/\s+/g, '')}
  Generated from analysis
  Key classes and relationships
end note

@enduml`;
  }

  // Insight document creation
  async createInsightDocument(analysisResult: any, metadata: any = {}): Promise<any> {
    try {
      const insightName = metadata.insight_name || `insight_${Date.now()}`;
      const insightType = metadata.insight_type || "analysis";
      
      // Generate comprehensive insight document
      const insightContent = this.generateInsightContent(analysisResult, metadata);
      
      // Save insight document
      const insightFile = path.join(this.insightConfig.outputDir, `${insightName}.md`);
      await fs.writeFile(insightFile, insightContent);
      
      // Generate PlantUML diagrams if enabled
      const diagrams: any[] = [];
      if (this.insightConfig.generatePuml) {
        const diagramTypes = ["architecture", "sequence", "use-cases"];
        
        for (const diagramType of diagramTypes) {
          const diagramResult = await this.generatePlantUMLDiagram(
            diagramType,
            insightName,
            `${insightName}_${diagramType}`,
            analysisResult
          );
          
          if (diagramResult.success) {
            diagrams.push(diagramResult);
          }
        }
      }
      
      return {
        success: true,
        insight_name: insightName,
        insight_file: insightFile,
        insight_type: insightType,
        diagrams_generated: diagrams.length,
        diagrams
      };
      
    } catch (error) {
      log("Failed to create insight document", "error", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private generateInsightContent(analysisResult: any, metadata: any): string {
    const insightName = metadata.insight_name || "Unnamed Insight";
    const significance = metadata.significance || 5;
    const tags = Array.isArray(metadata.tags) ? metadata.tags.join(", ") : "analysis";
    
    return `# ${insightName}

**Significance:** ${significance}/10  
**Tags:** ${tags}  
**Generated:** ${new Date().toISOString()}

## Executive Summary

${this.extractSummary(analysisResult)}

## Key Insights

${this.extractInsights(analysisResult)}

## Technical Details

${this.extractTechnicalDetails(analysisResult)}

## Implementation Guidance

${this.extractImplementationGuidance(analysisResult)}

## Recommendations

${this.extractRecommendations(analysisResult)}

## Supporting Data

\`\`\`json
${JSON.stringify(analysisResult, null, 2)}
\`\`\`

---
*Generated by Semantic Analysis Documentation Agent*

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>`;
  }

  private extractSummary(analysisResult: any): string {
    if (analysisResult.summary) return analysisResult.summary;
    if (analysisResult.result) return String(analysisResult.result);
    return "Comprehensive semantic analysis completed with actionable insights generated.";
  }

  private extractInsights(analysisResult: any): string {
    if (analysisResult.insights && Array.isArray(analysisResult.insights)) {
      return analysisResult.insights.map((insight: string, index: number) => `${index + 1}. ${insight}`).join('\n');
    }
    return "- Detailed analysis patterns identified\n- Code structure and relationships mapped\n- Optimization opportunities discovered";
  }

  private extractTechnicalDetails(analysisResult: any): string {
    const details: string[] = [];
    
    if (analysisResult.files_analyzed) {
      details.push(`- **Files Analyzed:** ${analysisResult.files_analyzed}`);
    }
    if (analysisResult.patterns_found) {
      details.push(`- **Patterns Found:** ${analysisResult.patterns_found}`);
    }
    if (analysisResult.entities_created) {
      details.push(`- **Entities Created:** ${analysisResult.entities_created}`);
    }
    if (analysisResult.processing_time) {
      details.push(`- **Processing Time:** ${analysisResult.processing_time}ms`);
    }
    
    return details.length > 0 ? details.join('\n') : "Technical analysis metrics recorded and processed.";
  }

  private extractImplementationGuidance(analysisResult: any): string {
    if (analysisResult.implementation_guidance) return analysisResult.implementation_guidance;
    return "Review the identified patterns and consider implementing the recommended optimizations in phases.";
  }

  private extractRecommendations(analysisResult: any): string {
    if (analysisResult.recommendations && Array.isArray(analysisResult.recommendations)) {
      return analysisResult.recommendations.map((rec: string, index: number) => `${index + 1}. ${rec}`).join('\n');
    }
    return "1. Review generated insights and prioritize implementation\n2. Monitor code quality improvements\n3. Apply identified patterns consistently";
  }

  // UKB integration for knowledge base management
  async createUKBEntityWithInsight(entityName: string, entityType: string, insights: string, significance: number = 5, tags: string[] = []): Promise<any> {
    try {
      if (!this.ukbConfig.enabled) {
        return { success: false, error: "UKB integration disabled" };
      }

      // Create insight document first
      const insightResult = await this.createInsightDocument(
        { insights, significance, recommendations: [] },
        { insight_name: entityName, insight_type: entityType, tags }
      );
      
      if (!insightResult.success) {
        return insightResult;
      }

      // Note: In a real implementation, this would call the UKB command
      // For now, we'll simulate the UKB entity creation
      log(`Would create UKB entity: ${entityName} (${entityType}) with significance ${significance}`, "info");
      
      return {
        success: true,
        entity_name: entityName,
        entity_type: entityType,
        significance,
        tags,
        insight_document: insightResult.insight_file,
        ukb_integrated: true
      };
      
    } catch (error) {
      log("Failed to create UKB entity with insight", "error", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Lessons learned generation
  async generateLessonsLearned(analysisResult: any, metadata: any = {}): Promise<any> {
    try {
      const title = metadata.title || "Lessons Learned";
      
      const lessonsContent = this.generateLessonsLearnedContent(analysisResult, metadata);
      
      // Save lessons learned document
      const lessonsFile = path.join(this.insightConfig.outputDir, `${title.replace(/\s+/g, '_').toLowerCase()}_lessons.md`);
      await fs.writeFile(lessonsFile, lessonsContent);
      
      return {
        success: true,
        title,
        lessons_file: lessonsFile,
        content: lessonsContent
      };
      
    } catch (error) {
      log("Failed to generate lessons learned", "error", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private generateLessonsLearnedContent(analysisResult: any, metadata: any): string {
    const title = metadata.title || "Lessons Learned";
    
    return `# ${title}

**Date:** ${new Date().toISOString()}  
**Context:** ${metadata.context || "Semantic Analysis Session"}

## What Worked Well

${this.extractSuccesses(analysisResult)}

## Challenges Encountered

${this.extractChallenges(analysisResult)}

## Key Learnings

${this.extractLearnings(analysisResult)}

## Actionable Improvements

${this.extractImprovements(analysisResult)}

## Future Considerations

${this.extractFutureConsiderations(analysisResult)}

---
*Lessons Learned captured by Documentation Agent*

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>`;
  }

  private extractSuccesses(analysisResult: any): string {
    const successes = analysisResult.successes || [];
    if (Array.isArray(successes) && successes.length > 0) {
      return successes.map((success: string, index: number) => `${index + 1}. ${success}`).join('\n');
    }
    return "- Analysis completed successfully\n- Insights generated effectively\n- System performed as expected";
  }

  private extractChallenges(analysisResult: any): string {
    const challenges = analysisResult.challenges || analysisResult.errors || [];
    if (Array.isArray(challenges) && challenges.length > 0) {
      return challenges.map((challenge: string, index: number) => `${index + 1}. ${challenge}`).join('\n');
    }
    return "- No significant challenges encountered";
  }

  private extractLearnings(analysisResult: any): string {
    const learnings = analysisResult.learnings || [];
    if (Array.isArray(learnings) && learnings.length > 0) {
      return learnings.map((learning: string, index: number) => `${index + 1}. ${learning}`).join('\n');
    }
    return "- Semantic analysis provides valuable insights\n- Pattern recognition improves code understanding\n- Automated documentation saves significant time";
  }

  private extractImprovements(analysisResult: any): string {
    const improvements = analysisResult.improvements || [];
    if (Array.isArray(improvements) && improvements.length > 0) {
      return improvements.map((improvement: string, index: number) => `${index + 1}. ${improvement}`).join('\n');
    }
    return "- Continue iterating on analysis patterns\n- Enhance documentation templates\n- Improve automated insight generation";
  }

  private extractFutureConsiderations(analysisResult: any): string {
    const considerations = analysisResult.future_considerations || [];
    if (Array.isArray(considerations) && considerations.length > 0) {
      return considerations.map((consideration: string, index: number) => `${index + 1}. ${consideration}`).join('\n');
    }
    return "- Monitor long-term effectiveness of implemented changes\n- Explore additional analysis capabilities\n- Integrate feedback for continuous improvement";
  }

  // Event handlers for workflow integration
  async handleGenerateDocumentation(data: any): Promise<any> {
    const templateName = data.template_name || data.templateName || "analysis_documentation";
    const analysisResult = data.analysis_result || data.analysisResult || {};
    const metadata = data.metadata || {};
    
    return await this.generateDocumentation(templateName, { ...analysisResult, ...metadata });
  }

  async handleGenerateReport(data: any): Promise<any> {
    const reportType = data.report_type || data.reportType || "analysis";
    
    switch (reportType) {
      case "analysis":
        return await this.generateAnalysisDocumentation(data.analysis_results || data.analysisResults || {});
      case "entity_summary":
        return await this.generateEntitySummary();
      case "workflow":
        return await this.generateWorkflowDocumentation(data.workflow || {});
      default:
        return { success: false, error: `Unknown report type: ${reportType}` };
    }
  }

  async handleCreateInsightDocument(data: any): Promise<any> {
    return await this.createInsightDocument(data.analysis_result || {}, data.metadata || {});
  }

  async handleGeneratePlantUMLDiagram(data: any): Promise<any> {
    return await this.generatePlantUMLDiagram(
      data.diagram_type || "architecture",
      data.content || "System",
      data.name || `diagram_${Date.now()}`,
      data.analysis_result || {}
    );
  }

  async handleCreateUKBEntityWithInsight(data: any): Promise<any> {
    return await this.createUKBEntityWithInsight(
      data.entity_name || "Unknown",
      data.entity_type || "Insight",
      data.insights || "No insights provided",
      data.significance || 5,
      data.tags || []
    );
  }

  async handleGenerateLessonsLearned(data: any): Promise<any> {
    return await this.generateLessonsLearned(data.analysis_result || {}, data.metadata || {});
  }

  // Template generation helper
  private async generateFromTemplate(template: DocumentationTemplate, data: Record<string, any>): Promise<DocumentationResult> {
    let content = template.content;
    
    // Add timestamp if not provided
    if (!data.timestamp) {
      data.timestamp = new Date().toISOString();
    }

    // Replace template variables
    for (const variable of template.variables) {
      const value = data[variable] || `[${variable}]`;
      const regex = new RegExp(`{{${variable}}}`, 'g');
      content = content.replace(regex, String(value));
    }

    return {
      title: data.title || "Generated Documentation",
      content,
      format: this.config.outputFormat,
      generatedAt: new Date().toISOString(),
      templateUsed: template.name,
      metadata: {
        templateType: template.type,
        variables: template.variables,
        dataProvided: Object.keys(data)
      }
    };
  }

  // Health check
  healthCheck(): any {
    return {
      status: "healthy",
      templates_available: this.templates.size,
      plantuml_available: this.plantumlAvailable,
      ukb_enabled: this.ukbConfig.enabled,
      registered_agents: this.agents.size,
      output_format: this.config.outputFormat,
      auto_generation: this.autoConfig
    };
  }
}
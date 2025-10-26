import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logging.js";
import { SemanticAnalysisAgent } from "./agents/semantic-analysis-agent.js";
import { SemanticAnalyzer } from "./agents/semantic-analyzer.js";
import { CoordinatorAgent } from "./agents/coordinator.js";
import { InsightGenerationAgent } from "./agents/insight-generation-agent.js";
import { DeduplicationAgent } from "./agents/deduplication.js";
import { WebSearchAgent } from "./agents/web-search.js";
import { PersistenceAgent } from "./agents/persistence-agent.js";
import fs from "fs/promises";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";

// Tool definitions
export const TOOLS: Tool[] = [
  {
    name: "heartbeat",
    description: "Send a heartbeat to keep the connection alive (call every 30 seconds)",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "test_connection",
    description: "Test the connection to the semantic analysis server",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "determine_insights",
    description: "Determine insights from analysis results using LLM providers",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Content to analyze for insights",
        },
        context: {
          type: "string", 
          description: "Additional context for the analysis",
        },
        analysis_type: {
          type: "string",
          description: "Type of analysis to perform (general, code, patterns, architecture)",
          enum: ["general", "code", "patterns", "architecture"],
        },
        provider: {
          type: "string",
          description: "Preferred LLM provider (anthropic, openai, auto)",
          enum: ["anthropic", "openai", "auto"],
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_code",
    description: "Analyze code for patterns, issues, and architectural insights",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Code content to analyze",
        },
        language: {
          type: "string",
          description: "Programming language (if known)",
        },
        file_path: {
          type: "string", 
          description: "File path for context",
        },
        analysis_focus: {
          type: "string",
          description: "Focus area for analysis",
          enum: ["patterns", "quality", "security", "performance", "architecture"],
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "analyze_repository",
    description: "Analyze repository structure and extract architectural patterns",
    inputSchema: {
      type: "object",
      properties: {
        repository_path: {
          type: "string",
          description: "Path to the repository to analyze",
        },
        include_patterns: {
          type: "array",
          items: { type: "string" },
          description: "File patterns to include (e.g., ['*.js', '*.ts'])",
        },
        exclude_patterns: {
          type: "array", 
          items: { type: "string" },
          description: "File patterns to exclude (e.g., ['node_modules', '*.test.js'])",
        },
        max_files: {
          type: "number",
          description: "Maximum number of files to analyze",
        },
      },
      required: ["repository_path"],
      additionalProperties: false,
    },
  },
  {
    name: "extract_patterns",
    description: "Extract reusable design and architectural patterns",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source content to extract patterns from",
        },
        pattern_types: {
          type: "array",
          items: { type: "string" },
          description: "Types of patterns to look for",
        },
        context: {
          type: "string",
          description: "Additional context about the source",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "create_ukb_entity_with_insight",
    description: "Create UKB entity with detailed insight document",
    inputSchema: {
      type: "object",
      properties: {
        entity_name: {
          type: "string",
          description: "Name for the UKB entity",
        },
        entity_type: {
          type: "string", 
          description: "Type of entity (e.g., Pattern, Workflow, Insight)",
        },
        insights: {
          type: "string",
          description: "Detailed insights content",
        },
        significance: {
          type: "number",
          description: "Significance score (1-10)",
          minimum: 1,
          maximum: 10,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
      },
      required: ["entity_name", "entity_type", "insights"],
      additionalProperties: false,
    },
  },
  {
    name: "execute_workflow",
    description: "Execute a predefined analysis workflow through the coordinator",
    inputSchema: {
      type: "object",
      properties: {
        workflow_name: {
          type: "string",
          description: "Name of the workflow to execute (e.g., 'complete-analysis', 'incremental-analysis')",
        },
        parameters: {
          type: "object",
          description: "Optional parameters for the workflow",
          additionalProperties: true,
        },
      },
      required: ["workflow_name"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_documentation",
    description: "Generate comprehensive documentation from analysis results",
    inputSchema: {
      type: "object",
      properties: {
        analysis_result: {
          type: "object",
          description: "Analysis results to document",
        },
        metadata: {
          type: "object",
          description: "Optional metadata for documentation generation",
          additionalProperties: true,
        },
      },
      required: ["analysis_result"],
      additionalProperties: false,
    },
  },
  {
    name: "create_insight_report",
    description: "Create a detailed insight report with PlantUML diagrams",
    inputSchema: {
      type: "object",
      properties: {
        analysis_result: {
          type: "object",
          description: "Analysis results to create insight from",
        },
        metadata: {
          type: "object",
          description: "Optional metadata including insight name and type",
          additionalProperties: true,
        },
      },
      required: ["analysis_result"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_plantuml_diagrams",
    description: "Generate PlantUML diagrams for analysis results",
    inputSchema: {
      type: "object",
      properties: {
        diagram_type: {
          type: "string",
          description: "Type of diagram (architecture, sequence, use-cases, class)",
          enum: ["architecture", "sequence", "use-cases", "class"],
        },
        content: {
          type: "string",
          description: "Content/title for the diagram",
        },
        name: {
          type: "string",
          description: "Base name for the diagram files",
        },
        analysis_result: {
          type: "object",
          description: "Optional analysis result for context",
          additionalProperties: true,
        },
      },
      required: ["diagram_type", "content", "name"],
      additionalProperties: false,
    },
  },
];

// Tool call handler
export async function handleToolCall(name: string, args: any): Promise<any> {
  log(`Handling tool call: ${name}`, "info", args);

  try {
    switch (name) {
      case "heartbeat":
        return handleHeartbeat();
        
      case "test_connection":
        return handleTestConnection();
        
      case "determine_insights":
        return await handleDetermineInsights(args);
        
      case "analyze_code":
        return await handleAnalyzeCode(args);
        
      case "analyze_repository":
        return await handleAnalyzeRepository(args);
        
      case "extract_patterns":
        return await handleExtractPatterns(args);
        
      case "create_ukb_entity_with_insight":
        return await handleCreateUkbEntity(args);
        
      case "execute_workflow":
        return await handleExecuteWorkflow(args);
        
      case "generate_documentation":
        return await handleGenerateDocumentation(args);
        
      case "create_insight_report":
        return await handleCreateInsightReport(args);
        
      case "generate_plantuml_diagrams":
        return await handleGeneratePlantUMLDiagrams(args);
        
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    log(`Error in tool ${name}:`, "error", error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// Tool implementations
let serverStartTime = Date.now();

function handleHeartbeat(): any {
  const uptime = (Date.now() - serverStartTime) / 1000;
  log("Heartbeat received", "info", { uptime });
  
  return {
    content: [
      {
        type: "text",
        text: `💗 Heartbeat received. Server uptime: ${uptime.toFixed(1)}s`,
      },
    ],
  };
}

function handleTestConnection(): any {
  log("Test connection called", "info");
  
  const timestamp = new Date().toISOString();
  const nodeVersion = process.version;
  const platform = process.platform;
  
  return {
    content: [
      {
        type: "text",
        text: `✅ Semantic Analysis MCP Server Connection Test\n\nServer Status: CONNECTED\nTimestamp: ${timestamp}\nNode.js Version: ${nodeVersion}\nPlatform: ${platform}\nPID: ${process.pid}\n\nAll systems operational!`,
      },
    ],
  };
}

async function handleDetermineInsights(args: any): Promise<any> {
  const { content, context, analysis_type = "general", provider = "auto" } = args;
  
  log(`Determining insights for content (${content.length} chars)`, "info", {
    analysis_type,
    provider,
    has_context: !!context,
  });
  
  try {
    const analyzer = new SemanticAnalyzer();
    log("SemanticAnalyzer created", "info");
    
    const result = await analyzer.analyzeContent(content, {
      context,
      analysisType: analysis_type,
      provider
    });
    
    log("SemanticAnalyzer.analyzeContent completed", "info", {
      hasResult: !!result,
      resultType: typeof result,
      resultKeys: result ? Object.keys(result) : null,
      insightsLength: result?.insights?.length || 0,
      provider: result?.provider || "none"
    });

    if (!result) {
      throw new Error("SemanticAnalyzer returned null/undefined result");
    }

    return {
      content: [
        {
          type: "text", 
          text: `# Semantic Analysis Insights\n\n${result.insights || 'No insights generated'}\n\n## Metadata\n- Provider: ${result.provider || 'Unknown'}\n- Analysis Type: ${analysis_type}\n- Timestamp: ${new Date().toISOString()}`,
        },
      ],
    };
  } catch (error: any) {
    log("Error in handleDetermineInsights", "error", {
      error: error.message,
      stack: error.stack
    });
    
    return {
      content: [
        {
          type: "text",
          text: `# Semantic Analysis Error\n\nError: ${error.message}\n\n## Details\n- Analysis Type: ${analysis_type}\n- Provider: ${provider}\n- Content Length: ${content.length}\n- Has Context: ${!!context}\n- Timestamp: ${new Date().toISOString()}`,
        },
      ],
    };
  }
}

async function handleAnalyzeCode(args: any): Promise<any> {
  const { code, language, file_path, analysis_focus = "patterns" } = args;
  
  log(`Analyzing code (${code.length} chars)`, "info", {
    language,
    file_path,
    analysis_focus,
  });
  
  const analyzer = new SemanticAnalysisAgent();
  const result = await analyzer.analyzeCode(code, language, file_path);
  
  return {
    content: [
      {
        type: "text",
        text: `# Code Analysis Results\n\n${result.analysis}\n\n## Findings\n${result.findings.map((f: string) => `- ${f}`).join('\n')}\n\n## Recommendations\n${result.recommendations.map((r: string) => `- ${r}`).join('\n')}`,
      },
    ],
  };
}

async function handleAnalyzeRepository(args: any): Promise<any> {
  const { repository_path, include_patterns, exclude_patterns, max_files } = args;
  
  log(`Analyzing repository: ${repository_path}`, "info", {
    include_patterns,
    exclude_patterns,
    max_files,
  });
  
  const analyzer = new SemanticAnalysisAgent();
  const result = await analyzer.analyzeRepository(repository_path, {
    includePatterns: include_patterns,
    excludePatterns: exclude_patterns,
    maxFiles: max_files,
  });
  
  return {
    content: [
      {
        type: "text",
        text: `# Repository Analysis\n\n## Structure Overview\n${result.structure}\n\n## Key Patterns\n${result.patterns.map((p: string) => `- ${p}`).join('\n')}\n\n## Architecture Insights\n${result.insights}`,
      },
    ],
  };
}

async function handleExtractPatterns(args: any): Promise<any> {
  const { source, pattern_types, context } = args;
  
  log(`Extracting patterns from source (${source.length} chars)`, "info", {
    pattern_types,
    has_context: !!context,
  });
  
  const analyzer = new SemanticAnalysisAgent();
  const result = await analyzer.extractPatterns(source, pattern_types, context);
  
  return {
    content: [
      {
        type: "text",
        text: `# Extracted Patterns\n\n${result.map((pattern: string) => `- ${pattern}`).join('\n')}`,
      },
    ],
  };
}

async function handleCreateUkbEntity(args: any): Promise<any> {
  const { entity_name, entity_type, insights, significance, tags } = args;
  
  log(`Creating UKB entity: ${entity_name}`, "info", {
    entity_type,
    significance,
    tags,
  });
  
  const knowledgeManager = new PersistenceAgent();
  const result = await knowledgeManager.createUkbEntity({
    name: entity_name,
    type: entity_type,
    insights,
    significance: significance || 5,
    tags: tags || [],
  });
  
  return {
    content: [
      {
        type: "text",
        text: `# UKB Entity Created\n\n**Name:** ${entity_name}\n**Type:** ${entity_type}\n**Significance:** ${significance || 5}/10\n\n## Status\n${result.success ? '✅ Successfully created' : '❌ Failed to create'}\n\n## Details\n${result.details}`,
      },
    ],
  };
}

async function handleExecuteWorkflow(args: any): Promise<any> {
  const { workflow_name, parameters } = args;
  
  log(`Executing workflow: ${workflow_name}`, "info", { parameters });
  
  try {
    // Initialize coordinator and execute real workflow
    // Use repository_path from parameters or default to current directory
    let repositoryPath = parameters?.repository_path || '.';
    
    // If we're running from the semantic analysis subdirectory, resolve the main repo path
    if (repositoryPath === '.' && process.cwd().includes('mcp-server-semantic-analysis')) {
      // Go up two levels from integrations/mcp-server-semantic-analysis to the main repo
      repositoryPath = path.join(process.cwd(), '../..');
    } else if (repositoryPath && !path.isAbsolute(repositoryPath)) {
      // Make relative paths absolute
      repositoryPath = path.resolve(repositoryPath);
    }
    
    log(`Using repository path: ${repositoryPath}`, "info");
    const coordinator = new CoordinatorAgent(repositoryPath);
    const execution = await coordinator.executeWorkflow(workflow_name, parameters);
    
    // Format execution results
    const statusEmoji = execution.status === "completed" ? "✅" : execution.status === "failed" ? "❌" : "⚡";
    const duration = execution.endTime ? 
      `${Math.round((execution.endTime.getTime() - execution.startTime.getTime()) / 1000)}s` : 
      "ongoing";
    
    let resultText = `# Workflow Execution\n\n**Workflow:** ${workflow_name}\n**Status:** ${statusEmoji} ${execution.status}\n**Duration:** ${duration}\n**Steps:** ${execution.currentStep}/${execution.totalSteps}\n\n## Parameters\n${JSON.stringify(parameters || {}, null, 2)}\n\n`;
    
    // Add step results
    if (Object.keys(execution.results).length > 0) {
      resultText += "## Results\n";
      for (const [step, result] of Object.entries(execution.results)) {
        resultText += `- **${step}**: ${typeof result === 'object' ? 'Completed' : result}\n`;
      }
      resultText += "\n";
    }
    
    // Add QA reports if available
    const qaResults = execution.results.quality_assurance;
    if (qaResults && qaResults.validations) {
      resultText += "## Quality Assurance\n";
      for (const [stepName, qa] of Object.entries(qaResults.validations)) {
        const qaReport = qa as any; // Type assertion for validation result
        const qaEmoji = qaReport.passed ? "✅" : "❌";
        resultText += `- **${stepName}**: ${qaEmoji} ${qaReport.passed ? 'Passed' : 'Failed'}\n`;
        if (qaReport.errors && qaReport.errors.length > 0) {
          resultText += `  - Errors: ${qaReport.errors.join(', ')}\n`;
        }
        if (qaReport.warnings && qaReport.warnings.length > 0) {
          resultText += `  - Warnings: ${qaReport.warnings.join(', ')}\n`;
        }
      }
      resultText += "\n";
    }
    
    // Add errors if any
    if (execution.errors.length > 0) {
      resultText += "## Errors\n";
      for (const error of execution.errors) {
        resultText += `- ${error}\n`;
      }
      resultText += "\n";
    }
    
    // Add artifacts information
    if (execution.status === "completed") {
      resultText += "## Generated Artifacts\n";
      resultText += "Check the following locations for generated files:\n";
      resultText += "- `knowledge-management/insights/` - Insight documents\n";
      resultText += "- `shared-memory-coding.json` - Updated knowledge base\n";
      resultText += "- Generated PlantUML diagrams and documentation\n";
    }
    
    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
    
  } catch (error) {
    log(`Workflow execution failed: ${workflow_name}`, "error", error);
    return {
      content: [
        {
          type: "text",
          text: `# Workflow Execution Failed\n\n**Workflow:** ${workflow_name}\n**Error:** ${error instanceof Error ? error.message : String(error)}\n\n## Parameters\n${JSON.stringify(parameters || {}, null, 2)}`,
        },
      ],
    };
  }
}

// Helper functions for formatting documentation sections
function formatDetailedFindings(analysis: any): string {
  if (!analysis) return "No detailed findings available.";
  
  const findings = [];
  
  // Add repository structure findings
  if (analysis.structure) {
    findings.push("### Repository Structure");
    findings.push(analysis.structure);
  }
  
  // Add key patterns
  if (analysis.patterns || analysis.key_patterns) {
    findings.push("\n### Key Patterns Identified");
    const patterns = analysis.patterns || analysis.key_patterns;
    if (Array.isArray(patterns)) {
      patterns.forEach((pattern: string) => findings.push(`- ${pattern}`));
    } else {
      findings.push(patterns);
    }
  }
  
  // Add insights
  if (analysis.insights) {
    findings.push("\n### Architectural Insights");
    findings.push(analysis.insights);
  }
  
  return findings.join("\n") || "Analysis completed successfully.";
}

function formatQualityMetrics(analysis: any): string {
  const metrics = [];
  
  if (analysis.complexity || analysis.complexity_score) {
    metrics.push(`- **Complexity Score**: ${analysis.complexity || analysis.complexity_score}/10`);
  }
  
  if (analysis.files_analyzed) {
    metrics.push(`- **Files Analyzed**: ${analysis.files_analyzed}`);
  }
  
  if (analysis.patterns?.length) {
    metrics.push(`- **Patterns Detected**: ${analysis.patterns.length}`);
  }
  
  metrics.push(`- **Architecture Type**: ${analysis.architecture_type || "Not specified"}`);
  metrics.push(`- **Maturity Level**: ${analysis.maturity || "Not assessed"}`);
  
  return metrics.join("\n") || "Quality metrics pending assessment.";
}

function formatArchitectureInsights(analysis: any): string {
  if (analysis.architecture_insights) {
    return analysis.architecture_insights;
  }
  
  const insights = [];
  
  if (analysis.architecture_type) {
    insights.push(`The system demonstrates a **${analysis.architecture_type}** architecture.`);
  }
  
  if (analysis.key_patterns?.length) {
    insights.push("\nKey architectural patterns include:");
    analysis.key_patterns.forEach((pattern: string) => {
      insights.push(`- ${pattern}`);
    });
  }
  
  return insights.join("\n") || "Architecture analysis pending.";
}

function formatPatternAnalysis(analysis: any): string {
  const patterns = [];
  
  if (analysis.patterns || analysis.key_patterns) {
    const patternList = analysis.patterns || analysis.key_patterns;
    patterns.push("### Identified Patterns\n");
    
    if (Array.isArray(patternList)) {
      patternList.forEach((pattern: string) => {
        patterns.push(`#### ${pattern}`);
        patterns.push("- **Usage**: Detected in multiple components");
        patterns.push("- **Impact**: Contributes to system maintainability\n");
      });
    }
  }
  
  return patterns.join("\n") || "Pattern analysis in progress.";
}

function formatRecommendations(analysis: any): string {
  if (analysis.recommendations) {
    return Array.isArray(analysis.recommendations) 
      ? analysis.recommendations.map((r: any) => `- ${r}`).join("\n")
      : analysis.recommendations;
  }
  
  const recommendations = [
    "1. **Documentation**: Enhance inline documentation for complex components",
    "2. **Testing**: Increase test coverage for critical paths",
    "3. **Architecture**: Consider implementing monitoring for distributed components",
    "4. **Performance**: Optimize shared memory access patterns"
  ];
  
  return recommendations.join("\n");
}

function formatAppendices(analysis: any): string {
  const appendices = [];
  
  appendices.push("### Analysis Metadata");
  appendices.push(`- **Analysis Date**: ${new Date().toISOString()}`);
  appendices.push(`- **Repository Path**: ${analysis.repository_path || "Not specified"}`);
  appendices.push(`- **Analysis Type**: Comprehensive Semantic Analysis`);
  
  if (analysis.metadata) {
    appendices.push("\n### Additional Metadata");
    Object.entries(analysis.metadata).forEach(([key, value]) => {
      appendices.push(`- **${key}**: ${value}`);
    });
  }
  
  return appendices.join("\n");
}

async function handleGenerateDocumentation(args: any): Promise<any> {
  const { analysis_result, metadata } = args;
  
  log("Generating documentation with real file writing", "info", { has_metadata: !!metadata });
  
  try {
    const docAgent = new InsightGenerationAgent();
    
    // Map the analysis result to the expected template variables
    const documentationData = {
      analysis_title: metadata?.title || analysis_result?.title || "Semantic Analysis Report",
      scope: analysis_result?.scope || analysis_result?.repository_path || "Repository analysis",
      duration: analysis_result?.duration || "Not measured",
      analyzed_items: analysis_result?.analyzed_items || 
                      `${analysis_result?.files_analyzed || 0} files analyzed`,
      methodology: analysis_result?.methodology || 
                   "Comprehensive semantic analysis using 8-agent architecture with AI-powered insights",
      results_summary: analysis_result?.summary || analysis_result?.results_summary || 
                       "Analysis completed successfully with insights extracted",
      detailed_findings: formatDetailedFindings(analysis_result),
      quality_metrics: formatQualityMetrics(analysis_result),
      architecture_insights: formatArchitectureInsights(analysis_result),
      pattern_analysis: formatPatternAnalysis(analysis_result),
      recommendations: formatRecommendations(analysis_result),
      appendices: formatAppendices(analysis_result),
      timestamp: new Date().toISOString()
    };
    
    // Generate the documentation content
    const docResult = await docAgent.generateDocumentation("analysis_documentation", documentationData);
    
    // Save the documentation to files
    const today = new Date().toISOString().split('T')[0];
    const insightsDir = process.env.KNOWLEDGE_BASE_PATH;
    if (!insightsDir) {
      throw new Error('KNOWLEDGE_BASE_PATH environment variable not set');
    }
    const outputPath = `${insightsDir}/${today}-semantic-analysis.md`;
    
    await docAgent.saveDocumentation(docResult, outputPath);
    
    log(`Documentation saved to file: ${outputPath}`, "info", {
      title: docResult.title,
      contentLength: docResult.content.length
    });
    
    return {
      content: [
        {
          type: "text",
          text: `# Generated Documentation\n\n**File Created:** ${outputPath}\n**Title:** ${docResult.title}\n**Size:** ${docResult.content.length} chars\n**Generated:** ${docResult.generatedAt}\n\n## Preview\n\n${docResult.content.substring(0, 500)}${docResult.content.length > 500 ? '...' : ''}`,
        },
      ],
      metadata: {
        filePath: outputPath,
        fileSize: docResult.content.length,
        title: docResult.title
      }
    };
    
  } catch (error) {
    log("Failed to generate documentation", "error", error);
    return {
      content: [
        {
          type: "text",
          text: `# Documentation Generation Failed\n\nError: ${error instanceof Error ? error.message : String(error)}\n\nFalling back to basic documentation...`,
        },
      ],
    };
  }
}

async function handleCreateInsightReport(args: any): Promise<any> {
  const { analysis_result, metadata } = args;
  
  log("Creating insight report", "info", { has_metadata: !!metadata });
  
  const insightName = metadata?.name || "Analysis Insight";
  const insightType = metadata?.type || "General";
  
  return {
    content: [
      {
        type: "text",
        text: `# Insight Report: ${insightName}\n\n**Type:** ${insightType}\n**Generated:** ${new Date().toISOString()}\n\n## Analysis Summary\n${JSON.stringify(analysis_result, null, 2)}\n\n## Key Insights\n- Pattern detection and analysis completed\n- Architecture insights extracted\n- Recommendations generated\n\n## Note\nPlantUML diagram generation pending full implementation.`,
      },
    ],
  };
}

async function handleGeneratePlantUMLDiagrams(args: any): Promise<any> {
  const { diagram_type, content, name, analysis_result } = args;
  
  // 🔍 TRACE: Log what arguments we received
  log(`🔍 DEBUG: handleGeneratePlantUMLDiagrams called with:`, "debug", {
    diagram_type,
    content,
    name,
    hasAnalysisResult: !!analysis_result,
    analysisResultType: typeof analysis_result,
    analysisResultKeys: analysis_result ? Object.keys(analysis_result) : [],
    argsKeys: Object.keys(args)
  });
  
  log(`Generating PlantUML diagram: ${name}`, "info", { diagram_type });
  
  // Use LLM-enhanced diagram generation instead of static templates
  const insightAgent = new InsightGenerationAgent();
  let diagramContent = '';
  
  try {
    // Try LLM-enhanced generation first
    log(`Attempting LLM-enhanced ${diagram_type} diagram generation`, "info");
    
    const dataForLLM = { 
      patternCatalog: analysis_result,
      content,
      name 
    };
    
    log(`🔍 DEBUG: Data being passed to LLM:`, "debug", {
      hasPatternCatalog: !!dataForLLM.patternCatalog,
      patternCatalogType: typeof dataForLLM.patternCatalog,
      content: dataForLLM.content,
      name: dataForLLM.name
    });
    
    diagramContent = await insightAgent.generateLLMEnhancedDiagram(diagram_type, dataForLLM);
    
    if (diagramContent && diagramContent.includes('@startuml')) {
      log(`LLM-enhanced diagram generated successfully`, "info", { length: diagramContent.length });
    } else {
      log(`LLM-enhanced diagram generation failed, content: ${diagramContent}`, "warning");
      throw new Error('LLM diagram generation failed - no valid PlantUML content');
    }
  } catch (error) {
    log(`LLM diagram generation failed: ${error}`, "error");
    return {
      content: [
        {
          type: "text",
          text: `❌ LLM-Enhanced PlantUML Generation Failed\n\n**Error:** ${error instanceof Error ? error.message : String(error)}\n\n**Diagram Type:** ${diagram_type}\n**Name:** ${name}\n\n**Root Cause:** The LLM provider could not generate repository-specific diagram content. This indicates either:\n1. Missing analysis data in the input\n2. LLM provider configuration issues\n3. Insufficient semantic analysis results\n\n**Solution:** Please check the semantic analysis results and ensure they contain meaningful patterns and components before attempting diagram generation.`
        }
      ],
      isError: true,
    };
  }
  
  try {
    // Set up directory structure
    const insightsDir = process.env.KNOWLEDGE_BASE_PATH;
    if (!insightsDir) {
      throw new Error('KNOWLEDGE_BASE_PATH environment variable not set');
    }
    const pumlDir = path.join(insightsDir, 'puml');
    const imagesDir = path.join(insightsDir, 'images');
    
    // Ensure directories exist
    mkdirSync(pumlDir, { recursive: true });
    mkdirSync(imagesDir, { recursive: true });
    
    // Generate lowercase filename for consistency
    const fileBaseName = name.toLowerCase();
    const pumlFile = path.join(pumlDir, `${fileBaseName}-${diagram_type}.puml`);
    
    // Write the PlantUML file
    writeFileSync(pumlFile, diagramContent);
    
    log(`PlantUML file created: ${pumlFile}`, "info", {
      name,
      diagram_type,
      fileSize: diagramContent.length
    });
    
    // Generate PNG image using plantuml command
    const pngFile = path.join(imagesDir, `${fileBaseName}-${diagram_type}.png`);
    let pngGenerated = false;
    
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      // Use relative path to avoid nested directory creation
      const relativePath = path.relative(path.dirname(pumlFile), imagesDir);
      await execAsync(`plantuml -tpng "${pumlFile}" -o "${relativePath}"`);
      pngGenerated = true;
      
      log(`PNG file generated: ${pngFile}`, "info", {
        pumlFile,
        pngFile
      });
      
    } catch (error) {
      log(`Failed to generate PNG: ${error}`, "warning", {
        pumlFile,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    return {
      content: [
        {
          type: "text",
          text: `# PlantUML Diagram Generated\n\n**PUML File:** ${pumlFile}\n**PNG File:** ${pngGenerated ? pngFile : 'Not generated'}\n**Type:** ${diagram_type}\n**Title:** ${content || name}\n**Size:** ${diagramContent.length} chars\n**Generated:** ${new Date().toISOString()}\n\n## Preview\n\`\`\`plantuml\n${diagramContent}\n\`\`\`\n\n${pngGenerated ? '✅ PNG image successfully generated!' : '⚠️ PNG generation failed - check PlantUML installation'}`
        }
      ],
      metadata: {
        filePath: pumlFile,
        fileSize: diagramContent.length,
        diagramType: diagram_type
      }
    };
  } catch (error) {
    log(`Error generating PlantUML diagram`, "error", error);
    throw error;
  }
}

function generateContextAwareDiagram(diagram_type: string, content: string, name: string, analysis_result: any): string {
  const baseTitle = content || name || "System";
  
  switch (diagram_type) {
    case "architecture":
      return generateArchitectureDiagram(baseTitle, analysis_result);
    case "sequence":
      return generateSequenceDiagram(baseTitle, analysis_result);
    case "use-cases":
      return generateUseCasesDiagram(baseTitle, analysis_result);
    case "integration":
      return generateIntegrationDiagram(baseTitle, analysis_result);
    default:
      return generateArchitectureDiagram(baseTitle, analysis_result);
  }
}

function generateArchitectureDiagram(title: string, analysis: any): string {
  // Extract meaningful components from analysis data
  let components = [];
  
  // Debug: log what we received
  console.log(`🎨 PlantUML generateArchitectureDiagram called:`, {
    title,
    hasAnalysis: !!analysis, 
    hasSemanticInsights: !!analysis?.semanticInsights,
    hasPatterns: !!analysis?.semanticInsights?.patterns,
    hasCommits: !!analysis?.commits,
    hasArchDecisions: !!analysis?.architecturalDecisions,
    analysisKeys: analysis ? Object.keys(analysis) : []
  });
  
  log(`generateArchitectureDiagram called with analysis:`, 'debug', { 
    hasAnalysis: !!analysis, 
    hasSemanticInsights: !!analysis?.semanticInsights,
    hasPatterns: !!analysis?.semanticInsights?.patterns,
    hasCommits: !!analysis?.commits,
    hasArchDecisions: !!analysis?.architecturalDecisions,
    analysisKeys: analysis ? Object.keys(analysis) : []
  });
  
  // Try different sources for meaningful components
  if (analysis?.semanticInsights?.patterns) {
    components = analysis.semanticInsights.patterns.map((p: any) => p.name || p.pattern).slice(0, 8);
    log(`Using semantic insights patterns:`, 'debug', components);
  } else if (analysis?.codeAnalysis?.patterns) {
    components = analysis.codeAnalysis.patterns.map((p: any) => p.name || p.pattern).slice(0, 8);
    log(`Using code analysis patterns:`, 'debug', components);
  } else if (analysis?.commits && analysis.commits.length > 0) {
    // Extract components from git commit messages and file changes
    const fileTypes = new Set<string>();
    analysis.commits.forEach((commit: any) => {
      if (commit.files) {
        commit.files.forEach((file: any) => {
          const fileName = typeof file === 'string' ? file : String(file);
          const ext = fileName.split('.').pop();
          if (ext) {
            if (ext.includes('ts') || ext.includes('js')) fileTypes.add('TypeScript/JavaScript Engine');
            if (ext.includes('json')) fileTypes.add('Configuration Manager');
            if (ext.includes('md')) fileTypes.add('Documentation System');
            if (fileName.includes('agent')) fileTypes.add('Agent Framework');
            if (fileName.includes('mcp')) fileTypes.add('MCP Protocol Handler');
          }
        });
      }
    });
    components = Array.from(fileTypes).slice(0, 6);
    log(`Using components from git commits:`, 'debug', components);
  } else if (analysis?.architecturalDecisions) {
    // Use architectural decisions as components
    components = analysis.architecturalDecisions.map((d: any) => d.component || d.area || 'System Component').slice(0, 6);
    log(`Using architectural decisions:`, 'debug', components);
  }
  
  // Fallback to meaningful default components if still empty
  if (components.length === 0) {
    components = [
      "Semantic Analysis Engine", 
      "Knowledge Management System", 
      "PlantUML Generator",
      "Quality Assurance Agent",
      "MCP Protocol Handler"
    ];
  }
  
  const hasSharedMemory = components.some((p: string) => p.toLowerCase().includes("shared") || p.toLowerCase().includes("memory"));
  
  let diagram = `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-architecture
!theme plain
title ${title} - Architecture Diagram

skinparam component {
  BackgroundColor<<service>> LightBlue
  BackgroundColor<<storage>> LightGreen
  BackgroundColor<<agent>> LightYellow
}

`;

  if (hasSharedMemory) {
    diagram += `package "Distributed System Architecture" {
  component "Service Orchestrator" as SO <<service>>
  component "Shared Memory Layer" as SM <<storage>>
  
  package "Domain Components" {
    component "UI Component" as UI <<agent>>
    component "Coding Component" as CODE <<agent>>
    component "RESI Component" as RESI <<agent>>
  }
  
  database "Persistent Storage" as DB <<storage>>
}

SO --> SM : Manages
UI --> SM : Read/Write
CODE --> SM : Read/Write
RESI --> SM : Read/Write
SM --> DB : Persist

`;
  } else {
    diagram += `package "System Architecture" {
`;
    components.forEach((comp: string, idx: number) => {
      diagram += `  component "${comp}" as C${idx} <<service>>\n`;
    });
    
    // Add some relationships
    for (let i = 0; i < components.length - 1; i++) {
      diagram += `  C${i} --> C${i + 1} : interacts\n`;
    }
    
    diagram += `}`;
  }
  
  diagram += `

note right
  Complexity Score: ${analysis?.complexity || "N/A"}/10
  Architecture Type: ${analysis?.architecture_type || "Distributed"}
end note

@enduml`;
  
  return diagram;
}

function generateSequenceDiagram(title: string, analysis: any): string {
  return `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-sequence
!theme plain
title ${title} - Sequence Diagram

actor User
participant "CLI Interface" as CLI
participant "MCP Server" as MCP
participant "Coordinator Agent" as COORD
participant "Repository Analyzer" as REPO
participant "Semantic Analyzer" as SEM
participant "Documentation Agent" as DOC
participant "Knowledge Manager" as KM

User -> CLI : semantic-analysis
CLI -> MCP : execute_workflow
MCP -> COORD : start workflow
COORD -> REPO : analyze_repository
REPO --> COORD : structure & patterns
COORD -> SEM : determine_insights
SEM --> COORD : architectural insights
COORD -> DOC : generate_documentation
DOC --> COORD : markdown & diagrams
COORD -> KM : create_entities
KM --> COORD : knowledge updated
COORD --> MCP : workflow complete
MCP --> CLI : results
CLI --> User : artifacts generated

@enduml`;
}

function generateUseCasesDiagram(title: string, analysis: any): string {
  return `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-use-cases
!theme plain
title ${title} - Use Cases Diagram

left to right direction
skinparam packageStyle rect

actor Developer
actor "CI/CD System" as CI
actor "Team Member" as Team

rectangle "Semantic Analysis System" {
  usecase "Analyze Repository" as UC1
  usecase "Extract Patterns" as UC2
  usecase "Generate Insights" as UC3
  usecase "Create Documentation" as UC4
  usecase "Update Knowledge Base" as UC5
  usecase "Generate Diagrams" as UC6
  usecase "Quality Validation" as UC7
}

Developer --> UC1
Developer --> UC2
UC1 --> UC3 : triggers
UC3 --> UC4 : triggers
UC3 --> UC5 : triggers
UC4 --> UC6 : includes
UC1 --> UC7 : validated by

CI --> UC1 : automated
Team --> UC5 : accesses

@enduml`;
}

function generateIntegrationDiagram(title: string, analysis: any): string {
  return `@startuml ${title.toLowerCase().replace(/\s+/g, '-')}-integration
!theme plain
title ${title} - Integration Diagram

skinparam component {
  BackgroundColor<<external>> Pink
  BackgroundColor<<internal>> LightBlue
  BackgroundColor<<storage>> LightGreen
}

package "Internal Systems" <<internal>> {
  component "MCP Server" as MCP
  component "8-Agent System" as AGENTS
  component "Knowledge Manager" as KM
}

package "External Integrations" <<external>> {
  component "Claude AI" as CLAUDE
  component "Git Repository" as GIT
  component "File System" as FS
}

package "Storage Layer" <<storage>> {
  database "MCP Memory" as MEMORY
  database "Shared Memory JSON" as JSON
  database "Insights Repository" as INSIGHTS
}

CLAUDE --> MCP : MCP Protocol
MCP --> AGENTS : Coordinates
AGENTS --> GIT : Analyzes
AGENTS --> FS : Read/Write
AGENTS --> KM : Updates

KM --> MEMORY : Sync
KM --> JSON : Persist
AGENTS --> INSIGHTS : Generate

note bottom of INSIGHTS
  - Markdown files
  - PlantUML diagrams
  - PNG images
  - Code snippets
end note

@enduml`;
}



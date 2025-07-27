#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { SemanticAnalyzer } from './agents/semantic-analyzer.js';
import { Coordinator } from './agents/coordinator.js';
import { Documentation } from './agents/documentation.js';
import { Deduplication } from './agents/deduplication.js';
import { Synchronization } from './agents/synchronization.js';
import { WebSearch } from './agents/web-search.js';

export class SemanticAnalysisServer {
  private server: Server;
  private semanticAnalyzer: SemanticAnalyzer;
  private coordinator: Coordinator;
  private documentation: Documentation;
  private deduplication: Deduplication;
  private synchronization: Synchronization;
  private webSearch: WebSearch;

  constructor() {
    this.server = new Server(
      {
        name: 'semantic-analysis',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize agents
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.coordinator = new Coordinator();
    this.documentation = new Documentation();
    this.deduplication = new Deduplication();
    this.synchronization = new Synchronization();
    this.webSearch = new WebSearch();

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'test_connection',
            description: 'Test the connection to the semantic analysis server',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: 'heartbeat',
            description: 'Send a heartbeat to keep the connection alive (call every 30 seconds)',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: 'determine_insights',
            description: 'Determine insights from analysis results using LLM providers',
            inputSchema: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: 'Content to analyze for insights',
                },
                context: {
                  type: 'string',
                  description: 'Additional context for the analysis',
                },
                analysis_type: {
                  type: 'string',
                  enum: ['general', 'code', 'patterns', 'architecture'],
                  description: 'Type of analysis to perform (general, code, patterns, architecture)',
                },
                provider: {
                  type: 'string',
                  enum: ['anthropic', 'openai', 'auto'],
                  description: 'Preferred LLM provider (anthropic, openai, auto)',
                },
              },
              required: ['content'],
              additionalProperties: false,
            },
          },
          {
            name: 'analyze_code',
            description: 'Analyze code for patterns, issues, and architectural insights',
            inputSchema: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'Code content to analyze',
                },
                file_path: {
                  type: 'string',
                  description: 'File path for context',
                },
                language: {
                  type: 'string',
                  description: 'Programming language (if known)',
                },
                analysis_focus: {
                  type: 'string',
                  enum: ['patterns', 'quality', 'security', 'performance', 'architecture'],
                  description: 'Focus area for analysis',
                },
              },
              required: ['code'],
              additionalProperties: false,
            },
          },
          {
            name: 'analyze_repository',
            description: 'Analyze repository structure and extract architectural patterns',
            inputSchema: {
              type: 'object',
              properties: {
                repository_path: {
                  type: 'string',
                  description: 'Path to the repository to analyze',
                },
                include_patterns: {
                  type: 'array',
                  items: { type: 'string' },
                  description: "File patterns to include (e.g., ['*.js', '*.ts'])",
                },
                exclude_patterns: {
                  type: 'array',
                  items: { type: 'string' },
                  description: "File patterns to exclude (e.g., ['node_modules', '*.test.js'])",
                },
                max_files: {
                  type: 'number',
                  description: 'Maximum number of files to analyze',
                },
              },
              required: ['repository_path'],
              additionalProperties: false,
            },
          },
          {
            name: 'extract_patterns',
            description: 'Extract reusable design and architectural patterns',
            inputSchema: {
              type: 'object',
              properties: {
                source: {
                  type: 'string',
                  description: 'Source content to extract patterns from',
                },
                pattern_types: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Types of patterns to look for',
                },
                context: {
                  type: 'string',
                  description: 'Additional context about the source',
                },
              },
              required: ['source'],
              additionalProperties: false,
            },
          },
          {
            name: 'create_ukb_entity_with_insight',
            description: 'Create UKB entity with detailed insight document',
            inputSchema: {
              type: 'object',
              properties: {
                entity_name: {
                  type: 'string',
                  description: 'Name for the UKB entity',
                },
                entity_type: {
                  type: 'string',
                  description: 'Type of entity (e.g., Pattern, Workflow, Insight)',
                },
                insights: {
                  type: 'string',
                  description: 'Detailed insights content',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tags for categorization',
                },
                significance: {
                  type: 'number',
                  minimum: 1,
                  maximum: 10,
                  description: 'Significance score (1-10)',
                },
              },
              required: ['entity_name', 'entity_type', 'insights'],
              additionalProperties: false,
            },
          },
          {
            name: 'execute_workflow',
            description: 'Execute a predefined analysis workflow through the coordinator',
            inputSchema: {
              type: 'object',
              properties: {
                workflow_name: {
                  type: 'string',
                  description: "Name of the workflow to execute (e.g., 'complete-analysis', 'incremental-analysis')",
                },
                parameters: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional parameters for the workflow',
                },
              },
              required: ['workflow_name'],
              additionalProperties: false,
            },
          },
          {
            name: 'generate_documentation',
            description: 'Generate comprehensive documentation from analysis results',
            inputSchema: {
              type: 'object',
              properties: {
                analysis_result: {
                  type: 'object',
                  description: 'Analysis results to document',
                },
                metadata: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional metadata for documentation generation',
                },
              },
              required: ['analysis_result'],
              additionalProperties: false,
            },
          },
          {
            name: 'create_insight_report',
            description: 'Create a detailed insight report with PlantUML diagrams',
            inputSchema: {
              type: 'object',
              properties: {
                analysis_result: {
                  type: 'object',
                  description: 'Analysis results to create insight from',
                },
                metadata: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional metadata including insight name and type',
                },
              },
              required: ['analysis_result'],
              additionalProperties: false,
            },
          },
          {
            name: 'generate_plantuml_diagrams',
            description: 'Generate PlantUML diagrams for analysis results',
            inputSchema: {
              type: 'object',
              properties: {
                diagram_type: {
                  type: 'string',
                  enum: ['architecture', 'sequence', 'use-cases', 'class'],
                  description: 'Type of diagram (architecture, sequence, use-cases, class)',
                },
                content: {
                  type: 'string',
                  description: 'Content/title for the diagram',
                },
                name: {
                  type: 'string',
                  description: 'Base name for the diagram files',
                },
                analysis_result: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional analysis result for context',
                },
              },
              required: ['diagram_type', 'content', 'name'],
              additionalProperties: false,
            },
          },
          {
            name: 'generate_lessons_learned',
            description: 'Generate lessons learned document (lele) with UKB integration',
            inputSchema: {
              type: 'object',
              properties: {
                analysis_result: {
                  type: 'object',
                  description: 'Analysis results to extract lessons from',
                },
                title: {
                  type: 'string',
                  description: 'Title for the lessons learned document',
                },
                metadata: {
                  type: 'object',
                  additionalProperties: true,
                  description: 'Optional metadata for the lessons learned',
                },
              },
              required: ['analysis_result'],
              additionalProperties: false,
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'test_connection':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'connected',
                    server: 'semantic-analysis',
                    version: '1.0.0',
                    timestamp: new Date().toISOString(),
                  }),
                },
              ],
            };

          case 'heartbeat':
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'alive',
                    timestamp: new Date().toISOString(),
                  }),
                },
              ],
            };

          case 'determine_insights':
            return await this.semanticAnalyzer.determineInsights(args);

          case 'analyze_code':
            return await this.semanticAnalyzer.analyzeCode(args);

          case 'analyze_repository':
            return await this.semanticAnalyzer.analyzeRepository(args);

          case 'extract_patterns':
            return await this.semanticAnalyzer.extractPatterns(args);

          case 'create_ukb_entity_with_insight':
            return await this.semanticAnalyzer.createUkbEntityWithInsight(args);

          case 'execute_workflow':
            return await this.coordinator.executeWorkflow(args);

          case 'generate_documentation':
            return await this.documentation.generateDocumentation(args);

          case 'create_insight_report':
            return await this.documentation.createInsightReport(args);

          case 'generate_plantuml_diagrams':
            return await this.documentation.generatePlantUMLDiagrams(args);

          case 'generate_lessons_learned':
            return await this.documentation.generateLessonsLearned(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error.message,
                tool: name,
                timestamp: new Date().toISOString(),
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  public async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Start the server if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new SemanticAnalysisServer();
  server.run().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
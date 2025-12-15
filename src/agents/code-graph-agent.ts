/**
 * CodeGraphAgent - AST-based code knowledge graph construction
 *
 * Integrates with code-graph-rag MCP server to:
 * - Index repositories using Tree-sitter AST parsing
 * - Query the Memgraph knowledge graph for code entities
 * - Provide semantic code search capabilities
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { log } from '../logging.js';

export interface CodeEntity {
  id: string;
  name: string;
  type: 'function' | 'class' | 'module' | 'method' | 'variable' | 'import';
  filePath: string;
  lineNumber: number;
  language: string;
  signature?: string;
  docstring?: string;
  complexity?: number;
  relationships: CodeRelationship[];
}

export interface CodeRelationship {
  type: 'calls' | 'imports' | 'extends' | 'implements' | 'uses' | 'defines';
  source: string;
  target: string;
  weight?: number;
}

export interface CodeGraphAnalysisResult {
  entities: CodeEntity[];
  relationships: CodeRelationship[];
  statistics: {
    totalEntities: number;
    totalRelationships: number;
    languageDistribution: Record<string, number>;
    entityTypeDistribution: Record<string, number>;
  };
  indexedAt: string;
  repositoryPath: string;
  /** Warning message if indexing was skipped (workflow continues normally) */
  warning?: string;
  /** True if indexing was skipped due to CLI unavailability */
  skipped?: boolean;
}

export interface CodeGraphQueryResult {
  matches: CodeEntity[];
  relevanceScores: Map<string, number>;
  queryTime: number;
}

export class CodeGraphAgent {
  private codeGraphRagDir: string;
  private repositoryPath: string;
  private memgraphHost: string;
  private memgraphPort: number;

  constructor(
    repositoryPath: string = '.',
    options: {
      codeGraphRagDir?: string;
      memgraphHost?: string;
      memgraphPort?: number;
    } = {}
  ) {
    this.repositoryPath = path.resolve(repositoryPath);
    this.codeGraphRagDir = options.codeGraphRagDir ||
      path.join(process.env.CODING_TOOLS_PATH || '.', 'integrations/code-graph-rag');
    this.memgraphHost = options.memgraphHost || process.env.MEMGRAPH_HOST || 'localhost';
    this.memgraphPort = options.memgraphPort || parseInt(process.env.MEMGRAPH_PORT || '7687');

    log(`[CodeGraphAgent] Initialized with repo: ${this.repositoryPath}`, 'info');
  }

  /**
   * Index a repository using code-graph-rag CLI
   * Uses: uv run graph-code index --repo-path <path> --output-proto-dir <dir>
   */
  async indexRepository(targetPath?: string | { target_path?: string }): Promise<CodeGraphAnalysisResult> {
    // Handle both direct path and wrapped parameter object from coordinator
    let repoPath: string;
    if (typeof targetPath === 'object' && targetPath !== null) {
      repoPath = targetPath.target_path || this.repositoryPath;
    } else if (typeof targetPath === 'string') {
      repoPath = targetPath;
    } else {
      repoPath = this.repositoryPath;
    }

    log(`[CodeGraphAgent] Indexing repository: ${repoPath}`, 'info');

    try {
      // Call code-graph-rag CLI to index the repository
      const result = await this.runCodeGraphCommand('index', [repoPath]);

      // Parse the result from code-graph-rag
      // The CLI outputs protobuf files and logs stats to stderr
      const indexingStats = result.indexingStats || {};

      const analysisResult: CodeGraphAnalysisResult = {
        entities: result.entities || [],
        relationships: result.relationships || [],
        statistics: {
          totalEntities: indexingStats.entitiesIndexed || result.entities?.length || 0,
          totalRelationships: result.relationships?.length || 0,
          languageDistribution: this.calculateLanguageDistribution(result.entities || []),
          entityTypeDistribution: this.calculateEntityTypeDistribution(result.entities || []),
        },
        indexedAt: new Date().toISOString(),
        repositoryPath: repoPath,
      };

      // Include indexing stats in result for reporting
      if (indexingStats.protoFilesGenerated > 0) {
        (analysisResult as any).indexingStats = indexingStats;
      }

      log(`[CodeGraphAgent] Indexed repository - ${indexingStats.filesProcessed || 0} files, ${indexingStats.protoFilesGenerated || 0} proto files generated`, 'info');
      return analysisResult;
    } catch (error) {
      // Return empty result instead of throwing - allows workflow to continue
      // The code-graph-rag CLI may not be properly configured or available
      log(`[CodeGraphAgent] Failed to index repository (returning empty result): ${error}`, 'warning');
      log(`[CodeGraphAgent] Code graph analysis requires code-graph-rag MCP server with Memgraph. Ensure Memgraph is running: docker ps | grep memgraph`, 'info');

      // Return valid result WITHOUT error field to not break workflow dependencies
      // The 'warning' field is informational and won't trigger dependency failures
      return {
        entities: [],
        relationships: [],
        statistics: {
          totalEntities: 0,
          totalRelationships: 0,
          languageDistribution: {},
          entityTypeDistribution: {},
        },
        indexedAt: new Date().toISOString(),
        repositoryPath: repoPath,
        warning: `Code graph indexing failed: ${error instanceof Error ? error.message : String(error)}`,
        skipped: true,
      };
    }
  }

  /**
   * Query the code graph for entities matching a pattern
   */
  async queryCodeGraph(query: string, options: {
    entityTypes?: string[];
    languages?: string[];
    limit?: number;
  } = {}): Promise<CodeGraphQueryResult> {
    log(`[CodeGraphAgent] Querying code graph: ${query}`, 'info');

    try {
      const result = await this.runCodeGraphCommand('query', [
        '--query', query,
        ...(options.entityTypes ? ['--types', options.entityTypes.join(',')] : []),
        ...(options.languages ? ['--languages', options.languages.join(',')] : []),
        ...(options.limit ? ['--limit', options.limit.toString()] : []),
      ]);

      return {
        matches: result.matches || [],
        relevanceScores: new Map(Object.entries(result.scores || {})),
        queryTime: result.queryTime || 0,
      };
    } catch (error) {
      log(`[CodeGraphAgent] Query failed: ${error}`, 'error');
      throw error;
    }
  }

  /**
   * Find code entities by semantic similarity
   */
  async findSimilarCode(codeSnippet: string, topK: number = 10): Promise<CodeEntity[]> {
    log(`[CodeGraphAgent] Finding similar code (topK: ${topK})`, 'info');

    try {
      const result = await this.runCodeGraphCommand('similar', [
        '--code', codeSnippet,
        '--top-k', topK.toString(),
      ]);

      return result.similar || [];
    } catch (error) {
      log(`[CodeGraphAgent] Similarity search failed: ${error}`, 'error');
      return [];
    }
  }

  /**
   * Get call graph for a specific function/method
   */
  async getCallGraph(entityName: string, depth: number = 3): Promise<{
    root: CodeEntity | null;
    calls: CodeRelationship[];
    calledBy: CodeRelationship[];
  }> {
    log(`[CodeGraphAgent] Getting call graph for: ${entityName}`, 'info');

    try {
      const result = await this.runCodeGraphCommand('call-graph', [
        '--entity', entityName,
        '--depth', depth.toString(),
      ]);

      return {
        root: result.root || null,
        calls: result.calls || [],
        calledBy: result.calledBy || [],
      };
    } catch (error) {
      log(`[CodeGraphAgent] Call graph retrieval failed: ${error}`, 'error');
      return { root: null, calls: [], calledBy: [] };
    }
  }

  /**
   * Run a code-graph-rag CLI command
   * The CLI uses: graph-code index --repo-path <path> --output-proto-dir <dir>
   * It outputs protobuf files and logs to stderr, returning summary stats
   */
  private async runCodeGraphCommand(command: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const fs = require('fs');
      const os = require('os');

      // Create temp directory for protobuf output
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-'));

      // Build proper CLI arguments based on command
      let cliArgs: string[];
      if (command === 'index') {
        // For index: graph-code index --repo-path <path> --output-proto-dir <dir>
        const repoPath = args[0] || this.repositoryPath;
        cliArgs = [
          'run',
          '--directory', this.codeGraphRagDir,
          'graph-code', 'index',
          '--repo-path', repoPath,
          '--output-proto-dir', tmpDir,
        ];
      } else if (command === 'query') {
        // For query: pass through args (query, similar, call-graph)
        cliArgs = [
          'run',
          '--directory', this.codeGraphRagDir,
          'graph-code', command,
          ...args,
        ];
      } else {
        // Other commands - pass through
        cliArgs = [
          'run',
          '--directory', this.codeGraphRagDir,
          'graph-code', command,
          ...args,
        ];
      }

      log(`[CodeGraphAgent] Running: uv ${cliArgs.join(' ')}`, 'info');

      const uvProcess = spawn('uv', cliArgs, {
        env: {
          ...process.env,
          MEMGRAPH_HOST: this.memgraphHost,
          MEMGRAPH_PORT: this.memgraphPort.toString(),
        },
        timeout: 300000, // 5 minute timeout for large codebases
      });

      let stdout = '';
      let stderr = '';

      uvProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      uvProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        // Log progress from stderr (CLI logs there)
        const lines = data.toString().trim().split('\n');
        for (const line of lines) {
          if (line.includes('INFO') || line.includes('SUCCESS')) {
            log(`[CodeGraphAgent] ${line}`, 'debug');
          }
        }
      });

      uvProcess.on('close', (code) => {
        if (code === 0) {
          try {
            // For index command, read protobuf output files and parse stats
            if (command === 'index') {
              const protoFiles = fs.readdirSync(tmpDir).filter((f: string) => f.endsWith('.pb') || f.endsWith('.proto'));
              log(`[CodeGraphAgent] Generated ${protoFiles.length} protobuf files in ${tmpDir}`, 'info');

              // Parse entity counts from stderr output
              const entitiesMatch = stderr.match(/Indexed (\d+) entities/);
              const filesMatch = stderr.match(/Processed (\d+) files/);

              // Return structured result with indexing stats
              resolve({
                entities: [], // Would need protobuf parsing to extract actual entities
                relationships: [],
                indexingStats: {
                  entitiesIndexed: entitiesMatch ? parseInt(entitiesMatch[1]) : 0,
                  filesProcessed: filesMatch ? parseInt(filesMatch[1]) : 0,
                  protoFilesGenerated: protoFiles.length,
                  outputDir: tmpDir,
                },
                raw: { stdout, stderr },
              });
            } else {
              // Try to parse as JSON for other commands
              try {
                const result = JSON.parse(stdout);
                resolve(result);
              } catch (e) {
                resolve({ raw: stdout, stderr });
              }
            }
          } catch (e) {
            resolve({ raw: stdout, stderr, error: String(e) });
          }
        } else {
          log(`[CodeGraphAgent] Command failed with code ${code}: ${stderr}`, 'error');
          reject(new Error(`code-graph-rag command failed (code ${code}): ${stderr.slice(0, 500)}`));
        }
      });

      uvProcess.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Calculate language distribution from entities
   */
  private calculateLanguageDistribution(entities: CodeEntity[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const entity of entities) {
      const lang = entity.language || 'unknown';
      distribution[lang] = (distribution[lang] || 0) + 1;
    }
    return distribution;
  }

  /**
   * Calculate entity type distribution
   */
  private calculateEntityTypeDistribution(entities: CodeEntity[]): Record<string, number> {
    const distribution: Record<string, number> = {};
    for (const entity of entities) {
      distribution[entity.type] = (distribution[entity.type] || 0) + 1;
    }
    return distribution;
  }

  /**
   * Transform code entities to knowledge graph entities for persistence
   * @param params - Either a CodeGraphAnalysisResult directly or a parameters object with code_analysis property
   */
  async transformToKnowledgeEntities(params: CodeGraphAnalysisResult | { code_analysis?: CodeGraphAnalysisResult; [key: string]: any }): Promise<Array<{
    name: string;
    entityType: string;
    observations: string[];
    significance: number;
  }>> {
    // Handle both direct CodeGraphAnalysisResult and wrapped parameters
    const codeAnalysis: CodeGraphAnalysisResult = 'code_analysis' in params && params.code_analysis
      ? params.code_analysis
      : params as CodeGraphAnalysisResult;

    const knowledgeEntities: Array<{
      name: string;
      entityType: string;
      observations: string[];
      significance: number;
    }> = [];

    // Ensure entities is an array, handle undefined/null gracefully
    const entities = codeAnalysis?.entities;
    if (!entities || !Array.isArray(entities)) {
      log(`[CodeGraphAgent] No entities to transform (entities is ${typeof entities})`, 'warning');
      return knowledgeEntities;
    }

    // Group entities by module/file for better organization
    const moduleGroups = new Map<string, CodeEntity[]>();
    for (const entity of entities) {
      const modulePath = path.dirname(entity.filePath);
      if (!moduleGroups.has(modulePath)) {
        moduleGroups.set(modulePath, []);
      }
      moduleGroups.get(modulePath)!.push(entity);
    }

    // Create knowledge entities for significant code structures
    for (const [modulePath, entities] of moduleGroups) {
      const classes = entities.filter(e => e.type === 'class');
      const functions = entities.filter(e => e.type === 'function');

      // Create entity for each class
      for (const cls of classes) {
        const methods = entities.filter(e => e.type === 'method' && e.filePath === cls.filePath);
        const observations = [
          `Class ${cls.name} defined in ${cls.filePath}:${cls.lineNumber}`,
          cls.docstring ? `Documentation: ${cls.docstring}` : null,
          methods.length > 0 ? `Contains ${methods.length} methods: ${methods.map(m => m.name).join(', ')}` : null,
          cls.complexity ? `Complexity score: ${cls.complexity}` : null,
        ].filter(Boolean) as string[];

        knowledgeEntities.push({
          name: cls.name,
          entityType: 'CodeClass',
          observations,
          significance: Math.min(10, 5 + Math.floor(methods.length / 2)),
        });
      }

      // Create entities for standalone functions with significant complexity
      for (const fn of functions.filter(f => (f.complexity || 0) > 5)) {
        const observations = [
          `Function ${fn.name} defined in ${fn.filePath}:${fn.lineNumber}`,
          fn.signature ? `Signature: ${fn.signature}` : null,
          fn.docstring ? `Documentation: ${fn.docstring}` : null,
          fn.complexity ? `Complexity score: ${fn.complexity}` : null,
        ].filter(Boolean) as string[];

        knowledgeEntities.push({
          name: fn.name,
          entityType: 'CodeFunction',
          observations,
          significance: Math.min(8, 3 + Math.floor((fn.complexity || 0) / 3)),
        });
      }
    }

    log(`[CodeGraphAgent] Transformed ${knowledgeEntities.length} code entities to knowledge entities`, 'info');
    return knowledgeEntities;
  }
}

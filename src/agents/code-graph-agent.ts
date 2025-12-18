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
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
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

    // Compute code-graph-rag directory with better defaults
    const codingRepoPath = process.env.CODING_REPO || process.env.CODING_TOOLS_PATH;
    if (options.codeGraphRagDir) {
      this.codeGraphRagDir = path.resolve(options.codeGraphRagDir);
    } else if (codingRepoPath) {
      this.codeGraphRagDir = path.join(codingRepoPath, 'integrations/code-graph-rag');
    } else {
      // Default to sibling directory pattern (mcp-server-semantic-analysis -> code-graph-rag)
      const currentDir = path.dirname(new URL(import.meta.url).pathname);
      this.codeGraphRagDir = path.resolve(currentDir, '../../../code-graph-rag');
    }

    this.memgraphHost = options.memgraphHost || process.env.MEMGRAPH_HOST || 'localhost';
    this.memgraphPort = options.memgraphPort || parseInt(process.env.MEMGRAPH_PORT || '7687');

    // Validate path exists
    if (!fs.existsSync(this.codeGraphRagDir)) {
      log(`[CodeGraphAgent] WARNING: codeGraphRagDir not found: ${this.codeGraphRagDir}`, 'warning');
    } else {
      log(`[CodeGraphAgent] Initialized with repo: ${this.repositoryPath}, codeGraphRagDir: ${this.codeGraphRagDir}`, 'info');
    }
  }

  /**
   * Check if Memgraph is reachable via TCP
   */
  private async checkMemgraphConnection(): Promise<{ connected: boolean; error?: string }> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = 5000; // 5 second timeout

      socket.setTimeout(timeout);

      socket.on('connect', () => {
        socket.destroy();
        resolve({ connected: true });
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve({ connected: false, error: `Connection timeout after ${timeout}ms` });
      });

      socket.on('error', (err) => {
        socket.destroy();
        resolve({ connected: false, error: err.message });
      });

      socket.connect(this.memgraphPort, this.memgraphHost);
    });
  }

  /**
   * Check if uv CLI is available
   */
  private async checkUvAvailable(): Promise<{ available: boolean; path?: string; error?: string }> {
    return new Promise((resolve) => {
      const which = spawn('which', ['uv']);
      let stdout = '';

      which.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      which.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve({ available: true, path: stdout.trim() });
        } else {
          resolve({ available: false, error: 'uv not found in PATH' });
        }
      });

      which.on('error', (err) => {
        resolve({ available: false, error: err.message });
      });
    });
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

    // Collect diagnostics for better error reporting
    const diagnostics: {
      memgraphConnection?: { connected: boolean; error?: string };
      uvAvailable?: { available: boolean; path?: string; error?: string };
      codeGraphRagDirExists?: boolean;
      pyprojectExists?: boolean;
      repositoryExists?: boolean;
    } = {};

    // Pre-flight checks
    diagnostics.codeGraphRagDirExists = fs.existsSync(this.codeGraphRagDir);
    diagnostics.pyprojectExists = fs.existsSync(path.join(this.codeGraphRagDir, 'pyproject.toml'));
    diagnostics.repositoryExists = fs.existsSync(repoPath);

    // Check Memgraph connection
    diagnostics.memgraphConnection = await this.checkMemgraphConnection();
    if (!diagnostics.memgraphConnection.connected) {
      log(`[CodeGraphAgent] Memgraph not reachable at ${this.memgraphHost}:${this.memgraphPort}: ${diagnostics.memgraphConnection.error}`, 'warning');
    }

    // Check uv availability
    diagnostics.uvAvailable = await this.checkUvAvailable();
    if (!diagnostics.uvAvailable.available) {
      log(`[CodeGraphAgent] uv CLI not available: ${diagnostics.uvAvailable.error}`, 'warning');
    }

    // Report pre-flight status
    log(`[CodeGraphAgent] Pre-flight checks: codeGraphRagDir=${diagnostics.codeGraphRagDirExists}, pyproject=${diagnostics.pyprojectExists}, repo=${diagnostics.repositoryExists}, memgraph=${diagnostics.memgraphConnection.connected}, uv=${diagnostics.uvAvailable.available}`, 'info');

    // If critical components are missing, return early with diagnostics
    if (!diagnostics.codeGraphRagDirExists || !diagnostics.pyprojectExists) {
      const reason = !diagnostics.codeGraphRagDirExists
        ? `code-graph-rag directory not found: ${this.codeGraphRagDir}`
        : `pyproject.toml not found in ${this.codeGraphRagDir}`;
      log(`[CodeGraphAgent] Skipping indexing: ${reason}`, 'warning');
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
        warning: reason,
        skipped: true,
        diagnostics,
      } as CodeGraphAnalysisResult & { diagnostics: typeof diagnostics };
    }

    if (!diagnostics.memgraphConnection.connected) {
      log(`[CodeGraphAgent] Skipping indexing: Memgraph not reachable. Start with: docker start memgraph`, 'warning');
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
        warning: `Memgraph not reachable at ${this.memgraphHost}:${this.memgraphPort}. Start with: docker start memgraph`,
        skipped: true,
        diagnostics,
      } as CodeGraphAnalysisResult & { diagnostics: typeof diagnostics };
    }

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

      // Include indexing stats and diagnostics in result for reporting
      if (indexingStats.protoFilesGenerated > 0) {
        (analysisResult as any).indexingStats = indexingStats;
      }
      (analysisResult as any).diagnostics = diagnostics;

      log(`[CodeGraphAgent] Indexed repository - ${indexingStats.filesProcessed || 0} files, ${indexingStats.protoFilesGenerated || 0} proto files generated`, 'info');
      return analysisResult;
    } catch (error) {
      // Return empty result instead of throwing - allows workflow to continue
      // The code-graph-rag CLI may not be properly configured or available
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[CodeGraphAgent] Failed to index repository: ${errorMessage}`, 'warning');
      log(`[CodeGraphAgent] Full error: ${error}`, 'debug');

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
        warning: `Code graph indexing failed: ${errorMessage}`,
        skipped: true,
        diagnostics,
      } as CodeGraphAnalysisResult & { diagnostics: typeof diagnostics };
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
      // Create temp directory for protobuf output
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-graph-'));

      // Build proper CLI arguments based on command
      let cliArgs: string[];
      let targetRepoPath: string = this.repositoryPath;

      if (command === 'index') {
        // For index: graph-code index --repo-path <path> --output-proto-dir <dir>
        targetRepoPath = args[0] || this.repositoryPath;
        cliArgs = [
          'run',
          '--directory', this.codeGraphRagDir,
          'graph-code', 'index',
          '--repo-path', targetRepoPath,
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
      log(`[CodeGraphAgent] Working directory: ${this.codeGraphRagDir}`, 'debug');

      const uvProcess = spawn('uv', cliArgs, {
        cwd: this.codeGraphRagDir, // Set working directory to code-graph-rag
        env: {
          ...process.env,
          MEMGRAPH_HOST: this.memgraphHost,
          MEMGRAPH_PORT: this.memgraphPort.toString(),
          TARGET_REPO_PATH: targetRepoPath, // Pass target repo as env var too
          CODING_REPO: process.env.CODING_REPO || '', // Pass through CODING_REPO if set
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
          if (line.includes('INFO') || line.includes('SUCCESS') || line.includes('ERROR')) {
            log(`[CodeGraphAgent] ${line}`, line.includes('ERROR') ? 'warning' : 'debug');
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

              // Parse entity counts from stderr output - try multiple patterns
              const entitiesMatch = stderr.match(/Indexed (\d+) entities/i) ||
                                    stderr.match(/(\d+) entities? indexed/i) ||
                                    stderr.match(/entities:\s*(\d+)/i);
              const filesMatch = stderr.match(/Processed (\d+) files/i) ||
                                 stderr.match(/(\d+) files? processed/i) ||
                                 stderr.match(/files:\s*(\d+)/i);

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
          // Enhanced error logging - include full stderr for debugging
          log(`[CodeGraphAgent] Command failed with code ${code}`, 'error');
          log(`[CodeGraphAgent] STDOUT: ${stdout.slice(0, 500)}`, 'debug');
          log(`[CodeGraphAgent] STDERR: ${stderr.slice(0, 1000)}`, 'error');

          const errorMsg = stderr.includes('ModuleNotFoundError')
            ? `Missing Python module: ${stderr.match(/ModuleNotFoundError: No module named '([^']+)'/)?.[1] || 'unknown'}`
            : stderr.includes('not found')
              ? `Command not found in PATH: ${stderr.slice(0, 200)}`
              : `code-graph-rag command failed (code ${code}): ${stderr.slice(0, 800)}`;

          reject(new Error(errorMsg));
        }
      });

      uvProcess.on('error', (error) => {
        log(`[CodeGraphAgent] Process spawn error: ${error.message}`, 'error');
        reject(new Error(`Failed to spawn uv process: ${error.message}`));
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
   *                 Optionally includes doc_semantics_enrichments for enhanced observations
   */
  async transformToKnowledgeEntities(params: CodeGraphAnalysisResult | {
    code_analysis?: CodeGraphAnalysisResult;
    doc_semantics_enrichments?: Array<{ entityName: string; observations: string[] }>;
    [key: string]: any;
  }): Promise<Array<{
    name: string;
    entityType: string;
    observations: string[];
    significance: number;
  }>> {
    // Handle both direct CodeGraphAnalysisResult and wrapped parameters
    const codeAnalysis: CodeGraphAnalysisResult = 'code_analysis' in params && params.code_analysis
      ? params.code_analysis
      : params as CodeGraphAnalysisResult;

    // Extract doc semantics enrichments if available
    const docSemanticsEnrichments = 'doc_semantics_enrichments' in params
      ? params.doc_semantics_enrichments
      : undefined;

    // Build enrichment lookup map for O(1) access
    const enrichmentMap = new Map<string, string[]>();
    if (docSemanticsEnrichments && Array.isArray(docSemanticsEnrichments)) {
      for (const enrichment of docSemanticsEnrichments) {
        if (enrichment.entityName && enrichment.observations) {
          enrichmentMap.set(enrichment.entityName.toLowerCase(), enrichment.observations);
        }
      }
      log(`[CodeGraphAgent] Using ${enrichmentMap.size} doc semantics enrichments`, 'info');
    }

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
    for (const [modulePath, moduleEntities] of moduleGroups) {
      const classes = moduleEntities.filter(e => e.type === 'class');
      const functions = moduleEntities.filter(e => e.type === 'function');

      // Create entity for each class
      for (const cls of classes) {
        const methods = moduleEntities.filter(e => e.type === 'method' && e.filePath === cls.filePath);

        // Check for enriched observations from doc semantics
        const enrichedObs = enrichmentMap.get(cls.name.toLowerCase());

        const observations = enrichedObs
          ? [
              `Class ${cls.name} defined in ${cls.filePath}:${cls.lineNumber}`,
              ...enrichedObs, // Use LLM-analyzed documentation instead of raw docstring
              methods.length > 0 ? `Contains ${methods.length} methods: ${methods.map(m => m.name).join(', ')}` : null,
              cls.complexity ? `Complexity score: ${cls.complexity}` : null,
            ].filter(Boolean) as string[]
          : [
              `Class ${cls.name} defined in ${cls.filePath}:${cls.lineNumber}`,
              cls.docstring ? `Documentation: ${cls.docstring}` : null,
              methods.length > 0 ? `Contains ${methods.length} methods: ${methods.map(m => m.name).join(', ')}` : null,
              cls.complexity ? `Complexity score: ${cls.complexity}` : null,
            ].filter(Boolean) as string[];

        knowledgeEntities.push({
          name: cls.name,
          entityType: 'CodeClass',
          observations,
          significance: Math.min(10, 5 + Math.floor(methods.length / 2) + (enrichedObs ? 1 : 0)), // Boost significance if enriched
        });
      }

      // Create entities for standalone functions with significant complexity
      for (const fn of functions.filter(f => (f.complexity || 0) > 5)) {
        // Check for enriched observations from doc semantics
        const enrichedObs = enrichmentMap.get(fn.name.toLowerCase());

        const observations = enrichedObs
          ? [
              `Function ${fn.name} defined in ${fn.filePath}:${fn.lineNumber}`,
              fn.signature ? `Signature: ${fn.signature}` : null,
              ...enrichedObs, // Use LLM-analyzed documentation instead of raw docstring
              fn.complexity ? `Complexity score: ${fn.complexity}` : null,
            ].filter(Boolean) as string[]
          : [
              `Function ${fn.name} defined in ${fn.filePath}:${fn.lineNumber}`,
              fn.signature ? `Signature: ${fn.signature}` : null,
              fn.docstring ? `Documentation: ${fn.docstring}` : null,
              fn.complexity ? `Complexity score: ${fn.complexity}` : null,
            ].filter(Boolean) as string[];

        knowledgeEntities.push({
          name: fn.name,
          entityType: 'CodeFunction',
          observations,
          significance: Math.min(8, 3 + Math.floor((fn.complexity || 0) / 3) + (enrichedObs ? 1 : 0)), // Boost significance if enriched
        });
      }
    }

    log(`[CodeGraphAgent] Transformed ${knowledgeEntities.length} code entities to knowledge entities`, 'info');
    return knowledgeEntities;
  }
}

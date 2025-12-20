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
import { SemanticAnalyzer } from './semantic-analyzer.js';

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
  /** True if using incremental mode (reusing existing data) */
  incrementalMode?: boolean;
  /** Number of files changed since last index */
  changedFilesCount?: number;
  /** Sample of changed file paths */
  changedFiles?: string[];
  /** Whether a full re-index was performed */
  reindexed?: boolean;
  /** Node count before re-index (if applicable) */
  previousNodeCount?: number;
  /** Human-readable message about the indexing result */
  message?: string;
}

export interface CodeGraphQueryResult {
  matches: CodeEntity[];
  relevanceScores: Map<string, number>;
  queryTime: number;
}

export interface NaturalLanguageQueryResult {
  question: string;
  generatedCypher: string;
  results: any[];
  queryTime: number;
  provider: string;
}

export interface IntelligentQueryContext {
  changedFiles?: string[];
  recentCommits?: string[];
  projectGoals?: string[];
  vibePatterns?: string[];
}

export interface IntelligentQueryResult {
  hotspots: Array<{ name: string; type: string; connections: number }>;
  circularDeps: Array<{ from: string; to: string }>;
  inheritanceTree: Array<{ parent: string; children: string[] }>;
  changeImpact: Array<{ changed: string; affected: string[] }>;
  architecturalPatterns: Array<{ pattern: string; evidence: string[] }>;
  correlations: string[];
  rawQueries: Array<{ question: string; cypher: string; results: any[] }>;
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
   * Check if Memgraph has existing index data for the repository
   * Returns node count and whether data exists
   */
  async hasExistingIndex(repoPath?: string): Promise<{ hasData: boolean; nodeCount: number; projectName?: string }> {
    const targetPath = repoPath || this.repositoryPath;
    const projectName = path.basename(targetPath);

    try {
      // Query Memgraph for existing project data
      const result = await this.runCypherQuery(
        `MATCH (n) WHERE n.project = "${projectName}" OR n.repository_path CONTAINS "${projectName}" RETURN count(n) as nodeCount LIMIT 1`
      );

      const nodeCount = result?.nodeCount || 0;
      log(`[CodeGraphAgent] Existing index check for ${projectName}: ${nodeCount} nodes found`, 'info');

      return {
        hasData: nodeCount > 0,
        nodeCount,
        projectName,
      };
    } catch (error) {
      log(`[CodeGraphAgent] Error checking existing index: ${error}`, 'warning');
      return { hasData: false, nodeCount: 0, projectName };
    }
  }

  /**
   * Get statistics from existing Memgraph data without re-indexing
   * Note: code-graph-rag doesn't set project property on nodes, so we query all entities.
   * For multi-project support, nodes would need a project/repo_path property during indexing.
   */
  async getExistingStats(repoPath?: string): Promise<CodeGraphAnalysisResult> {
    const targetPath = repoPath || this.repositoryPath;
    const projectName = path.basename(targetPath);

    try {
      // Query for entity counts by type (no project filter - code-graph-rag doesn't set project property)
      // Include all nodes since they don't have project property set
      const statsResult = await this.runCypherQuery(`
        MATCH (n)
        RETURN
          count(n) as totalEntities,
          count(CASE WHEN n:Function THEN 1 END) as functions,
          count(CASE WHEN n:Class THEN 1 END) as classes,
          count(CASE WHEN n:Method THEN 1 END) as methods,
          count(CASE WHEN n:Module THEN 1 END) as modules
      `);

      // Query for relationship count
      const relResult = await this.runCypherQuery(`
        MATCH (n)-[r]->(m)
        RETURN count(r) as totalRelationships
      `);

      // Query for language distribution (use label as proxy for language if property not set)
      const langResult = await this.runCypherQuery(`
        MATCH (n)
        WHERE n.language IS NOT NULL
        RETURN n.language as language, count(n) as count
      `);

      const languageDistribution: Record<string, number> = {};
      if (Array.isArray(langResult)) {
        langResult.forEach((row: any) => {
          if (row.language) {
            languageDistribution[row.language] = row.count || 0;
          }
        });
      }

      const entityTypeDistribution: Record<string, number> = {
        function: statsResult?.functions || 0,
        class: statsResult?.classes || 0,
        method: statsResult?.methods || 0,
        module: statsResult?.modules || 0,
      };

      return {
        entities: [], // Don't load all entities, just stats
        relationships: [],
        statistics: {
          totalEntities: statsResult?.totalEntities || 0,
          totalRelationships: relResult?.totalRelationships || 0,
          languageDistribution,
          entityTypeDistribution,
        },
        indexedAt: new Date().toISOString(),
        repositoryPath: targetPath,
        warning: 'Using existing Memgraph data (no re-indexing performed)',
        skipped: false, // Not skipped, just reused
      };
    } catch (error) {
      log(`[CodeGraphAgent] Error getting existing stats: ${error}`, 'warning');
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
        repositoryPath: targetPath,
        warning: `Failed to get existing stats: ${error}`,
        skipped: true,
      };
    }
  }

  /**
   * Execute a Cypher query against Memgraph using mgconsole
   * Uses CSV output format and parses into JSON objects
   * Can be called directly for explicit Cypher queries
   */
  async runCypherQuery(query: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const docker = spawn('docker', [
        'exec', '-i', 'code-graph-rag-memgraph-1',
        'mgconsole', '--output-format=csv'
      ]);

      let stdout = '';
      let stderr = '';

      docker.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      docker.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      docker.on('close', (code) => {
        if (code !== 0) {
          log(`[CodeGraphAgent] Cypher query failed: ${stderr}`, 'warning');
          resolve(null);
          return;
        }

        try {
          // Parse CSV output - first line is headers, rest are data rows
          const lines = stdout.trim().split('\n').filter(l => l.trim());
          if (lines.length === 0) {
            resolve([]);
            return;
          }

          // Parse CSV header and rows
          const headers = this.parseCSVLine(lines[0]);
          const results: any[] = [];

          for (let i = 1; i < lines.length; i++) {
            const values = this.parseCSVLine(lines[i]);
            const row: Record<string, any> = {};
            for (let j = 0; j < headers.length; j++) {
              row[headers[j]] = values[j] || null;
            }
            results.push(row);
          }

          // Return array of results (or first result for count queries)
          if (results.length === 1 && headers.some(h => h.includes('count') || h.includes('Count'))) {
            resolve(results[0]);
          } else {
            resolve(results);
          }
        } catch (e) {
          log(`[CodeGraphAgent] Failed to parse Cypher result: ${e}`, 'warning');
          resolve(null);
        }
      });

      docker.on('error', (err) => {
        log(`[CodeGraphAgent] Docker exec failed: ${err}`, 'warning');
        resolve(null);
      });

      // Send query to mgconsole
      docker.stdin.write(query + ';\n');
      docker.stdin.end();
    });
  }

  /**
   * Parse a CSV line, handling quoted values
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  /**
   * Index a repository using code-graph-rag CLI
   * Uses: uv run graph-code index --repo-path <path> --output-proto-dir <dir>
   *
   * Options:
   * - forceReindex: Force re-indexing even if Memgraph has existing data (default: false)
   * - minNodeThreshold: Minimum nodes required to consider existing data valid (default: 100)
   */
  async indexRepository(targetPath?: string | { target_path?: string; forceReindex?: boolean; minNodeThreshold?: number }): Promise<CodeGraphAnalysisResult> {
    // Handle both direct path and wrapped parameter object from coordinator
    let repoPath: string;
    let forceReindex = false;
    let minNodeThreshold = 100;

    if (typeof targetPath === 'object' && targetPath !== null) {
      repoPath = targetPath.target_path || this.repositoryPath;
      forceReindex = targetPath.forceReindex || false;
      minNodeThreshold = targetPath.minNodeThreshold || 100;
    } else if (typeof targetPath === 'string') {
      repoPath = targetPath;
    } else {
      repoPath = this.repositoryPath;
    }

    log(`[CodeGraphAgent] Indexing repository: ${repoPath} (forceReindex: ${forceReindex})`, 'info');

    // Check for existing Memgraph data before re-indexing (unless forced)
    if (!forceReindex) {
      const existingIndex = await this.hasExistingIndex(repoPath);
      if (existingIndex.hasData && existingIndex.nodeCount >= minNodeThreshold) {
        log(`[CodeGraphAgent] Found existing index with ${existingIndex.nodeCount} nodes for ${existingIndex.projectName}, skipping re-index`, 'info');
        log(`[CodeGraphAgent] To force re-indexing, use forceReindex: true`, 'info');
        return this.getExistingStats(repoPath);
      } else if (existingIndex.hasData) {
        log(`[CodeGraphAgent] Existing index has only ${existingIndex.nodeCount} nodes (threshold: ${minNodeThreshold}), will re-index`, 'info');
      }
    }

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
   * Supported file extensions for code graph indexing
   */
  private readonly SUPPORTED_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',  // JavaScript/TypeScript
    '.py', '.pyi',                                   // Python
    '.java',                                         // Java
    '.go',                                           // Go
    '.rs',                                           // Rust
    '.cpp', '.cc', '.cxx', '.hpp', '.h',            // C++
    '.c',                                            // C
    '.scala',                                        // Scala
    '.lua',                                          // Lua
  ];

  /**
   * Index repository incrementally based on git changes
   * Smart incremental approach:
   * - If Memgraph has substantial data (>100 nodes), reuse it for minor changes
   * - Only trigger full re-index if no data exists or forceReindex is true
   */
  async indexIncrementally(repoPath?: string, options: {
    sinceCommit?: string;    // Compare against this commit (e.g., 'HEAD~10', commit hash)
    sinceDays?: number;      // Or use time-based (default: 7 days)
    forceReindex?: boolean;  // Force full re-index even if data exists
    minExistingNodes?: number; // Threshold for "substantial" data (default: 100)
  } = {}): Promise<CodeGraphAnalysisResult> {
    const targetPath = repoPath || this.repositoryPath;
    const projectName = path.basename(targetPath);
    const { sinceCommit, sinceDays = 7, forceReindex = false, minExistingNodes = 100 } = options;

    log(`[CodeGraphAgent] Incremental indexing for ${projectName}`, 'info');

    // Check Memgraph connection first
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      log(`[CodeGraphAgent] Memgraph not reachable, skipping incremental indexing`, 'warning');
      return this.getExistingStats(targetPath);
    }

    try {
      // First check if we already have substantial data in Memgraph
      const existingStats = await this.getExistingStats(targetPath);
      const existingNodeCount = existingStats.statistics?.totalEntities || 0;

      if (!forceReindex && existingNodeCount >= minExistingNodes) {
        // We have substantial existing data
        log(`[CodeGraphAgent] Found ${existingNodeCount} existing nodes in Memgraph, checking for changes...`, 'info');

        // Get list of changed files using git
        const changedFiles = await this.getChangedFiles(targetPath, sinceCommit, sinceDays);
        const supportedFiles = changedFiles.filter(file =>
          this.SUPPORTED_EXTENSIONS.some(ext => file.toLowerCase().endsWith(ext))
        );

        if (supportedFiles.length === 0) {
          log(`[CodeGraphAgent] No source file changes, using existing index (${existingNodeCount} nodes)`, 'info');
          return {
            ...existingStats,
            incrementalMode: true,
            changedFilesCount: 0,
            reindexed: false,
          };
        }

        // For incremental analysis with existing data:
        // Only re-index if there are MANY changes (>20% of codebase or >50 files)
        const changeThreshold = Math.max(50, existingNodeCount * 0.2);
        if (supportedFiles.length < changeThreshold) {
          log(`[CodeGraphAgent] Only ${supportedFiles.length} files changed (threshold: ${Math.floor(changeThreshold)}), using existing index`, 'info');
          return {
            ...existingStats,
            incrementalMode: true,
            changedFilesCount: supportedFiles.length,
            changedFiles: supportedFiles.slice(0, 20), // Include sample of changed files
            reindexed: false,
            message: `Using existing code graph (${existingNodeCount} nodes). ${supportedFiles.length} files changed since last full index.`,
          };
        }

        log(`[CodeGraphAgent] ${supportedFiles.length} files changed (>${Math.floor(changeThreshold)} threshold), triggering full re-index`, 'info');
      } else if (existingNodeCount > 0) {
        log(`[CodeGraphAgent] Only ${existingNodeCount} existing nodes (threshold: ${minExistingNodes}), will do full index`, 'info');
      } else {
        log(`[CodeGraphAgent] No existing code graph data, will do full index`, 'info');
      }

      // Trigger full re-index
      const result = await this.indexRepository({
        target_path: targetPath,
        forceReindex: true,
        minNodeThreshold: 0
      });

      return {
        ...result,
        incrementalMode: false,
        reindexed: true,
        previousNodeCount: existingNodeCount,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[CodeGraphAgent] Incremental indexing failed: ${errorMessage}`, 'warning');
      // Fall back to existing stats
      return this.getExistingStats(targetPath);
    }
  }

  /**
   * Get list of files changed since a commit or time period
   */
  private async getChangedFiles(repoPath: string, sinceCommit?: string, sinceDays?: number): Promise<string[]> {
    return new Promise((resolve) => {
      let gitArgs: string[];

      if (sinceCommit) {
        // Use commit-based diff
        gitArgs = ['diff', '--name-only', `${sinceCommit}..HEAD`];
      } else {
        // Use time-based diff (files changed in last N days)
        const sinceDate = new Date();
        sinceDate.setDate(sinceDate.getDate() - (sinceDays || 7));
        const dateStr = sinceDate.toISOString().split('T')[0];
        gitArgs = ['log', '--name-only', '--pretty=format:', `--since=${dateStr}`];
      }

      const git = spawn('git', gitArgs, { cwd: repoPath });
      let stdout = '';
      let stderr = '';

      git.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      git.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      git.on('close', (code) => {
        if (code !== 0) {
          log(`[CodeGraphAgent] Git command failed: ${stderr}`, 'warning');
          resolve([]);
          return;
        }

        // Parse file list, remove duplicates and empty lines
        const files = [...new Set(
          stdout
            .split('\n')
            .map(f => f.trim())
            .filter(f => f.length > 0)
        )];

        log(`[CodeGraphAgent] Git found ${files.length} changed files`, 'info');
        resolve(files);
      });

      git.on('error', (err) => {
        log(`[CodeGraphAgent] Git spawn failed: ${err}`, 'warning');
        resolve([]);
      });
    });
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

  /**
   * Graph schema description for NL→Cypher translation
   */
  private readonly GRAPH_SCHEMA = `
Node Types:
- Function: Represents a function definition
  Properties: name, file_path, line_number, signature, docstring, language, complexity, project
- Class: Represents a class definition
  Properties: name, file_path, line_number, docstring, language, project
- Method: Represents a method within a class
  Properties: name, file_path, line_number, signature, docstring, language, project
- Module: Represents a source file/module
  Properties: name, file_path, language, project
- File: Represents a source file
  Properties: name, path, language, project
- Folder: Represents a directory
  Properties: name, path, project
- Package: Represents a package/library
  Properties: name, version, project

Relationship Types:
- CALLS: (Function|Method)-[:CALLS]->(Function|Method) - Function/method calls another
- DEFINES: (Module|Class)-[:DEFINES]->(Function|Method|Class) - Module/class defines a symbol
- IMPORTS: (Module)-[:IMPORTS]->(Module|Package) - Module imports another module/package
- INHERITS: (Class)-[:INHERITS]->(Class) - Class inheritance
- OVERRIDES: (Method)-[:OVERRIDES]->(Method) - Method overrides parent method
- CONTAINS_FILE: (Folder)-[:CONTAINS_FILE]->(File) - Folder contains file
- DEFINES_METHOD: (Class)-[:DEFINES_METHOD]->(Method) - Class defines method
`;

  /**
   * Query the code graph using natural language
   * Uses SemanticAnalyzer to translate natural language to Cypher
   */
  async queryNaturalLanguage(question: string): Promise<NaturalLanguageQueryResult> {
    const startTime = Date.now();
    log(`[CodeGraphAgent] Natural language query: ${question}`, 'info');

    // Check Memgraph connection first
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      throw new Error(`Memgraph not reachable: ${connectionCheck.error}`);
    }

    // Initialize SemanticAnalyzer for NL→Cypher translation
    const semanticAnalyzer = new SemanticAnalyzer();

    const cypherPrompt = `You are a Cypher query generator for a code knowledge graph stored in Memgraph.

${this.GRAPH_SCHEMA}

IMPORTANT RULES:
1. Return ONLY the Cypher query, no explanations or markdown formatting
2. Do NOT use backticks or code blocks
3. Always use LIMIT to avoid returning too many results (default LIMIT 25)
4. For text matching, use CONTAINS for partial matches or = for exact matches
5. Property names are lowercase with underscores (file_path, line_number)
6. Node labels are PascalCase (Function, Class, Method, Module, File, Folder)

User Question: ${question}

Cypher Query:`;

    try {
      // Use SemanticAnalyzer with auto provider fallback (Groq → Gemini → Anthropic → OpenAI)
      const result = await semanticAnalyzer.analyzeContent(cypherPrompt, {
        analysisType: 'code',
        provider: 'auto'
      });

      // Extract Cypher from response
      const cypher = this.extractCypher(result.insights);

      if (!cypher) {
        throw new Error('Failed to extract valid Cypher query from LLM response');
      }

      log(`[CodeGraphAgent] Generated Cypher: ${cypher}`, 'info');

      // Execute the generated Cypher query
      const queryResult = await this.runCypherQuery(cypher);

      const queryTime = Date.now() - startTime;
      log(`[CodeGraphAgent] NL query completed in ${queryTime}ms`, 'info');

      return {
        question,
        generatedCypher: cypher,
        results: Array.isArray(queryResult) ? queryResult : queryResult ? [queryResult] : [],
        queryTime,
        provider: result.provider || 'auto'
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`[CodeGraphAgent] NL query failed: ${errorMessage}`, 'error');
      throw error;
    }
  }

  /**
   * Execute intelligent, context-aware queries against the code graph.
   * Generates targeted questions based on context (changed files, commits, goals, vibes)
   * and executes them to produce evidence-backed insights.
   */
  async queryIntelligently(
    context: IntelligentQueryContext,
    options: { maxQueries?: number } = { maxQueries: 8 }
  ): Promise<IntelligentQueryResult> {
    const startTime = Date.now();
    const maxQueries = options.maxQueries || 8;
    log(`[CodeGraphAgent] Starting intelligent query with context: ${JSON.stringify({
      changedFiles: context.changedFiles?.length || 0,
      recentCommits: context.recentCommits?.length || 0,
      projectGoals: context.projectGoals?.length || 0,
      vibePatterns: context.vibePatterns?.length || 0,
    })}`, 'info');

    // Check connection first
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      log(`[CodeGraphAgent] Memgraph not connected, returning empty result`, 'warning');
      return this.emptyIntelligentResult(Date.now() - startTime);
    }

    // Generate context-aware questions
    const questions = this.generateContextAwareQuestions(context, maxQueries);
    log(`[CodeGraphAgent] Generated ${questions.length} questions`, 'info');

    // Execute queries and collect results
    const rawQueries: Array<{ question: string; cypher: string; results: any[] }> = [];
    const hotspots: Array<{ name: string; type: string; connections: number }> = [];
    const circularDeps: Array<{ from: string; to: string }> = [];
    const inheritanceTree: Array<{ parent: string; children: string[] }> = [];
    const changeImpact: Array<{ changed: string; affected: string[] }> = [];
    const architecturalPatterns: Array<{ pattern: string; evidence: string[] }> = [];
    const correlations: string[] = [];

    // Execute queries sequentially to avoid overwhelming the LLM API
    for (const question of questions) {
      try {
        const result = await this.queryNaturalLanguage(question);
        rawQueries.push({
          question,
          cypher: result.generatedCypher,
          results: result.results,
        });

        // Process results based on question type
        this.categorizeQueryResults(
          question,
          result.results,
          { hotspots, circularDeps, inheritanceTree, changeImpact, architecturalPatterns, correlations }
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`[CodeGraphAgent] Query failed: "${question}" - ${errorMsg}`, 'warning');
        correlations.push(`Query failed: ${question}`);
      }
    }

    const queryTime = Date.now() - startTime;
    log(`[CodeGraphAgent] Intelligent query completed in ${queryTime}ms with ${rawQueries.length} successful queries`, 'info');

    return {
      hotspots,
      circularDeps,
      inheritanceTree,
      changeImpact,
      architecturalPatterns,
      correlations,
      rawQueries,
      queryTime,
    };
  }

  /**
   * Generate context-aware questions based on the provided context
   */
  private generateContextAwareQuestions(context: IntelligentQueryContext, maxQueries: number): string[] {
    const questions: string[] = [];
    const { changedFiles, recentCommits, projectGoals, vibePatterns } = context;

    // Always include baseline architectural questions
    questions.push('What are the most connected entities (classes or functions with the most relationships)?');
    questions.push('Are there any circular dependencies between modules or classes?');
    questions.push('What is the inheritance hierarchy in this codebase?');

    // Questions based on changed files
    if (changedFiles && changedFiles.length > 0) {
      const fileList = changedFiles.slice(0, 5).join(', ');
      questions.push(`What classes or functions are defined in files: ${fileList}?`);
      questions.push(`What other functions or methods depend on code in files: ${fileList}?`);
    }

    // Questions based on recent commits
    if (recentCommits && recentCommits.length > 0) {
      const commitKeywords = this.extractKeywordsFromCommits(recentCommits);
      if (commitKeywords.length > 0) {
        questions.push(`Find code related to: ${commitKeywords.slice(0, 5).join(', ')}`);
      }
    }

    // Questions based on project goals
    if (projectGoals && projectGoals.length > 0) {
      for (const goal of projectGoals.slice(0, 2)) {
        questions.push(`What classes or functions implement functionality related to: ${goal}?`);
      }
    }

    // Questions based on vibe patterns (problems, issues from session history)
    if (vibePatterns && vibePatterns.length > 0) {
      for (const pattern of vibePatterns.slice(0, 2)) {
        questions.push(`Find code that might be related to: ${pattern}`);
      }
    }

    // Additional architectural discovery questions
    questions.push('What are the main modules and how do they interact?');
    questions.push('Find functions with high complexity or many dependencies');

    // Limit to maxQueries
    return questions.slice(0, maxQueries);
  }

  /**
   * Extract meaningful keywords from commit messages
   */
  private extractKeywordsFromCommits(commits: string[]): string[] {
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'fix', 'add', 'update', 'change', 'remove', 'delete', 'refactor', 'chore', 'feat', 'docs', 'style', 'test', 'ci', 'build']);

    const keywords: string[] = [];
    for (const commit of commits) {
      const words = commit.toLowerCase().split(/\s+/);
      for (const word of words) {
        const cleaned = word.replace(/[^a-z0-9]/g, '');
        if (cleaned.length > 3 && !stopWords.has(cleaned)) {
          keywords.push(cleaned);
        }
      }
    }

    // Remove duplicates and return
    return [...new Set(keywords)];
  }

  /**
   * Categorize query results into specific buckets based on question type
   */
  private categorizeQueryResults(
    question: string,
    results: any[],
    buckets: {
      hotspots: Array<{ name: string; type: string; connections: number }>;
      circularDeps: Array<{ from: string; to: string }>;
      inheritanceTree: Array<{ parent: string; children: string[] }>;
      changeImpact: Array<{ changed: string; affected: string[] }>;
      architecturalPatterns: Array<{ pattern: string; evidence: string[] }>;
      correlations: string[];
    }
  ): void {
    const lowerQuestion = question.toLowerCase();

    if (lowerQuestion.includes('connected') || lowerQuestion.includes('dependencies') || lowerQuestion.includes('complexity')) {
      // Hotspots detection
      for (const result of results) {
        if (result.name && result.connections !== undefined) {
          buckets.hotspots.push({
            name: result.name,
            type: result.type || result.labels || 'unknown',
            connections: parseInt(result.connections) || 0,
          });
        } else if (result.name) {
          // Try to extract connection count from other fields
          const connections = result.relationship_count || result.total_relationships || result.degree || 0;
          buckets.hotspots.push({
            name: result.name,
            type: result.type || result.labels || 'unknown',
            connections: parseInt(connections) || 0,
          });
        }
      }
      buckets.correlations.push(`Found ${results.length} entities related to: ${question}`);
    }

    if (lowerQuestion.includes('circular')) {
      // Circular dependencies
      for (const result of results) {
        if (result.from && result.to) {
          buckets.circularDeps.push({ from: result.from, to: result.to });
        }
      }
      if (results.length === 0) {
        buckets.correlations.push('No circular dependencies detected');
      } else {
        buckets.correlations.push(`Found ${results.length} potential circular dependencies`);
      }
    }

    if (lowerQuestion.includes('inheritance') || lowerQuestion.includes('hierarchy')) {
      // Inheritance tree
      const inheritanceMap = new Map<string, string[]>();
      for (const result of results) {
        const parent = result.parent || result.base_class || result.superclass;
        const child = result.child || result.derived_class || result.subclass || result.name;
        if (parent && child) {
          if (!inheritanceMap.has(parent)) {
            inheritanceMap.set(parent, []);
          }
          inheritanceMap.get(parent)!.push(child);
        }
      }
      for (const [parent, children] of inheritanceMap) {
        buckets.inheritanceTree.push({ parent, children });
      }
      buckets.correlations.push(`Found ${inheritanceMap.size} inheritance relationships`);
    }

    if (lowerQuestion.includes('depend on') || lowerQuestion.includes('call') || lowerQuestion.includes('affect')) {
      // Change impact
      const impactMap = new Map<string, string[]>();
      for (const result of results) {
        const source = result.source || result.caller || result.dependent;
        const target = result.target || result.callee || result.dependency || result.name;
        if (source && target) {
          if (!impactMap.has(source)) {
            impactMap.set(source, []);
          }
          impactMap.get(source)!.push(target);
        }
      }
      for (const [changed, affected] of impactMap) {
        buckets.changeImpact.push({ changed, affected });
      }
      if (impactMap.size > 0) {
        buckets.correlations.push(`Found ${impactMap.size} dependency chains affecting changed code`);
      }
    }

    if (lowerQuestion.includes('pattern') || lowerQuestion.includes('module') || lowerQuestion.includes('interact')) {
      // Architectural patterns
      const evidence: string[] = [];
      for (const result of results) {
        const name = result.name || result.module || result.pattern;
        const description = result.description || result.relationship || result.type;
        if (name) {
          evidence.push(`${name}${description ? ': ' + description : ''}`);
        }
      }
      if (evidence.length > 0) {
        buckets.architecturalPatterns.push({
          pattern: question,
          evidence,
        });
      }
    }

    // Generic results correlation
    if (results.length > 0 && buckets.correlations.length === 0) {
      buckets.correlations.push(`Query "${question.slice(0, 50)}..." returned ${results.length} results`);
    }
  }

  /**
   * Return empty result structure for cases where querying isn't possible
   */
  private emptyIntelligentResult(queryTime: number): IntelligentQueryResult {
    return {
      hotspots: [],
      circularDeps: [],
      inheritanceTree: [],
      changeImpact: [],
      architecturalPatterns: [],
      correlations: ['Code graph not available or not connected'],
      rawQueries: [],
      queryTime,
    };
  }

  /**
   * Extract Cypher query from LLM response
   * Handles various response formats (with/without code blocks, explanations, etc.)
   */
  private extractCypher(response: string): string | null {
    if (!response) return null;

    // First, try to find Cypher in code blocks
    const codeBlockMatch = response.match(/```(?:cypher)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Try to find a MATCH statement (most Cypher queries start with MATCH)
    const matchStatement = response.match(/\b(MATCH\s+[\s\S]*?)(?:$|(?=\n\n))/i);
    if (matchStatement) {
      // Clean up: remove any trailing explanation text
      let query = matchStatement[1].trim();
      // Remove anything after a line that doesn't look like Cypher
      const lines = query.split('\n');
      const cypherLines: string[] = [];
      for (const line of lines) {
        // Check if line looks like Cypher (contains keywords or is a continuation)
        if (/^\s*(MATCH|WHERE|RETURN|WITH|OPTIONAL|UNWIND|ORDER|LIMIT|SKIP|CREATE|MERGE|DELETE|SET|REMOVE|CALL|UNION|FOREACH|\||\(|{|,|-|\[)/i.test(line) ||
            line.trim() === '' ||
            /^\s*[a-z_]+\s*[<>=!]/i.test(line)) {
          cypherLines.push(line);
        } else if (cypherLines.length > 0) {
          // If we have some Cypher and hit a non-Cypher line, stop
          break;
        }
      }
      return cypherLines.join('\n').trim();
    }

    // Try CREATE, MERGE, or other Cypher starts
    const otherCypherMatch = response.match(/\b((?:CREATE|MERGE|CALL|UNWIND)\s+[\s\S]*?)(?:$|(?=\n\n))/i);
    if (otherCypherMatch) {
      return otherCypherMatch[1].trim();
    }

    // If the entire response looks like Cypher (no prose), use it
    const trimmed = response.trim();
    if (/^(?:MATCH|CREATE|MERGE|CALL|UNWIND)\s/i.test(trimmed) &&
        !/^[A-Z][a-z]+\s+[a-z]+\s/i.test(trimmed)) {  // Not starting with "This query..."
      return trimmed;
    }

    return null;
  }
}

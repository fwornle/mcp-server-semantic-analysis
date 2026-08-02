/**
 * CodeGraphAgent - AST-based code knowledge graph reader
 *
 * Reads a static graphify `graph.json` (NetworkX node-link JSON, maintained by
 * the graphify service) to:
 * - Report code entities (functions, classes, methods, files) and relationships
 * - Provide entity / similarity / call-graph lookups over the graph
 * - Feed LLM-based insight synthesis with entity + dependency context
 *
 * This replaces the former code-graph-rag + Memgraph/Cypher backend. All graph
 * access now goes through {@link GraphifyGraph}; the public class surface (every
 * interface + method signature/return shape) is preserved for existing callers.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';
import { GraphifyGraph, type GraphNode } from './graphify-graph.js';

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

export interface SynthesisResult {
  entityName: string;
  entityType: string;
  purpose: string;
  components: string[];
  patternsIdentified: string[];
  dependencies: string[];
  dependents: string[];
  potentialIssues: string[];
  sourceFiles: string[];
  documentation: string;
  success: boolean;
  errorMessage?: string;
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
  private graph: GraphifyGraph;

  constructor(
    repositoryPath: string = '.',
    options: {
      codeGraphRagDir?: string;
      // Retained for backwards-compatible construction; graphify has no Memgraph.
      memgraphHost?: string;
      memgraphPort?: number;
    } = {}
  ) {
    this.repositoryPath = path.resolve(repositoryPath);

    // Compute (legacy) code-graph-rag directory. Kept only for diagnostics; the
    // graph is now sourced from graphify's graph.json (see GraphifyGraph).
    const codingRepoPath = process.env.CODING_REPO || process.env.CODING_TOOLS_PATH || process.env.CODING_ROOT;
    if (options.codeGraphRagDir) {
      this.codeGraphRagDir = path.resolve(options.codeGraphRagDir);
    } else if (codingRepoPath) {
      this.codeGraphRagDir = path.join(codingRepoPath, 'integrations/code-graph-rag');
    } else {
      const currentDir = path.dirname(new URL(import.meta.url).pathname);
      this.codeGraphRagDir = path.resolve(currentDir, '../../../code-graph-rag');
    }

    this.graph = new GraphifyGraph();

    log(`[CodeGraphAgent] Initialized with repo: ${this.repositoryPath}, graph: ${this.graph.path()}`, 'info');
  }

  /**
   * Convert a graphify node into a CodeEntity, attaching mapped relationships.
   */
  private nodeToCodeEntity(node: GraphNode, withRelationships = false): CodeEntity {
    const kind = this.graph.kindOf(node);
    // GraphifyGraph kinds: function|class|method|file|variable.
    // CodeEntity.type: function|class|module|method|variable|import.
    const type: CodeEntity['type'] = kind === 'file' ? 'module' : kind;
    return {
      id: String(node.id),
      name: this.graph.nameOf(node),
      type,
      filePath: node.source_file || '',
      lineNumber: this.graph.lineOf(node),
      language: this.graph.languageOf(node),
      relationships: withRelationships
        ? (this.graph.neighborsAsRelationships(String(node.id)) as CodeRelationship[])
        : [],
    };
  }

  /**
   * "Connection" check for the graphify backend: reports connected=true when a
   * graph.json exists and loads with at least one node. Preserves the historical
   * shape so existing `if (!connectionCheck.connected) ...` guards still work
   * (they now mean "no graph available yet").
   */
  private async checkMemgraphConnection(): Promise<{ connected: boolean; error?: string }> {
    if (this.graph.available()) {
      return { connected: true };
    }
    return { connected: false, error: `graphify graph.json not available at ${this.graph.path()}` };
  }

  /**
   * Check if Memgraph has existing index data for the repository
   * Returns node count and whether data exists
   *
   * Note: code-graph-rag doesn't set project property on nodes during indexing,
   * so we query ALL nodes instead of filtering by project name.
   * For multi-project support, nodes would need a project property during indexing.
   */
  async hasExistingIndex(repoPath?: string): Promise<{ hasData: boolean; nodeCount: number; projectName?: string }> {
    const targetPath = repoPath || this.repositoryPath;
    const projectName = path.basename(targetPath);

    try {
      const nodeCount = this.graph.nodeCount();
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
   * Get statistics from the graphify graph.json without re-indexing.
   * The graphify service is authoritative for the graph; this reads its stats.
   */
  async getExistingStats(repoPath?: string): Promise<CodeGraphAnalysisResult> {
    const targetPath = repoPath || this.repositoryPath;
    const projectName = path.basename(targetPath);

    try {
      const stats = this.graph.stats();

      log(`[CodeGraphAgent] getExistingStats for ${projectName}: ${stats.totalEntities} entities, ${stats.totalRelationships} relationships`, 'info');

      return {
        entities: [], // Don't load all entities, just stats
        relationships: [],
        statistics: {
          totalEntities: stats.totalEntities,
          totalRelationships: stats.totalRelationships,
          languageDistribution: stats.languageDistribution,
          entityTypeDistribution: stats.entityTypeDistribution,
        },
        indexedAt: new Date().toISOString(),
        repositoryPath: targetPath,
        warning: 'Using existing graphify graph.json (no re-indexing performed)',
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
   * Best-effort Cypher shim over the graphify graph.json.
   *
   * There is no Cypher engine any more. This recognizes the handful of literal
   * Cypher patterns issued by this file and its callers (cgr-query-cache, wave
   * agents, wave-controller) and answers them from {@link GraphifyGraph} with
   * the SAME row shape each caller expects. Count-style queries return a single
   * object (as the old mgconsole path collapsed single count rows); everything
   * else returns an array. Unrecognized queries (e.g. LLM-generated Cypher) log
   * at debug and return [] for graceful degradation.
   */
  async runCypherQuery(query: string): Promise<any> {
    if (!this.graph.available()) {
      return [];
    }
    const q = query.replace(/\s+/g, ' ').trim();
    const literals = this.cypherLiterals(query);
    const first = literals[0] || '';
    const limit = this.cypherLimit(query);

    // --- count / stats queries (return a single object) -------------------
    if (/count\(n\)\s+as\s+nodeCount/i.test(q)) {
      return { nodeCount: this.graph.stats().totalEntities };
    }
    if (/as\s+totalEntities/i.test(q) && /as\s+functions/i.test(q)) {
      const s = this.graph.stats();
      return {
        totalEntities: s.totalEntities,
        functions: s.functions,
        classes: s.classes,
        methods: s.methods,
        modules: s.modules,
      };
    }
    if (/count\(r\)\s+as\s+totalRelationships/i.test(q)) {
      return { totalRelationships: this.graph.stats().totalRelationships };
    }

    // --- language distribution -------------------------------------------
    if (/n\.language\s+as\s+language/i.test(q)) {
      const dist = this.graph.stats().languageDistribution;
      return Object.entries(dist).map(([language, count]) => ({ language, count }));
    }

    // --- synthesizeInsights: significant entities of given types ----------
    if (/as\s+qualifiedName/i.test(q)) {
      const wantedKinds = this.entityKindsFromLabels(query);
      const nodes = this.graph.codeNodes()
        .filter(n => wantedKinds.size === 0 || wantedKinds.has(this.graph.kindOf(n)))
        .map(n => {
          const id = String(n.id);
          const degree = this.graph.outEdges(id).length + this.graph.inEdges(id).length;
          return { node: n, degree };
        })
        .sort((a, b) => b.degree - a.degree)
        .slice(0, limit || 20);
      return nodes.map(({ node, degree }) => {
        const kind = this.graph.kindOf(node);
        return {
          qualifiedName: this.graph.nameOf(node),
          name: this.graph.nameOf(node),
          entityType: kind.charAt(0).toUpperCase() + kind.slice(1),
          docstring: null,
          comments: null,
          relationshipCount: degree,
        };
      });
    }

    // --- synthesizeInsights: CALLS (out), calledBy (in) -------------------
    if (/\(n\)-\[:CALLS\]->\(target\)/i.test(q)) {
      const cg = this.graph.callGraph(first, 1);
      return cg.callees.map(name => ({ qn: name, type: '' }));
    }
    if (/\(caller\)-\[:CALLS\]->\(n\)/i.test(q)) {
      const cg = this.graph.callGraph(first, 1);
      return cg.callers.map(name => ({ qn: name, type: '' }));
    }
    if (/\[:INHERITS\]->\(parent\)/i.test(q)) {
      const roots = this.graph.findByName(first);
      const parents: Array<{ qn: string }> = [];
      for (const r of roots) {
        for (const e of this.graph.outEdges(String(r.id), ['inherits', 'extends'])) {
          const p = this.graph.getNode(String(e.target));
          if (p) parents.push({ qn: this.graph.nameOf(p) });
        }
      }
      return parents;
    }
    if (/\[:DEFINES_METHOD\]->\(method\)/i.test(q)) {
      const roots = this.graph.findByName(first);
      const methods: Array<{ name: string }> = [];
      for (const r of roots) {
        for (const e of this.graph.outEdges(String(r.id), ['method', 'contains', 'defines'])) {
          const m = this.graph.getNode(String(e.target));
          if (m && this.graph.kindOf(m) === 'method') methods.push({ name: this.graph.nameOf(m) });
        }
      }
      return methods.slice(0, limit || 15);
    }

    // --- cgr-query-cache: files -[:DEFINES]-> entities --------------------
    if (/\(f:File\)-\[:DEFINES\]->\(e\)/i.test(q)) {
      const needle = first.toLowerCase();
      const rows = this.graph.codeNodes()
        .filter(n => this.graph.kindOf(n) !== 'file' && (n.source_file || '').toLowerCase().includes(needle))
        .slice(0, limit || 50)
        .map(n => ({ e: this.nodeToCypherRow(n) }));
      return rows;
    }

    // --- cgr-query-cache: call path (e)-[:CALLS*1..D]->(callee) -----------
    if (/\[:CALLS\*1\.\./i.test(q)) {
      const depthMatch = query.match(/\[:CALLS\*1\.\.(\d+)\]/i);
      const depth = depthMatch ? parseInt(depthMatch[1], 10) : 2;
      const cg = this.graph.callGraph(first, depth);
      // Represent each callee as a chain row rooted at the queried entity.
      return cg.callees.slice(0, limit || 50).map(name => ({
        caller: first,
        callee: name,
        callerQN: first,
        calleeQN: name,
      }));
    }

    // --- cgr-query-cache: callees / imports by entity name ----------------
    if (/\(e\)-\[:CALLS\]->\(callee\)/i.test(q)) {
      const cg = this.graph.callGraph(first, 1);
      return cg.callees.slice(0, limit || 20).map(name => ({ name }));
    }
    if (/\(e\)-\[:IMPORTS\]->\(imp\)/i.test(q)) {
      const roots = this.graph.findByName(first);
      const names = new Set<string>();
      for (const r of roots) {
        for (const e of this.graph.outEdges(String(r.id), ['imports', 'imports_from', 're_exports'])) {
          const t = this.graph.getNode(String(e.target));
          if (t) names.add(this.graph.nameOf(t));
        }
      }
      return [...names].slice(0, limit || 20).map(name => ({ name }));
    }

    // --- cgr-query-cache: entity by exact name (RETURN e) -----------------
    if (/MATCH\s*\(e\)\s*WHERE\s*toLower\(e\.name\)/i.test(q)) {
      return this.graph.findByName(first)
        .slice(0, limit || 10)
        .map(n => ({ e: this.nodeToCypherRow(n) }));
    }

    // --- wave agents / wave-controller: files by path substring ----------
    if (/\(f:File\)/i.test(q) && /f\.file_path\s+AS\s+path/i.test(q)) {
      const needles = literals.map(l => l.toLowerCase()).filter(Boolean);
      const files = this.graph.files().filter(fp => {
        const low = fp.toLowerCase();
        return needles.length === 0 ? true : needles.some(nd => low.includes(nd));
      });
      return files.slice(0, limit || 50).map(path => ({ path }));
    }

    log(`[CodeGraphAgent] Unrecognized Cypher query (returning []): ${q.slice(0, 160)}`, 'debug');
    return [];
  }

  /** Extract all single-quoted string literals from a Cypher query. */
  private cypherLiterals(query: string): string[] {
    const out: string[] = [];
    const re = /'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      out.push(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    }
    return out;
  }

  /** Extract a LIMIT value from a Cypher query, if present. */
  private cypherLimit(query: string): number | null {
    const m = query.match(/LIMIT\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  /** Extract entity kinds from `n:Label` tokens in a WHERE clause. */
  private entityKindsFromLabels(query: string): Set<string> {
    const kinds = new Set<string>();
    const re = /\bn:(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      switch (m[1].toLowerCase()) {
        case 'function': kinds.add('function'); break;
        case 'class': kinds.add('class'); break;
        case 'method': kinds.add('method'); break;
        case 'module':
        case 'file': kinds.add('file'); break;
        default: break;
      }
    }
    return kinds;
  }

  /** Produce a Memgraph-style (snake_case) node row for RETURN e results. */
  private nodeToCypherRow(node: GraphNode): Record<string, any> {
    const kind = this.graph.kindOf(node);
    return {
      id: String(node.id),
      name: this.graph.nameOf(node),
      type: kind === 'file' ? 'module' : kind,
      file_path: node.source_file || '',
      line_number: this.graph.lineOf(node),
      language: this.graph.languageOf(node),
      signature: undefined,
    };
  }

  /**
   * "Index" a repository.
   *
   * The graphify service owns and maintains graph.json, so indexing here is a
   * no-op: we simply read the current graph stats. The signature and return
   * shape are preserved for callers. When no graph is available yet, a graceful
   * `skipped: true` result is returned (workflow continues).
   *
   * Options (forceReindex / minNodeThreshold) are accepted for compatibility but
   * do not trigger any external indexing process.
   */
  async indexRepository(targetPath?: string | { target_path?: string; forceReindex?: boolean; minNodeThreshold?: number }): Promise<CodeGraphAnalysisResult> {
    // Handle both direct path and wrapped parameter object from coordinator
    let repoPath: string;
    let forceReindex = false;

    if (typeof targetPath === 'object' && targetPath !== null) {
      repoPath = targetPath.target_path || this.repositoryPath;
      forceReindex = targetPath.forceReindex || false;
    } else if (typeof targetPath === 'string') {
      repoPath = targetPath;
    } else {
      repoPath = this.repositoryPath;
    }

    log(`[CodeGraphAgent] Index request for: ${repoPath} (forceReindex: ${forceReindex}) -- graphify graph.json is authoritative, no external indexing performed`, 'info');

    const diagnostics = {
      graphPath: this.graph.path(),
      graphAvailable: this.graph.available(),
      builtAtCommit: this.graph.builtAtCommit(),
      repositoryExists: fs.existsSync(repoPath),
    };

    if (!diagnostics.graphAvailable) {
      const reason = `graphify graph.json not available at ${this.graph.path()}`;
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

    const result = await this.getExistingStats(repoPath);
    (result as any).diagnostics = diagnostics;
    result.message = `Using graphify graph.json (${result.statistics.totalEntities} entities, commit ${diagnostics.builtAtCommit || 'unknown'}). Indexing is maintained by the graphify service.`;
    log(`[CodeGraphAgent] ${result.message}`, 'info');
    return result;
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
  async indexIncrementally(repoPathOrParams?: string | {
    repoPath?: string;
    options?: {
      sinceCommit?: string;
      sinceDays?: number;
      forceReindex?: boolean;
      minExistingNodes?: number;
    };
  }, options: {
    sinceCommit?: string;    // Compare against this commit (e.g., 'HEAD~10', commit hash)
    sinceDays?: number;      // Or use time-based (default: 7 days)
    forceReindex?: boolean;  // Force full re-index even if data exists
    minExistingNodes?: number; // Threshold for "substantial" data (default: 100)
  } = {}): Promise<CodeGraphAnalysisResult> {
    // Handle both direct path and wrapped parameter object from coordinator
    let targetPath: string;
    let effectiveOptions = options;

    if (typeof repoPathOrParams === 'object' && repoPathOrParams !== null) {
      // Wrapped parameter object from coordinator: { repoPath: "...", options: {...} }
      targetPath = repoPathOrParams.repoPath || this.repositoryPath;
      effectiveOptions = repoPathOrParams.options || {};
    } else if (typeof repoPathOrParams === 'string') {
      targetPath = repoPathOrParams;
    } else {
      targetPath = this.repositoryPath;
    }

    const projectName = path.basename(targetPath);
    const { sinceCommit, sinceDays = 7, forceReindex = false, minExistingNodes = 100 } = effectiveOptions;

    log(`[CodeGraphAgent] Incremental indexing for ${projectName}`, 'info');

    // Check graph availability first
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      log(`[CodeGraphAgent] graphify graph.json not available, skipping incremental indexing`, 'warning');
      return this.getExistingStats(targetPath);
    }

    try {
      // First check if we already have substantial data in the graph
      const existingStats = await this.getExistingStats(targetPath);
      const existingNodeCount = existingStats.statistics?.totalEntities || 0;

      if (!forceReindex && existingNodeCount >= minExistingNodes) {
        // We have substantial existing data
        log(`[CodeGraphAgent] Found ${existingNodeCount} existing nodes in graphify graph, checking for changes...`, 'info');

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
   * Execute a code-graph operation against the graphify graph.json.
   *
   * Supported commands (previously shelled out to the codebase_rag CLI):
   *  - 'query'      : findByName + type/language filter -> { matches, scores, queryTime }
   *  - 'similar'    : token-overlap name match          -> { similar }
   *  - 'call-graph' : BFS over calls/indirect_call      -> { root, calls, calledBy }
   *  - 'index'      : no-op (graphify owns the graph)   -> { entities, relationships, indexingStats }
   *  - 'export'     : read graph.json                   -> parsed JSON
   */
  private async runCodeGraphCommand(command: string, args: string[]): Promise<any> {
    const getArg = (flag: string): string | undefined => {
      const i = args.indexOf(flag);
      return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    };

    if (!this.graph.available() && command !== 'export') {
      log(`[CodeGraphAgent] runCodeGraphCommand('${command}'): graphify graph.json not available`, 'warning');
      if (command === 'query') return { matches: [], scores: {}, queryTime: 0 };
      if (command === 'similar') return { similar: [] };
      if (command === 'call-graph') return { root: null, calls: [], calledBy: [] };
      return { skipped: true, warning: `graphify graph.json not available at ${this.graph.path()}` };
    }

    const t0 = Date.now();

    switch (command) {
      case 'query': {
        const query = getArg('--query') || '';
        const types = getArg('--types')?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const languages = getArg('--languages')?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const limit = parseInt(getArg('--limit') || '0', 10) || 25;

        let entities = this.graph.findByName(query).map(n => this.nodeToCodeEntity(n, true));
        if (types && types.length) entities = entities.filter(e => types.includes(e.type.toLowerCase()));
        if (languages && languages.length) entities = entities.filter(e => languages.includes(e.language.toLowerCase()));
        const matches = entities.slice(0, limit);

        const scores: Record<string, number> = {};
        matches.forEach((m, i) => { scores[m.id] = matches.length > 1 ? 1 - i / matches.length : 1; });
        return { matches, scores, queryTime: Date.now() - t0 };
      }

      case 'similar': {
        const code = getArg('--code') || '';
        const topK = parseInt(getArg('--top-k') || '10', 10) || 10;
        const tokens = [...new Set((code.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []).map(t => t.toLowerCase()))];

        const scoreMap = new Map<string, { node: GraphNode; score: number }>();
        for (const tok of tokens) {
          for (const n of this.graph.findByName(tok)) {
            const id = String(n.id);
            const prev = scoreMap.get(id);
            if (prev) prev.score++;
            else scoreMap.set(id, { node: n, score: 1 });
          }
        }
        const ranked = [...scoreMap.values()].sort((a, b) => b.score - a.score).slice(0, topK);
        return { similar: ranked.map(r => this.nodeToCodeEntity(r.node, true)) };
      }

      case 'call-graph': {
        const entity = getArg('--entity') || '';
        const depth = parseInt(getArg('--depth') || '3', 10) || 3;
        const roots = this.graph.findByName(entity);
        const root = roots.length ? this.nodeToCodeEntity(roots[0], true) : null;
        const cg = this.graph.callGraph(entity, depth);
        const calls: CodeRelationship[] = cg.callees.map(name => ({ type: 'calls', source: entity, target: name }));
        const calledBy: CodeRelationship[] = cg.callers.map(name => ({ type: 'calls', source: name, target: entity }));
        return { root, calls, calledBy };
      }

      case 'index': {
        // graphify maintains the graph; report current stats as a no-op result.
        const stats = this.graph.stats();
        return {
          entities: [],
          relationships: [],
          indexingStats: {
            entitiesIndexed: stats.totalEntities,
            filesProcessed: stats.modules,
            protoFilesGenerated: 0,
          },
        };
      }

      case 'export': {
        try {
          const raw = fs.readFileSync(this.graph.path(), 'utf8');
          return JSON.parse(raw);
        } catch (e) {
          return { error: String(e), skipped: true };
        }
      }

      default:
        log(`[CodeGraphAgent] Unsupported command '${command}'`, 'warning');
        return { error: `Unsupported command '${command}'`, skipped: true };
    }
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
   * Synthesize insights for code entities using LLM analysis.
   * Queries the graph for entity details, relationships, and uses LLM to generate
   * comprehensive analysis of purpose, patterns, dependencies, and issues.
   *
   * @param params - Parameters including target entity types and analysis depth
   * @returns Array of synthesis results for each analyzed entity
   */
  async synthesizeInsights(params: {
    targetEntities?: string[];  // Entity types to analyze: ['Class', 'Function', 'Module']
    depth?: string;             // Analysis depth: 'full', 'structure', 'behavior', 'dependencies'
    limit?: number;             // Max entities to analyze (default: 20)
  } | { target_entities?: string[]; depth?: string; limit?: number }): Promise<SynthesisResult[]> {
    // Handle both camelCase and snake_case parameter formats from workflow
    const targetEntities = ('targetEntities' in params && params.targetEntities)
      || ('target_entities' in params && params.target_entities)
      || ['Class', 'Function'];
    const depth = params.depth || 'full';
    const limit = params.limit || 20;

    log(`[CodeGraphAgent] Synthesizing insights for ${targetEntities.join(', ')} (depth: ${depth}, limit: ${limit})`, 'info');

    const results: SynthesisResult[] = [];

    // Check graph availability
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      log(`[CodeGraphAgent] graphify graph.json not available, skipping synthesis`, 'warning');
      return results;
    }

    // Query for significant entities of target types
    const entityTypesClause = targetEntities.map(t => `n:${t}`).join(' OR ');
    const entitiesQuery = `
      MATCH (n)
      WHERE ${entityTypesClause}
      OPTIONAL MATCH (n)-[r]-()
      WITH n, count(r) as relationshipCount
      ORDER BY relationshipCount DESC
      LIMIT ${limit}
      RETURN n.qualified_name as qualifiedName, n.name as name, labels(n)[0] as entityType,
             n.docstring as docstring, n.comments as comments, relationshipCount
    `;

    const entities = await this.runCypherQuery(entitiesQuery);
    if (!Array.isArray(entities) || entities.length === 0) {
      log(`[CodeGraphAgent] No entities found for synthesis`, 'info');
      return results;
    }

    log(`[CodeGraphAgent] Found ${entities.length} entities for synthesis`, 'info');

    // Initialize SemanticAnalyzer for LLM-powered synthesis
    const semanticAnalyzer = new SemanticAnalyzer();

    // Process a single entity (used for parallel execution)
    const processEntity = async (entity: any): Promise<SynthesisResult> => {
      const qualifiedName = entity.qualifiedName || entity.name;
      const entityType = entity.entityType || 'Unknown';

      try {
        // Get relationships for this entity (parallel Cypher queries)
        const [callsResult, calledByResult, inheritsResult, containsResult] = await Promise.all([
          this.runCypherQuery(`
            MATCH (n)-[:CALLS]->(target)
            WHERE n.qualified_name = '${qualifiedName}'
            RETURN target.qualified_name as qn, labels(target)[0] as type
            LIMIT 10
          `),
          this.runCypherQuery(`
            MATCH (caller)-[:CALLS]->(n)
            WHERE n.qualified_name = '${qualifiedName}'
            RETURN caller.qualified_name as qn, labels(caller)[0] as type
            LIMIT 10
          `),
          this.runCypherQuery(`
            MATCH (n)-[:INHERITS]->(parent)
            WHERE n.qualified_name = '${qualifiedName}'
            RETURN parent.qualified_name as qn
          `),
          this.runCypherQuery(`
            MATCH (n)-[:DEFINES_METHOD]->(method)
            WHERE n.qualified_name = '${qualifiedName}'
            RETURN method.name as name
            LIMIT 15
          `)
        ]);

        const calls = Array.isArray(callsResult) ? callsResult.map(r => r.qn).filter(Boolean) : [];
        const calledBy = Array.isArray(calledByResult) ? calledByResult.map(r => r.qn).filter(Boolean) : [];
        const inherits = Array.isArray(inheritsResult) ? inheritsResult.map(r => r.qn).filter(Boolean) : [];
        const contains = Array.isArray(containsResult) ? containsResult.map(r => r.name).filter(Boolean) : [];

        // Build synthesis prompt
        const synthesisPrompt = `Analyze this code entity and provide insights:

ENTITY: ${qualifiedName}
TYPE: ${entityType}

DOCUMENTATION:
${entity.docstring || entity.comments || 'No documentation available'}

RELATIONSHIPS:
- Calls: ${calls.length > 0 ? calls.join(', ') : 'None'}
- Called by: ${calledBy.length > 0 ? calledBy.join(', ') : 'None'}
- Inherits from: ${inherits.length > 0 ? inherits.join(', ') : 'None'}
- Contains (methods): ${contains.length > 0 ? contains.join(', ') : 'None'}

ANALYSIS SCOPE: ${depth}

Provide your analysis in this EXACT format:
PURPOSE: [1-2 sentences describing what this code does]
COMPONENTS: [comma-separated list of key sub-components or methods]
PATTERNS: [comma-separated list of design patterns used]
DEPENDENCIES: [comma-separated list of critical external dependencies]
ISSUES: [comma-separated list of potential risks or concerns, or "None identified"]`;

        // Use SemanticAnalyzer for LLM synthesis
        const llmResult = await semanticAnalyzer.analyzeContent(synthesisPrompt, {
          analysisType: 'code',
          provider: 'auto'
        });

        // Parse the LLM response
        const synthesis = this.parseSynthesisResponse(qualifiedName, entityType, entity.docstring || '', llmResult.insights);
        synthesis.dependencies = calls;
        synthesis.dependents = calledBy;
        synthesis.components = contains.length > 0 ? contains : synthesis.components;

        log(`[CodeGraphAgent] Synthesized insights for ${qualifiedName}`, 'debug');
        return synthesis;

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`[CodeGraphAgent] Synthesis failed for ${qualifiedName}: ${errorMsg}`, 'warning');
        return {
          entityName: qualifiedName,
          entityType,
          purpose: 'Synthesis failed',
          components: [],
          patternsIdentified: [],
          dependencies: [],
          dependents: [],
          potentialIssues: [],
          sourceFiles: [],
          documentation: '',
          success: false,
          errorMessage: errorMsg
        };
      }
    };

    // Process entities in parallel batches with controlled concurrency
    // Limit to 5 concurrent LLM calls to avoid overwhelming the API
    const CONCURRENCY_LIMIT = 5;
    for (let i = 0; i < entities.length; i += CONCURRENCY_LIMIT) {
      const batch = entities.slice(i, i + CONCURRENCY_LIMIT);
      const batchResults = await Promise.all(batch.map(processEntity));
      results.push(...batchResults);
      log(`[CodeGraphAgent] Processed batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(entities.length / CONCURRENCY_LIMIT)} (${results.length}/${entities.length} entities)`, 'info');
    }

    log(`[CodeGraphAgent] Completed synthesis for ${results.length} entities`, 'info');
    return results;
  }

  /**
   * Parse LLM synthesis response into structured result
   */
  private parseSynthesisResponse(
    qualifiedName: string,
    entityType: string,
    documentation: string,
    response: string
  ): SynthesisResult {
    const result: SynthesisResult = {
      entityName: qualifiedName,
      entityType,
      purpose: '',
      components: [],
      patternsIdentified: [],
      dependencies: [],
      dependents: [],
      potentialIssues: [],
      sourceFiles: [],
      documentation,
      success: true
    };

    const lines = response.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('PURPOSE:')) {
        result.purpose = trimmedLine.substring(8).trim();
      } else if (trimmedLine.startsWith('COMPONENTS:')) {
        const items = trimmedLine.substring(11).trim();
        result.components = items.split(',').map(c => c.trim()).filter(c => c.length > 0);
      } else if (trimmedLine.startsWith('PATTERNS:')) {
        const items = trimmedLine.substring(9).trim();
        result.patternsIdentified = items.split(',').map(p => p.trim()).filter(p => p.length > 0);
      } else if (trimmedLine.startsWith('DEPENDENCIES:')) {
        const items = trimmedLine.substring(13).trim();
        result.dependencies = items.split(',').map(d => d.trim()).filter(d => d.length > 0);
      } else if (trimmedLine.startsWith('ISSUES:')) {
        const items = trimmedLine.substring(7).trim();
        if (items.toLowerCase() !== 'none identified') {
          result.potentialIssues = items.split(',').map(i => i.trim()).filter(i => i.length > 0);
        }
      }
    }

    // Fallback if purpose wasn't parsed
    if (!result.purpose) {
      result.purpose = response.substring(0, 500);
    }

    return result;
  }

  /**
   * Transform code entities to knowledge graph entities for persistence
   * @param params - Either a CodeGraphAnalysisResult directly or a parameters object with code_analysis property
   *                 Optionally includes doc_semantics_enrichments for enhanced observations
   *                 Optionally includes synthesis_results for LLM-powered insights
   */
  async transformToKnowledgeEntities(params: CodeGraphAnalysisResult | {
    code_analysis?: CodeGraphAnalysisResult;
    doc_semantics_enrichments?: Array<{ entityName: string; observations: string[] }>;
    synthesis_results?: SynthesisResult[];
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

    // Extract synthesis results if available
    const synthesisResults = 'synthesis_results' in params
      ? params.synthesis_results
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

    // Build synthesis lookup map for O(1) access
    const synthesisMap = new Map<string, SynthesisResult>();
    if (synthesisResults && Array.isArray(synthesisResults)) {
      for (const synthesis of synthesisResults) {
        if (synthesis.entityName && synthesis.success) {
          synthesisMap.set(synthesis.entityName.toLowerCase(), synthesis);
        }
      }
      log(`[CodeGraphAgent] Using ${synthesisMap.size} synthesis results`, 'info');
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
    for (const [_modulePath, moduleEntities] of moduleGroups) {
      const classes = moduleEntities.filter(e => e.type === 'class');
      const functions = moduleEntities.filter(e => e.type === 'function');

      // Create entity for each class
      for (const cls of classes) {
        const methods = moduleEntities.filter(e => e.type === 'method' && e.filePath === cls.filePath);

        // Check for enriched observations from doc semantics
        const enrichedObs = enrichmentMap.get(cls.name.toLowerCase());

        // Check for synthesis results (richer LLM-analyzed insights)
        const synthesis = synthesisMap.get(cls.name.toLowerCase());

        // Build observations prioritizing synthesis > enriched > raw
        let observations: string[];
        if (synthesis) {
          // Use comprehensive synthesis results
          observations = [
            `Class ${cls.name} defined in ${cls.filePath}:${cls.lineNumber}`,
            synthesis.purpose ? `Purpose: ${synthesis.purpose}` : null,
            synthesis.patternsIdentified.length > 0 ? `Patterns: ${synthesis.patternsIdentified.join(', ')}` : null,
            synthesis.dependencies.length > 0 ? `Dependencies: ${synthesis.dependencies.slice(0, 5).join(', ')}` : null,
            synthesis.potentialIssues.length > 0 ? `Issues: ${synthesis.potentialIssues.join(', ')}` : null,
            methods.length > 0 ? `Methods: ${methods.map(m => m.name).join(', ')}` : null,
          ].filter(Boolean) as string[];
        } else if (enrichedObs) {
          observations = [
            `Class ${cls.name} defined in ${cls.filePath}:${cls.lineNumber}`,
            ...enrichedObs,
            methods.length > 0 ? `Contains ${methods.length} methods: ${methods.map(m => m.name).join(', ')}` : null,
            cls.complexity ? `Complexity score: ${cls.complexity}` : null,
          ].filter(Boolean) as string[];
        } else {
          observations = [
            `Class ${cls.name} defined in ${cls.filePath}:${cls.lineNumber}`,
            cls.docstring ? `Documentation: ${cls.docstring}` : null,
            methods.length > 0 ? `Contains ${methods.length} methods: ${methods.map(m => m.name).join(', ')}` : null,
            cls.complexity ? `Complexity score: ${cls.complexity}` : null,
          ].filter(Boolean) as string[];
        }

        // Significance boost: synthesis (+2) > enriched (+1) > none
        const significanceBoost = synthesis ? 2 : (enrichedObs ? 1 : 0);

        knowledgeEntities.push({
          name: cls.name,
          entityType: 'Unclassified',  // Will be classified by ontology - NO HARDCODED TYPES
          observations,
          significance: Math.min(10, 5 + Math.floor(methods.length / 2) + significanceBoost),
        });
      }

      // Create entities for standalone functions with significant complexity
      for (const fn of functions.filter(f => (f.complexity || 0) > 5)) {
        // Check for synthesis results first, then enriched observations
        const synthesis = synthesisMap.get(fn.name.toLowerCase());
        const enrichedObs = enrichmentMap.get(fn.name.toLowerCase());

        // Build observations: synthesis > enriched > raw
        let observations: string[];
        if (synthesis && synthesis.success) {
          // Use synthesis results - richest observations
          observations = [
            `Function ${fn.name} defined in ${fn.filePath}:${fn.lineNumber}`,
            fn.signature ? `Signature: ${fn.signature}` : null,
            synthesis.purpose ? `Purpose: ${synthesis.purpose}` : null,
            synthesis.patternsIdentified.length > 0 ? `Patterns: ${synthesis.patternsIdentified.join(', ')}` : null,
            synthesis.dependencies.length > 0 ? `Dependencies: ${synthesis.dependencies.join(', ')}` : null,
            synthesis.potentialIssues.length > 0 ? `Potential Issues: ${synthesis.potentialIssues.join(', ')}` : null,
            fn.complexity ? `Complexity score: ${fn.complexity}` : null,
          ].filter(Boolean) as string[];
        } else if (enrichedObs) {
          // Use enriched observations from doc semantics
          observations = [
            `Function ${fn.name} defined in ${fn.filePath}:${fn.lineNumber}`,
            fn.signature ? `Signature: ${fn.signature}` : null,
            ...enrichedObs,
            fn.complexity ? `Complexity score: ${fn.complexity}` : null,
          ].filter(Boolean) as string[];
        } else {
          // Fallback to raw observations
          observations = [
            `Function ${fn.name} defined in ${fn.filePath}:${fn.lineNumber}`,
            fn.signature ? `Signature: ${fn.signature}` : null,
            fn.docstring ? `Documentation: ${fn.docstring}` : null,
            fn.complexity ? `Complexity score: ${fn.complexity}` : null,
          ].filter(Boolean) as string[];
        }

        // Significance boost: synthesis (+2) > enriched (+1) > none
        const significanceBoost = synthesis ? 2 : (enrichedObs ? 1 : 0);

        knowledgeEntities.push({
          name: fn.name,
          entityType: 'Unclassified',  // Will be classified by ontology - NO HARDCODED TYPES
          observations,
          significance: Math.min(8, 3 + Math.floor((fn.complexity || 0) / 3) + significanceBoost),
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
   * Query the code graph using natural language.
   *
   * There is no Cypher engine any more, so this performs a best-effort keyword
   * search over the graphify graph (findByName over keywords extracted from the
   * question). `generatedCypher` is returned empty; `provider` is 'graphify'.
   */
  async queryNaturalLanguage(question: string): Promise<NaturalLanguageQueryResult> {
    const startTime = Date.now();
    log(`[CodeGraphAgent] Natural language query: ${question}`, 'info');

    // Check graph availability first
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      throw new Error(`graphify graph.json not available: ${connectionCheck.error}`);
    }

    try {
      // Extract candidate keywords and search the graph by (stripped) name.
      const keywords = this.extractKeywordsFromCommits([question]);
      const seen = new Set<string>();
      const results: any[] = [];
      const LIMIT = 25;

      for (const kw of keywords) {
        for (const n of this.graph.findByName(kw)) {
          const id = String(n.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const entity = this.nodeToCodeEntity(n);
          results.push({
            name: entity.name,
            type: entity.type,
            file_path: entity.filePath,
            line_number: entity.lineNumber,
            language: entity.language,
          });
          if (results.length >= LIMIT) break;
        }
        if (results.length >= LIMIT) break;
      }

      const queryTime = Date.now() - startTime;
      log(`[CodeGraphAgent] NL query completed in ${queryTime}ms (${results.length} results)`, 'info');

      return {
        question,
        generatedCypher: '',
        results,
        queryTime,
        provider: 'graphify',
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

    // Check graph availability first
    const connectionCheck = await this.checkMemgraphConnection();
    if (!connectionCheck.connected) {
      log(`[CodeGraphAgent] graphify graph.json not available, returning empty result`, 'warning');
      return this.emptyIntelligentResult(Date.now() - startTime);
    }

    // Derive structured insights DIRECTLY from the graphify graph.
    const hotspots = this.graph.hotspots(20);
    const inheritanceTree = this.graph.inheritanceTree();
    const circularDeps = this.detectCircularDeps(200);
    const changeImpact = this.computeChangeImpact(context.changedFiles || []);
    const architecturalPatterns: Array<{ pattern: string; evidence: string[] }> = [];
    const correlations: string[] = [];

    if (hotspots.length > 0) {
      correlations.push(`Top hotspot: ${hotspots[0].name} (${hotspots[0].connections} connections)`);
    }
    correlations.push(circularDeps.length > 0
      ? `Found ${circularDeps.length} potential circular dependencies`
      : 'No circular dependencies detected');
    correlations.push(`Found ${inheritanceTree.length} inheritance relationships`);
    if (changeImpact.length > 0) {
      correlations.push(`${changeImpact.length} changed file(s) have downstream dependents`);
    }

    // Best-effort transparency: run keyword lookups for the generated questions.
    const questions = this.generateContextAwareQuestions(context, maxQueries);
    const rawQueries: Array<{ question: string; cypher: string; results: any[] }> = [];
    for (const question of questions) {
      try {
        const result = await this.queryNaturalLanguage(question);
        rawQueries.push({ question, cypher: result.generatedCypher, results: result.results });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log(`[CodeGraphAgent] Query failed: "${question}" - ${errorMsg}`, 'warning');
      }
    }

    const queryTime = Date.now() - startTime;
    log(`[CodeGraphAgent] Intelligent query completed in ${queryTime}ms (hotspots=${hotspots.length}, inheritance=${inheritanceTree.length}, circular=${circularDeps.length}, changeImpact=${changeImpact.length})`, 'info');

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
   * Best-effort circular dependency detection over calls/imports edges.
   * Finds reciprocal (2-cycle) relationships between distinct nodes, bounded
   * to `limit` results to keep it cheap on a 60k-node graph.
   */
  private detectCircularDeps(limit: number = 200): Array<{ from: string; to: string }> {
    const RELS = ['calls', 'indirect_call', 'imports', 'imports_from'];
    const edgeSet = new Set<string>();
    const nodesInvolved = new Set<string>();
    // Collect directed edges of interest.
    for (const n of this.graph.codeNodes()) {
      const id = String(n.id);
      for (const e of this.graph.outEdges(id, RELS)) {
        edgeSet.add(`${id} ${String(e.target)}`);
        nodesInvolved.add(id);
        nodesInvolved.add(String(e.target));
      }
    }
    const result: Array<{ from: string; to: string }> = [];
    const seenPair = new Set<string>();
    for (const key of edgeSet) {
      const [a, b] = key.split(' ');
      if (a === b) continue;
      const reverse = `${b} ${a}`;
      if (!edgeSet.has(reverse)) continue;
      const pairKey = a < b ? `${a} ${b}` : `${b} ${a}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      const na = this.graph.getNode(a);
      const nb = this.graph.getNode(b);
      result.push({
        from: na ? this.graph.nameOf(na) : a,
        to: nb ? this.graph.nameOf(nb) : b,
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Compute change impact: for each changed file, the names of entities that
   * depend on (call/import/reference) entities defined in that file.
   */
  private computeChangeImpact(changedFiles: string[]): Array<{ changed: string; affected: string[] }> {
    if (!changedFiles || changedFiles.length === 0) return [];
    const DEP_RELS = ['calls', 'indirect_call', 'imports', 'imports_from', 're_exports', 'references', 'uses'];
    const out: Array<{ changed: string; affected: string[] }> = [];

    for (const file of changedFiles.slice(0, 20)) {
      const base = file.toLowerCase();
      const affected = new Set<string>();
      for (const n of this.graph.codeNodes()) {
        if (!(n.source_file || '').toLowerCase().endsWith(base) && !base.endsWith((n.source_file || '').toLowerCase())) {
          if (!(n.source_file || '').toLowerCase().includes(base)) continue;
        }
        // Inbound dependents of this entity.
        for (const e of this.graph.inEdges(String(n.id), DEP_RELS)) {
          const dep = this.graph.getNode(String(e.source));
          if (dep && (dep.source_file || '') !== (n.source_file || '')) {
            affected.add(this.graph.nameOf(dep));
          }
        }
      }
      if (affected.size > 0) {
        out.push({ changed: file, affected: [...affected].slice(0, 25) });
      }
    }
    return out;
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

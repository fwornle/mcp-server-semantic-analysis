/**
 * GraphifyGraph - Static reader for the graphify NetworkX node-link graph.json
 *
 * Replaces the code-graph-rag + Memgraph/Cypher backend. The graphify service
 * maintains a single static `graph.json` (NetworkX node-link JSON) which this
 * class loads lazily and caches by file mtime (the file is tens of MB, so it is
 * only re-parsed when it actually changes on disk).
 *
 * There is NO type/name/qualified_name field on nodes -- entity kind and name
 * are DERIVED from the `label` (see kindOf / nameOf).
 *
 * @module agents/graphify-graph
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';

/** A raw graphify node (NetworkX node-link). */
export interface GraphNode {
  id: string;
  label: string;
  file_type?: 'code' | 'document' | 'rationale' | 'concept' | string;
  source_file?: string;
  source_location?: string;
  type?: string;
  [key: string]: any;
}

/** A raw graphify edge (NetworkX link). */
export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' | string;
  [key: string]: any;
}

export type EntityKind = 'function' | 'class' | 'method' | 'file' | 'variable';

/** Map a graphify edge relation to a CodeRelationship.type value. */
export function mapRelation(relation: string):
  | 'calls' | 'imports' | 'extends' | 'implements' | 'uses' | 'defines' | null {
  switch (relation) {
    case 'calls':
    case 'indirect_call':
      return 'calls';
    case 'imports':
    case 'imports_from':
    case 're_exports':
      return 'imports';
    case 'inherits':
    case 'extends':
      return 'extends';
    case 'implements':
      return 'implements';
    case 'method':
    case 'contains':
    case 'defines':
      return 'defines';
    case 'uses':
    case 'references':
      return 'uses';
    default:
      return null;
  }
}

interface GraphStats {
  totalEntities: number;
  totalRelationships: number;
  functions: number;
  classes: number;
  methods: number;
  modules: number;
  languageDistribution: Record<string, number>;
  entityTypeDistribution: Record<string, number>;
}

export class GraphifyGraph {
  private graphPath: string;
  private loadedMtimeMs = -1;
  private isAvailable = false;

  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private nodeById = new Map<string, GraphNode>();
  private outAdj = new Map<string, GraphEdge[]>();
  private inAdj = new Map<string, GraphEdge[]>();
  private commit: string | null = null;

  constructor(explicitPath?: string) {
    this.graphPath = explicitPath || GraphifyGraph.resolveGraphPath();
  }

  /**
   * Resolve the graph.json path:
   *   GRAPHIFY_OUT/graph.json  (if GRAPHIFY_OUT set)
   *   else ${CODING_REPO|CODING_TOOLS_PATH|CODING_ROOT}/.data/graphify/graphify-out/graph.json
   *   else /coding/.data/graphify/graphify-out/graph.json
   */
  static resolveGraphPath(): string {
    if (process.env.GRAPHIFY_OUT) {
      return path.join(process.env.GRAPHIFY_OUT, 'graph.json');
    }
    const root = process.env.CODING_REPO || process.env.CODING_TOOLS_PATH || process.env.CODING_ROOT;
    if (root) {
      return path.join(root, '.data/graphify/graphify-out/graph.json');
    }
    return '/coding/.data/graphify/graphify-out/graph.json';
  }

  /** Path currently used for the graph (for diagnostics). */
  path(): string {
    return this.graphPath;
  }

  /**
   * Lazily (re)load the graph, cached by file mtime. Missing file => empty graph.
   */
  load(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.graphPath);
    } catch {
      if (this.isAvailable || this.loadedMtimeMs !== -2) {
        log(`[GraphifyGraph] graph.json not found at ${this.graphPath}`, 'warning');
      }
      this.reset();
      this.loadedMtimeMs = -2; // sentinel: "known missing", avoid repeated warnings
      this.isAvailable = false;
      return;
    }

    if (this.isAvailable && stat.mtimeMs === this.loadedMtimeMs) {
      return; // cache hit -- unchanged
    }

    try {
      const raw = fs.readFileSync(this.graphPath, 'utf8');
      const parsed = JSON.parse(raw);
      const nodes: GraphNode[] = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      const edges: GraphEdge[] = Array.isArray(parsed.links)
        ? parsed.links
        : (Array.isArray(parsed.edges) ? parsed.edges : []);

      this.nodes = nodes;
      this.edges = edges;
      this.commit = parsed.built_at_commit || null;

      this.nodeById.clear();
      this.outAdj.clear();
      this.inAdj.clear();
      for (const n of nodes) {
        if (n && n.id !== undefined) this.nodeById.set(String(n.id), n);
      }
      for (const e of edges) {
        if (!e) continue;
        const s = String(e.source);
        const t = String(e.target);
        (this.outAdj.get(s) || this.outAdj.set(s, []).get(s)!).push(e);
        (this.inAdj.get(t) || this.inAdj.set(t, []).get(t)!).push(e);
      }

      this.loadedMtimeMs = stat.mtimeMs;
      this.isAvailable = nodes.length > 0;
      log(`[GraphifyGraph] Loaded ${nodes.length} nodes / ${edges.length} edges from ${this.graphPath} (commit ${this.commit || 'unknown'})`, 'info');
    } catch (err) {
      log(`[GraphifyGraph] Failed to load graph.json: ${err instanceof Error ? err.message : String(err)}`, 'warning');
      this.reset();
      this.isAvailable = false;
    }
  }

  private reset(): void {
    this.nodes = [];
    this.edges = [];
    this.nodeById.clear();
    this.outAdj.clear();
    this.inAdj.clear();
    this.commit = null;
  }

  available(): boolean {
    this.load();
    return this.isAvailable;
  }

  nodeCount(): number {
    this.load();
    return this.codeNodes().length;
  }

  builtAtCommit(): string | null {
    this.load();
    return this.commit;
  }

  /** Derive entity kind from a node's label (no type tag exists in the data). */
  kindOf(node: GraphNode): EntityKind {
    const label = (node.label || '').trim();
    if (label.startsWith('.') && label.endsWith('()')) return 'method';
    if (label.endsWith('()')) return 'function';
    if (/\.[A-Za-z0-9]+$/.test(label) && !label.includes('()')) return 'file';
    if (label.length > 0 && label[0] === label[0].toUpperCase() && /[A-Za-z]/.test(label[0])) return 'class';
    return 'variable';
  }

  /** Derive display name from label: strip trailing () and leading '.'. */
  nameOf(node: GraphNode): string {
    let label = (node.label || '').trim();
    if (label.endsWith('()')) label = label.slice(0, -2);
    if (label.startsWith('.')) label = label.slice(1);
    return label;
  }

  /** Derive language from a node's source_file extension. */
  languageOf(node: GraphNode): string {
    const file = node.source_file || '';
    const ext = path.extname(file).toLowerCase();
    switch (ext) {
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        return 'javascript';
      case '.ts':
      case '.tsx':
        return 'typescript';
      case '.py':
      case '.pyi':
        return 'python';
      case '.go':
        return 'go';
      case '.rs':
        return 'rust';
      case '.java':
        return 'java';
      default:
        return 'unknown';
    }
  }

  /** Line number from source_location ("L<line>"). */
  lineOf(node: GraphNode): number {
    const loc = node.source_location || '';
    return parseInt(loc.replace(/^L/, ''), 10) || 0;
  }

  /** All code-typed nodes. */
  codeNodes(): GraphNode[] {
    this.load();
    return this.nodes.filter(n => n.file_type === 'code');
  }

  /** Unique source_file paths of code nodes. */
  files(): string[] {
    this.load();
    const set = new Set<string>();
    for (const n of this.nodes) {
      if (n.file_type === 'code' && n.source_file) set.add(n.source_file);
    }
    return [...set];
  }

  getNode(id: string): GraphNode | undefined {
    this.load();
    return this.nodeById.get(String(id));
  }

  stats(): GraphStats {
    this.load();
    const code = this.codeNodes();
    const languageDistribution: Record<string, number> = {};
    const entityTypeDistribution: Record<string, number> = {};
    let functions = 0, classes = 0, methods = 0;

    for (const n of code) {
      const lang = this.languageOf(n);
      languageDistribution[lang] = (languageDistribution[lang] || 0) + 1;
      const kind = this.kindOf(n);
      entityTypeDistribution[kind] = (entityTypeDistribution[kind] || 0) + 1;
      if (kind === 'function') functions++;
      else if (kind === 'class') classes++;
      else if (kind === 'method') methods++;
    }

    const modules = this.files().length;

    return {
      totalEntities: code.length,
      totalRelationships: this.edges.length,
      functions,
      classes,
      methods,
      modules,
      languageDistribution,
      entityTypeDistribution,
    };
  }

  /**
   * Find code nodes by (stripped) name, case-insensitive. Exact matches first,
   * then substring matches.
   */
  findByName(name: string): GraphNode[] {
    this.load();
    const needle = (name || '').trim().toLowerCase();
    if (!needle) return [];
    const exact: GraphNode[] = [];
    const partial: GraphNode[] = [];
    for (const n of this.nodes) {
      if (n.file_type !== 'code') continue;
      const nm = this.nameOf(n).toLowerCase();
      if (nm === needle) exact.push(n);
      else if (nm.includes(needle)) partial.push(n);
    }
    return [...exact, ...partial];
  }

  /** Outbound edges from a node, optionally filtered to a set of relations. */
  outEdges(id: string, relations?: string[]): GraphEdge[] {
    this.load();
    const edges = this.outAdj.get(String(id)) || [];
    if (!relations || relations.length === 0) return edges;
    const set = new Set(relations);
    return edges.filter(e => set.has(e.relation));
  }

  /** Inbound edges to a node, optionally filtered to a set of relations. */
  inEdges(id: string, relations?: string[]): GraphEdge[] {
    this.load();
    const edges = this.inAdj.get(String(id)) || [];
    if (!relations || relations.length === 0) return edges;
    const set = new Set(relations);
    return edges.filter(e => set.has(e.relation));
  }

  /**
   * BFS call graph over 'calls'/'indirect_call' edges from all nodes matching
   * `name`. Returns callee names (outbound) and caller names (inbound).
   */
  callGraph(name: string, depth: number = 3): { callers: string[]; callees: string[]; depth: number } {
    this.load();
    const CALL_RELS = ['calls', 'indirect_call'];
    const roots = this.findByName(name);
    const callees = new Set<string>();
    const callers = new Set<string>();

    const bfs = (startIds: string[], direction: 'out' | 'in', collect: Set<string>) => {
      const visited = new Set<string>(startIds);
      let frontier = startIds;
      for (let d = 0; d < depth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          const edges = direction === 'out' ? this.outEdges(id, CALL_RELS) : this.inEdges(id, CALL_RELS);
          for (const e of edges) {
            const otherId = direction === 'out' ? String(e.target) : String(e.source);
            if (visited.has(otherId)) continue;
            visited.add(otherId);
            next.push(otherId);
            const node = this.nodeById.get(otherId);
            if (node) collect.add(this.nameOf(node));
          }
        }
        frontier = next;
      }
    };

    const rootIds = roots.map(n => String(n.id));
    bfs(rootIds, 'out', callees);
    bfs(rootIds, 'in', callers);

    return { callers: [...callers], callees: [...callees], depth };
  }

  /** Top-N code nodes by total (in+out) degree. */
  hotspots(topN: number = 20): Array<{ name: string; type: string; connections: number }> {
    this.load();
    const scored = this.codeNodes().map(n => {
      const id = String(n.id);
      const out = (this.outAdj.get(id) || []).length;
      const inc = (this.inAdj.get(id) || []).length;
      return { name: this.nameOf(n), type: this.kindOf(n), connections: out + inc };
    });
    scored.sort((a, b) => b.connections - a.connections);
    return scored.slice(0, topN);
  }

  /** Inheritance tree via inherits/extends edges, grouped by parent. */
  inheritanceTree(): Array<{ parent: string; children: string[] }> {
    this.load();
    const REL = new Set(['inherits', 'extends']);
    const map = new Map<string, string[]>();
    for (const e of this.edges) {
      if (!REL.has(e.relation)) continue;
      // child inherits/extends parent: source=child, target=parent
      const child = this.nodeById.get(String(e.source));
      const parent = this.nodeById.get(String(e.target));
      if (!child || !parent) continue;
      const p = this.nameOf(parent);
      const c = this.nameOf(child);
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(c);
    }
    return [...map.entries()].map(([parent, children]) => ({ parent, children }));
  }

  /**
   * All edges touching a node, mapped to CodeRelationship-shaped objects
   * ({ type, source, target, weight }). Only mappable relations are included.
   */
  neighborsAsRelationships(id: string): Array<{
    type: 'calls' | 'imports' | 'extends' | 'implements' | 'uses' | 'defines';
    source: string;
    target: string;
    weight?: number;
  }> {
    this.load();
    const sid = String(id);
    const out: Array<{ type: any; source: string; target: string; weight?: number }> = [];
    const push = (e: GraphEdge) => {
      const type = mapRelation(e.relation);
      if (!type) return;
      const src = this.nodeById.get(String(e.source));
      const tgt = this.nodeById.get(String(e.target));
      out.push({
        type,
        source: src ? this.nameOf(src) : String(e.source),
        target: tgt ? this.nameOf(tgt) : String(e.target),
        weight: typeof e.weight === 'number' ? e.weight : undefined,
      });
    };
    for (const e of this.outAdj.get(sid) || []) push(e);
    for (const e of this.inAdj.get(sid) || []) push(e);
    return out;
  }
}

/**
 * Serena Code Analyzer
 *
 * Provides AST-based code analysis using Serena MCP tools.
 * Extracts code references from observations and enriches them with actual code structure.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import { log } from "../logging.js";

export interface CodeReference {
  type: 'file' | 'class' | 'function' | 'method' | 'variable' | 'pattern';
  name: string;
  filePath?: string;
  context?: string;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  location?: {
    file: string;
    line: number;
  };
  children?: SymbolInfo[];
  body?: string;
}

export interface FileStructure {
  path: string;
  symbols: SymbolInfo[];
}

export interface SerenaAnalysisResult {
  symbols: SymbolInfo[];
  fileStructures: FileStructure[];
  codeSnippets: Array<{
    reference: CodeReference;
    code: string;
    context: string;
  }>;
  errors: string[];
}

/**
 * Extracts code references from text content (observations, descriptions, etc.)
 */
export function extractCodeReferences(text: string): CodeReference[] {
  const references: CodeReference[] = [];

  // Pattern for file paths (e.g., src/utils/foo.ts, lib/vkb-server/express-server.js)
  const filePathPattern = /(?:^|\s|['"`])([a-zA-Z0-9_\-./]+\.(?:ts|js|tsx|jsx|py|java|go|rs|cpp|c|h))/g;
  let match: RegExpExecArray | null;
  while ((match = filePathPattern.exec(text)) !== null) {
    references.push({
      type: 'file',
      name: match[1],
      filePath: match[1]
    });
  }

  // Pattern for class names (PascalCase, 2+ uppercase letters)
  const classPattern = /(?:class|interface|type)\s+([A-Z][a-zA-Z0-9]+)/g;
  while ((match = classPattern.exec(text)) !== null) {
    references.push({
      type: 'class',
      name: match[1]
    });
  }

  // Pattern for standalone PascalCase words that look like class names
  const pascalCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
  while ((match = pascalCasePattern.exec(text)) !== null) {
    // Avoid duplicates
    if (!references.some(r => r.name === match![1])) {
      references.push({
        type: 'class',
        name: match[1]
      });
    }
  }

  // Pattern for function/method names (camelCase followed by parentheses)
  const functionPattern = /\b([a-z][a-zA-Z0-9]*)\s*\(/g;
  while ((match = functionPattern.exec(text)) !== null) {
    // Filter common words that aren't functions
    const commonWords = ['if', 'for', 'while', 'switch', 'catch', 'with', 'new', 'return'];
    if (!commonWords.includes(match[1])) {
      references.push({
        type: 'function',
        name: match[1]
      });
    }
  }

  return references;
}

/**
 * SerenaCodeAnalyzer provides code analysis capabilities by calling Serena MCP tools.
 *
 * Note: This class requires a running Serena MCP server. If Serena is not available,
 * methods will return empty results gracefully.
 */
export class SerenaCodeAnalyzer {
  private client: Client | null = null;
  private connected: boolean = false;
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  /**
   * Initialize connection to Serena MCP server
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;

    try {
      // Find the serena command
      const serenaCommand = process.env.SERENA_COMMAND || 'serena';

      log(`Connecting to Serena MCP server...`, 'info');

      const transport = new StdioClientTransport({
        command: serenaCommand,
        args: ['--project', this.projectPath],
        env: process.env as Record<string, string>
      });

      this.client = new Client({
        name: "semantic-analysis-serena-client",
        version: "1.0.0"
      }, {
        capabilities: {}
      });

      await this.client.connect(transport);
      this.connected = true;
      log(`Connected to Serena MCP server`, 'info');
      return true;
    } catch (error) {
      log(`Failed to connect to Serena: ${error}`, 'warning');
      this.connected = false;
      return false;
    }
  }

  /**
   * Disconnect from Serena
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.close();
      } catch (e) {
        // Ignore close errors
      }
      this.connected = false;
      this.client = null;
    }
  }

  /**
   * Call a Serena tool
   */
  private async callTool(name: string, args: Record<string, any>): Promise<any> {
    if (!this.client || !this.connected) {
      const connected = await this.connect();
      if (!connected) {
        return null;
      }
    }

    try {
      const result = await this.client!.callTool({ name, arguments: args });
      return result;
    } catch (error) {
      log(`Serena tool call failed (${name}): ${error}`, 'warning');
      return null;
    }
  }

  /**
   * Get symbols overview for a file
   */
  async getSymbolsOverview(relativePath: string): Promise<SymbolInfo[]> {
    const result = await this.callTool('get_symbols_overview', {
      relative_path: relativePath
    });

    if (!result?.content?.[0]?.text) return [];

    try {
      const data = JSON.parse(result.content[0].text);
      return Array.isArray(data) ? data.map(this.normalizeSymbol) : [];
    } catch {
      return [];
    }
  }

  /**
   * Find a symbol by name pattern
   */
  async findSymbol(
    namePattern: string,
    options: {
      relativePath?: string;
      includeBody?: boolean;
      depth?: number;
    } = {}
  ): Promise<SymbolInfo[]> {
    const result = await this.callTool('find_symbol', {
      name_path_pattern: namePattern,
      relative_path: options.relativePath || '',
      include_body: options.includeBody || false,
      depth: options.depth || 0
    });

    if (!result?.content?.[0]?.text) return [];

    try {
      const data = JSON.parse(result.content[0].text);
      return Array.isArray(data) ? data.map(this.normalizeSymbol) : [];
    } catch {
      return [];
    }
  }

  /**
   * Search for a pattern in files
   */
  async searchForPattern(
    pattern: string,
    options: {
      relativePath?: string;
      contextLinesBefore?: number;
      contextLinesAfter?: number;
    } = {}
  ): Promise<Map<string, string[]>> {
    const result = await this.callTool('search_for_pattern', {
      substring_pattern: pattern,
      relative_path: options.relativePath || '',
      context_lines_before: options.contextLinesBefore || 2,
      context_lines_after: options.contextLinesAfter || 2
    });

    if (!result?.content?.[0]?.text) return new Map();

    try {
      const data = JSON.parse(result.content[0].text);
      return new Map(Object.entries(data));
    } catch {
      return new Map();
    }
  }

  /**
   * Normalize symbol data from Serena response
   */
  private normalizeSymbol(raw: any): SymbolInfo {
    return {
      name: raw.name || raw.name_path?.split('/').pop() || 'unknown',
      kind: raw.kind || 'unknown',
      location: raw.body_location ? {
        file: raw.relative_path || '',
        line: raw.body_location.start_line || 0
      } : undefined,
      children: raw.children?.map((c: any) => ({
        name: c.name || c.name_path?.split('/').pop() || 'unknown',
        kind: c.kind || 'unknown',
        location: c.body_location ? {
          file: raw.relative_path || '',
          line: c.body_location.start_line || 0
        } : undefined
      })),
      body: raw.body
    };
  }

  /**
   * Analyze code references from observations and enrich with actual code structure
   */
  async analyzeCodeReferences(references: CodeReference[]): Promise<SerenaAnalysisResult> {
    const result: SerenaAnalysisResult = {
      symbols: [],
      fileStructures: [],
      codeSnippets: [],
      errors: []
    };

    // Deduplicate references
    const uniqueRefs = this.deduplicateReferences(references);

    for (const ref of uniqueRefs) {
      try {
        switch (ref.type) {
          case 'file':
            if (ref.filePath) {
              const symbols = await this.getSymbolsOverview(ref.filePath);
              if (symbols.length > 0) {
                result.fileStructures.push({
                  path: ref.filePath,
                  symbols
                });
              }
            }
            break;

          case 'class':
          case 'function':
          case 'method':
            const found = await this.findSymbol(ref.name, {
              includeBody: true,
              depth: 1
            });
            if (found.length > 0) {
              result.symbols.push(...found);
              // Add code snippet
              if (found[0].body) {
                result.codeSnippets.push({
                  reference: ref,
                  code: found[0].body,
                  context: `${ref.type} ${ref.name}`
                });
              }
            }
            break;
        }
      } catch (error) {
        result.errors.push(`Failed to analyze ${ref.type} "${ref.name}": ${error}`);
      }
    }

    return result;
  }

  /**
   * Deduplicate references by name and type
   */
  private deduplicateReferences(references: CodeReference[]): CodeReference[] {
    const seen = new Set<string>();
    return references.filter(ref => {
      const key = `${ref.type}:${ref.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Get a concise summary of code structure for documentation
   */
  formatCodeStructureSummary(analysis: SerenaAnalysisResult): string {
    const lines: string[] = [];

    // File structures
    for (const file of analysis.fileStructures) {
      lines.push(`### ${file.path}`);
      for (const symbol of file.symbols) {
        const indent = '  ';
        lines.push(`${indent}- **${symbol.name}** (${symbol.kind})`);
        if (symbol.children) {
          for (const child of symbol.children.slice(0, 5)) { // Limit children
            lines.push(`${indent}  - ${child.name} (${child.kind})`);
          }
          if (symbol.children.length > 5) {
            lines.push(`${indent}  - ... and ${symbol.children.length - 5} more`);
          }
        }
      }
      lines.push('');
    }

    // Standalone symbols (not in file structures)
    const standaloneSymbols = analysis.symbols.filter(s =>
      !analysis.fileStructures.some(f =>
        f.symbols.some(fs => fs.name === s.name)
      )
    );

    if (standaloneSymbols.length > 0) {
      lines.push('### Key Symbols');
      for (const symbol of standaloneSymbols) {
        lines.push(`- **${symbol.name}** (${symbol.kind})${symbol.location ? ` at ${symbol.location.file}:${symbol.location.line}` : ''}`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * Create a SerenaCodeAnalyzer instance for the current project
 */
export function createSerenaAnalyzer(projectPath?: string): SerenaCodeAnalyzer {
  const path = projectPath || process.env.PROJECT_PATH || process.cwd();
  return new SerenaCodeAnalyzer(path);
}

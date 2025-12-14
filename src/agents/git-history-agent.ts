import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { log } from '../logging.js';
import { CheckpointManager } from '../utils/checkpoint-manager.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

export interface GitCommit {
  hash: string;
  author: string;
  date: Date;
  message: string;
  files: GitFileChange[];
  stats: {
    additions: number;
    deletions: number;
    totalChanges: number;
  };
}

export interface GitFileChange {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C';  // Added, Modified, Deleted, Renamed, Copied
  additions: number;
  deletions: number;
  oldPath?: string;  // For renamed files
}

export interface ArchitecturalDecision {
  type: 'structural' | 'pattern' | 'dependency' | 'refactoring';
  description: string;
  files: string[];
  commit: string;
  impact: 'low' | 'medium' | 'high';
}

export interface CodeEvolutionPattern {
  pattern: string;
  occurrences: number;
  files: string[];
  commits: string[];
  trend: 'increasing' | 'decreasing' | 'stable';
}

export interface GitHistoryAnalysisResult {
  checkpointInfo: {
    fromTimestamp: Date | null;
    toTimestamp: Date;
    commitsAnalyzed: number;
  };
  commits: GitCommit[];
  architecturalDecisions: ArchitecturalDecision[];
  codeEvolution: CodeEvolutionPattern[];
  summary: {
    majorChanges: string[];
    activeDevelopmentAreas: string[];
    refactoringPatterns: string[];
    insights: string;
  };
}

export class GitHistoryAgent {
  private repositoryPath: string;
  private team: string;
  private checkpointManager: CheckpointManager;
  private semanticAnalyzer: SemanticAnalyzer;
  private excludePatterns: string[] = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '*.log',
    '*.tmp',
    '.DS_Store'
  ];

  constructor(repositoryPath: string = '.', team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.checkpointManager = new CheckpointManager(repositoryPath);
    this.semanticAnalyzer = new SemanticAnalyzer();
  }

  async analyzeGitHistory(fromTimestampOrParams?: Date | Record<string, any>): Promise<GitHistoryAnalysisResult> {
    // Handle both Date parameter (old API) and parameters object (new coordinator API)
    let fromTimestamp: Date | undefined;
    let checkpointEnabled = true;
    let daysBack: number | undefined;
    let depth: number | undefined;

    if (fromTimestampOrParams instanceof Date) {
      fromTimestamp = fromTimestampOrParams;
    } else if (typeof fromTimestampOrParams === 'object' && fromTimestampOrParams !== null) {
      // Parameters object from coordinator - extract all parameters
      if (fromTimestampOrParams.fromTimestamp) {
        fromTimestamp = new Date(fromTimestampOrParams.fromTimestamp);
      }
      if (fromTimestampOrParams.checkpoint_enabled !== undefined) {
        checkpointEnabled = fromTimestampOrParams.checkpoint_enabled;
      }
      if (fromTimestampOrParams.days_back) {
        daysBack = fromTimestampOrParams.days_back;
      }
      if (fromTimestampOrParams.depth) {
        depth = fromTimestampOrParams.depth;
      }
    }

    log('Starting git history analysis', 'info', {
      repositoryPath: this.repositoryPath,
      fromTimestamp: fromTimestamp?.toISOString() || 'auto',
      checkpointEnabled,
      daysBack,
      depth
    });

    try {
      // Validate git repository
      this.validateGitRepository();

      // Determine effective timestamp based on parameters
      let effectiveFromTimestamp: Date | null = null;
      
      if (fromTimestamp) {
        effectiveFromTimestamp = fromTimestamp;
      } else if (daysBack) {
        // Analyze commits from last N days
        effectiveFromTimestamp = new Date(Date.now() - (daysBack * 24 * 60 * 60 * 1000));
        log(`Analyzing commits from last ${daysBack} days`, 'info', {
          fromDate: effectiveFromTimestamp.toISOString()
        });
      } else if (checkpointEnabled) {
        // Use checkpoint only if explicitly enabled
        const checkpoint = await this.getLastAnalysisCheckpoint();
        effectiveFromTimestamp = checkpoint;
      }
      // If none of the above, analyze all commits (effectiveFromTimestamp = null)

      // Extract commits
      log('Starting commit extraction', 'info', {
        fromTimestamp: effectiveFromTimestamp?.toISOString() || 'repository start',
        repositoryPath: this.repositoryPath
      });
      const { commits, filteredCount } = await this.extractCommits(effectiveFromTimestamp);
      log(`Extracted ${commits.length} commits for analysis (${filteredCount} documentation commits filtered)`, 'info', {
        commitsAnalyzed: commits.length,
        filteredDocCommits: filteredCount,
        timeRange: {
          from: effectiveFromTimestamp?.toISOString() || 'repository start',
          to: new Date().toISOString()
        },
        commitHashes: commits.slice(0, 5).map(c => c.hash.substring(0, 8)),
        totalFiles: commits.reduce((sum, c) => sum + c.files.length, 0),
        totalChanges: commits.reduce((sum, c) => sum + c.stats.totalChanges, 0)
      });

      // Analyze architectural decisions
      const architecturalDecisions = this.identifyArchitecturalDecisions(commits);

      // Extract code evolution patterns
      const codeEvolution = this.extractCodeEvolution(commits);

      // Generate summary
      const summary = this.generateSummary(commits, architecturalDecisions, codeEvolution);

      const result: GitHistoryAnalysisResult = {
        checkpointInfo: {
          fromTimestamp: effectiveFromTimestamp,
          toTimestamp: new Date(),
          commitsAnalyzed: commits.length
        },
        commits,
        architecturalDecisions,
        codeEvolution,
        summary
      };

      // Note: Checkpoint is now updated by CoordinatorAgent when entire workflow completes successfully
      // await this.saveAnalysisCheckpoint(new Date());

      log('Git history analysis completed', 'info', {
        commitsAnalyzed: commits.length,
        architecturalDecisions: architecturalDecisions.length,
        patterns: codeEvolution.length
      });

      return result;

    } catch (error) {
      log('Git history analysis failed', 'error', error);
      throw error;
    }
  }

  private validateGitRepository(): void {
    const gitDir = path.join(this.repositoryPath, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`Not a git repository: ${this.repositoryPath}`);
    }
  }

  private async getLastAnalysisCheckpoint(): Promise<Date | null> {
    // Use CheckpointManager instead of writing directly to git-tracked JSON
    return this.checkpointManager.getLastGitAnalysis();
  }

  private async saveAnalysisCheckpoint(timestamp: Date): Promise<void> {
    // Use CheckpointManager instead of writing directly to git-tracked JSON
    this.checkpointManager.setLastGitAnalysis(timestamp);
  }

  private async extractCommits(fromTimestamp: Date | null): Promise<{ commits: GitCommit[], filteredCount: number }> {
    try {
      // Build git log command
      let gitCommand = 'git log --pretty=format:"%H|%an|%ad|%s" --date=iso --numstat';
      
      if (fromTimestamp) {
        const since = fromTimestamp.toISOString().split('T')[0];
        gitCommand += ` --since="${since}"`;
      }

      // Execute git command
      const output = execSync(gitCommand, { 
        cwd: this.repositoryPath, 
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
      });

      return this.parseGitLogOutput(output);

    } catch (error) {
      log('Failed to extract git commits', 'error', error);
      throw new Error(`Git command failed: ${error}`);
    }
  }

  private parseGitLogOutput(output: string): { commits: GitCommit[], filteredCount: number } {
    const commits: GitCommit[] = [];
    const sections = output.split('\n\n').filter(section => section.trim());
    let filteredCount = 0;

    for (const section of sections) {
      const lines = section.split('\n');
      if (lines.length < 1) continue;

      // Parse commit header
      const headerParts = lines[0].split('|');
      if (headerParts.length < 4) continue;

      const [hash, author, dateStr, message] = headerParts;
      const date = new Date(dateStr);

      // Skip documentation-only commits for semantic analysis
      if (this.isDocumentationOnlyCommit(message)) {
        log(`Skipping documentation commit: ${hash.substring(0, 8)} - ${message}`, 'debug');
        filteredCount++;
        continue;
      }

      // Parse file changes
      const files: GitFileChange[] = [];
      let totalAdditions = 0;
      let totalDeletions = 0;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Parse numstat format: additions deletions filename
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
          const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
          const filePath = parts[2];

          // Skip excluded files
          if (this.shouldExcludeFile(filePath)) continue;

          // Determine file status (simplified)
          let status: GitFileChange['status'] = 'M';
          if (additions > 0 && deletions === 0) status = 'A';
          else if (additions === 0 && deletions > 0) status = 'D';

          files.push({
            path: filePath,
            status,
            additions,
            deletions
          });

          totalAdditions += additions;
          totalDeletions += deletions;
        }
      }

      commits.push({
        hash: hash.substring(0, 8),
        author,
        date,
        message,
        files,
        stats: {
          additions: totalAdditions,
          deletions: totalDeletions,
          totalChanges: totalAdditions + totalDeletions
        }
      });
    }

    return { commits, filteredCount };
  }

  private shouldExcludeFile(filePath: string): boolean {
    return this.excludePatterns.some(pattern => {
      // Handle glob patterns like *.log
      if (pattern.startsWith('*.')) {
        const extension = pattern.substring(1); // Remove the *
        return filePath.endsWith(extension);
      }
      // Handle regular includes
      return filePath.includes(pattern);
    });
  }

  private isDocumentationOnlyCommit(message: string): boolean {
    const lowerMessage = message.toLowerCase().trim();
    
    // Check for explicit documentation commit patterns
    const docPatterns = [
      /^docs?:/,                           // docs: prefix
      /^doc:/,                             // doc: prefix  
      /^documentation:/,                   // documentation: prefix
      /^update.*session.*logs?$/,          // update session logs
      /^session.*logs?.*updated?$/,        // session logs updated
      /^add.*session.*logs?$/,             // add session logs
      /^.*session.*history$/,              // session history
      /^update.*documentation$/,           // update documentation
      /^updated?.*documentation$/,         // updated documentation  
      /^add.*\.md$/,                       // add *.md
      /^update.*\.md$/,                    // update *.md
      /^updated?.*\.md$/,                  // updated *.md
      /^readme.*update/,                   // readme update
      /^update.*readme/,                   // update readme
      /^comment/,                          // comment
      /^fix.*typo/,                        // fix typo
      /^typo.*fix/,                        // typo fix
      /^correct.*documentation$/,          // correct documentation
      /^improve.*documentation$/,          // improve documentation
      /^clarify.*documentation$/,          // clarify documentation
      /^.*\.specstory.*$/,                 // .specstory related
      /^.*puml.*diagram.*$/,               // puml diagram
      /^.*diagram.*fix.*$/,                // diagram fix
    ];

    // Check if message matches any documentation pattern
    if (docPatterns.some(pattern => pattern.test(lowerMessage))) {
      return true;
    }

    // Check for common documentation keywords (must be the primary focus)
    const docKeywords = ['session logs', 'documentation', 'readme', 'comment', 'typo', 'diagram'];
    const hasDocKeyword = docKeywords.some(keyword => lowerMessage.includes(keyword));
    
    // If it contains doc keywords and is short/simple, likely pure documentation
    if (hasDocKeyword && lowerMessage.length < 60) {
      return true;
    }

    return false;
  }

  private identifyArchitecturalDecisions(commits: GitCommit[]): ArchitecturalDecision[] {
    const decisions: ArchitecturalDecision[] = [];

    for (const commit of commits) {
      // Analyze commit message for architectural keywords
      const message = commit.message.toLowerCase();
      const files = commit.files.map(f => f.path);

      // Structural changes
      if (this.isStructuralChange(message, files, commit.stats)) {
        decisions.push({
          type: 'structural',
          description: `Structural changes: ${commit.message}`,
          files,
          commit: commit.hash,
          impact: this.calculateImpact(commit.stats, files.length)
        });
      }

      // Pattern introductions
      if (this.isPatternIntroduction(message, files)) {
        decisions.push({
          type: 'pattern',
          description: `Pattern implementation: ${commit.message}`,
          files,
          commit: commit.hash,
          impact: 'medium'
        });
      }

      // Refactoring
      if (this.isRefactoring(message, commit.stats)) {
        decisions.push({
          type: 'refactoring',
          description: `Refactoring: ${commit.message}`,
          files,
          commit: commit.hash,
          impact: this.calculateImpact(commit.stats, files.length)
        });
      }

      // Dependency changes
      if (this.isDependencyChange(files)) {
        decisions.push({
          type: 'dependency',
          description: `Dependency update: ${commit.message}`,
          files,
          commit: commit.hash,
          impact: 'medium'
        });
      }
    }

    return decisions;
  }

  private isStructuralChange(message: string, files: string[], stats: GitCommit['stats']): boolean {
    const structuralKeywords = ['restructure', 'reorganize', 'move', 'rename', 'refactor'];
    const hasKeyword = structuralKeywords.some(keyword => message.includes(keyword));
    const hasSignificantChanges = stats.totalChanges > 200 || files.length > 10;
    
    return hasKeyword || hasSignificantChanges;
  }

  private isPatternIntroduction(message: string, files: string[]): boolean {
    const patternKeywords = ['pattern', 'architecture', 'design', 'implement', 'add', 'introduce'];
    const hasPatternKeyword = patternKeywords.some(keyword => message.includes(keyword));
    const hasNewFiles = files.some(f => f.endsWith('.ts') || f.endsWith('.js'));
    
    return hasPatternKeyword && hasNewFiles;
  }

  private isRefactoring(message: string, stats: GitCommit['stats']): boolean {
    const refactorKeywords = ['refactor', 'cleanup', 'improve', 'optimize', 'simplify'];
    const hasRefactorKeyword = refactorKeywords.some(keyword => message.includes(keyword));
    const hasBalancedChanges = stats.additions > 0 && stats.deletions > 0;
    
    return hasRefactorKeyword || hasBalancedChanges;
  }

  private isDependencyChange(files: string[]): boolean {
    const depFiles = ['package.json', 'package-lock.json', 'yarn.lock', 'requirements.txt', 'Cargo.toml'];
    return files.some(file => {
      const fileName = typeof file === 'string' ? file : String(file);
      return depFiles.includes(path.basename(fileName));
    });
  }

  private calculateImpact(stats: GitCommit['stats'], fileCount: number): 'low' | 'medium' | 'high' {
    if (stats.totalChanges > 500 || fileCount > 20) return 'high';
    if (stats.totalChanges > 100 || fileCount > 5) return 'medium';
    return 'low';
  }

  private async extractCodeEvolutionWithLLM(commits: GitCommit[]): Promise<CodeEvolutionPattern[]> {
    if (commits.length === 0) {
      return [];
    }

    try {
      // Prepare commit summary for LLM analysis
      const commitSummary = commits.slice(0, 50).map(c => ({
        hash: c.hash,
        message: c.message,
        files: c.files.map(f => f.path).slice(0, 5),
        changes: c.stats.totalChanges,
      }));

      const prompt = `Analyze these git commits and identify development patterns and evolution trends.

Commits (most recent first):
${commitSummary.map(c => `- [${c.hash}] ${c.message} (${c.changes} changes, files: ${c.files.join(', ')})`).join('\n')}

Identify:
1. Development patterns (e.g., "MCP agent development", "UI component work", "API refactoring")
2. Evolution trends (increasing, decreasing, stable activity in each area)
3. Key architectural changes

Respond with JSON:
{
  "patterns": [
    {
      "pattern": "<descriptive pattern name>",
      "occurrences": <count>,
      "trend": "increasing|decreasing|stable",
      "relatedCommits": ["<hash1>", "<hash2>"],
      "description": "<brief explanation>"
    }
  ]
}`;

      const response = await this.semanticAnalyzer.analyzeContent(prompt, {
        maxTokens: 1500,
        temperature: 0.5,
      });

      // Parse LLM response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        return (parsed.patterns || []).map((p: any) => ({
          pattern: p.pattern,
          occurrences: p.occurrences || 1,
          files: [],  // Files extracted separately
          commits: p.relatedCommits || [],
          trend: p.trend || 'stable',
        }));
      }
    } catch (error) {
      log('LLM code evolution analysis failed', 'warning', error);
    }

    return [];
  }

  private extractCodeEvolution(commits: GitCommit[]): CodeEvolutionPattern[] {
    // Synchronous fallback - returns empty as per original design
    // Use extractCodeEvolutionWithLLM for LLM-powered analysis
    return [];
  }

  private extractMessagePatterns(message: string, commit: GitCommit, patterns: Map<string, any>): void {
    // Common development patterns
    const patternMatches = [
      { pattern: 'bug fixes', regex: /fix|bug|error|issue/ },
      { pattern: 'feature additions', regex: /add|feature|implement|new/ },
      { pattern: 'refactoring', regex: /refactor|cleanup|improve|optimize/ },
      { pattern: 'testing', regex: /test|spec|unittest/ },
      { pattern: 'documentation', regex: /doc|readme|comment/ },
      { pattern: 'configuration', regex: /config|setting|setup/ },
      { pattern: 'dependency updates', regex: /update|upgrade|bump|dep/ }
    ];

    for (const { pattern, regex } of patternMatches) {
      if (regex.test(message)) {
        this.updatePattern(patterns, pattern, commit);
      }
    }
  }

  private extractFilePatterns(files: string[], commit: GitCommit, patterns: Map<string, any>): void {
    // File-based patterns
    const filePatterns = [
      { pattern: 'TypeScript development', test: (f: string) => f.endsWith('.ts') },
      { pattern: 'JavaScript development', test: (f: string) => f.endsWith('.js') },
      { pattern: 'Configuration changes', test: (f: string) => f.includes('config') || f.endsWith('.json') || f.endsWith('.yml') },
      { pattern: 'Test file changes', test: (f: string) => f.includes('test') || f.includes('spec') },
      { pattern: 'Documentation updates', test: (f: string) => f.endsWith('.md') || f.includes('doc') },
      { pattern: 'Agent development', test: (f: string) => f.includes('agent') },
      { pattern: 'Tool development', test: (f: string) => f.includes('tool') }
    ];

    for (const { pattern, test } of filePatterns) {
      if (files.some(file => {
        const fileName = typeof file === 'string' ? file : String(file);
        return test(fileName);
      })) {
        this.updatePattern(patterns, pattern, commit);
      }
    }
  }

  private updatePattern(patterns: Map<string, any>, patternName: string, commit: GitCommit): void {
    if (!patterns.has(patternName)) {
      patterns.set(patternName, {
        occurrences: 0,
        files: new Set<string>(),
        commits: new Set<string>(),
        timestamps: []
      });
    }

    const data = patterns.get(patternName)!;
    data.occurrences++;
    data.commits.add(commit.hash);
    data.timestamps.push(commit.date);
    
    commit.files.forEach(file => data.files.add(file.path));
  }

  private calculateTrend(timestamps: Date[]): 'increasing' | 'decreasing' | 'stable' {
    if (timestamps.length < 3) return 'stable';

    timestamps.sort((a, b) => a.getTime() - b.getTime());
    
    const midpoint = Math.floor(timestamps.length / 2);
    const firstHalf = timestamps.slice(0, midpoint);
    const secondHalf = timestamps.slice(midpoint);

    const firstHalfCount = firstHalf.length;
    const secondHalfCount = secondHalf.length;

    if (secondHalfCount > firstHalfCount * 1.5) return 'increasing';
    if (firstHalfCount > secondHalfCount * 1.5) return 'decreasing';
    return 'stable';
  }

  private generateSummary(
    commits: GitCommit[], 
    decisions: ArchitecturalDecision[], 
    evolution: CodeEvolutionPattern[]
  ): GitHistoryAnalysisResult['summary'] {
    // Major changes (high impact decisions)
    const majorChanges = decisions
      .filter(d => d.impact === 'high')
      .map(d => d.description)
      .slice(0, 5);

    // Active development areas (most changed files)
    const fileChangeCounts = new Map<string, number>();
    commits.forEach(commit => {
      commit.files.forEach(file => {
        fileChangeCounts.set(file.path, (fileChangeCounts.get(file.path) || 0) + 1);
      });
    });

    const activeDevelopmentAreas = Array.from(fileChangeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, count]) => `${path} (${count} changes)`);

    // Refactoring patterns
    const refactoringPatterns = decisions
      .filter(d => d.type === 'refactoring')
      .map(d => d.description)
      .slice(0, 3);

    // Generate insights
    const totalChanges = commits.reduce((sum, c) => sum + c.stats.totalChanges, 0);
    const avgChangesPerCommit = commits.length > 0 ? Math.round(totalChanges / commits.length) : 0;
    const topPattern = evolution.length > 0 ? evolution[0].pattern : 'No patterns detected';

    const insights = `Analyzed ${commits.length} commits with ${totalChanges} total changes (avg ${avgChangesPerCommit} per commit). ` +
      `Identified ${decisions.length} architectural decisions and ${evolution.length} code evolution patterns. ` +
      `Primary development pattern: ${topPattern}. ` +
      `${majorChanges.length} major changes detected requiring attention.`;

    return {
      majorChanges,
      activeDevelopmentAreas,
      refactoringPatterns,
      insights
    };
  }

  /**
   * Analyze git history with LLM-enhanced pattern extraction
   * This provides richer semantic analysis than the standard method
   */
  async analyzeGitHistoryWithLLM(fromTimestampOrParams?: Date | Record<string, any>): Promise<GitHistoryAnalysisResult & { llmPatterns?: CodeEvolutionPattern[] }> {
    // First do standard analysis
    const result = await this.analyzeGitHistory(fromTimestampOrParams);

    // Then enhance with LLM-based code evolution analysis
    if (result.commits.length > 0) {
      try {
        const llmPatterns = await this.extractCodeEvolutionWithLLM(result.commits);

        // Merge LLM patterns into result
        if (llmPatterns.length > 0) {
          result.codeEvolution = llmPatterns;

          // Update summary with LLM insights
          result.summary.insights = `${result.summary.insights} LLM identified ${llmPatterns.length} development patterns: ${llmPatterns.map(p => p.pattern).join(', ')}.`;
        }

        return {
          ...result,
          llmPatterns,
        };
      } catch (error) {
        log('LLM analysis failed, returning standard results', 'warning', error);
      }
    }

    return result;
  }

  /**
   * Analyze commit messages semantically using LLM
   */
  async analyzeCommitMessagesSemantically(commits: GitCommit[]): Promise<{
    themes: string[];
    keyDecisions: string[];
    technicalDebt: string[];
    summary: string;
  }> {
    if (commits.length === 0) {
      return { themes: [], keyDecisions: [], technicalDebt: [], summary: 'No commits to analyze' };
    }

    try {
      const messages = commits.slice(0, 30).map(c => `[${c.hash}] ${c.message}`).join('\n');

      const prompt = `Analyze these git commit messages and extract:
1. Main development themes/areas of focus
2. Key architectural or design decisions
3. Signs of technical debt or areas needing attention
4. Overall summary of development direction

Commit messages:
${messages}

Respond with JSON:
{
  "themes": ["<theme1>", "<theme2>"],
  "keyDecisions": ["<decision1>", "<decision2>"],
  "technicalDebt": ["<debt indicator1>", "<debt indicator2>"],
  "summary": "<2-3 sentence summary of development activity>"
}`;

      const response = await this.semanticAnalyzer.analyzeContent(prompt, {
        maxTokens: 800,
        temperature: 0.5,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      log('Semantic commit analysis failed', 'warning', error);
    }

    return {
      themes: [],
      keyDecisions: [],
      technicalDebt: [],
      summary: 'Analysis failed',
    };
  }
}
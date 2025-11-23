import * as fs from 'fs';
import * as path from 'path';
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { log } from '../logging.js';

export interface CodeFile {
  path: string;
  content: string;
  language: string;
  size: number;
  complexity: number;
  patterns: string[];
  functions: string[];
  imports: string[];
  changeType: 'added' | 'modified' | 'deleted';
}

export interface SemanticAnalysisResult {
  codeAnalysis: {
    filesAnalyzed: number;
    totalLinesOfCode: number;
    languageDistribution: Record<string, number>;
    complexityMetrics: {
      averageComplexity: number;
      highComplexityFiles: string[];
      totalFunctions: number;
    };
    architecturalPatterns: {
      name: string;
      files: string[];
      description: string;
      confidence: number;
    }[];
    codeQuality: {
      score: number;
      issues: string[];
      recommendations: string[];
    };
  };
  crossAnalysisInsights: {
    gitCodeCorrelation: string[];
    vibeCodeCorrelation: string[];
    conversationImplementationMap: {
      problem: string;
      implementation: string[];
      files: string[];
    }[];
  };
  semanticInsights: {
    keyPatterns: string[];
    architecturalDecisions: string[];
    technicalDebt: string[];
    innovativeApproaches: string[];
    learnings: string[];
  };
  // FIXED: Added insights field for QA compatibility
  insights?: string;
  confidence: number;
  processingTime: number;
}

export class SemanticAnalysisAgent {
  private groqClient: Groq | null = null;
  private geminiClient: GoogleGenerativeAI | null = null;
  private anthropicClient: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;
  private repositoryPath: string;

  constructor(repositoryPath: string = '.') {
    this.repositoryPath = repositoryPath;
    this.initializeClients();
  }

  async analyzeGitAndVibeData(
    gitAnalysis: any,
    vibeAnalysis: any,
    options: {
      maxFiles?: number;
      includePatterns?: string[];
      excludePatterns?: string[];
      analysisDepth?: 'surface' | 'deep' | 'comprehensive';
    } = {}
  ): Promise<SemanticAnalysisResult> {
    const startTime = Date.now();

    // ULTRA DEBUG: Write input data to trace file
    const fs = await import('fs');
    const traceFile = `${process.cwd()}/logs/semantic-analysis-trace-${Date.now()}.json`;
    await fs.promises.writeFile(traceFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      phase: 'INPUT_DATA',
      gitAnalysis: {
        hasData: !!gitAnalysis,
        commitsCount: gitAnalysis?.commits?.length || 0,
        firstCommit: gitAnalysis?.commits?.[0] || null,
        lastCommit: gitAnalysis?.commits?.[gitAnalysis?.commits?.length - 1] || null,
        fullData: gitAnalysis
      },
      vibeAnalysis: {
        hasData: !!vibeAnalysis,
        sessionsCount: vibeAnalysis?.sessions?.length || 0,
        firstSession: vibeAnalysis?.sessions?.[0] || null,
        fullData: vibeAnalysis
      },
      options
    }, null, 2));
    log(`🔍 TRACE: Input data written to ${traceFile}`, 'info');

    log('Starting comprehensive semantic analysis', 'info', {
      gitCommits: gitAnalysis?.commits?.length || 0,
      vibeSessions: vibeAnalysis?.sessions?.length || 0,
      analysisDepth: options.analysisDepth || 'deep',
      traceFile
    });

    try {
      // Extract files to analyze from git history
      const filesToAnalyze = this.extractFilesFromGitHistory(gitAnalysis, options);
      log(`Identified ${filesToAnalyze.length} files for analysis`, 'info');

      // Perform deep code analysis
      const codeFiles = await this.analyzeCodeFiles(filesToAnalyze, options);
      
      // Generate code analysis metrics
      const codeAnalysis = this.generateCodeAnalysisMetrics(codeFiles);

      // Perform cross-analysis correlation
      const crossAnalysisInsights = await this.performCrossAnalysis(
        codeFiles, gitAnalysis, vibeAnalysis
      );

      // Generate semantic insights using LLM
      const semanticInsights = await this.generateSemanticInsights(
        codeFiles, gitAnalysis, vibeAnalysis, crossAnalysisInsights
      );

      const processingTime = Date.now() - startTime;
      
      // FIXED: Create aggregated insights for QA validation
      const aggregatedInsights = [
        ...semanticInsights.keyPatterns,
        ...semanticInsights.learnings,
        ...semanticInsights.architecturalDecisions
      ].filter(Boolean).join('. ');
      
      const result: SemanticAnalysisResult = {
        codeAnalysis,
        crossAnalysisInsights,
        semanticInsights,
        insights: aggregatedInsights || 'No specific insights extracted from semantic analysis.',
        confidence: this.calculateConfidence(codeFiles, crossAnalysisInsights),
        processingTime
      };

      log('Semantic analysis completed', 'info', {
        filesAnalyzed: codeFiles.length,
        patternsFound: semanticInsights.keyPatterns.length,
        confidence: result.confidence,
        processingTime,
        hasInsightsField: 'insights' in result,
        insightsLength: result.insights ? result.insights.length : 0
      });

      return result;

    } catch (error) {
      log('Semantic analysis failed', 'error', error);
      throw error;
    }
  }

  private initializeClients(): void {
    // Initialize Groq client (primary/default - cheap, fast)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== "your-groq-api-key") {
      this.groqClient = new Groq({
        apiKey: groqKey,
      });
      log("Groq client initialized for semantic analysis (default provider)", "info");
    }

    // Initialize Gemini client (fallback #1 - cheap, good quality)
    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey && googleKey !== "your-google-api-key") {
      this.geminiClient = new GoogleGenerativeAI(googleKey);
      log("Gemini client initialized for semantic analysis (fallback #1)", "info");
    }

    // Initialize Anthropic client (fallback #2)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey !== "your-anthropic-api-key") {
      this.anthropicClient = new Anthropic({
        apiKey: anthropicKey,
      });
      log("Anthropic client initialized for semantic analysis (fallback #2)", "info");
    }

    // Initialize OpenAI client (fallback #3)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && openaiKey !== "your-openai-api-key") {
      this.openaiClient = new OpenAI({
        apiKey: openaiKey,
      });
      log("OpenAI client initialized for semantic analysis (fallback #3)", "info");
    }

    if (!this.groqClient && !this.geminiClient && !this.anthropicClient && !this.openaiClient) {
      log("No LLM clients available for semantic analysis", "warning");
    }
  }

  private extractFilesFromGitHistory(
    gitAnalysis: any,
    options: { maxFiles?: number; includePatterns?: string[]; excludePatterns?: string[] }
  ): string[] {
    const {
      maxFiles = 50,
      includePatterns = ['**/*.ts', '**/*.js', '**/*.json', '**/*.md'],
      excludePatterns = ['node_modules/**', 'dist/**', '.git/**', '**/*.log']
    } = options;

    const filesSet = new Set<string>();

    // DEBUG: Log what we received
    log('File extraction - received gitAnalysis', 'info', {
      hasGitAnalysis: !!gitAnalysis,
      gitAnalysisType: typeof gitAnalysis,
      hasCommits: !!gitAnalysis?.commits,
      commitsLength: gitAnalysis?.commits?.length || 0,
      gitAnalysisKeys: gitAnalysis ? Object.keys(gitAnalysis) : [],
      firstCommitSample: gitAnalysis?.commits?.[0] ? {
        hash: gitAnalysis.commits[0].hash,
        hasFiles: !!gitAnalysis.commits[0].files,
        filesCount: gitAnalysis.commits[0].files?.length || 0
      } : null
    });

    // Extract files from commits
    if (gitAnalysis?.commits) {
      gitAnalysis.commits.forEach((commit: any) => {
        if (commit.files) {
          commit.files.forEach((file: any) => {
            if (this.shouldIncludeFile(file.path, includePatterns, excludePatterns)) {
              filesSet.add(file.path);
            }
          });
        }
      });
    }

    // Extract files from architectural decisions
    if (gitAnalysis?.architecturalDecisions) {
      gitAnalysis.architecturalDecisions.forEach((decision: any) => {
        if (decision.files) {
          decision.files.forEach((filePath: string) => {
            if (this.shouldIncludeFile(filePath, includePatterns, excludePatterns)) {
              filesSet.add(filePath);
            }
          });
        }
      });
    }

    // Convert to array and limit
    const files = Array.from(filesSet).slice(0, maxFiles);
    
    log(`File extraction: ${filesSet.size} unique files found, analyzing top ${files.length}`, 'info');
    return files;
  }

  private shouldIncludeFile(
    filePath: string, 
    includePatterns: string[], 
    excludePatterns: string[]
  ): boolean {
    // Check exclude patterns first
    for (const pattern of excludePatterns) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(filePath)) {
        return false;
      }
    }

    // Check include patterns
    for (const pattern of includePatterns) {
      const regex = new RegExp(pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
      if (regex.test(filePath)) {
        return true;
      }
    }

    return false;
  }

  private async analyzeCodeFiles(
    filePaths: string[], 
    options: { analysisDepth?: string }
  ): Promise<CodeFile[]> {
    const codeFiles: CodeFile[] = [];
    const depth = options.analysisDepth || 'deep';

    for (const filePath of filePaths) {
      try {
        const fullPath = path.join(this.repositoryPath, filePath);
        
        if (!fs.existsSync(fullPath)) {
          log(`File not found: ${filePath}`, 'warning');
          continue;
        }

        const stats = fs.statSync(fullPath);
        if (stats.size > 1024 * 1024) { // Skip files > 1MB
          log(`Skipping large file: ${filePath} (${stats.size} bytes)`, 'info');
          continue;
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        const language = this.detectLanguage(filePath);

        const codeFile: CodeFile = {
          path: filePath,
          content,
          language,
          size: content.length,
          complexity: this.calculateComplexity(content, language),
          patterns: this.detectCodePatterns(content, language),
          functions: this.extractFunctions(content, language),
          imports: this.extractImports(content, language),
          changeType: 'modified' // Default, could be enhanced with git diff analysis
        };

        codeFiles.push(codeFile);

      } catch (error) {
        log(`Error analyzing file ${filePath}`, 'warning', error);
      }
    }

    log(`Code analysis completed: ${codeFiles.length} files processed`, 'info');
    return codeFiles;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const languageMap: Record<string, string> = {
      '.ts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.json': 'json',
      '.md': 'markdown',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.go': 'go',
      '.rs': 'rust',
      '.php': 'php',
      '.rb': 'ruby',
      '.yml': 'yaml',
      '.yaml': 'yaml'
    };

    return languageMap[ext] || 'text';
  }

  private calculateComplexity(content: string, language: string): number {
    // Simple cyclomatic complexity estimation
    let complexity = 1; // Base complexity

    // Count decision points based on language
    const patterns = {
      typescript: /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g,
      javascript: /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g,
      python: /\b(if|elif|else|while|for|try|except|and|or)\b/g,
      java: /\b(if|else|while|for|switch|case|catch|&&|\|\||\?)\b/g
    };

    const pattern = patterns[language as keyof typeof patterns] || patterns.javascript;
    const matches = content.match(pattern);
    
    if (matches) {
      complexity += matches.length;
    }

    return Math.min(complexity, 50); // Cap at 50 for sanity
  }

  private detectCodePatterns(content: string, language: string): string[] {
    const patterns: string[] = [];

    // Common architectural patterns
    const patternMatches = [
      { pattern: 'singleton', regex: /class\s+\w+\s*{[\s\S]*?private\s+static\s+instance/i },
      { pattern: 'factory', regex: /create\w*\s*\([^)]*\)[\s\S]*?return\s+new/i },
      { pattern: 'observer', regex: /(addEventListener|subscribe|notify|Observer)/i },
      { pattern: 'promise', regex: /(Promise|async|await)/i },
      { pattern: 'decorator', regex: /@\w+/g },
      { pattern: 'middleware', regex: /(middleware|next\(\)|express)/i },
      { pattern: 'repository', regex: /Repository|DataAccess/i },
      { pattern: 'service', regex: /Service|Provider/i },
      { pattern: 'component', regex: /(React\.|Component|useState|useEffect)/i },
      { pattern: 'api', regex: /(fetch|axios|http|api)/i }
    ];

    for (const { pattern, regex } of patternMatches) {
      if (regex.test(content)) {
        patterns.push(pattern);
      }
    }

    return patterns;
  }

  private extractFunctions(content: string, language: string): string[] {
    const functions: string[] = [];

    // Language-specific function extraction
    let functionRegex: RegExp;

    switch (language) {
      case 'typescript':
      case 'javascript':
        functionRegex = /(?:function\s+(\w+)|(\w+)\s*\([^)]*\)\s*(?:=>|\{)|(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?:=>|\{))/g;
        break;
      case 'python':
        functionRegex = /def\s+(\w+)\s*\(/g;
        break;
      case 'java':
        functionRegex = /(?:public|private|protected)?\s*(?:static)?\s*\w+\s+(\w+)\s*\(/g;
        break;
      default:
        functionRegex = /function\s+(\w+)|(\w+)\s*\(/g;
    }

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      const functionName = match[1] || match[2] || match[3];
      if (functionName && functionName !== 'if' && functionName !== 'for') {
        functions.push(functionName);
      }
    }

    return [...new Set(functions)]; // Remove duplicates
  }

  private extractImports(content: string, language: string): string[] {
    const imports: string[] = [];

    // Language-specific import extraction
    let importRegex: RegExp;

    switch (language) {
      case 'typescript':
      case 'javascript':
        importRegex = /import\s+(?:.*?\s+from\s+)?['"`]([^'"`]+)['"`]/g;
        break;
      case 'python':
        importRegex = /(?:from\s+(\S+)\s+import|import\s+([^;\n]+))/g;
        break;
      case 'java':
        importRegex = /import\s+([^;\n]+);/g;
        break;
      default:
        importRegex = /import\s+['"`]([^'"`]+)['"`]/g;
    }

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2];
      if (importPath) {
        imports.push(importPath.trim());
      }
    }

    return [...new Set(imports)]; // Remove duplicates
  }

  private generateCodeAnalysisMetrics(codeFiles: CodeFile[]): SemanticAnalysisResult['codeAnalysis'] {
    const totalLinesOfCode = codeFiles.reduce((sum, file) => 
      sum + file.content.split('\n').length, 0
    );

    // Language distribution
    const languageDistribution: Record<string, number> = {};
    codeFiles.forEach(file => {
      languageDistribution[file.language] = (languageDistribution[file.language] || 0) + 1;
    });

    // Complexity metrics
    const complexities = codeFiles.map(f => f.complexity);
    const averageComplexity = complexities.reduce((a, b) => a + b, 0) / complexities.length;
    const highComplexityFiles = codeFiles
      .filter(f => f.complexity > 10)
      .map(f => f.path);
    const totalFunctions = codeFiles.reduce((sum, f) => sum + f.functions.length, 0);

    // Architectural patterns
    const patternCounts = new Map<string, { files: string[]; count: number }>();
    codeFiles.forEach(file => {
      file.patterns.forEach(pattern => {
        if (!patternCounts.has(pattern)) {
          patternCounts.set(pattern, { files: [], count: 0 });
        }
        const data = patternCounts.get(pattern)!;
        data.files.push(file.path);
        data.count++;
      });
    });

    const architecturalPatterns = Array.from(patternCounts.entries())
      .map(([name, data]) => ({
        name,
        files: data.files,
        description: this.getPatternDescription(name),
        confidence: Math.min(data.count / codeFiles.length, 1)
      }))
      .sort((a, b) => b.confidence - a.confidence);

    // Code quality assessment
    const codeQuality = this.assessCodeQuality(codeFiles);

    return {
      filesAnalyzed: codeFiles.length,
      totalLinesOfCode,
      languageDistribution,
      complexityMetrics: {
        averageComplexity: Math.round(averageComplexity * 100) / 100,
        highComplexityFiles,
        totalFunctions
      },
      architecturalPatterns,
      codeQuality
    };
  }

  private getPatternDescription(pattern: string): string {
    const descriptions: Record<string, string> = {
      singleton: 'Ensures a class has only one instance',
      factory: 'Creates objects without specifying exact classes',
      observer: 'Defines one-to-many dependency between objects',
      promise: 'Handles asynchronous operations',
      decorator: 'Adds behavior to objects dynamically',
      middleware: 'Processes requests in a pipeline',
      repository: 'Encapsulates data access logic',
      service: 'Contains business logic',
      component: 'Reusable UI building blocks',
      api: 'Handles external communication'
    };

    return descriptions[pattern] || `${pattern} pattern implementation`;
  }

  private assessCodeQuality(codeFiles: CodeFile[]): { score: number; issues: string[]; recommendations: string[] } {
    const issues: string[] = [];
    const recommendations: string[] = [];
    let score = 100;

    // Check for high complexity
    const highComplexityCount = codeFiles.filter(f => f.complexity > 15).length;
    if (highComplexityCount > 0) {
      issues.push(`${highComplexityCount} files have high complexity (>15)`);
      recommendations.push('Consider refactoring complex functions into smaller ones');
      score -= highComplexityCount * 5;
    }

    // Check for large files
    const largeFiles = codeFiles.filter(f => f.content.split('\n').length > 500);
    if (largeFiles.length > 0) {
      issues.push(`${largeFiles.length} files exceed 500 lines`);
      recommendations.push('Break down large files into smaller, focused modules');
      score -= largeFiles.length * 3;
    }

    // Check for missing patterns
    const hasServices = codeFiles.some(f => f.patterns.includes('service'));
    const hasComponents = codeFiles.some(f => f.patterns.includes('component'));
    if (!hasServices && codeFiles.length > 5) {
      recommendations.push('Consider implementing service layer for better separation of concerns');
    }

    return {
      score: Math.max(0, score),
      issues,
      recommendations
    };
  }

  private async performCrossAnalysis(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any
  ): Promise<SemanticAnalysisResult['crossAnalysisInsights']> {
    const gitCodeCorrelation: string[] = [];
    const vibeCodeCorrelation: string[] = [];
    const conversationImplementationMap: any[] = [];

    // Correlate git patterns with code patterns
    if (gitAnalysis?.codeEvolution) {
      gitAnalysis.codeEvolution.forEach((pattern: any) => {
        const relatedFiles = codeFiles.filter(file => 
          pattern.files.some((gitFile: any) => {
            const fileName = typeof gitFile === 'string' ? gitFile : String(gitFile);
            return file.path.includes(fileName);
          })
        );
        if (relatedFiles.length > 0) {
          const codePatterns = [...new Set(relatedFiles.flatMap(f => f.patterns))];
          gitCodeCorrelation.push(
            `Git pattern "${pattern.pattern}" correlates with code patterns: ${codePatterns.join(', ')}`
          );
        }
      });
    }

    // Correlate conversation themes with code implementation
    if (vibeAnalysis?.problemSolutionPairs) {
      vibeAnalysis.problemSolutionPairs.forEach((pair: any) => {
        const implementationFiles = codeFiles.filter(file =>
          pair.solution.technologies.some((tech: string) => 
            file.language.toLowerCase().includes(tech.toLowerCase()) ||
            file.content.toLowerCase().includes(tech.toLowerCase())
          )
        );

        if (implementationFiles.length > 0) {
          conversationImplementationMap.push({
            problem: pair.problem.description.substring(0, 100) + '...',
            implementation: implementationFiles.flatMap(f => f.patterns),
            files: implementationFiles.map(f => f.path)
          });

          vibeCodeCorrelation.push(
            `Problem "${pair.problem.description.substring(0, 50)}..." implemented using ${implementationFiles.map(f => f.language).join(', ')}`
          );
        }
      });
    }

    return {
      gitCodeCorrelation,
      vibeCodeCorrelation,
      conversationImplementationMap
    };
  }

  private async generateSemanticInsights(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any
  ): Promise<SemanticAnalysisResult['semanticInsights']> {
    // Generate insights using LLM if available
    if (this.groqClient || this.geminiClient || this.anthropicClient || this.openaiClient) {
      return await this.generateLLMInsights(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis);
    }

    // Fallback to rule-based insights
    return this.generateRuleBasedInsights(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis);
  }

  private async generateLLMInsights(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any
  ): Promise<SemanticAnalysisResult['semanticInsights']> {
    try {
      const analysisPrompt = this.buildAnalysisPrompt(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis);

      // ULTRA DEBUG: Write LLM prompt to trace file
      const fs2 = await import('fs');
      const promptTraceFile = `${process.cwd()}/logs/semantic-analysis-prompt-${Date.now()}.txt`;
      await fs2.promises.writeFile(promptTraceFile, `=== LLM PROMPT ===\n${analysisPrompt}\n\n=== END PROMPT ===\n`);
      log(`🔍 TRACE: LLM prompt written to ${promptTraceFile}`, 'info');

      let response: string;

      // Try Groq first (default, cheap, low-latency)
      if (this.groqClient) {
        try {
          response = await this.callGroqWithRetry(analysisPrompt);
        } catch (groqError: any) {
          log('Groq call failed, trying Gemini fallback', 'warning', {
            error: groqError.message,
            status: groqError.status
          });

          // If Groq fails due to rate limiting, try Gemini
          if (this.geminiClient && this.isRateLimitError(groqError)) {
            try {
              response = await this.callGeminiWithRetry(analysisPrompt);
            } catch (geminiError: any) {
              log('Gemini fallback failed, trying Anthropic', 'warning', {
                error: geminiError.message,
                status: geminiError.status
              });

              // If Gemini also fails, try Anthropic
              if (this.anthropicClient && this.isRateLimitError(geminiError)) {
                try {
                  response = await this.callAnthropicWithRetry(analysisPrompt);
                } catch (anthropicError: any) {
                  log('Anthropic fallback failed, trying OpenAI', 'warning', {
                    error: anthropicError.message,
                    status: anthropicError.status
                  });

                  // If Anthropic fails, try OpenAI as last resort
                  if (this.openaiClient && this.isRateLimitError(anthropicError)) {
                    response = await this.callOpenAIWithRetry(analysisPrompt);
                  } else {
                    throw anthropicError;
                  }
                }
              } else {
                throw geminiError;
              }
            }
          } else {
            throw groqError;
          }
        }
      } else if (this.geminiClient) {
        // Fallback #1: Gemini if Groq not available
        try {
          response = await this.callGeminiWithRetry(analysisPrompt);
        } catch (geminiError: any) {
          log('Gemini call failed, trying Anthropic fallback', 'warning', {
            error: geminiError.message,
            status: geminiError.status
          });

          // If Gemini fails due to rate limiting, try Anthropic
          if (this.anthropicClient && this.isRateLimitError(geminiError)) {
            try {
              response = await this.callAnthropicWithRetry(analysisPrompt);
            } catch (anthropicError: any) {
              log('Anthropic fallback failed, trying OpenAI', 'warning', {
                error: anthropicError.message,
                status: anthropicError.status
              });

              // If Anthropic fails, try OpenAI as last resort
              if (this.openaiClient && this.isRateLimitError(anthropicError)) {
                response = await this.callOpenAIWithRetry(analysisPrompt);
              } else {
                throw anthropicError;
              }
            }
          } else {
            throw geminiError;
          }
        }
      } else if (this.anthropicClient) {
        // Fallback #2: Anthropic if neither Groq nor Gemini available
        try {
          response = await this.callAnthropicWithRetry(analysisPrompt);
        } catch (anthropicError: any) {
          log('Anthropic call failed, trying OpenAI fallback', 'warning', {
            error: anthropicError.message,
            status: anthropicError.status
          });

          // If Anthropic fails due to rate limiting, try OpenAI
          if (this.openaiClient && this.isRateLimitError(anthropicError)) {
            response = await this.callOpenAIWithRetry(analysisPrompt);
          } else {
            throw anthropicError;
          }
        }
      } else if (this.openaiClient) {
        // Fallback #3: OpenAI if no other providers available
        response = await this.callOpenAIWithRetry(analysisPrompt);
      } else {
        throw new Error('No LLM client available');
      }

      // ULTRA DEBUG: Write LLM response to trace file
      const fs3 = await import('fs');
      const responseTraceFile = `${process.cwd()}/logs/semantic-analysis-response-${Date.now()}.txt`;
      await fs3.promises.writeFile(responseTraceFile, `=== LLM RESPONSE ===\n${response}\n\n=== END RESPONSE ===\n`);
      log(`🔍 TRACE: LLM response written to ${responseTraceFile}`, 'info');

      const parsedInsights = this.parseInsightsFromLLMResponse(response);

      // ULTRA DEBUG: Write parsed insights to trace file
      const parsedTraceFile = `${process.cwd()}/logs/semantic-analysis-parsed-${Date.now()}.json`;
      await fs3.promises.writeFile(parsedTraceFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        phase: 'PARSED_INSIGHTS',
        parsedInsights
      }, null, 2));
      log(`🔍 TRACE: Parsed insights written to ${parsedTraceFile}`, 'info');

      return parsedInsights;

    } catch (error) {
      log('LLM insight generation failed, falling back to rule-based', 'warning', error);
      return this.generateRuleBasedInsights(codeFiles, gitAnalysis, vibeAnalysis, crossAnalysis);
    }
  }

  /**
   * Check if an error is a rate limit error
   */
  private isRateLimitError(error: any): boolean {
    return error.status === 429 || 
           error.message?.includes('rate_limit') ||
           error.message?.includes('Rate limit') ||
           error.error?.error?.type === 'rate_limit_error';
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Call Groq with exponential backoff retry
   * Using llama-3.3-70b-versatile: cheap, low-latency model
   */
  private async callGroqWithRetry(prompt: string, maxRetries: number = 3): Promise<string> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        log(`Calling Groq API (attempt ${attempt + 1}/${maxRetries})`, 'info');

        const result = await this.groqClient!.chat.completions.create({
          model: "llama-3.3-70b-versatile", // Cheap, low-latency model
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7
        });

        const response = result.choices[0]?.message?.content || '';
        log(`Groq API call successful`, 'info', {
          responseLength: response.length,
          attempt: attempt + 1,
          model: "llama-3.3-70b-versatile"
        });

        return response;

      } catch (error: any) {
        lastError = error;

        if (this.isRateLimitError(error)) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
          log(`Rate limited, retrying in ${backoffMs}ms`, 'warning', {
            attempt: attempt + 1,
            maxRetries,
            status: error.status,
            backoffMs
          });

          if (attempt < maxRetries - 1) {
            await this.sleep(backoffMs);
            continue;
          }
        }

        // For non-rate-limit errors, don't retry
        log(`Groq API call failed`, 'error', {
          attempt: attempt + 1,
          error: error.message,
          status: error.status
        });
        break;
      }
    }

    throw lastError;
  }

  /**
   * Call Gemini with exponential backoff retry
   * Using gemini-2.0-flash-exp: cheap, fast model with good quality
   */
  private async callGeminiWithRetry(prompt: string, maxRetries: number = 3): Promise<string> {
    let lastError: any;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        log(`Calling Gemini API (attempt ${attempt + 1}/${maxRetries})`, 'info');

        const model = this.geminiClient!.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent(prompt);
        const response = result.response.text();

        log(`Gemini API call successful`, 'info', {
          responseLength: response.length,
          attempt: attempt + 1,
          model: "gemini-2.0-flash-exp"
        });

        return response;

      } catch (error: any) {
        lastError = error;

        if (this.isRateLimitError(error)) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
          log(`Rate limited, retrying in ${backoffMs}ms`, 'warning', {
            attempt: attempt + 1,
            maxRetries,
            status: error.status,
            backoffMs
          });

          if (attempt < maxRetries - 1) {
            await this.sleep(backoffMs);
            continue;
          }
        }

        // For non-rate-limit errors, don't retry
        log(`Gemini API call failed`, 'error', {
          attempt: attempt + 1,
          error: error.message,
          status: error.status
        });
        break;
      }
    }

    throw lastError;
  }

  /**
   * Call Anthropic with exponential backoff retry
   */
  private async callAnthropicWithRetry(prompt: string, maxRetries: number = 3): Promise<string> {
    let lastError: any;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        log(`Calling Anthropic API (attempt ${attempt + 1}/${maxRetries})`, 'info');
        
        const result = await this.anthropicClient!.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }]
        });
        
        const response = result.content[0].type === 'text' ? result.content[0].text : '';
        log(`Anthropic API call successful`, 'info', {
          responseLength: response.length,
          attempt: attempt + 1
        });
        
        return response;
        
      } catch (error: any) {
        lastError = error;
        
        if (this.isRateLimitError(error)) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
          log(`Rate limited, retrying in ${backoffMs}ms`, 'warning', {
            attempt: attempt + 1,
            maxRetries,
            status: error.status,
            backoffMs
          });
          
          if (attempt < maxRetries - 1) {
            await this.sleep(backoffMs);
            continue;
          }
        }
        
        // For non-rate-limit errors, don't retry
        log(`Anthropic API call failed`, 'error', {
          attempt: attempt + 1,
          error: error.message,
          status: error.status
        });
        break;
      }
    }
    
    throw lastError;
  }

  /**
   * Call OpenAI with exponential backoff retry
   */
  private async callOpenAIWithRetry(prompt: string, maxRetries: number = 3): Promise<string> {
    let lastError: any;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        log(`Calling OpenAI API (attempt ${attempt + 1}/${maxRetries})`, 'info');
        
        const result = await this.openaiClient!.chat.completions.create({
          model: "gpt-4",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }]
        });
        
        const response = result.choices[0]?.message?.content || '';
        log(`OpenAI API call successful`, 'info', {
          responseLength: response.length,
          attempt: attempt + 1
        });
        
        return response;
        
      } catch (error: any) {
        lastError = error;
        
        if (this.isRateLimitError(error)) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 seconds
          log(`Rate limited, retrying in ${backoffMs}ms`, 'warning', {
            attempt: attempt + 1,
            maxRetries,
            status: error.status,
            backoffMs
          });
          
          if (attempt < maxRetries - 1) {
            await this.sleep(backoffMs);
            continue;
          }
        }
        
        // For non-rate-limit errors, don't retry
        log(`OpenAI API call failed`, 'error', {
          attempt: attempt + 1,
          error: error.message,
          status: error.status
        });
        break;
      }
    }
    
    throw lastError;
  }

  private buildAnalysisPrompt(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any
  ): string {
    const codeOverview = codeFiles.slice(0, 5).map(file => ({
      path: file.path,
      language: file.language,
      patterns: file.patterns,
      functions: file.functions.slice(0, 5),
      complexity: file.complexity
    }));

    return `Analyze this software development session and provide key insights:

CODE ANALYSIS:
${JSON.stringify(codeOverview, null, 2)}

GIT CHANGES:
- Commits: ${gitAnalysis?.commits?.length || 0}
- Architectural decisions: ${gitAnalysis?.architecturalDecisions?.length || 0}
- Code evolution patterns: ${gitAnalysis?.codeEvolution?.map((p: any) => p.pattern).join(', ') || 'None'}

CONVERSATION ANALYSIS:
- Sessions: ${vibeAnalysis?.sessions?.length || 0}
- Problem-solution pairs: ${vibeAnalysis?.problemSolutionPairs?.length || 0}
- Main themes: ${vibeAnalysis?.patterns?.developmentThemes?.map((t: any) => t.theme).join(', ') || 'None'}

CROSS-ANALYSIS:
${crossAnalysis.gitCodeCorrelation.join('\n')}
${crossAnalysis.vibeCodeCorrelation.join('\n')}

Please provide insights in JSON format:
{
  "keyPatterns": ["pattern1", "pattern2", ...],
  "architecturalDecisions": ["decision1", "decision2", ...],
  "technicalDebt": ["debt1", "debt2", ...],
  "innovativeApproaches": ["approach1", "approach2", ...],
  "learnings": ["learning1", "learning2", ...]
}

Focus on:
1. What architectural patterns are being used effectively
2. What technical decisions show good engineering practices
3. What areas need improvement or refactoring
4. What innovative approaches were taken
5. What can be learned for future development`;
  }

  private parseInsightsFromLLMResponse(response: string): SemanticAnalysisResult['semanticInsights'] {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          keyPatterns: parsed.keyPatterns || [],
          architecturalDecisions: parsed.architecturalDecisions || [],
          technicalDebt: parsed.technicalDebt || [],
          innovativeApproaches: parsed.innovativeApproaches || [],
          learnings: parsed.learnings || []
        };
      }
    } catch (error) {
      log('Failed to parse LLM response as JSON', 'warning', error);
    }

    // Fallback: extract insights from text
    return {
      keyPatterns: this.extractPatternFromText(response, 'pattern'),
      architecturalDecisions: this.extractPatternFromText(response, 'decision|architecture'),
      technicalDebt: this.extractPatternFromText(response, 'debt|improvement|refactor'),
      innovativeApproaches: this.extractPatternFromText(response, 'innovative|creative|novel'),
      learnings: this.extractPatternFromText(response, 'learning|insight|lesson')
    };
  }

  private extractPatternFromText(text: string, pattern: string): string[] {
    const regex = new RegExp(`(?:${pattern})[^.]*`, 'gi');
    const matches = text.match(regex);
    return matches ? matches.slice(0, 5) : [];
  }

  private generateRuleBasedInsights(
    codeFiles: CodeFile[],
    gitAnalysis: any,
    vibeAnalysis: any,
    crossAnalysis: any
  ): SemanticAnalysisResult['semanticInsights'] {
    // Extract insights from git analysis if available
    const keyPatterns = codeFiles?.length > 0 
      ? [...new Set(codeFiles.flatMap(f => f.patterns))]
      : (gitAnalysis?.patterns || []).map((p: any) => p.name || p);
    
    const architecturalDecisions = gitAnalysis?.architecturalDecisions
      ?.map((d: any) => `${d.type || 'Decision'}: ${d.description || d}`)
      .slice(0, 5) || [];

    // Get technical debt from code analysis or git commits
    const technicalDebt = codeFiles?.length > 0
      ? codeFiles.filter(f => f.complexity > 15)
          .map(f => `High complexity in ${f.path} (${f.complexity})`).slice(0, 3)
      : gitAnalysis?.commits?.filter((c: any) => c.message?.includes('fix') || c.message?.includes('refactor'))
          .map((c: any) => `Technical fix: ${c.message?.substring(0, 50)}...`).slice(0, 3) || [];

    // Generate insights from conversation analysis
    const innovativeApproaches = crossAnalysis?.conversationImplementationMap?.length > 0
      ? crossAnalysis.conversationImplementationMap
          .map((m: any) => `Implemented ${m.implementation?.join(', ') || 'solution'} for: ${m.problem}`)
          .slice(0, 3)
      : vibeAnalysis?.sessions?.map((s: any) => `Development insight from session: ${s.content?.substring(0, 50)}...`).slice(0, 3) || [];

    // Generate meaningful learnings even without code files
    const learnings = [];
    
    if (codeFiles?.length > 0) {
      learnings.push(`Primary development language: ${this.getMostUsedLanguage(codeFiles)}`);
      learnings.push(`Code quality score: ${this.calculateOverallQuality(codeFiles)}%`);
    } else {
      learnings.push(`Analysis based on git history with ${gitAnalysis?.commits?.length || 0} commits`);
      learnings.push(`Repository contains ${gitAnalysis?.totalChanges || 0} total changes`);
    }
    
    learnings.push(`Most common pattern: ${keyPatterns[0] || 'Pattern analysis in progress'}`);
    
    if (gitAnalysis?.summary) {
      learnings.push(`Repository focus: ${gitAnalysis.summary}`);
    }

    log('Generated rule-based insights', 'info', {
      keyPatterns: keyPatterns.length,
      architecturalDecisions: architecturalDecisions.length,
      technicalDebt: technicalDebt.length,
      innovativeApproaches: innovativeApproaches.length,
      learnings: learnings.length
    });

    return {
      keyPatterns,
      architecturalDecisions,
      technicalDebt,
      innovativeApproaches,
      learnings
    };
  }

  private getMostUsedLanguage(codeFiles: CodeFile[]): string {
    const counts = new Map<string, number>();
    codeFiles.forEach(file => {
      counts.set(file.language, (counts.get(file.language) || 0) + 1);
    });
    
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
  }

  private calculateOverallQuality(codeFiles: CodeFile[]): number {
    const avgComplexity = codeFiles.reduce((sum, f) => sum + f.complexity, 0) / codeFiles.length;
    const complexityScore = Math.max(0, 100 - (avgComplexity - 5) * 10);
    
    const patternScore = Math.min(100, codeFiles.flatMap(f => f.patterns).length * 10);
    
    return Math.round((complexityScore + patternScore) / 2);
  }

  private calculateConfidence(codeFiles: CodeFile[], crossAnalysis: any): number {
    let confidence = 0.5; // Base confidence
    
    // More files analyzed = higher confidence
    confidence += Math.min(0.3, codeFiles.length * 0.02);
    
    // Cross-analysis correlations increase confidence
    confidence += Math.min(0.2, crossAnalysis.gitCodeCorrelation.length * 0.05);
    confidence += Math.min(0.2, crossAnalysis.vibeCodeCorrelation.length * 0.05);
    
    return Math.min(1, confidence);
  }

  // Public wrapper methods for coordinator and tools compatibility
  async analyzeSemantics(parameters: any): Promise<SemanticAnalysisResult> {
    const { _context, incremental, git_analysis_results, vibe_analysis_results } = parameters;
    
    // Support both direct parameters and context-based parameters
    const gitAnalysis = git_analysis_results || _context?.previousResults?.analyze_git_history;
    const vibeAnalysis = vibe_analysis_results || _context?.previousResults?.analyze_vibe_history;
    
    return await this.analyzeGitAndVibeData(gitAnalysis, vibeAnalysis, {
      analysisDepth: incremental ? 'surface' : 'deep'
    });
  }

  async analyzeContent(content: string, context?: any, analysisType?: string): Promise<any> {
    // FIXED: Use the actual content parameter instead of mock data
    // This method is called by insight-generation-agent with real LLM prompts

    log('analyzeContent called with real prompt', 'info', {
      contentLength: content.length,
      hasContext: !!context,
      analysisType: analysisType || 'general',
      contextType: typeof context
    });

    try {
      // Build the full prompt with context if provided
      let fullPrompt = content;
      if (context && typeof context === 'object' && context.context) {
        fullPrompt = `${context.context}\n\n${content}`;
      }

      // Call LLM with the actual prompt using the same logic as generateLLMInsights
      let response: string;

      if (this.groqClient) {
        try {
          response = await this.callGroqWithRetry(fullPrompt);
        } catch (groqError: any) {
          if (this.geminiClient && this.isRateLimitError(groqError)) {
            response = await this.callGeminiWithRetry(fullPrompt);
          } else if (this.anthropicClient) {
            response = await this.callAnthropicWithRetry(fullPrompt);
          } else {
            throw groqError;
          }
        }
      } else if (this.geminiClient) {
        response = await this.callGeminiWithRetry(fullPrompt);
      } else if (this.anthropicClient) {
        response = await this.callAnthropicWithRetry(fullPrompt);
      } else if (this.openaiClient) {
        response = await this.callOpenAIWithRetry(fullPrompt);
      } else {
        throw new Error('No LLM client available');
      }

      log('LLM analysis completed successfully', 'info', {
        responseLength: response.length
      });

      return {
        insights: response,
        provider: this.groqClient ? 'groq' : this.geminiClient ? 'gemini' : this.anthropicClient ? 'anthropic' : 'openai',
        confidence: 0.8
      };

    } catch (error) {
      log('analyzeContent failed', 'error', error);
      throw error;
    }
  }

  async analyzeCode(code: string, language?: string, filePath?: string): Promise<any> {
    // Legacy compatibility method  
    const mockFile: CodeFile = {
      path: filePath || 'temp.js',
      content: code,
      language: language || 'javascript',
      size: code.length,
      complexity: this.calculateComplexity(code, language || 'javascript'),
      patterns: this.detectCodePatterns(code, language || 'javascript'),
      functions: this.extractFunctions(code, language || 'javascript'),
      imports: this.extractImports(code, language || 'javascript'),
      changeType: 'modified'
    };

    const codeAnalysis = this.generateCodeAnalysisMetrics([mockFile]);
    
    return {
      analysis: `Code analysis completed for ${language || 'javascript'} file`,
      findings: codeAnalysis.codeQuality.issues,
      recommendations: codeAnalysis.codeQuality.recommendations,
      complexity: mockFile.complexity,
      patterns: mockFile.patterns
    };
  }

  async analyzeRepository(repositoryPath: string, options: any = {}): Promise<any> {
    // Legacy compatibility method
    const mockGitAnalysis = { commits: [], codeEvolution: [] };  
    const mockVibeAnalysis = { sessions: [], problemSolutionPairs: [] };
    
    const result = await this.analyzeGitAndVibeData(mockGitAnalysis, mockVibeAnalysis, {
      maxFiles: options.maxFiles,
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
      analysisDepth: 'comprehensive'
    });
    
    return {
      structure: `Repository contains ${result.codeAnalysis.filesAnalyzed} files in ${Object.keys(result.codeAnalysis.languageDistribution).length} languages`,
      patterns: result.semanticInsights.keyPatterns,
      insights: result.semanticInsights.learnings.join('. '),
      complexity: result.codeAnalysis.complexityMetrics.averageComplexity
    };
  }

  async extractPatterns(source: string, patternTypes?: string[], context?: string): Promise<string[]> {
    // Legacy compatibility - this should be private but tools.ts expects it public
    const patterns = this.detectCodePatterns(source, 'generic');
    return patterns.filter((pattern: any) => 
      !patternTypes || patternTypes.some(type => 
        pattern.toLowerCase().includes(type.toLowerCase())
      )
    );
  }
}
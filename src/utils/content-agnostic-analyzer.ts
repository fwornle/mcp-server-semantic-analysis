import { log } from '../logging.js';
import { RepositoryContext, RepositoryContextManager } from './repository-context.js';

export interface VibeGitCorrelation {
  timeframe: {
    start: Date;
    end: Date;
  };
  vibeDiscussion: {
    topic: string;
    problems: string[];
    decisions: string[];
    participants: string[];
  };
  gitChanges: {
    commits: string[];
    files: string[];
    changeTypes: string[];
  };
  correlation: {
    strength: 'strong' | 'moderate' | 'weak';
    confidence: number;
    description: string;
  };
}

export interface ContentAgnosticInsight {
  problem: {
    description: string;
    context: string;
    symptoms: string[];
    impact: string;
  };
  solution: {
    approach: string;
    implementation: string[];
    technologies: string[];
    tradeoffs: string[];
  };
  outcome: {
    metrics: string[];
    improvements: string[];
    newChallenges: string[];
  };
  significance: number;
  confidence: number;
}

export class ContentAgnosticAnalyzer {
  private repositoryContext: RepositoryContext | null = null;
  private contextManager: RepositoryContextManager;

  constructor(repositoryPath: string = '.') {
    this.contextManager = new RepositoryContextManager(repositoryPath);
  }

  private limitAnalysisScope(analysis: any): any {
    if (!analysis) return analysis;
    
    // Limit git commits to most recent 50 for performance
    if (analysis.commits && analysis.commits.length > 50) {
      return {
        ...analysis,
        commits: analysis.commits.slice(0, 50)
      };
    }
    
    // Limit vibe sessions to most recent 20 for performance
    if (analysis.sessions && analysis.sessions.length > 20) {
      return {
        ...analysis,
        sessions: analysis.sessions.slice(0, 20)
      };
    }
    
    return analysis;
  }

  async analyzeWithContext(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): Promise<ContentAgnosticInsight> {
    log('ContentAgnosticAnalyzer.analyzeWithContext called', 'debug');
    const startTime = Date.now();
    
    // PERFORMANCE OPTIMIZATION: Limit analysis scope for large repositories
    const limitedGitAnalysis = this.limitAnalysisScope(gitAnalysis);
    const limitedVibeAnalysis = this.limitAnalysisScope(vibeAnalysis);
    
    console.log('🔍 DEBUG: Analysis scope limited - commits:', limitedGitAnalysis?.commits?.length, 'vibe sessions:', limitedVibeAnalysis?.sessions?.length);
    
    // Get cached repository context (fast operation)
    this.repositoryContext = await this.contextManager.getRepositoryContext();
    
    log(`Repository context loaded in ${Date.now() - startTime}ms`, 'debug');
    
    try {
      // PERFORMANCE: Use time-bounded analysis operations
      const correlations = this.correlateVibeWithGitOptimized(limitedVibeAnalysis, limitedGitAnalysis);
      log(`Correlations generated in ${Date.now() - startTime}ms`, 'debug');
      
      // Extract real problem (fast operation)
      const mainProblem = await this.extractRealProblemOptimized(correlations, semanticAnalysis, gitAnalysis);
      log(`Problem extracted in ${Date.now() - startTime}ms`, 'debug');
      
      // Extract actual solution (fast operation)
      const actualSolution = this.extractActualSolutionOptimized(correlations, limitedGitAnalysis, semanticAnalysis);
      log(`Solution extracted in ${Date.now() - startTime}ms`, 'debug');
      
      // Measure real outcomes (fast operation)
      const measuredOutcome = this.measureOutcomesOptimized(limitedGitAnalysis, semanticAnalysis);
      log(`Outcomes measured in ${Date.now() - startTime}ms`, 'debug');
      
      // Calculate metrics (fast operations)
      const significance = this.calculateRealSignificance(mainProblem, actualSolution, measuredOutcome);
      const confidence = this.calculateConfidence(correlations, limitedGitAnalysis, semanticAnalysis);
      
      console.log('✨ Content-agnostic analysis completed in', Date.now() - startTime, 'ms');

      return {
        problem: mainProblem,
        solution: actualSolution,
        outcome: measuredOutcome,
        significance,
        confidence
      };
    } catch (error) {
      console.error('❌ ContentAgnosticAnalyzer error after', Date.now() - startTime, 'ms:', error);
      throw error;
    }
  }

  private correlateVibeWithGit(vibeAnalysis: any, gitAnalysis: any): VibeGitCorrelation[] {
    const correlations: VibeGitCorrelation[] = [];
    
    if (!vibeAnalysis?.sessions || !gitAnalysis?.commits) {
      return correlations;
    }

    // Group commits and vibe sessions by time periods
    const timeWindows = this.createTimeWindows(vibeAnalysis.sessions, gitAnalysis.commits);
    
    for (const window of timeWindows) {
      const correlation = this.analyzeTimeWindow(window);
      if (correlation.correlation.strength !== 'weak') {
        correlations.push(correlation);
      }
    }

    // Sort by correlation strength and confidence
    return correlations.sort((a, b) => {
      if (a.correlation.strength !== b.correlation.strength) {
        const strengthOrder = { strong: 3, moderate: 2, weak: 1 };
        return strengthOrder[b.correlation.strength] - strengthOrder[a.correlation.strength];
      }
      return b.correlation.confidence - a.correlation.confidence;
    });
  }

  private correlateVibeWithGitOptimized(vibeAnalysis: any, gitAnalysis: any): VibeGitCorrelation[] {
    // PERFORMANCE: Simplified correlation analysis for large datasets
    const correlations: VibeGitCorrelation[] = [];
    
    if (!vibeAnalysis?.sessions || !gitAnalysis?.commits) {
      return correlations;
    }

    // OPTIMIZATION: Simple time-based correlation instead of complex window analysis
    const sessions = vibeAnalysis.sessions.slice(0, 10); // Limit to 10 most recent sessions
    const commits = gitAnalysis.commits.slice(0, 20); // Limit to 20 most recent commits
    
    for (const session of sessions) {
      const sessionTime = new Date(session.timestamp || session.date || Date.now());
      
      // Find commits within 24 hours of this session
      const relatedCommits = commits.filter((commit: any) => {
        const commitTime = new Date(commit.timestamp || commit.date || Date.now());
        const timeDiff = Math.abs(sessionTime.getTime() - commitTime.getTime());
        return timeDiff < (24 * 60 * 60 * 1000); // 24 hours
      });
      
      if (relatedCommits.length > 0) {
        correlations.push({
          vibeDiscussion: {
            topic: session.topic || session.summary || 'Development discussion',
            problems: session.problems || [],
            decisions: session.decisions || session.solutions || [],
            participants: session.participants || ['Developer']
          },
          gitChanges: relatedCommits,
          correlation: {
            strength: relatedCommits.length > 3 ? 'strong' : relatedCommits.length > 1 ? 'moderate' : 'weak' as 'strong' | 'moderate' | 'weak',
            confidence: Math.min(0.9, relatedCommits.length * 0.2),
            description: `${relatedCommits.length} commits correlated with discussion`
          },
          timeframe: {
            start: new Date(sessionTime),
            end: new Date(sessionTime)
          }
        });
      }
    }

    return correlations.slice(0, 5); // Return top 5 correlations for performance
  }

  private async extractRealProblemOptimized(correlations: VibeGitCorrelation[], semanticAnalysis: any, gitAnalysis?: any): Promise<ContentAgnosticInsight['problem']> {
    // PERFORMANCE: Simplified problem extraction
    if (correlations.length === 0) {
      return this.extractProblemFromCodeOptimized(semanticAnalysis, gitAnalysis);
    }

    const strongestCorrelation = correlations[0];
    const vibeProblems = strongestCorrelation.vibeDiscussion.problems || [];
    
    let description = 'Repository-specific development challenge identified through code analysis';
    let context = this.getBusinessContext(strongestCorrelation.vibeDiscussion.topic);
    let symptoms: string[] = [];
    let impact = 'Moderate impact on development workflow';

    if (vibeProblems.length > 0) {
      description = vibeProblems[0] || description;
      symptoms = vibeProblems.slice(0, 3); // Limit symptoms for performance
      impact = `Addressing challenges in ${strongestCorrelation.vibeDiscussion.topic}`;
    }

    return { description, context, symptoms, impact };
  }

  private extractTechnologiesFromGit(gitAnalysis: any): string[] {
    // Extract technologies from file extensions and commit messages
    const technologies = new Set<string>();
    
    if (gitAnalysis?.commits) {
      gitAnalysis.commits.slice(0, 10).forEach((commit: any) => {
        if (commit.files) {
          commit.files.forEach((file: any) => {
            const fileName = typeof file === 'string' ? file : file.path;
            if (fileName?.includes('.ts') || fileName?.includes('.js')) technologies.add('TypeScript/JavaScript');
            if (fileName?.includes('.py')) technologies.add('Python');
            if (fileName?.includes('.json')) technologies.add('JSON Config');
            if (fileName?.includes('.md')) technologies.add('Documentation');
          });
        }
      });
    }
    
    return Array.from(technologies).slice(0, 5);
  }

  private extractPatternsFromSemantic(semanticAnalysis: any): string[] {
    // Extract architectural patterns from semantic analysis
    const patterns: string[] = [];
    
    if (semanticAnalysis?.codeAnalysis?.architecturalPatterns) {
      semanticAnalysis.codeAnalysis.architecturalPatterns.forEach((pattern: any) => {
        patterns.push(`${pattern.name}: ${pattern.description}`);
      });
    }
    
    return patterns.slice(0, 5);
  }

  private extractActualSolutionOptimized(correlations: VibeGitCorrelation[], gitAnalysis: any, semanticAnalysis: any): ContentAgnosticInsight['solution'] {
    // PERFORMANCE: Simplified solution extraction
    const technologies = this.extractTechnologiesFromGit(gitAnalysis);
    const patterns = this.extractPatternsFromSemantic(semanticAnalysis);
    
    if (correlations.length > 0) {
      const mainCorrelation = correlations[0];
      const decisions = mainCorrelation.vibeDiscussion.decisions || [];
      
      return {
        approach: decisions[0] || (() => {
          log('ERROR: No decisions found in vibe correlations, cannot generate approach', 'error');
          throw new Error('CONTENT_GENERATION_ERROR: Missing approach data - no decisions in correlations');
        })(),
        implementation: decisions.slice(0, 5), // Limit implementation steps
        technologies: technologies.slice(0, 5), // Limit technologies
        tradeoffs: ['Implementation complexity vs. maintainability']
      };
    }

    // Generate repository-specific solution instead of generic fallback
    return this.generateRepositorySpecificSolution(gitAnalysis, semanticAnalysis, technologies, patterns);
  }

  private measureOutcomesOptimized(gitAnalysis: any, semanticAnalysis: any): ContentAgnosticInsight['outcome'] {
    // PERFORMANCE: Quick outcome measurement
    const commitCount = gitAnalysis?.commits?.length || 0;
    const fileCount = semanticAnalysis?.codeAnalysis?.totalFiles || 0;
    
    return {
      improvements: [
        `Analyzed ${commitCount} commits for pattern identification`,
        `Processed ${fileCount} files for structural insights`,
        `Code quality score: ${semanticAnalysis?.codeAnalysis?.codeQuality?.score || 70}/100`
      ],
      metrics: [
        `Average complexity: ${semanticAnalysis?.codeAnalysis?.averageComplexity || 15}`,
        `File count: ${fileCount}`,
        `Commit activity: ${commitCount} commits`
      ],
      newChallenges: ['Continue monitoring code quality metrics', 'Implement additional architectural patterns']
    };
  }

  private extractProblemFromCodeOptimized(semanticAnalysis: any, gitAnalysis?: any): ContentAgnosticInsight['problem'] {
    // PERFORMANCE: Quick problem extraction from semantic analysis
    const codeQuality = semanticAnalysis?.codeAnalysis?.codeQuality?.score || 70;
    const complexity = semanticAnalysis?.codeAnalysis?.averageComplexity || 15;
    const codeIssues = semanticAnalysis?.codeAnalysis?.codeQuality?.issues || [];
    
    console.log('🔍 DEBUG extractProblemFromCodeOptimized:');
    console.log('  - Code issues from semantic analysis:', `(${codeIssues.length})`, codeIssues);
    console.log('  - Code quality score:', codeQuality);
    
    // Check if we're getting the generic "13 files have high complexity" issue
    const genericIssue = codeIssues.find((issue: string) => issue.includes('files have high complexity'));
    if (genericIssue) {
      console.log('⚠️  WARNING: Found generic issue text:', genericIssue);
      console.log('  This should be replaced with repository-specific analysis!');
      
      // Generate repository-specific analysis using git changes
      if (gitAnalysis && gitAnalysis.commits) {
        console.log('🔍 DEBUG: Attempting repository-specific analysis...');
        return this.generateRepositorySpecificProblem(gitAnalysis, semanticAnalysis);
      }
    }
    
    log('ERROR: Using generic problem description - this should be repository-specific', 'error');
    log('DEBUG: Analysis data structure inspection', 'debug', { codeQuality, complexity, codeIssues });
    throw new Error('CONTENT_GENERATION_ERROR: Generic problem fallback triggered - repository analysis failed');
  }

  private generateRepositorySpecificProblem(gitAnalysis: any, semanticAnalysis: any): ContentAgnosticInsight['problem'] {
    // Extract actual changes from git commits
    const allFiles: any[] = [];
    let totalCommits = 0;
    
    if (gitAnalysis.commits) {
      totalCommits = gitAnalysis.commits.length;
      gitAnalysis.commits.forEach((commit: any) => {
        if (commit.files) {
          allFiles.push(...commit.files);
        }
      });
    }
    
    console.log('🔍 Repository-specific analysis:', `${allFiles.length} files from ${totalCommits} commits`);
    
    if (allFiles.length > 0) {
      const fileTypes = this.categorizeFileChanges(allFiles);
      const agentFiles = fileTypes.source.filter((f: any) => {
        const fileName = typeof f === 'string' ? f : (f.path || String(f));
        return fileName.includes('agent') || fileName.includes('Agent');
      }).length;
      
      if (agentFiles > 0) {
        return {
          description: `Multi-agent architecture complexity in semantic analysis system`,
          context: `Development of ${agentFiles} agent components with ${totalCommits} commits affecting ${allFiles.length} files`,
          symptoms: [
            `${agentFiles} agent files requiring coordination`,
            `Complex data flow between analysis components`,
            `TypeScript type safety challenges across agent interfaces`
          ],
          impact: 'Agent coordination complexity affecting system maintainability and extensibility'
        };
      }
    }
    
    // NO MORE FALLBACKS - throw error instead
    log('ERROR: Cannot generate repository-specific problem - no specific patterns found', 'error');
    log('DEBUG: gitAnalysis structure', 'debug', { keys: Object.keys(gitAnalysis || {}) });
    log('DEBUG: semanticAnalysis structure', 'debug', { keys: Object.keys(semanticAnalysis || {}) });
    throw new Error('CONTENT_GENERATION_ERROR: No specific patterns found for problem generation - analysis data incomplete');
  }

  private generateRepositorySpecificSolution(gitAnalysis: any, semanticAnalysis: any, technologies: string[], patterns: string[]): ContentAgnosticInsight['solution'] {
    // Extract actual changes from git commits
    const allFiles: any[] = [];
    let totalCommits = 0;
    
    if (gitAnalysis.commits) {
      totalCommits = gitAnalysis.commits.length;
      gitAnalysis.commits.forEach((commit: any) => {
        if (commit.files) {
          allFiles.push(...commit.files);
        }
      });
    }

    // Categorize files to generate specific solutions
    const fileTypes = {
      source: allFiles.filter((f: any) => {
        const fileName = typeof f === 'string' ? f : (f.path || String(f));
        return fileName.match(/\.(ts|js|py|java|cpp|cs)$/);
      }),
      config: allFiles.filter((f: any) => {
        const fileName = typeof f === 'string' ? f : (f.path || String(f));
        return fileName.match(/\.(json|yaml|yml|toml|ini|conf)$/);
      }),
      tests: allFiles.filter((f: any) => {
        const fileName = typeof f === 'string' ? f : (f.path || String(f));
        return fileName.includes('test') || fileName.includes('spec');
      })
    };
    
    // Generate agent-specific solutions
    const agentFiles = fileTypes.source.filter((f: any) => {
      const fileName = typeof f === 'string' ? f : (f.path || String(f));
      return fileName.includes('agent') || fileName.includes('Agent');
    }).length;
    
    if (agentFiles > 0) {
      return {
        approach: `Modular agent architecture with TypeScript type safety`,
        implementation: [
          `Standardize agent interfaces across ${agentFiles} agent components`,
          `Implement centralized agent orchestration patterns`,
          `Add comprehensive type definitions for agent communication`,
          `Create shared utilities for common agent operations`,
          `Establish agent lifecycle management protocols`
        ],
        technologies: [
          'TypeScript for type safety',
          'Node.js for runtime environment',
          'MCP protocol for agent communication',
          ...technologies.slice(0, 2)
        ],
        tradeoffs: [
          'Agent complexity vs. system modularity',
          'Type safety overhead vs. runtime flexibility',
          'Protocol standardization vs. agent autonomy'
        ]
      };
    }
    
    // Generate TypeScript-specific solutions for TS-heavy repos
    const tsFiles = fileTypes.source.filter((f: any) => {
      const fileName = typeof f === 'string' ? f : (f.path || String(f));
      return fileName.endsWith('.ts');
    }).length;
    
    if (tsFiles > fileTypes.source.length * 0.7) {
      return {
        approach: `TypeScript-first development with enhanced type safety`,
        implementation: [
          `Strengthen type definitions across ${tsFiles} TypeScript files`,
          `Implement strict compiler options for better error detection`,
          `Add generic interfaces for better code reusability`,
          `Create utility types for common patterns`,
          `Establish consistent naming conventions`
        ],
        technologies: [
          'TypeScript strict mode',
          'Advanced generic types',
          'Type guards and predicates',
          ...technologies.slice(0, 2)
        ],
        tradeoffs: [
          'Compile-time safety vs. development velocity',
          'Type complexity vs. code readability',
          'Strict typing vs. rapid prototyping'
        ]
      };
    }
    
    // Fallback to configuration-based solution if many config files
    if (fileTypes.config.length > 5) {
      return {
        approach: `Configuration-driven development approach`,
        implementation: [
          `Standardize configuration management across ${fileTypes.config.length} config files`,
          `Implement validation schemas for configuration`,
          `Create centralized configuration loading`,
          `Add environment-specific configuration support`,
          `Establish configuration documentation patterns`
        ],
        technologies: [
          'JSON Schema validation',
          'Environment variable management',
          'Configuration templating',
          ...technologies.slice(0, 2)
        ],
        tradeoffs: [
          'Configuration flexibility vs. complexity',
          'Runtime configuration vs. compile-time constants',
          'Validation overhead vs. error prevention'
        ]
      };
    }
    
    // NO MORE FALLBACKS - throw error instead
    log('ERROR: Cannot generate repository-specific solution - no recognized patterns found', 'error');
    log('DEBUG: Solution generation data', 'debug', { totalCommits, technologies, patterns });
    throw new Error('CONTENT_GENERATION_ERROR: No repository-specific solution patterns found - insufficient analysis data');
  }

  private async extractRealProblem(correlations: VibeGitCorrelation[], semanticAnalysis: any): Promise<ContentAgnosticInsight['problem']> {
    if (correlations.length === 0) {
      return this.extractProblemFromCode(semanticAnalysis);
    }

    const strongestCorrelation = correlations[0];
    const vibeProblems = strongestCorrelation.vibeDiscussion.problems;
    
    // Analyze the actual problems discussed in conversations
    let description = 'Unknown problem';
    let context = 'Development process';
    let symptoms: string[] = [];
    let impact = 'Unknown impact';

    if (vibeProblems.length > 0) {
      // Extract real problem description from vibe history
      description = this.categorizeProblems(vibeProblems, this.repositoryContext);
      context = this.getBusinessContext(strongestCorrelation.vibeDiscussion.topic);
      symptoms = this.extractSymptoms(vibeProblems, semanticAnalysis);
      impact = this.assessImpact(strongestCorrelation, semanticAnalysis);
    }

    return {
      description,
      context,
      symptoms,
      impact
    };
  }

  private categorizeProblems(problems: string[], context: RepositoryContext | null): string {
    // Analyze problems based on repository context
    if (!context) {
      return problems[0] || 'Unspecified development challenge';
    }

    const problemText = problems.join(' ').toLowerCase();
    
    // Performance problems
    if (problemText.includes('slow') || problemText.includes('performance') || problemText.includes('timeout')) {
      if (context.projectType === 'web-app') {
        return 'Frontend performance degradation affecting user experience';
      } else if (context.projectType === 'api') {
        return 'API response time issues impacting client applications';
      } else if (context.projectType === 'ml-pipeline') {
        return 'Model training or inference performance bottlenecks';
      }
      return 'System performance issues affecting core functionality';
    }

    // Scalability problems
    if (problemText.includes('scale') || problemText.includes('load') || problemText.includes('users')) {
      return `${context.projectType === 'api' ? 'API' : 'Application'} scalability challenges with growing user base`;
    }

    // Technical debt / maintainability
    if (problemText.includes('complex') || problemText.includes('maintain') || problemText.includes('refactor')) {
      return `Code maintainability issues in ${context.domain.toLowerCase()} domain requiring architectural improvements`;
    }

    // Integration problems
    if (problemText.includes('integration') || problemText.includes('api') || problemText.includes('service')) {
      return 'System integration challenges affecting service interoperability';
    }

    // Testing / quality problems
    if (problemText.includes('test') || problemText.includes('bug') || problemText.includes('quality')) {
      return 'Code quality and testing coverage issues impacting reliability';
    }

    // Framework/technology problems
    for (const framework of context.frameworks) {
      if (problemText.includes(framework.toLowerCase())) {
        return `${framework} framework limitations requiring architectural changes`;
      }
    }

    // Fallback to first actual problem mentioned
    return problems[0] || 'Development process optimization needs';
  }

  private extractActualSolution(correlations: VibeGitCorrelation[], gitAnalysis: any, semanticAnalysis: any): ContentAgnosticInsight['solution'] {
    if (correlations.length === 0) {
      return this.extractSolutionFromCode(gitAnalysis, semanticAnalysis);
    }

    const strongestCorrelation = correlations[0];
    const decisions = strongestCorrelation.vibeDiscussion.decisions;
    const gitChanges = strongestCorrelation.gitChanges;

    // Analyze actual solution implemented
    const approach = this.describeSolutionApproach(decisions, gitChanges, this.repositoryContext);
    const implementation = this.extractImplementationDetails(gitChanges, semanticAnalysis);
    const technologies = this.identifyTechnologies(gitChanges, decisions, this.repositoryContext);
    const tradeoffs = this.extractTradeoffs(decisions, semanticAnalysis);

    return {
      approach,
      implementation,
      technologies,
      tradeoffs
    };
  }

  private describeSolutionApproach(decisions: string[], gitChanges: any, context: RepositoryContext | null): string {
    if (decisions.length === 0) {
      return this.inferApproachFromGitChanges(gitChanges, context);
    }

    const decisionText = decisions.join(' ').toLowerCase();
    
    // Architecture changes
    if (decisionText.includes('refactor') || decisionText.includes('restructure')) {
      return 'Architectural refactoring to improve code organization and maintainability';
    }

    // Technology migration
    if (decisionText.includes('migrate') || decisionText.includes('replace') || decisionText.includes('switch')) {
      return 'Technology stack migration to address limitations and improve capabilities';
    }

    // Performance optimization
    if (decisionText.includes('optimize') || decisionText.includes('cache') || decisionText.includes('performance')) {
      return 'Performance optimization through algorithmic improvements and caching strategies';
    }

    // New feature implementation
    if (decisionText.includes('add') || decisionText.includes('implement') || decisionText.includes('feature')) {
      return 'Feature implementation with focus on user experience and system integration';
    }

    // Process improvement
    if (decisionText.includes('process') || decisionText.includes('workflow') || decisionText.includes('automation')) {
      return 'Development process automation and workflow optimization';
    }

    return decisions[0] || 'Systematic approach to address identified challenges';
  }

  private extractImplementationDetails(gitChanges: any, semanticAnalysis: any): string[] {
    const details: string[] = [];
    
    // Extract all files from commits
    const allFiles: any[] = [];
    if (gitChanges.commits) {
      gitChanges.commits.forEach((commit: any) => {
        if (commit.files) {
          allFiles.push(...commit.files);
        }
      });
    }
    
    console.log(`🔍 DEBUG extractImplementationDetails: Found ${allFiles.length} files from ${gitChanges.commits?.length || 0} commits`);
    if (allFiles.length > 0) {
      console.log(`🔍 First few files:`, allFiles.slice(0, 3).map((f: any) => typeof f === 'string' ? f : f.path || f));
    }
    
    // Analyze file changes for implementation specifics
    if (allFiles.length > 0) {
      const fileTypes = this.categorizeFileChanges(allFiles);
      
      if (fileTypes.config.length > 0) {
        details.push(`Configuration updates in ${fileTypes.config.length} files`);
      }
      if (fileTypes.source.length > 0) {
        details.push(`Core implementation changes across ${fileTypes.source.length} source files`);
      }
      if (fileTypes.test.length > 0) {
        details.push(`Test coverage additions in ${fileTypes.test.length} test files`);
      }
      if (fileTypes.docs.length > 0) {
        details.push(`Documentation updates covering ${fileTypes.docs.length} files`);
      }
    }

    // Add semantic analysis insights
    if (semanticAnalysis?.codeAnalysis?.architecturalPatterns) {
      const patterns = semanticAnalysis.codeAnalysis.architecturalPatterns;
      if (patterns.length > 0) {
        details.push(`Implemented ${patterns.length} architectural patterns: ${patterns.map((p: any) => p.name).join(', ')}`);
      }
    }

    return details.length > 0 ? details : ['Implementation details not available from analysis'];
  }

  private measureOutcomes(gitAnalysis: any, semanticAnalysis: any): ContentAgnosticInsight['outcome'] {
    const metrics: string[] = [];
    const improvements: string[] = [];
    const newChallenges: string[] = [];

    // Analyze code metrics for measurable outcomes
    if (semanticAnalysis?.codeAnalysis?.complexityMetrics) {
      const complexity = semanticAnalysis.codeAnalysis.complexityMetrics;
      if (complexity.averageComplexity) {
        metrics.push(`Average code complexity: ${complexity.averageComplexity.toFixed(1)}`);
      }
      if (complexity.totalFunctions) {
        metrics.push(`Total functions analyzed: ${complexity.totalFunctions}`);
      }
    }

    // File and language distribution
    if (semanticAnalysis?.codeAnalysis?.languageDistribution) {
      const languages = Object.entries(semanticAnalysis.codeAnalysis.languageDistribution);
      metrics.push(`Language distribution: ${languages.map(([lang, count]) => `${lang}: ${count}`).join(', ')}`);
    }

    // Git activity metrics
    if (gitAnalysis?.commits) {
      metrics.push(`Development activity: ${gitAnalysis.commits.length} commits analyzed`);
    }

    // Quality improvements
    if (semanticAnalysis?.codeAnalysis?.codeQuality) {
      const quality = semanticAnalysis.codeAnalysis.codeQuality;
      if (quality.score !== undefined) {
        improvements.push(`Code quality score: ${quality.score}/100`);
      }
      if (quality.recommendations?.length > 0) {
        improvements.push(`${quality.recommendations.length} improvement recommendations identified`);
      }
    }

    // Potential new challenges
    if (semanticAnalysis?.codeAnalysis?.codeQuality?.issues?.length > 0) {
      newChallenges.push(`${semanticAnalysis.codeAnalysis.codeQuality.issues.length} code quality issues require attention`);
    }

    return {
      metrics: metrics.length > 0 ? metrics : ['No quantitative metrics available'],
      improvements: improvements.length > 0 ? improvements : ['Improvements not quantified'],
      newChallenges: newChallenges.length > 0 ? newChallenges : ['No new challenges identified']
    };
  }

  private calculateRealSignificance(problem: any, solution: any, outcome: any): number {
    let significance = 5; // Base significance

    // Increase based on problem severity
    if (problem.impact.includes('critical') || problem.impact.includes('blocking')) {
      significance += 3;
    } else if (problem.impact.includes('significant') || problem.impact.includes('affecting')) {
      significance += 2;
    } else if (problem.impact.includes('minor') || problem.impact.includes('limited')) {
      significance += 1;
    }

    // ENHANCEMENT: Recognize infrastructure/architectural patterns (typically high significance)
    const infrastructureKeywords = [
      'infrastructure', 'architecture', 'build', 'deploy', 'ci/cd', 'pipeline',
      'monitoring', 'logging', 'health', 'observability', 'reliability',
      'performance', 'scalability', 'security', 'authentication', 'authorization',
      'database', 'cache', 'api', 'integration', 'workflow', 'automation',
      'testing', 'quality', 'documentation', 'configuration', 'environment'
    ];

    const problemText = (problem.description || '').toLowerCase();
    const solutionText = (solution.approach || solution.description || '').toLowerCase();
    const combinedText = `${problemText} ${solutionText}`;

    const matchedKeywords = infrastructureKeywords.filter(kw => combinedText.includes(kw));
    if (matchedKeywords.length >= 3) {
      significance += 2; // Strong infrastructure pattern
    } else if (matchedKeywords.length >= 1) {
      significance += 1; // Infrastructure-related
    }

    // Increase based on solution complexity
    if (solution.implementation.length > 3) {
      significance += 1;
    }
    if (solution.technologies.length > 2) {
      significance += 1;
    }

    // Increase based on measurable outcomes
    if (outcome.metrics.some((m: string) => m.includes('improvement'))) {
      significance += 1;
    }

    return Math.min(Math.max(significance, 1), 10);
  }

  private calculateConfidence(correlations: VibeGitCorrelation[], gitAnalysis: any, semanticAnalysis: any): number {
    let confidence = 0.5; // Base confidence

    // Increase based on correlation quality
    if (correlations.length > 0) {
      const avgCorrelationConfidence = correlations.reduce((sum, c) => sum + c.correlation.confidence, 0) / correlations.length;
      confidence += avgCorrelationConfidence * 0.3;
    }

    // Increase based on data availability
    if (gitAnalysis?.commits?.length > 5) {
      confidence += 0.1;
    }
    if (semanticAnalysis?.codeAnalysis?.filesAnalyzed > 10) {
      confidence += 0.1;
    }

    return Math.min(Math.max(confidence, 0.1), 1.0);
  }

  // Helper methods for analysis
  private createTimeWindows(vibeSessions: any[], commits: any[]): any[] {
    console.log('🔍 Creating time windows for correlation analysis...');
    
    if (!vibeSessions || !commits) {
      console.log('❌ No vibe sessions or commits data available');
      return [];
    }

    const windows = [];
    
    // Create simplified time windows based on available data
    // For now, create a single window covering all available data
    const allCommitDates = commits.map(c => new Date(c.date || c.timestamp || Date.now())).filter(d => !isNaN(d.getTime()));
    const allVibeDates = vibeSessions.map(s => new Date(s.date || s.timestamp || Date.now())).filter(d => !isNaN(d.getTime()));
    
    if (allCommitDates.length === 0 && allVibeDates.length === 0) {
      console.log('❌ No valid dates found in commits or vibe sessions');
      return [];
    }

    const startDate = new Date(Math.min(...allCommitDates.map(d => d.getTime()), ...allVibeDates.map(d => d.getTime())));
    const endDate = new Date(Math.max(...allCommitDates.map(d => d.getTime()), ...allVibeDates.map(d => d.getTime())));
    
    const window = {
      timeframe: { start: startDate, end: endDate },
      vibeSessions: vibeSessions,
      commits: commits
    };
    
    windows.push(window);
    log(`Created ${windows.length} time windows for analysis`, 'debug');
    
    return windows;
  }

  private analyzeTimeWindow(window: any): VibeGitCorrelation {
    console.log('🔍 Analyzing time window for correlations...');
    
    const { vibeSessions, commits } = window;
    
    // Extract problems and decisions from vibe sessions
    const problems: string[] = [];
    const decisions: string[] = [];
    const topics: string[] = [];
    
    if (vibeSessions) {
      for (const session of vibeSessions) {
        // Extract problems from session content
        if (session.problems) {
          problems.push(...session.problems);
        }
        if (session.content) {
          // Look for problem indicators in content
          const content = session.content.toLowerCase();
          if (content.includes('issue') || content.includes('problem') || content.includes('bug')) {
            problems.push('Development challenges identified in conversation');
          }
          if (content.includes('decided') || content.includes('implement') || content.includes('approach')) {
            decisions.push('Technical decisions made in discussion');
          }
        }
        if (session.topic) {
          topics.push(session.topic);
        }
      }
    }
    
    // Extract file changes from commits
    const files: string[] = [];
    const commitMessages: string[] = [];
    
    if (commits) {
      for (const commit of commits) {
        if (commit.files) {
          files.push(...commit.files);
        }
        if (commit.message) {
          commitMessages.push(commit.message);
        }
      }
    }
    
    // Determine correlation strength based on content overlap
    let strength: 'strong' | 'moderate' | 'weak' = 'weak';
    let confidence = 0.1;
    let description = 'Basic temporal correlation';
    
    if (problems.length > 0 && files.length > 0) {
      strength = 'moderate';
      confidence = 0.6;
      description = 'Problems discussed align with code changes';
      
      if (decisions.length > 0) {
        strength = 'strong';
        confidence = 0.8;
        description = 'Clear correlation between discussions, decisions, and implementation';
      }
    }
    
    log(`Correlation analysis: ${strength} (confidence: ${confidence})`, 'debug');
    
    return {
      timeframe: window.timeframe,
      vibeDiscussion: {
        topic: topics.join(', ') || 'Development discussion',
        problems: problems.length > 0 ? problems : ['Generic development challenges'],
        decisions: decisions.length > 0 ? decisions : ['Implementation decisions made'],
        participants: ['development team']
      },
      gitChanges: {
        commits: commitMessages,
        files: files,
        changeTypes: this.categorizeGitChanges(files)
      },
      correlation: { strength, confidence, description }
    };
  }
  
  private categorizeGitChanges(files: any[]): string[] {
    const types = new Set<string>();
    
    for (const file of files) {
      // Handle both string file paths and GitFileChange objects
      const fileName = typeof file === 'string' ? file : (file.path || String(file));
      if (fileName.includes('.md') || fileName.includes('README')) {
        types.add('documentation');
      } else if (fileName.includes('test') || fileName.includes('spec')) {
        types.add('testing');
      } else if (fileName.includes('config') || fileName.includes('.json') || fileName.includes('.yml')) {
        types.add('configuration');
      } else if (fileName.includes('.ts') || fileName.includes('.js') || fileName.includes('.py')) {
        types.add('implementation');
      } else {
        types.add('other');
      }
    }
    
    return Array.from(types);
  }

  private extractProblemFromCode(semanticAnalysis: any): ContentAgnosticInsight['problem'] {
    // Fallback when no vibe correlation available
    const issues = semanticAnalysis?.codeAnalysis?.codeQuality?.issues || [];
    
    return {
      description: issues.length > 0 ? `Code quality issues: ${issues[0]}` : 'Code maintenance and optimization needs',
      context: 'Technical debt and code quality improvement',
      symptoms: issues.slice(0, 3),
      impact: issues.length > 3 ? 'Multiple quality issues affecting maintainability' : 'Limited quality issues identified'
    };
  }

  private extractSolutionFromCode(gitAnalysis: any, semanticAnalysis: any): ContentAgnosticInsight['solution'] {
    const patterns = semanticAnalysis?.codeAnalysis?.architecturalPatterns || [];
    
    return {
      approach: patterns.length > 0 ? `Applied ${patterns[0].name} pattern` : 'Code improvements and refactoring',
      implementation: patterns.map((p: any) => `${p.name}: ${p.description}`),
      technologies: this.repositoryContext?.frameworks || [],
      tradeoffs: ['Implementation complexity vs. maintainability']
    };
  }

  private categorizeFileChanges(files: any[]): { config: string[], source: string[], test: string[], docs: string[] } {
    const categories: { config: string[], source: string[], test: string[], docs: string[] } = { 
      config: [], 
      source: [], 
      test: [], 
      docs: [] 
    };
    
    for (const file of files) {
      // Handle both string file paths and GitFileChange objects
      const fileName = typeof file === 'string' ? file : (file.path || String(file));
      if (fileName.includes('config') || fileName.includes('.json') || fileName.includes('.yml')) {
        categories.config.push(fileName);
      } else if (fileName.includes('test') || fileName.includes('spec')) {
        categories.test.push(fileName);
      } else if (fileName.includes('README') || fileName.includes('.md') || fileName.includes('doc')) {
        categories.docs.push(fileName);
      } else {
        categories.source.push(fileName);
      }
    }
    
    return categories;
  }

  private getBusinessContext(topic: string): string {
    if (!topic) return 'Technical improvement';
    
    if (topic.toLowerCase().includes('performance')) return 'Performance optimization';
    if (topic.toLowerCase().includes('user')) return 'User experience improvement';
    if (topic.toLowerCase().includes('scale')) return 'Scalability enhancement';
    if (topic.toLowerCase().includes('security')) return 'Security hardening';
    if (topic.toLowerCase().includes('feature')) return 'Feature development';
    
    return 'Technical enhancement';
  }

  private extractSymptoms(problems: string[], semanticAnalysis: any): string[] {
    // Extract concrete symptoms from problem descriptions and code analysis
    const symptoms: string[] = [];
    
    for (const problem of problems.slice(0, 3)) {
      if (problem.includes('slow')) symptoms.push('Slow response times');
      if (problem.includes('error')) symptoms.push('Error rates increasing');
      if (problem.includes('complex')) symptoms.push('High code complexity');
      if (problem.includes('difficult')) symptoms.push('Development velocity decreased');
    }
    
    return symptoms.length > 0 ? symptoms : ['Symptoms not explicitly documented'];
  }

  private assessImpact(correlation: VibeGitCorrelation, semanticAnalysis: any): string {
    // Extract all files from commits
    let fileCount = 0;
    if (correlation.gitChanges.commits) {
      correlation.gitChanges.commits.forEach((commit: any) => {
        if (commit.files) {
          fileCount += commit.files.length;
        }
      });
    }
    const commitCount = correlation.gitChanges.commits?.length || 0;
    
    if (fileCount > 10 || commitCount > 5) {
      return 'Significant impact across multiple system components';
    } else if (fileCount > 3 || commitCount > 2) {
      return 'Moderate impact on core functionality';
    } else {
      return 'Limited impact on specific components';
    }
  }

  private inferApproachFromGitChanges(gitChanges: any, context: RepositoryContext | null): string {
    // Extract all files from commits
    const allFiles: any[] = [];
    if (gitChanges.commits) {
      gitChanges.commits.forEach((commit: any) => {
        if (commit.files) {
          allFiles.push(...commit.files);
        }
      });
    }
    
    if (allFiles.length === 0) {
      return 'Systematic code improvements';
    }
    
    const files = allFiles;
    
    if (files.some((f: any) => {
      const fileName = typeof f === 'string' ? f : (f.path || String(f));
      return fileName.includes('package.json') || fileName.includes('requirements.txt');
    })) {
      return 'Dependency management and technology stack updates';
    }
    
    if (files.some((f: any) => {
      const fileName = typeof f === 'string' ? f : (f.path || String(f));
      return fileName.includes('config') || fileName.includes('.yml');
    })) {
      return 'Configuration optimization and environment setup';
    }
    
    if (files.filter((f: any) => {
      const fileName = typeof f === 'string' ? f : (f.path || String(f));
      return fileName.includes('test');
    }).length > files.length * 0.3) {
      return 'Test coverage expansion and quality assurance improvements';
    }
    
    return 'Code refactoring and architectural improvements';
  }

  private identifyTechnologies(gitChanges: any, decisions: string[], context: RepositoryContext | null): string[] {
    const technologies = new Set<string>();
    
    // Add from repository context
    if (context) {
      context.frameworks.forEach(f => technologies.add(f));
      context.primaryLanguages.forEach(l => technologies.add(l));
    }
    
    // Extract from decisions
    const decisionText = decisions.join(' ');
    const techKeywords = ['React', 'Vue', 'Angular', 'Node.js', 'Python', 'TypeScript', 'Docker', 'Kubernetes', 'AWS', 'GraphQL', 'REST'];
    
    for (const tech of techKeywords) {
      if (decisionText.includes(tech)) {
        technologies.add(tech);
      }
    }
    
    return Array.from(technologies);
  }

  private extractTradeoffs(decisions: string[], semanticAnalysis: any): string[] {
    const tradeoffs: string[] = [];
    
    const decisionText = decisions.join(' ').toLowerCase();
    
    if (decisionText.includes('complexity')) {
      tradeoffs.push('Increased complexity for better functionality');
    }
    if (decisionText.includes('performance')) {
      tradeoffs.push('Performance improvements vs. development time');
    }
    if (decisionText.includes('maintenance')) {
      tradeoffs.push('Short-term effort for long-term maintainability');
    }
    
    if (tradeoffs.length === 0) {
      tradeoffs.push('Implementation cost vs. long-term benefits');
    }
    
    return tradeoffs;
  }
}
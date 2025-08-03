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

  async analyzeWithContext(gitAnalysis: any, vibeAnalysis: any, semanticAnalysis: any): Promise<ContentAgnosticInsight> {
    console.log('🚀 ContentAgnosticAnalyzer.analyzeWithContext called!');
    
    // Get cached repository context
    this.repositoryContext = await this.contextManager.getRepositoryContext();
    
    console.log('📊 Repository context loaded:', {
      projectType: this.repositoryContext.projectType,
      domain: this.repositoryContext.domain,
      primaryLanguages: this.repositoryContext.primaryLanguages
    });
    
    log('Starting content-agnostic analysis', 'info', {
      projectType: this.repositoryContext.projectType,
      domain: this.repositoryContext.domain,
      primaryLanguages: this.repositoryContext.primaryLanguages
    });

    // Correlate vibe discussions with git changes
    const correlations = this.correlateVibeWithGit(vibeAnalysis, gitAnalysis);
    
    // Extract real problem from strongest correlation
    const mainProblem = await this.extractRealProblem(correlations, semanticAnalysis);
    
    // Extract actual solution from code changes
    const actualSolution = this.extractActualSolution(correlations, gitAnalysis, semanticAnalysis);
    
    // Measure real outcomes
    const measuredOutcome = this.measureOutcomes(gitAnalysis, semanticAnalysis);
    
    // Calculate significance based on actual impact
    const significance = this.calculateRealSignificance(mainProblem, actualSolution, measuredOutcome);
    
    // Calculate confidence based on data quality
    const confidence = this.calculateConfidence(correlations, gitAnalysis, semanticAnalysis);

    return {
      problem: mainProblem,
      solution: actualSolution,
      outcome: measuredOutcome,
      significance,
      confidence
    };
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
    
    // Analyze file changes for implementation specifics
    if (gitChanges.files) {
      const fileTypes = this.categorizeFileChanges(gitChanges.files);
      
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
    console.log(`📊 Created ${windows.length} time windows for analysis`);
    
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
    
    console.log(`📊 Correlation analysis: ${strength} (confidence: ${confidence})`);
    
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
  
  private categorizeGitChanges(files: string[]): string[] {
    const types = new Set<string>();
    
    for (const file of files) {
      if (file.includes('.md') || file.includes('README')) {
        types.add('documentation');
      } else if (file.includes('test') || file.includes('spec')) {
        types.add('testing');
      } else if (file.includes('config') || file.includes('.json') || file.includes('.yml')) {
        types.add('configuration');
      } else if (file.includes('.ts') || file.includes('.js') || file.includes('.py')) {
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

  private categorizeFileChanges(files: string[]): { config: string[], source: string[], test: string[], docs: string[] } {
    const categories: { config: string[], source: string[], test: string[], docs: string[] } = { 
      config: [], 
      source: [], 
      test: [], 
      docs: [] 
    };
    
    for (const file of files) {
      if (file.includes('config') || file.includes('.json') || file.includes('.yml')) {
        categories.config.push(file);
      } else if (file.includes('test') || file.includes('spec')) {
        categories.test.push(file);
      } else if (file.includes('README') || file.includes('.md') || file.includes('doc')) {
        categories.docs.push(file);
      } else {
        categories.source.push(file);
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
    const fileCount = correlation.gitChanges.files.length;
    const commitCount = correlation.gitChanges.commits.length;
    
    if (fileCount > 10 || commitCount > 5) {
      return 'Significant impact across multiple system components';
    } else if (fileCount > 3 || commitCount > 2) {
      return 'Moderate impact on core functionality';
    } else {
      return 'Limited impact on specific components';
    }
  }

  private inferApproachFromGitChanges(gitChanges: any, context: RepositoryContext | null): string {
    if (!gitChanges.files || gitChanges.files.length === 0) {
      return 'Systematic code improvements';
    }
    
    const files = gitChanges.files;
    
    if (files.some((f: string) => f.includes('package.json') || f.includes('requirements.txt'))) {
      return 'Dependency management and technology stack updates';
    }
    
    if (files.some((f: string) => f.includes('config') || f.includes('.yml'))) {
      return 'Configuration optimization and environment setup';
    }
    
    if (files.filter((f: string) => f.includes('test')).length > files.length * 0.3) {
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
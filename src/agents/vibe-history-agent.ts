import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logging.js';
import { SemanticAnalyzer } from './semantic-analyzer.js';

export interface ConversationSession {
  filename: string;
  timestamp: Date;
  project: string;
  sessionType: string;
  exchanges: ConversationExchange[];
  metadata: {
    sessionId?: string;
    startTime?: Date;
    endTime?: Date;
    totalMessages: number;
    summary?: string;
  };
}

export interface ConversationExchange {
  id: number;
  timestamp: Date;
  userMessage: string;
  assistantMessage: string;
  context: {
    tools: string[];
    files: string[];
    actions: string[];
  };
}

export interface DevelopmentContext {
  problemType: string;
  problemDescription: string;
  solutionApproach: string;
  technicalDetails: string[];
  outcomes: string[];
  session: string;
  timestamp: Date;
}

export interface ProblemSolutionPair {
  problem: {
    description: string;
    context: string;
    difficulty: 'low' | 'medium' | 'high';
  };
  solution: {
    approach: string;
    steps: string[];
    technologies: string[];
    outcome: string;
  };
  metadata: {
    session: string;
    timestamp: Date;
    exchanges: number[];
  };
}

export interface VibeHistoryAnalysisResult {
  checkpointInfo: {
    fromTimestamp: Date | null;
    toTimestamp: Date;
    sessionsAnalyzed: number;
  };
  sessions: ConversationSession[];
  developmentContexts: DevelopmentContext[];
  problemSolutionPairs: ProblemSolutionPair[];
  patterns: {
    commonProblems: { problem: string; frequency: number }[];
    preferredSolutions: { solution: string; frequency: number }[];
    toolUsage: { tool: string; frequency: number }[];
    developmentThemes: { theme: string; frequency: number }[];
  };
  summary: {
    totalExchanges: number;
    primaryFocus: string;
    keyLearnings: string[];
    insights: string;
  };
}

export class VibeHistoryAgent {
  private repositoryPath: string;
  private specstoryPath: string;
  private semanticAnalyzer: SemanticAnalyzer;
  private team: string;

  constructor(repositoryPath: string = '.', team: string = 'coding') {
    this.repositoryPath = repositoryPath;
    this.team = team;
    this.specstoryPath = path.join(repositoryPath, '.specstory', 'history');
    this.semanticAnalyzer = new SemanticAnalyzer();
  }

  async analyzeVibeHistory(fromTimestampOrParams?: Date | Record<string, any>): Promise<VibeHistoryAnalysisResult> {
    // Handle both Date parameter (old API) and parameters object (new coordinator API)
    let fromTimestamp: Date | undefined;
    if (fromTimestampOrParams instanceof Date) {
      fromTimestamp = fromTimestampOrParams;
    } else if (typeof fromTimestampOrParams === 'object' && fromTimestampOrParams !== null) {
      // Parameters object from coordinator - extract timestamp if provided
      if (fromTimestampOrParams.fromTimestamp) {
        fromTimestamp = new Date(fromTimestampOrParams.fromTimestamp);
      }
    }

    log('Starting vibe history analysis', 'info', {
      repositoryPath: this.repositoryPath,
      specstoryPath: this.specstoryPath,
      fromTimestamp: fromTimestamp?.toISOString() || 'beginning'
    });

    try {
      // Validate specstory directory
      this.validateSpecstoryDirectory();

      // Get analysis checkpoint
      const checkpoint = await this.getLastAnalysisCheckpoint();
      const effectiveFromTimestamp = fromTimestamp || checkpoint;

      // Discover and parse session files
      const sessions = await this.parseSessionFiles(effectiveFromTimestamp);
      log(`Parsed ${sessions.length} conversation sessions`, 'info');

      // Extract development contexts
      const developmentContexts = this.extractDevelopmentContexts(sessions);

      // Identify problem-solution pairs
      const problemSolutionPairs = this.identifyProblemSolutionPairs(sessions);

      // Analyze patterns
      const patterns = this.analyzePatterns(sessions, developmentContexts, problemSolutionPairs);

      // Generate summary
      const summary = await this.generateSummary(sessions, developmentContexts, problemSolutionPairs, patterns);

      const result: VibeHistoryAnalysisResult = {
        checkpointInfo: {
          fromTimestamp: effectiveFromTimestamp,
          toTimestamp: new Date(),
          sessionsAnalyzed: sessions.length
        },
        sessions,
        developmentContexts,
        problemSolutionPairs,
        patterns,
        summary
      };

      // Update checkpoint
      await this.saveAnalysisCheckpoint(new Date());

      log('Vibe history analysis completed', 'info', {
        sessionsAnalyzed: sessions.length,
        contextsExtracted: developmentContexts.length,
        problemSolutionPairs: problemSolutionPairs.length
      });

      return result;

    } catch (error) {
      log('Vibe history analysis failed', 'error', error);
      throw error;
    }
  }

  private validateSpecstoryDirectory(): void {
    if (!fs.existsSync(this.specstoryPath)) {
      throw new Error(`Specstory directory not found: ${this.specstoryPath}`);
    }
  }

  private async getLastAnalysisCheckpoint(): Promise<Date | null> {
    try {
      const sharedMemoryPath = path.join(this.repositoryPath, '.data', 'knowledge-export', `${this.team}.json`);
      if (fs.existsSync(sharedMemoryPath)) {
        const data = JSON.parse(fs.readFileSync(sharedMemoryPath, 'utf8'));
        if (data.metadata?.lastVibeAnalysis) {
          return new Date(data.metadata.lastVibeAnalysis);
        }
      }
      return null;
    } catch (error) {
      log('Could not read vibe analysis checkpoint', 'warning', error);
      return null;
    }
  }

  private async saveAnalysisCheckpoint(timestamp: Date): Promise<void> {
    try {
      const sharedMemoryPath = path.join(this.repositoryPath, '.data', 'knowledge-export', `${this.team}.json`);
      let data: any = { entities: [], metadata: {} };
      
      if (fs.existsSync(sharedMemoryPath)) {
        data = JSON.parse(fs.readFileSync(sharedMemoryPath, 'utf8'));
      }
      
      if (!data.metadata) {
        data.metadata = {};
      }
      
      data.metadata.lastVibeAnalysis = timestamp.toISOString();
      
      fs.writeFileSync(sharedMemoryPath, JSON.stringify(data, null, 2));
      log('Vibe analysis checkpoint saved', 'info', { timestamp: timestamp.toISOString() });
    } catch (error) {
      log('Could not save vibe analysis checkpoint', 'warning', error);
    }
  }

  private async parseSessionFiles(fromTimestamp: Date | null): Promise<ConversationSession[]> {
    const sessions: ConversationSession[] = [];
    
    try {
      const files = fs.readdirSync(this.specstoryPath)
        .filter(file => file.endsWith('.md'))
        .sort();

      for (const file of files) {
        const filePath = path.join(this.specstoryPath, file);
        const fileStats = fs.statSync(filePath);
        
        // Skip files older than checkpoint
        if (fromTimestamp && fileStats.mtime < fromTimestamp) {
          continue;
        }

        try {
          const session = await this.parseSessionFile(filePath);
          if (session) {
            sessions.push(session);
          }
        } catch (error) {
          log(`Failed to parse session file: ${file}`, 'warning', error);
        }
      }

    } catch (error) {
      log('Failed to read specstory directory', 'error', error);
      throw error;
    }

    return sessions;
  }

  private async parseSessionFile(filePath: string): Promise<ConversationSession | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const filename = path.basename(filePath);
      
      // Extract metadata from filename and content
      const metadata = this.extractSessionMetadata(filename, content);
      if (!metadata) return null;

      // Parse exchanges
      const exchanges = this.parseExchanges(content);

      return {
        filename,
        timestamp: metadata.timestamp,
        project: metadata.project,
        sessionType: metadata.sessionType,
        exchanges,
        metadata: {
          sessionId: metadata.sessionId,
          startTime: metadata.startTime,
          endTime: metadata.endTime,
          totalMessages: metadata.totalMessages || exchanges.length * 2,
          summary: metadata.summary
        }
      };

    } catch (error) {
      log(`Error parsing session file: ${filePath}`, 'error', error);
      return null;
    }
  }

  private extractSessionMetadata(filename: string, content: string): any {
    // Parse filename: YYYY-MM-DD_HHMM-HHMM_hash.md (LSL format)
    // Also support legacy format: YYYY-MM-DD_HH-MM-SS_project-session.md
    const lslMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})-(\d{4})_(.+)\.md$/);
    const legacyMatch = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_(.+)-session\.md$/);

    let datePart, startTime, endTime, identifier, timestamp;

    if (lslMatch) {
      // LSL format: YYYY-MM-DD_HHMM-HHMM_hash.md
      [, datePart, startTime, endTime, identifier] = lslMatch;
      // Convert HHMM to HH:MM
      const startHHMM = `${startTime.slice(0, 2)}:${startTime.slice(2)}`;
      timestamp = new Date(`${datePart}T${startHHMM}:00`);
    } else if (legacyMatch) {
      // Legacy format: YYYY-MM-DD_HH-MM-SS_project-session.md
      const timePart = legacyMatch[2];
      datePart = legacyMatch[1];
      identifier = legacyMatch[3];
      timestamp = new Date(`${datePart}T${timePart.replace(/-/g, ':')}:00`);
    } else {
      log(`Invalid session filename format: ${filename}`, 'warning');
      return null;
    }

    // Extract metadata from content
    const sessionIdMatch = content.match(/\*\*Session ID:\*\* ([^\s\n]+)/);
    const summaryMatch = content.match(/\*\*Summary:\*\* ([^\n]+)/);
    const startTimeMatch = content.match(/\*\*Start Time:\*\* ([^\n]+)/);
    const endTimeMatch = content.match(/\*\*End Time:\*\* ([^\n]+)/);
    const totalMessagesMatch = content.match(/\*\*Total Messages:\*\* (\d+)/);

    return {
      timestamp,
      project: identifier.replace(/_/g, ' ').replace(/-/g, ' '),
      sessionType: 'development',
      sessionId: sessionIdMatch?.[1],
      summary: summaryMatch?.[1],
      startTime: startTimeMatch ? new Date(startTimeMatch[1]) : timestamp,
      endTime: endTimeMatch ? new Date(endTimeMatch[1]) : timestamp,
      totalMessages: totalMessagesMatch ? parseInt(totalMessagesMatch[1], 10) : undefined
    };
  }

  private parseExchanges(content: string): ConversationExchange[] {
    const exchanges: ConversationExchange[] = [];
    
    // Split content into exchange sections
    const exchangeSections = content.split(/## Exchange \d+/).slice(1);

    for (let i = 0; i < exchangeSections.length; i++) {
      try {
        const section = exchangeSections[i];
        const exchange = this.parseExchange(i + 1, section);
        if (exchange) {
          exchanges.push(exchange);
        }
      } catch (error) {
        log(`Error parsing exchange ${i + 1}`, 'warning', error);
      }
    }

    return exchanges;
  }

  private parseExchange(id: number, section: string): ConversationExchange | null {
    try {
      // Extract user message
      const userMatch = section.match(/\*\*User:\*\* \*\(([^)]+)\)\*\n([\s\S]*?)(?=\n\*\*Assistant:\*\*|\n---|\n## Exchange|\n\*\*Extraction Summary|\nEOF|$)/);
      if (!userMatch) return null;

      const timestamp = new Date(userMatch[1]);
      const userMessage = userMatch[2].trim();

      // Extract assistant message
      const assistantMatch = section.match(/\*\*Assistant:\*\* \*\(([^)]+)\)\*\n([\s\S]*?)(?=\n---|\n## Exchange|\n\*\*Extraction Summary|\nEOF|$)/);
      const assistantMessage = assistantMatch ? assistantMatch[2].trim() : '';

      // Extract context (tools, files, actions)
      const context = this.extractExchangeContext(userMessage, assistantMessage);

      return {
        id,
        timestamp,
        userMessage,
        assistantMessage,
        context
      };

    } catch (error) {
      log(`Error parsing exchange content`, 'warning', error);
      return null;
    }
  }

  private extractExchangeContext(userMessage: string, assistantMessage: string): ConversationExchange['context'] {
    const tools: string[] = [];
    const files: string[] = [];
    const actions: string[] = [];

    // Extract tool usage
    const toolMatches = assistantMessage.match(/\[Tool: ([^\]]+)\]/g);
    if (toolMatches) {
      toolMatches.forEach(match => {
        const tool = match.replace(/\[Tool: ([^\]]+)\]/, '$1');
        if (!tools.includes(tool)) tools.push(tool);
      });
    }

    // Extract file references
    const fileMatches = [...userMessage, assistantMessage].join(' ').match(/[\w\-./]+\.(ts|js|json|md|py|txt|yml|yaml)\b/g);
    if (fileMatches) {
      fileMatches.forEach(file => {
        if (!files.includes(file)) files.push(file);
      });
    }

    // Extract actions from common patterns
    const actionPatterns = [
      { pattern: /creating?|create/i, action: 'create' },
      { pattern: /updating?|update/i, action: 'update' },
      { pattern: /fixing?|fix/i, action: 'fix' },
      { pattern: /analyzing?|analyze/i, action: 'analyze' },
      { pattern: /implementing?|implement/i, action: 'implement' },
      { pattern: /refactoring?|refactor/i, action: 'refactor' },
      { pattern: /testing?|test/i, action: 'test' },
      { pattern: /debugging?|debug/i, action: 'debug' }
    ];

    const combinedText = userMessage + ' ' + assistantMessage;
    actionPatterns.forEach(({ pattern, action }) => {
      if (pattern.test(combinedText) && !actions.includes(action)) {
        actions.push(action);
      }
    });

    return { tools, files, actions };
  }

  private extractDevelopmentContexts(sessions: ConversationSession[]): DevelopmentContext[] {
    const contexts: DevelopmentContext[] = [];

    for (const session of sessions) {
      // Group related exchanges into contexts
      let currentContext: Partial<DevelopmentContext> | null = null;
      let contextExchanges: ConversationExchange[] = [];

      for (const exchange of session.exchanges) {
        // Check if this exchange starts a new development context
        if (this.isContextStart(exchange)) {
          // Save previous context if exists
          if (currentContext && contextExchanges.length > 0) {
            const context = this.buildDevelopmentContext(currentContext, contextExchanges, session);
            if (context) contexts.push(context);
          }

          // Start new context
          currentContext = {
            session: session.filename,
            timestamp: exchange.timestamp
          };
          contextExchanges = [exchange];
        } else if (currentContext) {
          contextExchanges.push(exchange);
        }
      }

      // Handle final context
      if (currentContext && contextExchanges.length > 0) {
        const context = this.buildDevelopmentContext(currentContext, contextExchanges, session);
        if (context) contexts.push(context);
      }
    }

    return contexts;
  }

  private isContextStart(exchange: ConversationExchange): boolean {
    const userMessage = exchange.userMessage.toLowerCase();
    const startPatterns = [
      'help me', 'i need to', 'how do i', 'can you', 'implement',
      'create', 'fix', 'debug', 'analyze', 'review'
    ];

    return startPatterns.some(pattern => userMessage.includes(pattern));
  }

  private buildDevelopmentContext(
    partial: Partial<DevelopmentContext>,
    exchanges: ConversationExchange[],
    session: ConversationSession
  ): DevelopmentContext | null {
    if (exchanges.length === 0) return null;

    const firstExchange = exchanges[0];
    const allText = exchanges.map(e => e.userMessage + ' ' + e.assistantMessage).join(' ');

    // Determine problem type
    const problemType = this.identifyProblemType(allText);
    
    // Extract problem description
    const problemDescription = firstExchange.userMessage.split('\n')[0].trim();

    // Extract solution approach
    const solutionApproach = this.extractSolutionApproach(exchanges);

    // Extract technical details
    const technicalDetails = this.extractTechnicalDetails(exchanges);

    // Extract outcomes
    const outcomes = this.extractOutcomes(exchanges);

    return {
      problemType,
      problemDescription,
      solutionApproach,
      technicalDetails,
      outcomes,
      session: session.filename,
      timestamp: partial.timestamp || firstExchange.timestamp
    };
  }

  private identifyProblemType(text: string): string {
    const problemTypes = [
      { type: 'Bug Fix', keywords: ['bug', 'error', 'issue', 'problem', 'broken', 'fail'] },
      { type: 'Feature Implementation', keywords: ['implement', 'feature', 'add', 'create', 'new'] },
      { type: 'Refactoring', keywords: ['refactor', 'improve', 'optimize', 'cleanup', 'restructure'] },
      { type: 'Configuration', keywords: ['config', 'setup', 'install', 'configure'] },
      { type: 'Analysis', keywords: ['analyze', 'review', 'investigate', 'understand'] },
      { type: 'Testing', keywords: ['test', 'spec', 'verification', 'validate'] }
    ];

    const lowerText = text.toLowerCase();
    for (const { type, keywords } of problemTypes) {
      if (keywords.some(keyword => lowerText.includes(keyword))) {
        return type;
      }
    }

    return 'General Development';
  }

  private extractSolutionApproach(exchanges: ConversationExchange[]): string {
    // Look for assistant's first substantial response
    for (const exchange of exchanges) {
      if (exchange.assistantMessage.length > 100) {
        // Extract first paragraph or sentence
        const sentences = exchange.assistantMessage.split(/[.!?]+/);
        return sentences[0]?.trim() + '.' || '';
      }
    }
    return 'Solution approach not clearly documented';
  }

  private extractTechnicalDetails(exchanges: ConversationExchange[]): string[] {
    const details: string[] = [];
    
    exchanges.forEach(exchange => {
      // Extract technical terms
      const technicalTerms = exchange.assistantMessage.match(/`[^`]+`/g);
      if (technicalTerms) {
        technicalTerms.forEach(term => {
          const clean = term.replace(/`/g, '');
          if (!details.includes(clean)) details.push(clean);
        });
      }

      // Extract tools used
      exchange.context.tools.forEach(tool => {
        if (!details.includes(`Tool: ${tool}`)) {
          details.push(`Tool: ${tool}`);
        }
      });
    });

    return details.slice(0, 10); // Limit to top 10
  }

  private extractOutcomes(exchanges: ConversationExchange[]): string[] {
    const outcomes: string[] = [];
    const lastExchange = exchanges[exchanges.length - 1];
    
    if (lastExchange?.assistantMessage) {
      // Look for success indicators
      const successPatterns = [
        /successfully? (created|implemented|fixed|updated|completed)/gi,
        /✅.*$/gm,
        /(done|finished|completed|ready)/gi
      ];

      successPatterns.forEach(pattern => {
        const matches = lastExchange.assistantMessage.match(pattern);
        if (matches) {
          matches.forEach(match => {
            if (!outcomes.includes(match.trim())) {
              outcomes.push(match.trim());
            }
          });
        }
      });
    }

    return outcomes.slice(0, 5);
  }

  private identifyProblemSolutionPairs(sessions: ConversationSession[]): ProblemSolutionPair[] {
    const pairs: ProblemSolutionPair[] = [];

    for (const session of sessions) {
      // Look for clear problem-solution patterns
      for (let i = 0; i < session.exchanges.length - 1; i++) {
        const exchange = session.exchanges[i];
        
        if (this.isProblemDescription(exchange.userMessage)) {
          // Find the solution in subsequent exchanges
          const solutionExchanges = session.exchanges.slice(i, i + 5); // Look ahead 5 exchanges
          const solution = this.extractSolution(solutionExchanges);
          
          if (solution) {
            const problem = this.buildProblemDescription(exchange);
            pairs.push({
              problem,
              solution,
              metadata: {
                session: session.filename,
                timestamp: exchange.timestamp,
                exchanges: solutionExchanges.map(e => e.id)
              }
            });
          }
        }
      }
    }

    return pairs;
  }

  private isProblemDescription(message: string): boolean {
    const problemIndicators = [
      'error', 'problem', 'issue', 'bug', 'fail', 'broken',
      'not working', 'help with', 'struggling with', 'stuck on'
    ];
    
    const lowerMessage = message.toLowerCase();
    return problemIndicators.some(indicator => lowerMessage.includes(indicator)) &&
           message.length > 50; // Substantial description
  }

  private buildProblemDescription(exchange: ConversationExchange): ProblemSolutionPair['problem'] {
    const description = exchange.userMessage.split('\n')[0].trim();
    const context = exchange.userMessage;
    
    // Assess difficulty based on message length and complexity
    let difficulty: 'low' | 'medium' | 'high' = 'medium';
    if (context.length < 100) difficulty = 'low';
    else if (context.length > 500) difficulty = 'high';

    return {
      description,
      context,
      difficulty
    };
  }

  private extractSolution(exchanges: ConversationExchange[]): ProblemSolutionPair['solution'] | null {
    if (exchanges.length === 0) return null;

    // Find assistant response with substantial content
    const solutionExchange = exchanges.find(e => e.assistantMessage.length > 200);
    if (!solutionExchange) return null;

    const approach = this.extractSolutionApproach([solutionExchange]);
    const steps = this.extractSolutionSteps(solutionExchange.assistantMessage);
    const technologies = this.extractTechnologies(solutionExchange);
    const outcome = this.extractSolutionOutcome(exchanges);

    return {
      approach,
      steps,
      technologies,
      outcome
    };
  }

  private extractSolutionSteps(message: string): string[] {
    const steps: string[] = [];
    
    // Look for numbered lists
    const numberedSteps = message.match(/^\d+\.\s+(.+)$/gm);
    if (numberedSteps) {
      return numberedSteps.map(step => step.replace(/^\d+\.\s+/, '').trim());
    }

    // Look for bulleted lists
    const bulletedSteps = message.match(/^[-*]\s+(.+)$/gm);
    if (bulletedSteps) {
      return bulletedSteps.map(step => step.replace(/^[-*]\s+/, '').trim());
    }

    // Extract sentences that look like steps
    const sentences = message.split(/[.!?]+/);
    sentences.forEach(sentence => {
      if (sentence.includes('will') || sentence.includes('need to') || sentence.includes('should')) {
        steps.push(sentence.trim());
      }
    });

    return steps.slice(0, 5);
  }

  private extractTechnologies(exchange: ConversationExchange): string[] {
    const technologies: string[] = [];
    
    // From tools used
    exchange.context.tools.forEach(tool => technologies.push(tool));
    
    // From files (extract file extensions)
    exchange.context.files.forEach(file => {
      const ext = path.extname(file).toLowerCase();
      const techMap: Record<string, string> = {
        '.ts': 'TypeScript',
        '.js': 'JavaScript',
        '.json': 'JSON',
        '.md': 'Markdown',
        '.py': 'Python',
        '.yml': 'YAML',
        '.yaml': 'YAML'
      };
      
      if (techMap[ext] && !technologies.includes(techMap[ext])) {
        technologies.push(techMap[ext]);
      }
    });

    return technologies;
  }

  private extractSolutionOutcome(exchanges: ConversationExchange[]): string {
    const lastExchange = exchanges[exchanges.length - 1];
    
    // Look for completion indicators
    const completionPatterns = [
      'successfully completed',
      'working correctly',
      'issue resolved',
      'implemented successfully',
      'fixed the problem'
    ];

    for (const pattern of completionPatterns) {
      if (lastExchange?.assistantMessage.toLowerCase().includes(pattern)) {
        return pattern;
      }
    }

    return 'Solution implemented';
  }

  private analyzePatterns(
    sessions: ConversationSession[],
    contexts: DevelopmentContext[],
    pairs: ProblemSolutionPair[]
  ): VibeHistoryAnalysisResult['patterns'] {
    // Common problems
    const problemCounts = new Map<string, number>();
    pairs.forEach(pair => {
      const problem = pair.problem.description.substring(0, 100) + '...';
      problemCounts.set(problem, (problemCounts.get(problem) || 0) + 1);
    });

    const commonProblems = Array.from(problemCounts.entries())
      .map(([problem, frequency]) => ({ problem, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Preferred solutions
    const solutionCounts = new Map<string, number>();
    pairs.forEach(pair => {
      const approach = pair.solution.approach;
      solutionCounts.set(approach, (solutionCounts.get(approach) || 0) + 1);
    });

    const preferredSolutions = Array.from(solutionCounts.entries())
      .map(([solution, frequency]) => ({ solution, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Tool usage
    const toolCounts = new Map<string, number>();
    sessions.forEach(session => {
      session.exchanges.forEach(exchange => {
        exchange.context.tools.forEach(tool => {
          toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
        });
      });
    });

    const toolUsage = Array.from(toolCounts.entries())
      .map(([tool, frequency]) => ({ tool, frequency }))
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Development themes
    const themeCounts = new Map<string, number>();
    contexts.forEach(context => {
      themeCounts.set(context.problemType, (themeCounts.get(context.problemType) || 0) + 1);
    });

    const developmentThemes = Array.from(themeCounts.entries())
      .map(([theme, frequency]) => ({ theme, frequency }))
      .sort((a, b) => b.frequency - a.frequency);

    return {
      commonProblems,
      preferredSolutions,
      toolUsage,
      developmentThemes
    };
  }

  private async generateSummary(
    sessions: ConversationSession[],
    contexts: DevelopmentContext[],
    pairs: ProblemSolutionPair[],
    patterns: VibeHistoryAnalysisResult['patterns']
  ): Promise<VibeHistoryAnalysisResult['summary']> {
    const totalExchanges = sessions.reduce((sum, s) => sum + s.exchanges.length, 0);

    const primaryFocus = patterns.developmentThemes.length > 0
      ? patterns.developmentThemes[0].theme
      : 'General Development';

    const keyLearnings: string[] = [];

    // Extract key learnings from successful problem-solution pairs
    pairs.slice(0, 3).forEach(pair => {
      if (pair.solution.outcome !== 'Solution implemented') {
        keyLearnings.push(`${pair.problem.description.substring(0, 80)}... → ${pair.solution.outcome}`);
      }
    });

    // Add pattern insights
    if (patterns.preferredSolutions.length > 0) {
      keyLearnings.push(`Preferred approach: ${patterns.preferredSolutions[0].solution}`);
    }

    // ENHANCEMENT: Use LLM to generate richer insights from conversation patterns
    let enhancedInsights = `Analyzed ${sessions.length} conversation sessions with ${totalExchanges} exchanges. ` +
      `Primary development focus: ${primaryFocus}. ` +
      `Identified ${pairs.length} problem-solution patterns and ${contexts.length} development contexts. ` +
      `Most used tool: ${patterns.toolUsage[0]?.tool || 'N/A'}. ` +
      `Success rate: ${Math.round((pairs.length / Math.max(contexts.length, 1)) * 100)}% of contexts resulted in clear solutions.`;

    try {
      // Build context for LLM analysis
      const analysisContext = {
        sessionCount: sessions.length,
        totalExchanges,
        primaryTheme: primaryFocus,
        topProblems: patterns.commonProblems.slice(0, 3).map(p => p.problem),
        topSolutions: patterns.preferredSolutions.slice(0, 3).map(s => s.solution),
        mostUsedTools: patterns.toolUsage.slice(0, 5).map(t => t.tool),
        themes: patterns.developmentThemes.slice(0, 3).map(t => t.theme)
      };

      const prompt = `Analyze these development session patterns and provide actionable insights:

Context:
- ${analysisContext.sessionCount} sessions with ${analysisContext.totalExchanges} exchanges
- Primary focus: ${analysisContext.primaryTheme}
- Common problems: ${analysisContext.topProblems.join(', ')}
- Preferred solutions: ${analysisContext.topSolutions.join(', ')}
- Most used tools: ${analysisContext.mostUsedTools.join(', ')}
- Development themes: ${analysisContext.themes.join(', ')}

Provide a JSON response:
{
  "executiveSummary": string, // 2-3 sentence high-level summary
  "keyPatterns": string[], // 3-4 important patterns discovered
  "recommendations": string[], // 2-3 actionable recommendations
  "trendAnalysis": string // Overall trend or direction
}`;

      const result = await this.semanticAnalyzer.analyzeContent(prompt, {
        analysisType: "patterns",
        provider: "auto"
      });

      const llmInsights = JSON.parse(result.insights);

      // Enhance key learnings with LLM-discovered patterns
      if (llmInsights.keyPatterns) {
        llmInsights.keyPatterns.forEach((pattern: string) => {
          if (!keyLearnings.includes(pattern)) {
            keyLearnings.push(pattern);
          }
        });
      }

      // Use LLM-generated summary if available
      if (llmInsights.executiveSummary) {
        enhancedInsights = llmInsights.executiveSummary;
      }

      log("LLM-enhanced session summary generated", "info", {
        patternsFound: llmInsights.keyPatterns?.length || 0,
        recommendations: llmInsights.recommendations?.length || 0
      });

    } catch (error) {
      log("LLM summary enhancement failed, using template-based summary", "warning", error);
      // Fall back to template-based insights (already set above)
    }

    return {
      totalExchanges,
      primaryFocus,
      keyLearnings: keyLearnings.slice(0, 5), // Limit to top 5
      insights: enhancedInsights
    };
  }
}
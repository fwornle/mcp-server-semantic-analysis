import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { log } from "../logging.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Model tier types
export type ModelTier = "fast" | "standard" | "premium";

// Task types that map to tiers
export type TaskType =
  | "git_history_analysis" | "vibe_history_analysis" | "semantic_code_analysis"
  | "documentation_linking" | "web_search_summarization" | "ontology_classification"
  | "content_validation" | "deduplication_similarity"
  | "insight_generation" | "observation_generation" | "pattern_recognition"
  | "quality_assurance_review" | "deep_code_analysis" | "entity_significance_scoring"
  | "git_file_extraction" | "commit_message_parsing" | "file_pattern_matching"
  | "basic_classification" | "documentation_file_scanning";

export interface AnalysisOptions {
  context?: string;
  analysisType?: "general" | "code" | "patterns" | "architecture" | "diagram";
  provider?: "groq" | "gemini" | "anthropic" | "openai" | "custom" | "auto";
  tier?: ModelTier;      // Explicit tier selection
  taskType?: TaskType;   // Task type for automatic tier selection
}

export interface CodeAnalysisOptions {
  language?: string;
  filePath?: string;
  focus?: "patterns" | "quality" | "security" | "performance" | "architecture";
}

export interface PatternExtractionOptions {
  patternTypes?: string[];
  context?: string;
}

export interface AnalysisResult {
  insights: string;
  provider: string;
  confidence: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  model?: string;
}

export interface CodeAnalysisResult {
  analysis: string;
  findings: string[];
  recommendations: string[];
  patterns: string[];
}

export interface Pattern {
  name: string;
  type: string;
  description: string;
  code: string;
  usageExample?: string;
}

export interface PatternExtractionResult {
  patterns: Pattern[];
  summary: string;
}

// Tier configuration interface
interface TierConfig {
  providers: {
    [provider: string]: {
      fast?: string;
      standard?: string;
      premium?: string;
    };
  };
  provider_priority: {
    fast: string[];
    standard: string[];
    premium: string[];
  };
  task_tiers: {
    fast: string[];
    standard: string[];
    premium: string[];
  };
  agent_overrides: {
    [agent: string]: ModelTier;
  };
}

// Global LLM call metrics tracking (shared across all SemanticAnalyzer instances)
export interface LLMCallMetrics {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: number;
}

export interface StepLLMMetrics {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  providers: string[];
  calls: LLMCallMetrics[];
}

export class SemanticAnalyzer {
  // Static metrics tracking for workflow step aggregation
  private static currentStepMetrics: StepLLMMetrics = {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    providers: [],
    calls: [],
  };

  /**
   * Reset metrics tracking (call at start of each workflow step)
   */
  static resetStepMetrics(): void {
    SemanticAnalyzer.currentStepMetrics = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      providers: [],
      calls: [],
    };
  }

  /**
   * Get accumulated metrics for current step (call at end of each workflow step)
   */
  static getStepMetrics(): StepLLMMetrics {
    return { ...SemanticAnalyzer.currentStepMetrics };
  }

  /**
   * Record an LLM call's metrics
   */
  private static recordCallMetrics(result: AnalysisResult): void {
    if (result.tokenUsage) {
      const metrics: LLMCallMetrics = {
        provider: result.provider,
        model: result.model,
        inputTokens: result.tokenUsage.inputTokens,
        outputTokens: result.tokenUsage.outputTokens,
        totalTokens: result.tokenUsage.totalTokens,
        timestamp: Date.now(),
      };

      SemanticAnalyzer.currentStepMetrics.calls.push(metrics);
      SemanticAnalyzer.currentStepMetrics.totalCalls++;
      SemanticAnalyzer.currentStepMetrics.totalInputTokens += metrics.inputTokens;
      SemanticAnalyzer.currentStepMetrics.totalOutputTokens += metrics.outputTokens;
      SemanticAnalyzer.currentStepMetrics.totalTokens += metrics.totalTokens;

      if (!SemanticAnalyzer.currentStepMetrics.providers.includes(result.provider)) {
        SemanticAnalyzer.currentStepMetrics.providers.push(result.provider);
      }
    }
  }

  private groqClient: Groq | null = null;
  private geminiClient: GoogleGenerativeAI | null = null;
  private customClient: OpenAI | null = null;
  private anthropicClient: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;

  // Tier configuration
  private tierConfig: TierConfig | null = null;

  // PERFORMANCE OPTIMIZATION: Request batching for improved throughput
  // Configurable via LLM_BATCH_SIZE env var (default: 20, min: 1, max: 50)
  private batchQueue: Array<{
    prompt: string;
    options: AnalysisOptions;
    resolve: (result: AnalysisResult) => void;
    reject: (error: any) => void;
  }> = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = Math.min(Math.max(
    parseInt(process.env.LLM_BATCH_SIZE || '20', 10), 1
  ), 50);
  private readonly BATCH_TIMEOUT = 100; // ms

  constructor() {
    this.initializeClients();
    this.loadTierConfig();
  }

  /**
   * Load tier configuration from YAML file
   */
  private loadTierConfig(): void {
    try {
      // Try multiple possible locations for the config
      const possiblePaths = [
        path.join(process.cwd(), 'config', 'model-tiers.yaml'),
        path.join(process.cwd(), 'integrations', 'mcp-server-semantic-analysis', 'config', 'model-tiers.yaml'),
        path.join(__dirname, '..', '..', 'config', 'model-tiers.yaml'),
      ];

      for (const configPath of possiblePaths) {
        if (fs.existsSync(configPath)) {
          const configContent = fs.readFileSync(configPath, 'utf8');
          this.tierConfig = yaml.load(configContent) as TierConfig;
          log(`Loaded model tier config from ${configPath}`, 'info');
          return;
        }
      }

      log('No model-tiers.yaml found, using default tier mappings', 'warning');
      // Set default tier config
      this.tierConfig = this.getDefaultTierConfig();
    } catch (error) {
      log('Failed to load tier config, using defaults', 'warning', error);
      this.tierConfig = this.getDefaultTierConfig();
    }
  }

  /**
   * Get default tier configuration
   */
  private getDefaultTierConfig(): TierConfig {
    return {
      providers: {
        groq: {
          fast: 'llama-3.1-8b-instant',
          standard: 'llama-3.3-70b-versatile',
        },
        anthropic: {
          standard: 'claude-3-5-haiku-latest',
          premium: 'claude-sonnet-4-20250514',
        },
        openai: {
          standard: 'gpt-4o-mini',
          premium: 'gpt-4o',
        },
      },
      provider_priority: {
        fast: ['groq'],
        standard: ['groq', 'anthropic', 'openai'],
        premium: ['anthropic', 'openai', 'groq'],
      },
      task_tiers: {
        fast: ['git_file_extraction', 'commit_message_parsing', 'file_pattern_matching', 'basic_classification'],
        standard: ['git_history_analysis', 'vibe_history_analysis', 'semantic_code_analysis', 'documentation_linking', 'ontology_classification'],
        premium: ['insight_generation', 'observation_generation', 'pattern_recognition', 'quality_assurance_review', 'deep_code_analysis'],
      },
      agent_overrides: {
        insight_generation: 'premium',
        observation_generation: 'premium',
        quality_assurance: 'premium',
      },
    };
  }

  /**
   * Determine tier from task type
   */
  getTierForTask(taskType?: TaskType): ModelTier {
    if (!taskType) return 'standard';

    // Check environment variable override first
    const envTier = process.env.SEMANTIC_ANALYSIS_TIER?.toLowerCase() as ModelTier;
    if (envTier && ['fast', 'standard', 'premium'].includes(envTier)) {
      return envTier;
    }

    // Check task-specific env override (e.g., INSIGHT_GENERATION_TIER=premium)
    const taskEnvKey = `${taskType.toUpperCase()}_TIER`;
    const taskEnvTier = process.env[taskEnvKey]?.toLowerCase() as ModelTier;
    if (taskEnvTier && ['fast', 'standard', 'premium'].includes(taskEnvTier)) {
      return taskEnvTier;
    }

    // Look up in config
    if (this.tierConfig?.task_tiers) {
      for (const [tier, tasks] of Object.entries(this.tierConfig.task_tiers)) {
        if (tasks.includes(taskType)) {
          return tier as ModelTier;
        }
      }
    }

    return 'standard'; // Default
  }

  /**
   * Get provider and model for a specific tier
   */
  private getProviderForTier(tier: ModelTier): { provider: string; model: string } | null {
    // Check task-specific provider override (e.g., INSIGHT_GENERATION_PROVIDER=anthropic)
    const providerPriority = this.tierConfig?.provider_priority[tier] || ['groq', 'anthropic', 'openai'];

    for (const providerName of providerPriority) {
      // Check if client is available
      const clientAvailable =
        (providerName === 'groq' && this.groqClient) ||
        (providerName === 'anthropic' && this.anthropicClient) ||
        (providerName === 'openai' && this.openaiClient) ||
        (providerName === 'gemini' && this.geminiClient);

      if (!clientAvailable) continue;

      // Get model for this provider and tier
      const providerConfig = this.tierConfig?.providers[providerName];
      const model = providerConfig?.[tier] || providerConfig?.standard;

      if (model) {
        log(`Selected ${providerName}/${model} for tier ${tier}`, 'info');
        return { provider: providerName, model };
      }
    }

    return null;
  }

  /**
   * Analyze with specific provider and model (tier-based routing)
   */
  private async analyzeWithTier(prompt: string, provider: string, model: string): Promise<AnalysisResult> {
    log(`analyzeWithTier: ${provider}/${model}`, 'info', { promptLength: prompt.length });

    switch (provider) {
      case 'groq':
        return this.analyzeWithGroq(prompt, model);
      case 'anthropic':
        return this.analyzeWithAnthropic(prompt, model);
      case 'openai':
        return this.analyzeWithOpenAI(prompt, model);
      case 'gemini':
        return this.analyzeWithGemini(prompt);
      case 'custom':
        return this.analyzeWithCustom(prompt);
      default:
        throw new Error(`Unknown provider for tier: ${provider}`);
    }
  }

  // Request timeout for LLM API calls (30 seconds)
  private static readonly LLM_TIMEOUT_MS = 30000;

  private initializeClients(): void {
    // Priority order: (1) Groq (default), (2) Gemini, (3) Custom API, (4) Anthropic, (5) OpenAI

    // Initialize Groq client (highest priority - cheap, low-latency)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== "your-groq-api-key") {
      this.groqClient = new Groq({
        apiKey: groqKey,
        timeout: SemanticAnalyzer.LLM_TIMEOUT_MS,
      });
      log("Groq client initialized (default provider)", "info");
    }

    // Initialize Gemini client (second priority - cheap, good quality)
    // Note: Gemini SDK doesn't support timeout in constructor, handled per-request
    const googleKey = process.env.GOOGLE_API_KEY;
    if (googleKey && googleKey !== "your-google-api-key") {
      this.geminiClient = new GoogleGenerativeAI(googleKey);
      log("Gemini client initialized (fallback #1)", "info");
    }

    // Initialize Custom OpenAI-compatible client (third priority)
    const customBaseUrl = process.env.OPENAI_BASE_URL;
    const customKey = process.env.OPENAI_API_KEY;
    if (customBaseUrl && customKey && customKey !== "your-openai-api-key") {
      this.customClient = new OpenAI({
        apiKey: customKey,
        baseURL: customBaseUrl,
        timeout: SemanticAnalyzer.LLM_TIMEOUT_MS,
      });
      log("Custom OpenAI-compatible client initialized (fallback #2)", "info", { baseURL: customBaseUrl });
    }

    // Initialize Anthropic client (fourth priority)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey !== "your-anthropic-api-key") {
      this.anthropicClient = new Anthropic({
        apiKey: anthropicKey,
        timeout: SemanticAnalyzer.LLM_TIMEOUT_MS,
      });
      log("Anthropic client initialized (fallback #3)", "info");
    }

    // Initialize OpenAI client (fifth priority - only if no custom base URL)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && openaiKey !== "your-openai-api-key" && !customBaseUrl) {
      this.openaiClient = new OpenAI({
        apiKey: openaiKey,
        timeout: SemanticAnalyzer.LLM_TIMEOUT_MS,
      });
      log("OpenAI client initialized (fallback #4)", "info");
    }

    if (!this.groqClient && !this.geminiClient && !this.customClient && !this.anthropicClient && !this.openaiClient) {
      log("No LLM clients available - check API keys", "warning");
    }
  }

  // PERFORMANCE OPTIMIZATION: Batch processing methods
  private async processBatch(): Promise<void> {
    if (this.batchQueue.length === 0) return;
    
    const currentBatch = this.batchQueue.splice(0, this.BATCH_SIZE);
    log(`Processing batch of ${currentBatch.length} requests`, 'info');
    
    try {
      // Process batch requests in parallel
      const batchPromises = currentBatch.map(async (item) => {
        try {
          const result = await this.analyzeContentDirectly(item.prompt, item.options);
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      });
      
      await Promise.all(batchPromises);
      log(`Completed batch processing of ${currentBatch.length} requests`, 'info');
      
    } catch (error) {
      log(`Batch processing failed`, 'error', error);
      // Reject all remaining items in this batch
      currentBatch.forEach(item => item.reject(error));
    }
    
    // Schedule next batch if queue has items
    if (this.batchQueue.length > 0) {
      this.scheduleBatch();
    }
  }
  
  private scheduleBatch(): void {
    if (this.batchTimer) return; // Already scheduled
    
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.processBatch();
    }, this.BATCH_TIMEOUT);
  }
  
  // New method for direct analysis (used by batch processor)
  private async analyzeContentDirectly(content: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const { context, analysisType = "general", provider = "auto" } = options;
    const prompt = this.buildAnalysisPrompt(content, context, analysisType);

    // Use existing provider selection logic
    if (provider === "groq" && this.groqClient) {
      return await this.analyzeWithGroq(prompt);
    } else if (provider === "gemini" && this.geminiClient) {
      return await this.analyzeWithGemini(prompt);
    } else if (provider === "custom" && this.customClient) {
      return await this.analyzeWithCustom(prompt);
    } else if (provider === "anthropic" && this.anthropicClient) {
      return await this.analyzeWithAnthropic(prompt);
    } else if (provider === "openai" && this.openaiClient) {
      return await this.analyzeWithOpenAI(prompt);
    } else if (provider === "auto") {
      // Auto mode with fallback cascade: try each provider in order until one succeeds
      const providers = [
        { name: 'groq', client: this.groqClient, method: this.analyzeWithGroq.bind(this) },
        { name: 'gemini', client: this.geminiClient, method: this.analyzeWithGemini.bind(this) },
        { name: 'custom', client: this.customClient, method: this.analyzeWithCustom.bind(this) },
        { name: 'anthropic', client: this.anthropicClient, method: this.analyzeWithAnthropic.bind(this) },
        { name: 'openai', client: this.openaiClient, method: this.analyzeWithOpenAI.bind(this) }
      ];

      const errors: Array<{ provider: string; error: any }> = [];

      for (const { name, client, method } of providers) {
        if (!client) continue;

        try {
          log(`Attempting analysis with ${name}`, 'info');
          const result = await method(prompt);
          if (errors.length > 0) {
            log(`Successfully fell back to ${name} after ${errors.length} failure(s)`, 'info', {
              failedProviders: errors.map(e => e.provider)
            });
          }
          // Record metrics for step-level aggregation
          SemanticAnalyzer.recordCallMetrics(result);
          return result;
        } catch (error: any) {
          const isRateLimit = error?.status === 429 || error?.message?.includes('rate limit');
          log(`${name} analysis failed${isRateLimit ? ' (rate limit)' : ''}`, 'warning', {
            error: error?.message,
            status: error?.status
          });
          errors.push({ provider: name, error });
          // Continue to next provider
        }
      }

      // All providers failed
      log('All LLM providers failed', 'error', { errors });
      throw new Error(`All LLM providers failed. Errors: ${errors.map(e => `${e.provider}: ${e.error?.message || 'Unknown error'}`).join('; ')}`);
    }

    throw new Error("No available LLM provider");
  }

  async analyzeContent(content: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const { context, analysisType = "general", provider = "auto", tier, taskType } = options;

    // Determine effective tier (explicit tier > taskType lookup > default)
    const effectiveTier = tier || this.getTierForTask(taskType as TaskType) || 'standard';

    log(`Analyzing content with ${provider} provider, tier: ${effectiveTier}`, "info", {
      contentLength: content.length,
      analysisType,
      tier: effectiveTier,
      taskType,
      hasContext: !!context,
      groqClient: !!this.groqClient,
      geminiClient: !!this.geminiClient,
      customClient: !!this.customClient,
      anthropicClient: !!this.anthropicClient,
      openaiClient: !!this.openaiClient,
    });

    const prompt = this.buildAnalysisPrompt(content, context, analysisType);

    // If tier is specified (or derived from taskType), use tier-based selection
    if ((tier || taskType) && provider === "auto") {
      const tierSelection = this.getProviderForTier(effectiveTier);
      if (tierSelection) {
        log(`Using tier-based selection: ${tierSelection.provider}/${tierSelection.model} for tier ${effectiveTier}`, 'info');
        return this.analyzeWithTier(prompt, tierSelection.provider, tierSelection.model);
      }
    }

    // PERFORMANCE OPTIMIZATION: Use batching for non-urgent requests
    // For diagram generation and similar tasks, use batching to improve throughput
    const shouldBatch = analysisType === "diagram" || analysisType === "patterns";
    
    if (shouldBatch) {
      return new Promise<AnalysisResult>((resolve, reject) => {
        this.batchQueue.push({ prompt, options, resolve, reject });
        
        // If we have enough items for a batch, process immediately
        if (this.batchQueue.length >= this.BATCH_SIZE) {
          if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
          }
          this.processBatch();
        } else {
          // Otherwise, schedule processing
          this.scheduleBatch();
        }
      });
    }

    let result: AnalysisResult;

    // Determine which provider to use with correct precedence:
    // 1. If specific provider requested, use it
    // 2. If auto: Groq → Gemini → Custom → Anthropic → OpenAI
    if (provider === "groq") {
      if (!this.groqClient) {
        throw new Error("Groq client not available");
      }
      result = await this.analyzeWithGroq(prompt);
    } else if (provider === "gemini") {
      if (!this.geminiClient) {
        throw new Error("Gemini client not available");
      }
      result = await this.analyzeWithGemini(prompt);
    } else if (provider === "custom") {
      if (!this.customClient) {
        throw new Error("Custom client not available");
      }
      result = await this.analyzeWithCustom(prompt);
    } else if (provider === "anthropic") {
      if (!this.anthropicClient) {
        throw new Error("Anthropic client not available");
      }
      result = await this.analyzeWithAnthropic(prompt);
    } else if (provider === "openai") {
      if (!this.openaiClient) {
        throw new Error("OpenAI client not available");
      }
      result = await this.analyzeWithOpenAI(prompt);
    } else if (provider === "auto") {
      // Auto mode with fallback cascade: try each provider in order until one succeeds
      log("Entering auto mode provider selection with fallback", "info", {
        hasGroq: !!this.groqClient,
        hasGemini: !!this.geminiClient,
        hasCustom: !!this.customClient,
        hasAnthropic: !!this.anthropicClient,
        hasOpenAI: !!this.openaiClient
      });

      const providers = [
        { name: 'groq', client: this.groqClient, method: this.analyzeWithGroq.bind(this) },
        { name: 'gemini', client: this.geminiClient, method: this.analyzeWithGemini.bind(this) },
        { name: 'custom', client: this.customClient, method: this.analyzeWithCustom.bind(this) },
        { name: 'anthropic', client: this.anthropicClient, method: this.analyzeWithAnthropic.bind(this) },
        { name: 'openai', client: this.openaiClient, method: this.analyzeWithOpenAI.bind(this) }
      ];

      const errors: Array<{ provider: string; error: any }> = [];

      for (const { name, client, method } of providers) {
        if (!client) continue;

        try {
          log(`Attempting analysis with ${name}`, 'info');
          result = await method(prompt);
          if (errors.length > 0) {
            log(`Successfully fell back to ${name} after ${errors.length} failure(s)`, 'info', {
              failedProviders: errors.map(e => e.provider)
            });
          }
          break; // Success - exit loop
        } catch (error: any) {
          const isRateLimit = error?.status === 429 || error?.message?.includes('rate limit');
          log(`${name} analysis failed${isRateLimit ? ' (rate limit)' : ''}`, 'warning', {
            error: error?.message,
            status: error?.status
          });
          errors.push({ provider: name, error });
          // Continue to next provider
        }
      }

      // Check if we got a result
      if (!result!) {
        log('All LLM providers failed', 'error', { errors });
        throw new Error(`All LLM providers failed. Errors: ${errors.map(e => `${e.provider}: ${e.error?.message || 'Unknown error'}`).join('; ')}`);
      }
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    log("SemanticAnalyzer result before return", "info", {
      hasResult: !!result,
      resultType: typeof result,
      resultKeys: result ? Object.keys(result) : null
    });

    // Record metrics for step-level aggregation
    SemanticAnalyzer.recordCallMetrics(result);

    return result;
  }

  async analyzeCode(code: string, options: CodeAnalysisOptions = {}): Promise<CodeAnalysisResult> {
    const { language, filePath, focus = "patterns" } = options;

    log(`Analyzing code with focus: ${focus}`, "info", {
      codeLength: code.length,
      language,
      filePath,
    });

    const prompt = this.buildCodeAnalysisPrompt(code, language, filePath, focus);
    const result = await this.analyzeContent(prompt, {
      analysisType: "code",
      provider: "auto",
    });

    return this.parseCodeAnalysisResult(result.insights);
  }

  async extractPatterns(source: string, options: PatternExtractionOptions = {}): Promise<PatternExtractionResult> {
    const { patternTypes = ["design", "architectural", "workflow"], context } = options;

    log("Extracting patterns from source", "info", {
      sourceLength: source.length,
      patternTypes,
      hasContext: !!context,
    });

    const prompt = this.buildPatternExtractionPrompt(source, patternTypes, context);
    const result = await this.analyzeContent(prompt, {
      analysisType: "patterns",
      provider: "auto",
    });

    return this.parsePatternExtractionResult(result.insights);
  }

  private buildAnalysisPrompt(content: string, context?: string, analysisType: string = "general"): string {
    let prompt = "";

    switch (analysisType) {
      case "patterns":
        prompt = `Analyze the following content for architectural and design patterns. Identify recurring patterns, best practices, and reusable solutions.

${context ? `Context: ${context}\n\n` : ""}

Content to analyze:
${content}

Please provide:
1. List of identified patterns with clear names
2. Description of each pattern
3. Significance score (1-10)
4. Implementation details
5. Usage recommendations`;
        break;

      case "code":
        prompt = `Analyze the following code for quality, patterns, and improvements.

${context ? `Context: ${context}\n\n` : ""}

Code to analyze:
${content}

Please provide:
1. Code quality assessment
2. Identified patterns and anti-patterns
3. Security considerations
4. Performance insights
5. Improvement recommendations`;
        break;

      case "architecture":
        prompt = `Analyze the following for architectural insights and design decisions.

${context ? `Context: ${context}\n\n` : ""}

Content:
${content}

Please provide:
1. Architectural patterns identified
2. Design decisions and trade-offs
3. System structure insights
4. Scalability considerations
5. Maintainability assessment`;
        break;

      case "diagram":
        prompt = `Generate a PlantUML diagram based on the following analysis data.

${context ? `Context: ${context}\n\n` : ""}

Analysis Data:
${content}

IMPORTANT REQUIREMENTS:
- You MUST respond with a complete PlantUML diagram enclosed in @startuml and @enduml tags
- Use proper PlantUML syntax for the requested diagram type
- Make the diagram visually clear and informative with real components from the analysis
- Include meaningful relationships and annotations based on the actual data
- Do NOT provide explanatory text - ONLY the PlantUML code
- The diagram should represent the actual architectural patterns and components found in the analysis

Generate the PlantUML diagram now:`;
        break;

      default:
        prompt = `Provide a comprehensive analysis of the following content.

${context ? `Context: ${context}\n\n` : ""}

Content:
${content}

Please provide detailed insights, patterns, and recommendations.`;
    }

    return prompt;
  }

  private buildCodeAnalysisPrompt(code: string, language?: string, filePath?: string, focus: string = "patterns"): string {
    return `Analyze the following ${language || "code"} for ${focus}.
${filePath ? `File: ${filePath}\n` : ""}

Code:
${code}

Focus on ${focus} analysis and provide:
1. Main findings
2. Specific patterns or issues
3. Recommendations
4. Code examples where relevant`;
  }

  private buildPatternExtractionPrompt(source: string, patternTypes: string[], context?: string): string {
    return `Extract ${patternTypes.join(", ")} patterns from the following source.
${context ? `Context: ${context}\n` : ""}

Source:
${source}

For each pattern found, provide:
1. Pattern name (PascalCase)
2. Pattern type
3. Clear description
4. Code example
5. Usage recommendations`;
  }

  private async analyzeWithGroq(prompt: string, model?: string): Promise<AnalysisResult> {
    const selectedModel = model || "llama-3.3-70b-versatile";
    log("analyzeWithGroq called", "info", {
      hasClient: !!this.groqClient,
      promptLength: prompt.length,
      model: selectedModel
    });

    if (!this.groqClient) {
      throw new Error("Groq client not initialized");
    }

    try {
      log(`Making Groq API call with model ${selectedModel}`, "info");
      const response = await this.groqClient.chat.completions.create({
        model: selectedModel,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      });

      log("Groq API response received", "info", {
        hasChoices: !!response.choices,
        choicesLength: response.choices?.length
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in Groq response");
      }

      // Capture token usage from response
      const usage = response.usage;
      const result: AnalysisResult = {
        insights: content,
        provider: "groq",
        confidence: 0.85,
        model: selectedModel,
        tokenUsage: usage ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        } : undefined,
      };

      log("analyzeWithGroq returning result", "info", {
        hasInsights: !!result.insights,
        insightsLength: result.insights?.length,
        provider: result.provider,
        tokenUsage: result.tokenUsage,
      });

      return result;
    } catch (error) {
      log("Groq analysis failed", "error", error);
      throw error;
    }
  }

  private async analyzeWithGemini(prompt: string): Promise<AnalysisResult> {
    log("analyzeWithGemini called", "info", {
      hasClient: !!this.geminiClient,
      promptLength: prompt.length
    });

    if (!this.geminiClient) {
      throw new Error("Gemini client not initialized");
    }

    try {
      log("Making Gemini API call", "info");
      const model = this.geminiClient.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
      const response = await model.generateContent(prompt);
      const text = response.response.text();

      log("Gemini API response received", "info", {
        hasText: !!text,
        textLength: text?.length
      });

      if (!text) {
        throw new Error("No content in Gemini response");
      }

      // Capture token usage from response if available (Gemini uses usageMetadata)
      const usageMetadata = response.response.usageMetadata;
      const result: AnalysisResult = {
        insights: text,
        provider: "gemini",
        confidence: 0.88,
        model: "gemini-2.0-flash-exp",
        tokenUsage: usageMetadata ? {
          inputTokens: usageMetadata.promptTokenCount || 0,
          outputTokens: usageMetadata.candidatesTokenCount || 0,
          totalTokens: usageMetadata.totalTokenCount || 0,
        } : undefined,
      };

      log("analyzeWithGemini returning result", "info", {
        hasInsights: !!result.insights,
        insightsLength: result.insights?.length,
        provider: result.provider,
        tokenUsage: result.tokenUsage,
      });

      return result;
    } catch (error) {
      log("Gemini analysis failed", "error", error);
      throw error;
    }
  }

  private async analyzeWithAnthropic(prompt: string, model?: string): Promise<AnalysisResult> {
    const selectedModel = model || "claude-sonnet-4-20250514";
    log("analyzeWithAnthropic called", "info", {
      hasClient: !!this.anthropicClient,
      promptLength: prompt.length,
      model: selectedModel
    });

    if (!this.anthropicClient) {
      throw new Error("Anthropic client not initialized");
    }

    try {
      log(`Making Anthropic API call with model ${selectedModel}`, "info");
      const response = await this.anthropicClient.messages.create({
        model: selectedModel,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      
      log("Anthropic API response received", "info", {
        hasContent: !!response.content,
        contentLength: response.content?.length,
        firstContentType: response.content?.[0]?.type
      });

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from Anthropic");
      }

      // Capture token usage from response
      const usage = response.usage;
      const result: AnalysisResult = {
        insights: content.text,
        provider: "anthropic",
        confidence: 0.9,
        model: selectedModel,
        tokenUsage: usage ? {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        } : undefined,
      };

      log("analyzeWithAnthropic returning result", "info", {
        hasInsights: !!result.insights,
        insightsLength: result.insights?.length,
        provider: result.provider,
        tokenUsage: result.tokenUsage,
      });

      return result;
    } catch (error) {
      log("Anthropic analysis failed", "error", error);
      throw error;
    }
  }

  private async analyzeWithOpenAI(prompt: string, model?: string): Promise<AnalysisResult> {
    const selectedModel = model || "gpt-4-turbo-preview";
    if (!this.openaiClient) {
      throw new Error("OpenAI client not initialized");
    }

    try {
      log(`Making OpenAI API call with model ${selectedModel}`, "info");
      const response = await this.openaiClient.chat.completions.create({
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in OpenAI response");
      }

      // Capture token usage from response
      const usage = response.usage;
      return {
        insights: content,
        provider: "openai",
        confidence: 0.85,
        model: selectedModel,
        tokenUsage: usage ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        } : undefined,
      };
    } catch (error) {
      log("OpenAI analysis failed", "error", error);
      throw error;
    }
  }

  private async analyzeWithCustom(prompt: string): Promise<AnalysisResult> {
    if (!this.customClient) {
      throw new Error("Custom client not initialized");
    }

    try {
      const response = await this.customClient.chat.completions.create({
        model: "gpt-4", // Default model, can be overridden by corporate config
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in custom provider response");
      }

      // Capture token usage from response
      const usage = response.usage;
      return {
        insights: content,
        provider: "custom",
        confidence: 0.9,
        model: "gpt-4",
        tokenUsage: usage ? {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
        } : undefined,
      };
    } catch (error) {
      log("Custom provider analysis failed", "error", error);
      throw error;
    }
  }

  private parseCodeAnalysisResult(insights: string): CodeAnalysisResult {
    // Basic parsing - in production, this would be more sophisticated
    const lines = insights.split("\n");
    const findings: string[] = [];
    const recommendations: string[] = [];
    const patterns: string[] = [];

    let currentSection = "";
    for (const line of lines) {
      if (line.includes("finding") || line.includes("issue")) {
        currentSection = "findings";
      } else if (line.includes("recommend") || line.includes("suggestion")) {
        currentSection = "recommendations";
      } else if (line.includes("pattern")) {
        currentSection = "patterns";
      } else if (line.trim() && currentSection) {
        switch (currentSection) {
          case "findings":
            findings.push(line.trim());
            break;
          case "recommendations":
            recommendations.push(line.trim());
            break;
          case "patterns":
            patterns.push(line.trim());
            break;
        }
      }
    }

    return {
      analysis: insights,
      findings,
      recommendations,
      patterns,
    };
  }

  private parsePatternExtractionResult(insights: string): PatternExtractionResult {
    const patterns: Pattern[] = [];
    const lines = insights.split("\n");
    
    let currentPattern: Partial<Pattern> | null = null;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.match(/^(Pattern|Name):\s*(.+)/i)) {
        if (currentPattern?.name) {
          patterns.push(this.finalizePattern(currentPattern));
        }
        currentPattern = { name: RegExp.$2.trim() };
      } else if (currentPattern) {
        if (trimmed.match(/^Type:\s*(.+)/i)) {
          currentPattern.type = RegExp.$1.trim();
        } else if (trimmed.match(/^Description:\s*(.+)/i)) {
          currentPattern.description = RegExp.$1.trim();
        } else if (trimmed.match(/^Code:|Example:/i)) {
          currentPattern.code = "";
        } else if (currentPattern.code !== undefined && trimmed) {
          currentPattern.code += trimmed + "\n";
        }
      }
    }
    
    if (currentPattern?.name) {
      patterns.push(this.finalizePattern(currentPattern));
    }

    return {
      patterns,
      summary: `Extracted ${patterns.length} patterns from analysis`,
    };
  }

  private finalizePattern(partial: Partial<Pattern>): Pattern {
    return {
      name: partial.name || "UnnamedPattern",
      type: partial.type || "general",
      description: partial.description || "Pattern extracted from analysis",
      code: partial.code || "",
      usageExample: partial.usageExample,
    };
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // For now, return a mock embedding - in production, use actual embedding model
    log("Generating embedding for text", "info", { textLength: text.length });
    
    // Mock embedding - replace with actual embedding generation
    const mockEmbedding = Array(384).fill(0).map(() => Math.random());
    return mockEmbedding;
  }

  async analyzeDifferences(content1: string, content2: string): Promise<{ hasUniqueValue: boolean; differences: string[] }> {
    const prompt = `Compare these two pieces of content and identify unique valuable differences:

Content 1:
${content1}

Content 2:
${content2}

Identify:
1. Unique insights in Content 1 not present in Content 2
2. Whether Content 1 adds meaningful new information
3. Key differences between the contents`;

    const result = await this.analyzeContent(prompt, { analysisType: "general" });

    // Parse the response to determine if there's unique value
    const hasUniqueValue = result.insights.toLowerCase().includes("unique") ||
                          result.insights.toLowerCase().includes("new information");

    return {
      hasUniqueValue,
      differences: [result.insights],
    };
  }

  // ============================================================================
  // MULTI-AGENT SYSTEM: AgentResponse Envelope Methods
  // These methods return the standard AgentResponse envelope for the new
  // multi-agent routing system. Existing methods are preserved for compatibility.
  // ============================================================================

  /**
   * Analyze content and return result wrapped in AgentResponse envelope
   * This is the primary method for the multi-agent system
   */
  async analyzeContentWithEnvelope(
    content: string,
    options: AnalysisOptions & {
      stepName?: string;
      upstreamConfidence?: number;
      upstreamIssues?: Array<{ severity: string; message: string }>;
    } = {}
  ): Promise<{
    data: AnalysisResult;
    metadata: {
      confidence: number;
      confidenceBreakdown: {
        dataCompleteness: number;
        semanticCoherence: number;
        upstreamInfluence: number;
        processingQuality: number;
      };
      qualityScore: number;
      issues: Array<{
        severity: 'critical' | 'warning' | 'info';
        category: string;
        code: string;
        message: string;
        retryable: boolean;
        suggestedFix?: string;
      }>;
      warnings: string[];
      processingTimeMs: number;
      modelUsed?: string;
      tokenUsage?: { input: number; output: number; total: number };
    };
    routing: {
      suggestedNextSteps: string[];
      skipRecommendations: string[];
      escalationNeeded: boolean;
      escalationReason?: string;
      retryRecommendation?: {
        shouldRetry: boolean;
        reason: string;
        suggestedChanges: string;
      };
    };
    timestamp: string;
    agentId: string;
    stepName: string;
  }> {
    const startTime = Date.now();
    const issues: Array<{
      severity: 'critical' | 'warning' | 'info';
      category: string;
      code: string;
      message: string;
      retryable: boolean;
      suggestedFix?: string;
    }> = [];
    const warnings: string[] = [];
    let modelUsed: string | undefined;

    try {
      // Validate input
      const inputValidation = this.validateInput(content, options);
      if (!inputValidation.valid) {
        issues.push({
          severity: 'warning',
          category: 'data_quality',
          code: 'INPUT_VALIDATION_WARNING',
          message: inputValidation.message || 'Input validation issue',
          retryable: false,
        });
      }

      // Check upstream context
      if (options.upstreamConfidence !== undefined && options.upstreamConfidence < 0.5) {
        warnings.push(`Upstream confidence is low (${options.upstreamConfidence.toFixed(2)}), results may be affected`);
      }

      // Perform analysis
      const result = await this.analyzeContent(content, options);
      modelUsed = result.provider;

      // Calculate confidence
      const confidenceBreakdown = this.calculateSemanticConfidence(content, result, options);
      const overallConfidence = this.computeOverallConfidence(confidenceBreakdown);

      // Detect issues in result
      const resultIssues = this.detectResultIssues(result, confidenceBreakdown);
      issues.push(...resultIssues);

      // Generate routing suggestions
      const routing = this.generateRoutingSuggestions(overallConfidence, issues, options);

      const processingTimeMs = Date.now() - startTime;

      return {
        data: result,
        metadata: {
          confidence: overallConfidence,
          confidenceBreakdown,
          qualityScore: Math.round(overallConfidence * 100),
          issues,
          warnings,
          processingTimeMs,
          modelUsed,
        },
        routing,
        timestamp: new Date().toISOString(),
        agentId: 'semantic_analyzer',
        stepName: options.stepName || 'semantic_analysis',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const processingTimeMs = Date.now() - startTime;

      issues.push({
        severity: 'critical',
        category: 'processing_error',
        code: 'SEMANTIC_ANALYSIS_FAILED',
        message: `Analysis failed: ${errorMessage}`,
        retryable: true,
        suggestedFix: 'Retry with smaller content or different provider',
      });

      return {
        data: { insights: '', provider: 'error', confidence: 0 },
        metadata: {
          confidence: 0,
          confidenceBreakdown: {
            dataCompleteness: 0,
            semanticCoherence: 0,
            upstreamInfluence: options.upstreamConfidence ?? 1,
            processingQuality: 0,
          },
          qualityScore: 0,
          issues,
          warnings,
          processingTimeMs,
        },
        routing: {
          suggestedNextSteps: [],
          skipRecommendations: [],
          escalationNeeded: false,
          retryRecommendation: {
            shouldRetry: true,
            reason: 'Analysis failed due to error',
            suggestedChanges: 'Check content length and format, retry with different parameters',
          },
        },
        timestamp: new Date().toISOString(),
        agentId: 'semantic_analyzer',
        stepName: options.stepName || 'semantic_analysis',
      };
    }
  }

  /**
   * Validate input content and options
   */
  private validateInput(content: string, options: AnalysisOptions): { valid: boolean; message?: string } {
    if (!content || content.trim().length === 0) {
      return { valid: false, message: 'Content is empty' };
    }

    if (content.length > 100000) {
      return { valid: false, message: 'Content exceeds maximum length (100KB)' };
    }

    if (content.length < 10) {
      return { valid: false, message: 'Content is too short for meaningful analysis' };
    }

    return { valid: true };
  }

  /**
   * Calculate confidence breakdown for semantic analysis
   */
  private calculateSemanticConfidence(
    content: string,
    result: AnalysisResult,
    options: AnalysisOptions & { upstreamConfidence?: number }
  ): {
    dataCompleteness: number;
    semanticCoherence: number;
    upstreamInfluence: number;
    processingQuality: number;
  } {
    // Data completeness: based on input quality
    let dataCompleteness = 0.8;
    if (content.length > 1000) dataCompleteness = 0.9;
    if (content.length > 5000) dataCompleteness = 1.0;
    if (content.length < 100) dataCompleteness = 0.5;

    // Semantic coherence: based on result quality
    let semanticCoherence = result.confidence; // Use existing confidence
    if (result.insights.length < 50) semanticCoherence *= 0.7; // Short response
    if (result.insights.toLowerCase().includes('error')) semanticCoherence *= 0.8;
    if (result.insights.toLowerCase().includes('unable to')) semanticCoherence *= 0.7;

    // Upstream influence: from context
    const upstreamInfluence = options.upstreamConfidence ?? 1.0;

    // Processing quality: based on provider reliability
    let processingQuality = 0.85;
    if (result.provider === 'groq') processingQuality = 0.9;
    if (result.provider === 'anthropic') processingQuality = 0.95;
    if (result.provider === 'openai') processingQuality = 0.92;
    if (result.provider === 'error') processingQuality = 0;

    return {
      dataCompleteness: Math.min(1, Math.max(0, dataCompleteness)),
      semanticCoherence: Math.min(1, Math.max(0, semanticCoherence)),
      upstreamInfluence: Math.min(1, Math.max(0, upstreamInfluence)),
      processingQuality: Math.min(1, Math.max(0, processingQuality)),
    };
  }

  /**
   * Compute overall confidence from breakdown
   */
  private computeOverallConfidence(breakdown: {
    dataCompleteness: number;
    semanticCoherence: number;
    upstreamInfluence: number;
    processingQuality: number;
  }): number {
    const weights = {
      dataCompleteness: 0.2,
      semanticCoherence: 0.35,
      upstreamInfluence: 0.2,
      processingQuality: 0.25,
    };

    return (
      breakdown.dataCompleteness * weights.dataCompleteness +
      breakdown.semanticCoherence * weights.semanticCoherence +
      breakdown.upstreamInfluence * weights.upstreamInfluence +
      breakdown.processingQuality * weights.processingQuality
    );
  }

  /**
   * Detect issues in the analysis result
   */
  private detectResultIssues(
    result: AnalysisResult,
    confidence: { dataCompleteness: number; semanticCoherence: number; processingQuality: number }
  ): Array<{
    severity: 'critical' | 'warning' | 'info';
    category: string;
    code: string;
    message: string;
    retryable: boolean;
    suggestedFix?: string;
  }> {
    const issues: Array<{
      severity: 'critical' | 'warning' | 'info';
      category: string;
      code: string;
      message: string;
      retryable: boolean;
      suggestedFix?: string;
    }> = [];

    // Check for empty or very short insights
    if (!result.insights || result.insights.length < 20) {
      issues.push({
        severity: 'warning',
        category: 'data_quality',
        code: 'SHORT_INSIGHTS',
        message: 'Analysis returned very short or empty insights',
        retryable: true,
        suggestedFix: 'Increase content detail or use premium tier',
      });
    }

    // Check for low confidence
    if (result.confidence < 0.5) {
      issues.push({
        severity: 'warning',
        category: 'low_confidence',
        code: 'LOW_RESULT_CONFIDENCE',
        message: `Analysis confidence is low (${result.confidence.toFixed(2)})`,
        retryable: true,
        suggestedFix: 'Review input quality and retry with premium tier',
      });
    }

    // Check semantic coherence
    if (confidence.semanticCoherence < 0.5) {
      issues.push({
        severity: 'warning',
        category: 'semantic_mismatch',
        code: 'LOW_SEMANTIC_COHERENCE',
        message: 'Analysis result has low semantic coherence',
        retryable: true,
        suggestedFix: 'Provide more context or clearer input',
      });
    }

    // Check for error indicators in response
    const errorPhrases = ['unable to analyze', 'cannot determine', 'insufficient information', 'error occurred'];
    for (const phrase of errorPhrases) {
      if (result.insights.toLowerCase().includes(phrase)) {
        issues.push({
          severity: 'info',
          category: 'data_quality',
          code: 'ANALYSIS_UNCERTAINTY',
          message: `Analysis indicates uncertainty: "${phrase}"`,
          retryable: false,
        });
        break;
      }
    }

    return issues;
  }

  /**
   * Generate routing suggestions based on analysis results
   */
  private generateRoutingSuggestions(
    confidence: number,
    issues: Array<{ severity: string; retryable: boolean; message: string }>,
    options: AnalysisOptions
  ): {
    suggestedNextSteps: string[];
    skipRecommendations: string[];
    escalationNeeded: boolean;
    escalationReason?: string;
    retryRecommendation?: {
      shouldRetry: boolean;
      reason: string;
      suggestedChanges: string;
    };
  } {
    const routing: {
      suggestedNextSteps: string[];
      skipRecommendations: string[];
      escalationNeeded: boolean;
      escalationReason?: string;
      retryRecommendation?: {
        shouldRetry: boolean;
        reason: string;
        suggestedChanges: string;
      };
    } = {
      suggestedNextSteps: [],
      skipRecommendations: [],
      escalationNeeded: false,
    };

    // If confidence is very low, suggest retry
    if (confidence < 0.4) {
      const retryableIssues = issues.filter(i => i.retryable);
      if (retryableIssues.length > 0) {
        routing.retryRecommendation = {
          shouldRetry: true,
          reason: `Low confidence (${confidence.toFixed(2)}) with ${retryableIssues.length} retryable issue(s)`,
          suggestedChanges: retryableIssues.map(i => i.message).join('; '),
        };
      }
    }

    // Check for critical issues needing escalation
    const criticalNonRetryable = issues.filter(i => i.severity === 'critical' && !i.retryable);
    if (criticalNonRetryable.length > 0) {
      routing.escalationNeeded = true;
      routing.escalationReason = criticalNonRetryable.map(i => i.message).join('; ');
    }

    // Suggest next steps based on analysis type
    if (confidence > 0.7) {
      if (options.analysisType === 'code') {
        routing.suggestedNextSteps.push('ontology_classification', 'insight_generation');
      } else if (options.analysisType === 'patterns') {
        routing.suggestedNextSteps.push('quality_assurance');
      }
    }

    // Skip recommendations for low confidence
    if (confidence < 0.3) {
      routing.skipRecommendations.push('insight_generation'); // Skip if base analysis failed
    }

    return routing;
  }
}
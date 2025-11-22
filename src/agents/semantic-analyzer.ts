import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { log } from "../logging.js";

export interface AnalysisOptions {
  context?: string;
  analysisType?: "general" | "code" | "patterns" | "architecture" | "diagram";
  provider?: "groq" | "gemini" | "anthropic" | "openai" | "custom" | "auto";
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

export class SemanticAnalyzer {
  private groqClient: Groq | null = null;
  private geminiClient: GoogleGenerativeAI | null = null;
  private customClient: OpenAI | null = null;
  private anthropicClient: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;
  
  // PERFORMANCE OPTIMIZATION: Request batching for improved throughput
  private batchQueue: Array<{ 
    prompt: string; 
    options: AnalysisOptions; 
    resolve: (result: AnalysisResult) => void; 
    reject: (error: any) => void;
  }> = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_SIZE = 5;
  private readonly BATCH_TIMEOUT = 100; // ms

  constructor() {
    this.initializeClients();
  }

  private initializeClients(): void {
    // Priority order: (1) Groq (default), (2) Gemini, (3) Custom API, (4) Anthropic, (5) OpenAI

    // Initialize Groq client (highest priority - cheap, low-latency)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== "your-groq-api-key") {
      this.groqClient = new Groq({
        apiKey: groqKey,
      });
      log("Groq client initialized (default provider)", "info");
    }

    // Initialize Gemini client (second priority - cheap, good quality)
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
      });
      log("Custom OpenAI-compatible client initialized (fallback #2)", "info", { baseURL: customBaseUrl });
    }

    // Initialize Anthropic client (fourth priority)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey !== "your-anthropic-api-key") {
      this.anthropicClient = new Anthropic({
        apiKey: anthropicKey,
      });
      log("Anthropic client initialized (fallback #3)", "info");
    }

    // Initialize OpenAI client (fifth priority - only if no custom base URL)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && openaiKey !== "your-openai-api-key" && !customBaseUrl) {
      this.openaiClient = new OpenAI({
        apiKey: openaiKey,
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
      if (this.groqClient) {
        return await this.analyzeWithGroq(prompt);
      } else if (this.geminiClient) {
        return await this.analyzeWithGemini(prompt);
      } else if (this.customClient) {
        return await this.analyzeWithCustom(prompt);
      } else if (this.anthropicClient) {
        return await this.analyzeWithAnthropic(prompt);
      } else if (this.openaiClient) {
        return await this.analyzeWithOpenAI(prompt);
      }
    }

    throw new Error("No available LLM provider");
  }

  async analyzeContent(content: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const { context, analysisType = "general", provider = "auto" } = options;

    log(`Analyzing content with ${provider} provider`, "info", {
      contentLength: content.length,
      analysisType,
      hasContext: !!context,
      groqClient: !!this.groqClient,
      geminiClient: !!this.geminiClient,
      customClient: !!this.customClient,
      anthropicClient: !!this.anthropicClient,
      openaiClient: !!this.openaiClient,
    });

    const prompt = this.buildAnalysisPrompt(content, context, analysisType);

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
      // Auto mode: Groq → Gemini → Custom → Anthropic → OpenAI priority
      log("Entering auto mode provider selection", "info", {
        hasGroq: !!this.groqClient,
        hasGemini: !!this.geminiClient,
        hasCustom: !!this.customClient,
        hasAnthropic: !!this.anthropicClient,
        hasOpenAI: !!this.openaiClient
      });

      if (this.groqClient) {
        log("Using Groq client (auto mode default)", "info");
        result = await this.analyzeWithGroq(prompt);
      } else if (this.geminiClient) {
        log("Using Gemini client (auto mode fallback #1)", "info");
        result = await this.analyzeWithGemini(prompt);
      } else if (this.customClient) {
        log("Using Custom client (auto mode fallback #2)", "info");
        result = await this.analyzeWithCustom(prompt);
      } else if (this.anthropicClient) {
        log("Using Anthropic client (auto mode fallback #3)", "info");
        result = await this.analyzeWithAnthropic(prompt);
      } else if (this.openaiClient) {
        log("Using OpenAI client (auto mode fallback #4)", "info");
        result = await this.analyzeWithOpenAI(prompt);
      } else {
        throw new Error("No available LLM provider");
      }
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }

    log("SemanticAnalyzer result before return", "info", {
      hasResult: !!result,
      resultType: typeof result,
      resultKeys: result ? Object.keys(result) : null
    });

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

  private async analyzeWithGroq(prompt: string): Promise<AnalysisResult> {
    log("analyzeWithGroq called", "info", {
      hasClient: !!this.groqClient,
      promptLength: prompt.length
    });

    if (!this.groqClient) {
      throw new Error("Groq client not initialized");
    }

    try {
      log("Making Groq API call", "info");
      const response = await this.groqClient.chat.completions.create({
        model: "llama-3.3-70b-versatile",
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

      const result = {
        insights: content,
        provider: "groq",
        confidence: 0.85,
      };

      log("analyzeWithGroq returning result", "info", {
        hasInsights: !!result.insights,
        insightsLength: result.insights?.length,
        provider: result.provider
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

      const result = {
        insights: text,
        provider: "gemini",
        confidence: 0.88,
      };

      log("analyzeWithGemini returning result", "info", {
        hasInsights: !!result.insights,
        insightsLength: result.insights?.length,
        provider: result.provider
      });

      return result;
    } catch (error) {
      log("Gemini analysis failed", "error", error);
      throw error;
    }
  }

  private async analyzeWithAnthropic(prompt: string): Promise<AnalysisResult> {
    log("analyzeWithAnthropic called", "info", {
      hasClient: !!this.anthropicClient,
      promptLength: prompt.length
    });
    
    if (!this.anthropicClient) {
      throw new Error("Anthropic client not initialized");
    }

    try {
      log("Making Anthropic API call", "info");
      const response = await this.anthropicClient.messages.create({
        model: "claude-sonnet-4-20250514",
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

      const result = {
        insights: content.text,
        provider: "anthropic",
        confidence: 0.9,
      };
      
      log("analyzeWithAnthropic returning result", "info", {
        hasInsights: !!result.insights,
        insightsLength: result.insights?.length,
        provider: result.provider
      });

      return result;
    } catch (error) {
      log("Anthropic analysis failed", "error", error);
      throw error;
    }
  }

  private async analyzeWithOpenAI(prompt: string): Promise<AnalysisResult> {
    if (!this.openaiClient) {
      throw new Error("OpenAI client not initialized");
    }

    try {
      const response = await this.openaiClient.chat.completions.create({
        model: "gpt-4-turbo-preview",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No content in OpenAI response");
      }

      return {
        insights: content,
        provider: "openai",
        confidence: 0.85,
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

      return {
        insights: content,
        provider: "custom",
        confidence: 0.9,
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
}
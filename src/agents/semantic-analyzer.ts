import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { log } from "../logging.js";

export interface AnalysisOptions {
  context?: string;
  analysisType?: "general" | "code" | "patterns" | "architecture" | "diagram";
  provider?: "anthropic" | "openai" | "custom" | "auto";
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
  private customClient: OpenAI | null = null;
  private anthropicClient: Anthropic | null = null;
  private openaiClient: OpenAI | null = null;

  constructor() {
    this.initializeClients();
  }

  private initializeClients(): void {
    // Priority order: (1) Custom API (corporate/local), (2) Anthropic, (3) OpenAI

    // Initialize Custom OpenAI-compatible client (highest priority)
    const customBaseUrl = process.env.OPENAI_BASE_URL;
    const customKey = process.env.OPENAI_API_KEY;
    if (customBaseUrl && customKey && customKey !== "your-openai-api-key") {
      this.customClient = new OpenAI({
        apiKey: customKey,
        baseURL: customBaseUrl,
      });
      log("Custom OpenAI-compatible client initialized", "info", { baseURL: customBaseUrl });
    }

    // Initialize Anthropic client (second priority)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && anthropicKey !== "your-anthropic-api-key") {
      this.anthropicClient = new Anthropic({
        apiKey: anthropicKey,
      });
      log("Anthropic client initialized", "info");
    }

    // Initialize OpenAI client (third priority - only if no custom base URL)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey && openaiKey !== "your-openai-api-key" && !customBaseUrl) {
      this.openaiClient = new OpenAI({
        apiKey: openaiKey,
      });
      log("OpenAI client initialized", "info");
    }

    if (!this.customClient && !this.anthropicClient && !this.openaiClient) {
      log("No LLM clients available - check API keys", "warning");
    }
  }

  async analyzeContent(content: string, options: AnalysisOptions = {}): Promise<AnalysisResult> {
    const { context, analysisType = "general", provider = "auto" } = options;

    log(`Analyzing content with ${provider} provider`, "info", {
      contentLength: content.length,
      analysisType,
      hasContext: !!context,
      customClient: !!this.customClient,
      anthropicClient: !!this.anthropicClient,
      openaiClient: !!this.openaiClient,
    });

    const prompt = this.buildAnalysisPrompt(content, context, analysisType);

    let result: AnalysisResult;

    // Determine which provider to use with correct precedence:
    // 1. If specific provider requested, use it
    // 2. If auto: Custom → Anthropic → OpenAI
    if (provider === "custom") {
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
      // Auto mode: Custom → Anthropic → OpenAI priority
      log("Entering auto mode provider selection", "info", {
        hasCustom: !!this.customClient,
        hasAnthropic: !!this.anthropicClient,
        hasOpenAI: !!this.openaiClient
      });
      
      if (this.customClient) {
        log("Using Custom client (auto mode top priority)", "info");
        result = await this.analyzeWithCustom(prompt);
      } else if (this.anthropicClient) {
        log("Using Anthropic client (auto mode second priority)", "info");
        result = await this.analyzeWithAnthropic(prompt);
      } else if (this.openaiClient) {
        log("Using OpenAI client (auto mode fallback)", "info");
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
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 4000,
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
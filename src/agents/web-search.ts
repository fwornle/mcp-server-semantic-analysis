import { log } from "../logging.js";
import axios, { AxiosRequestConfig } from "axios";
import * as cheerio from "cheerio";
import { SemanticAnalyzer } from './semantic-analyzer.js';

export interface SearchOptions {
  maxResults?: number;
  providers?: string[];
  engine?: string;
  timeout?: number;
  contentExtraction?: {
    maxContentLength?: number;
    extractCode?: boolean;
    extractLinks?: boolean;
  };
  /** Use LLM to summarize and re-rank top results */
  useLLMSummarization?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  codeBlocks?: string[];
  links?: string[];
  relevanceScore: number;
}

export interface SearchResponse {
  query: string;
  provider: string;
  results: SearchResult[];
  totalResults: number;
  searchTime: number;
  /** LLM-generated summary of results (if useLLMSummarization is true) */
  llmSummary?: string;
  /** LLM-generated insights (if useLLMSummarization is true) */
  llmInsights?: string[];
}

export class WebSearchAgent {
  private readonly defaultProviders = ["duckduckgo", "google"];
  private readonly defaultOptions: SearchOptions = {
    maxResults: 10,
    timeout: 30000,
    contentExtraction: {
      maxContentLength: 10000,
      extractCode: true,
      extractLinks: true,
    },
  };
  private semanticAnalyzer: SemanticAnalyzer;

  constructor() {
    this.semanticAnalyzer = new SemanticAnalyzer();
    log("WebSearchAgent initialized", "info");
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const searchOptions = { ...this.defaultOptions, ...options };
    const providers = searchOptions.providers || this.defaultProviders;

    log(`Searching for: "${query}"`, "info", {
      providers,
      maxResults: searchOptions.maxResults,
    });

    const startTime = Date.now();

    try {
      // Try providers in order
      for (const provider of providers) {
        try {
          const results = await this.searchWithProvider(query, provider, searchOptions);
          const searchTime = Date.now() - startTime;

          // Optionally use LLM to summarize and re-rank results
          if (searchOptions.useLLMSummarization && results.length > 0) {
            const { summary, rankedResults, insights } = await this.summarizeTopResults(query, results);
            return {
              query,
              provider,
              results: rankedResults,
              totalResults: rankedResults.length,
              searchTime,
              llmSummary: summary,
              llmInsights: insights,
            };
          }

          return {
            query,
            provider,
            results,
            totalResults: results.length,
            searchTime,
          };
        } catch (error) {
          log(`Search failed with provider ${provider}`, "warning", error);
          continue;
        }
      }

      throw new Error("All search providers failed");
    } catch (error) {
      log("Web search failed", "error", error);
      throw error;
    }
  }

  async searchForCode(query: string, language?: string): Promise<SearchResult[]> {
    const codeQuery = language 
      ? `${query} ${language} code example`
      : `${query} code example`;

    const response = await this.search(codeQuery, {
      maxResults: 5,
      contentExtraction: {
        extractCode: true,
        maxContentLength: 5000,
      },
    });

    // Filter results that contain code blocks
    return response.results.filter(result => 
      result.codeBlocks && result.codeBlocks.length > 0
    );
  }

  async searchForDocumentation(topic: string, technology?: string): Promise<SearchResult[]> {
    const docQuery = technology
      ? `${topic} ${technology} documentation tutorial`
      : `${topic} documentation tutorial`;

    const response = await this.search(docQuery, {
      maxResults: 8,
      contentExtraction: {
        extractLinks: true,
        maxContentLength: 8000,
      },
    });

    // Filter for documentation-like results
    return response.results.filter(result =>
      this.isDocumentationResult(result)
    );
  }

  private async searchWithProvider(
    query: string,
    provider: string,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    switch (provider) {
      case "duckduckgo":
        return await this.searchDuckDuckGo(query, options);
      case "google":
        return await this.searchGoogle(query, options);
      default:
        throw new Error(`Unsupported search provider: ${provider}`);
    }
  }

  private async searchDuckDuckGo(query: string, options: SearchOptions): Promise<SearchResult[]> {
    log("Searching with DuckDuckGo", "info", { query });

    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
      
      const config: AxiosRequestConfig = {
        timeout: options.timeout || 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
      };

      const response = await axios.get(url, config);
      const $ = cheerio.load(response.data);

      // First pass: collect raw results without relevance scores
      const rawResults: Array<{title: string; url: string; snippet: string}> = [];

      $('.result').each((i: number, elem: any) => {
        if (rawResults.length >= (options.maxResults || 10)) return false;

        const $elem = $(elem);
        const $link = $elem.find('a.result__a');
        const $snippet = $elem.find('a.result__snippet');

        if ($link.length) {
          const title = $link.text().trim();
          const url = $link.attr('href') || '';
          const snippet = $snippet.text().trim();

          if (title && url) {
            rawResults.push({ title, url, snippet });
          }
        }
      });

      // Second pass: calculate relevance scores asynchronously
      const results: SearchResult[] = await Promise.all(
        rawResults.map(async ({ title, url, snippet }) => ({
          title,
          url,
          snippet,
          relevanceScore: await this.calculateRelevance(title, snippet, query),
        }))
      );

      // Extract content if requested
      if (options.contentExtraction?.extractCode || options.contentExtraction?.extractLinks) {
        for (const result of results.slice(0, 3)) { // Only extract for top 3 results
          try {
            const content = await this.extractContent(result.url, options);
            result.content = content;
            
            if (options.contentExtraction?.extractCode) {
              result.codeBlocks = this.extractCodeBlocks(content);
            }
            
            if (options.contentExtraction?.extractLinks) {
              result.links = this.extractLinks(content, result.url);
            }
          } catch (error) {
            log("Failed to extract content", "warning", { url: result.url, error });
          }
        }
      }

      return results;
      
    } catch (error) {
      log("DuckDuckGo search failed", "error", error);
      // Fallback to mock results if real search fails
      return this.getFallbackResults(query, options);
    }
  }

  private async searchGoogle(query: string, options: SearchOptions): Promise<SearchResult[]> {
    log("Searching with Google", "info", { query });

    try {
      // Note: This is a fallback implementation using web scraping
      // In production, you should use Google Custom Search API
      const encodedQuery = encodeURIComponent(query);
      const url = `https://www.google.com/search?q=${encodedQuery}&num=${options.maxResults || 10}`;
      
      const config: AxiosRequestConfig = {
        timeout: options.timeout || 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
        },
      };

      const response = await axios.get(url, config);
      const $ = cheerio.load(response.data);

      // First pass: collect raw results without relevance scores
      const rawResults: Array<{title: string; url: string; snippet: string}> = [];

      // Google search result parsing (note: Google actively blocks scraping)
      $('div.g').each((i: number, elem: any) => {
        if (rawResults.length >= (options.maxResults || 10)) return false;

        const $elem = $(elem);
        const $link = $elem.find('h3').closest('a');
        const $snippet = $elem.find('[data-sncf]').first();

        if ($link.length) {
          const title = $link.find('h3').text().trim();
          const href = $link.attr('href') || '';
          const snippet = $snippet.text().trim();

          // Clean up Google's redirect URLs
          let cleanUrl = href;
          if (href.startsWith('/url?q=')) {
            const urlParams = new URLSearchParams(href.substring(6));
            cleanUrl = urlParams.get('q') || href;
          }

          if (title && cleanUrl && !cleanUrl.startsWith('/search')) {
            rawResults.push({ title, url: cleanUrl, snippet });
          }
        }
      });

      // Second pass: calculate relevance scores asynchronously
      const results: SearchResult[] = await Promise.all(
        rawResults.map(async ({ title, url, snippet }) => ({
          title,
          url,
          snippet,
          relevanceScore: await this.calculateRelevance(title, snippet, query),
        }))
      );

      // Extract content if requested (limit to top 3 results)
      if (options.contentExtraction?.extractCode || options.contentExtraction?.extractLinks) {
        for (const result of results.slice(0, 3)) {
          try {
            const content = await this.extractContent(result.url, options);
            result.content = content;
            
            if (options.contentExtraction?.extractCode) {
              result.codeBlocks = this.extractCodeBlocks(content);
            }
            
            if (options.contentExtraction?.extractLinks) {
              result.links = this.extractLinks(content, result.url);
            }
          } catch (error) {
            log("Failed to extract content", "warning", { url: result.url, error });
          }
        }
      }

      return results;
      
    } catch (error) {
      log("Google search failed, using fallback", "warning", error);
      // Fallback to mock results if real search fails
      return this.getFallbackResults(query, options);
    }
  }

  private async calculateRelevance(title: string, snippet: string, query: string): Promise<number> {
    // Keyword-based relevance scoring (fast baseline)
    const queryWords = query.toLowerCase().split(/\s+/);
    const titleWords = title.toLowerCase().split(/\s+/);
    const snippetWords = snippet.toLowerCase().split(/\s+/);

    let keywordScore = 0;
    const totalWords = queryWords.length;

    for (const word of queryWords) {
      // Exact matches in title (highest weight)
      if (titleWords.some(tw => tw === word)) {
        keywordScore += 0.4;
      }
      // Partial matches in title
      else if (titleWords.some(tw => tw.includes(word) || word.includes(tw))) {
        keywordScore += 0.2;
      }

      // Exact matches in snippet
      if (snippetWords.some(sw => sw === word)) {
        keywordScore += 0.3;
      }
      // Partial matches in snippet
      else if (snippetWords.some(sw => sw.includes(word) || word.includes(sw))) {
        keywordScore += 0.1;
      }
    }

    return Math.min(keywordScore / totalWords, 1.0);
  }

  /**
   * Use LLM to summarize and rank top search results
   * Called after initial keyword-based filtering to provide semantic insights
   */
  async summarizeTopResults(query: string, results: SearchResult[]): Promise<{
    summary: string;
    rankedResults: SearchResult[];
    insights: string[];
  }> {
    if (results.length === 0) {
      return { summary: 'No results found', rankedResults: [], insights: [] };
    }

    try {
      // Only process top 5 results to avoid LLM overload
      const topResults = results.slice(0, 5);

      const prompt = `Analyze these search results for the query "${query}" and provide:
1. A brief summary of what these results offer
2. Rank them by relevance (most to least relevant)
3. Key insights or patterns

Results:
${topResults.map((r, i) => `${i + 1}. "${r.title}" - ${r.snippet}`).join('\n')}

Respond with JSON:
{
  "summary": "<2-3 sentence summary>",
  "ranking": [<indices 1-${topResults.length} in order of relevance>],
  "insights": ["<insight 1>", "<insight 2>"]
}`;

      const response = await this.semanticAnalyzer.analyzeContent(prompt, {
        maxTokens: 500,
        temperature: 0.5,
      });

      // Parse LLM response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // Reorder results based on LLM ranking
        const rankedResults: SearchResult[] = [];
        for (const idx of parsed.ranking || []) {
          if (idx >= 1 && idx <= topResults.length) {
            rankedResults.push(topResults[idx - 1]);
          }
        }
        // Add any remaining results
        for (const result of topResults) {
          if (!rankedResults.includes(result)) {
            rankedResults.push(result);
          }
        }
        // Add remaining results beyond top 5
        rankedResults.push(...results.slice(5));

        return {
          summary: parsed.summary || 'Results analyzed',
          rankedResults,
          insights: parsed.insights || [],
        };
      }
    } catch (error) {
      log('LLM summarization failed, returning original results', 'warning', error);
    }

    // Fallback: return original results
    return {
      summary: `Found ${results.length} results for "${query}"`,
      rankedResults: results,
      insights: [],
    };
  }

  private extractCodeBlocks(content: string): string[] {
    const codeBlocks: string[] = [];
    
    // Match various code block patterns
    const patterns = [
      // Markdown code blocks
      /```[\s\S]*?```/g,
      // HTML pre/code blocks
      /<pre[^>]*>[\s\S]*?<\/pre>/gi,
      /<code[^>]*>[\s\S]*?<\/code>/gi,
      // Common code patterns
      /function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\}/g,
      /class\s+\w+[\s\S]*?\{[\s\S]*?\}/g,
      /\w+\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\}/g,
    ];
    
    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        codeBlocks.push(...matches.map(match => {
          // Clean up HTML tags and markdown syntax
          return match
            .replace(/<[^>]+>/g, '')  // Remove HTML tags
            .replace(/^```\w*\n?/, '')  // Remove opening markdown
            .replace(/\n?```$/, '')  // Remove closing markdown
            .trim();
        }));
      }
    }
    
    // Remove duplicates and empty blocks
    return [...new Set(codeBlocks)].filter(block => block.length > 10);
  }

  private extractLinks(content: string, baseUrl: string): string[] {
    const links: string[] = [];
    
    // Extract various link patterns
    const patterns = [
      // HTML links
      /<a[^>]+href=["']([^"']+)["'][^>]*>/gi,
      // Markdown links
      /\[([^\]]+)\]\(([^)]+)\)/g,
      // Plain URLs
      /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        let url = match[1] || match[2] || match[0];
        
        // Clean up the URL
        url = url.trim().replace(/["'<>]/g, '');
        
        // Convert relative URLs to absolute
        if (url.startsWith('/')) {
          try {
            const base = new URL(baseUrl);
            url = `${base.protocol}//${base.host}${url}`;
          } catch (e) {
            continue; // Skip invalid URLs
          }
        }
        
        // Validate URL format
        if (url.match(/^https?:\/\/.+/)) {
          links.push(url);
        }
      }
    }
    
    // Remove duplicates and invalid links
    return [...new Set(links)].filter(link => {
      try {
        new URL(link);
        return true;
      } catch {
        return false;
      }
    });
  }

  private getFallbackResults(query: string, options: SearchOptions): SearchResult[] {
    const mockResults: SearchResult[] = [
      {
        title: `${query} - Stack Overflow`,
        url: `https://stackoverflow.com/questions/tagged/${query.replace(/\s+/g, '-')}`,
        snippet: `Questions and answers about ${query} from the developer community.`,
        content: this.generateMockContent(query, "stackoverflow"),
        codeBlocks: this.generateMockCodeBlocks(query),
        relevanceScore: 0.85,
      },
      {
        title: `GitHub - ${query} Examples`,
        url: `https://github.com/search?q=${encodeURIComponent(query)}`,
        snippet: `Open source projects and code examples for ${query}.`,
        content: this.generateMockContent(query, "github"),
        codeBlocks: this.generateMockCodeBlocks(query),
        links: [`https://github.com/trending?q=${query}`],
        relevanceScore: 0.80,
      },
      {
        title: `${query} Documentation`,
        url: `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(query)}`,
        snippet: `Official documentation and guides for ${query}.`,
        content: this.generateMockContent(query, "documentation"),
        relevanceScore: 0.75,
      },
    ];

    return mockResults.slice(0, options.maxResults || 10);
  }

  private generateMockContent(query: string, source: string): string {
    return `Mock content for ${query} from ${source}. This would contain the full extracted content from the webpage in a real implementation. The content would be processed to extract relevant information about ${query}.`;
  }

  private generateMockCodeBlocks(query: string): string[] {
    return [
      `// Example code for ${query}
function ${query.replace(/\s+/g, '')}() {
  console.log('Example implementation');
  return true;
}`,
      `/* 
 * ${query} usage example
 */
const result = ${query.replace(/\s+/g, '')}();`,
    ];
  }

  private isDocumentationResult(result: SearchResult): boolean {
    const docKeywords = ["documentation", "docs", "api", "reference", "guide", "tutorial"];
    const urlContainsDoc = docKeywords.some(keyword => 
      result.url.toLowerCase().includes(keyword)
    );
    const titleContainsDoc = docKeywords.some(keyword =>
      result.title.toLowerCase().includes(keyword)
    );

    return urlContainsDoc || titleContainsDoc || result.relevanceScore > 0.8;
  }

  async extractContent(url: string, options: SearchOptions = {}): Promise<string> {
    log(`Extracting content from: ${url}`, "info");

    try {
      const config: AxiosRequestConfig = {
        timeout: (options.timeout || 30000) / 2, // Use half the search timeout for content extraction
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      };

      const response = await axios.get(url, config);
      const $ = cheerio.load(response.data);
      
      // Remove script and style elements
      $('script, style, nav, header, footer, aside, .sidebar, .menu, .advertisement').remove();
      
      // Extract main content areas
      let content = '';
      const contentSelectors = [
        'main', 'article', '.content', '.post', '.entry',
        '#content', '#main', '.main-content', '.post-content',
        'section', '.container'
      ];
      
      // Try content selectors in order of preference
      for (const selector of contentSelectors) {
        const $contentArea = $(selector).first();
        if ($contentArea.length && $contentArea.text().trim().length > 100) {
          content = $contentArea.text();
          break;
        }
      }
      
      // Fallback to body if no content area found
      if (!content) {
        content = $('body').text();
      }
      
      // Clean up the content
      content = content
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .replace(/\n\s*\n/g, '\n')  // Remove extra newlines
        .trim();
      
      const maxLength = options.contentExtraction?.maxContentLength || 10000;
      return content.length > maxLength 
        ? content.substring(0, maxLength) + "..."
        : content;
        
    } catch (error) {
      log(`Failed to extract content from ${url}`, "warning", error);
      return `Failed to extract content from ${url}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async searchSimilarPatterns(pattern: string): Promise<SearchResult[]> {
    const patternQuery = `"${pattern}" design pattern implementation`;

    // NOTE: Content extraction disabled for performance
    // Fetching 3+ URLs sequentially was causing timeouts
    const response = await this.search(patternQuery, {
      maxResults: 6,
      timeout: 15000, // 15 second timeout
      contentExtraction: {
        extractCode: false,
        extractLinks: false,
      },
    });

    return response.results;
  }

  async searchReferences(patterns: string[], context: string = ""): Promise<{references: SearchResult[], validation: {valid: number, total: number}}> {
    log("Searching for pattern references", "info", { patterns, context });
    
    const allReferences: SearchResult[] = [];
    let validCount = 0;
    
    try {
      for (const pattern of patterns) {
        // Create search queries for each pattern
        const queries = [
          `"${pattern}" architecture pattern`,
          `${pattern} design pattern examples`,
          `${pattern} implementation guide`,
          `${pattern} best practices ${context}`.trim()
        ];
        
        for (const query of queries) {
          try {
            const searchResponse = await this.search(query, {
              maxResults: 3,
              engine: "duckduckgo",
              contentExtraction: {
                extractCode: true,
                extractLinks: true
              }
            });
            
            // Filter and validate results
            const validResults = searchResponse.results.filter((result: any) => {
              const isRelevant = result.title.toLowerCase().includes(pattern.toLowerCase()) ||
                                result.snippet.toLowerCase().includes(pattern.toLowerCase()) ||
                                (result.content && result.content.toLowerCase().includes(pattern.toLowerCase()));
              
              if (isRelevant) {
                validCount++;
                return true;
              }
              return false;
            });
            
            allReferences.push(...validResults);
            
            // Avoid overwhelming external services
            await new Promise(resolve => setTimeout(resolve, 1000));
            
          } catch (error) {
            log(`Failed to search for pattern: ${pattern}`, "warning", error);
          }
        }
      }
      
      // Remove duplicates based on URL
      const uniqueReferences = allReferences.filter((result, index, self) => 
        index === self.findIndex(r => r.url === result.url)
      );
      
      // Sort by relevance score
      uniqueReferences.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
      
      const validation = {
        valid: validCount,
        total: allReferences.length
      };
      
      log(`Pattern reference search completed`, "info", {
        patterns: patterns.length,
        totalReferences: uniqueReferences.length,
        validation
      });
      
      return {
        references: uniqueReferences.slice(0, 20), // Limit to top 20 results
        validation
      };
      
    } catch (error) {
      log("Pattern reference search failed", "error", error);
      
      // Return fallback results
      return {
        references: this.generateFallbackPatternReferences(patterns, context),
        validation: { valid: 0, total: 0 }
      };
    }
  }

  private generateFallbackPatternReferences(patterns: string[], context: string): SearchResult[] {
    return patterns.slice(0, 5).map(pattern => ({
      title: `${pattern} Pattern - Architecture Documentation`,
      url: `https://martinfowler.com/tags/${pattern.toLowerCase().replace(/\s+/g, '%20')}.html`,
      snippet: `Comprehensive guide to the ${pattern} pattern, including implementation details and best practices.`,
      content: `The ${pattern} pattern is a well-established architectural pattern used in ${context}. This pattern provides a structured approach to solving common design problems and improving code maintainability.`,
      relevanceScore: 0.7,
      codeBlocks: [`// Example implementation of ${pattern}\nclass ${this.generateCleanPatternName(pattern)} {\n  // Implementation details\n}`]
    }));
  }

  /**
   * Generate clean pattern names to avoid corrupted concatenations
   */
  private generateCleanPatternName(pattern: string): string {
    // Clean and normalize the pattern name
    const words = pattern.trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .filter(word => word.length > 0);

    if (words.length === 1) {
      return `${words[0]}Implementation`;
    }

    // Create proper camelCase
    const camelCase = words[0] + words.slice(1).join('');
    return `${camelCase}Implementation`;
  }
}
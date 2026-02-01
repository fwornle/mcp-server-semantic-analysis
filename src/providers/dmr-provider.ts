/**
 * Docker Model Runner (DMR) Provider
 *
 * Provides local LLM inference via Docker Desktop's Model Runner.
 * Uses OpenAI-compatible API at localhost:${DMR_PORT}/engines/v1
 *
 * Port configured in: .env.ports (DMR_PORT=12434)
 *
 * Prerequisites:
 * - Docker Desktop with Model Runner enabled: docker desktop enable model-runner --tcp ${DMR_PORT}
 * - Models pulled: docker model pull ai/llama3.2
 */

import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { log } from "../logging.js";

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get DMR host and port from environment (set in .env.ports)
// DMR_HOST: Use 'host.docker.internal' on Windows, 'localhost' on macOS/Linux
const DMR_HOST = process.env.DMR_HOST || "localhost";
const DMR_PORT = process.env.DMR_PORT || "12434";

// DMR configuration interface
export interface DMRConfig {
  host: string;
  port: number;
  baseUrl: string;
  defaultModel: string;
  modelOverrides: Record<string, string>;
  timeout: number;
  maxTokens: number;
  temperature: number;
  connection: {
    maxRetries: number;
    retryDelay: number;
    healthCheckInterval: number;
  };
}

// DMR response structure
export interface DMRResponse {
  content: string;
  provider: "dmr";
  model: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

// Default configuration (uses DMR_HOST and DMR_PORT from environment)
const DEFAULT_CONFIG: DMRConfig = {
  host: DMR_HOST,
  port: parseInt(DMR_PORT, 10),
  baseUrl: `http://${DMR_HOST}:${DMR_PORT}/engines/v1`,
  defaultModel: "ai/llama3.2",
  modelOverrides: {},
  timeout: 120000,
  maxTokens: 4096,
  temperature: 0.7,
  connection: {
    maxRetries: 3,
    retryDelay: 1000,
    healthCheckInterval: 30000,
  },
};

// Singleton DMR client
let dmrClient: OpenAI | null = null;
let dmrConfig: DMRConfig = DEFAULT_CONFIG;
let isAvailable: boolean | null = null;
let lastHealthCheck: number = 0;

/**
 * Expand environment variables in a string (${VAR} or ${VAR:-default})
 */
function expandEnvVars(str: string): string {
  return str.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, varName, defaultVal) => {
    return process.env[varName] || defaultVal || "";
  });
}

/**
 * Load DMR configuration from YAML file
 */
function loadDMRConfig(): DMRConfig {
  const possiblePaths = [
    path.join(process.cwd(), "config", "dmr-config.yaml"),
    path.join(
      process.cwd(),
      "integrations",
      "mcp-server-semantic-analysis",
      "config",
      "dmr-config.yaml"
    ),
    path.join(__dirname, "..", "..", "config", "dmr-config.yaml"),
  ];

  for (const configPath of possiblePaths) {
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, "utf8");
        const parsed = yaml.load(configContent) as { dmr: Partial<DMRConfig> };
        if (parsed?.dmr) {
          log(`Loaded DMR config from ${configPath}`, "info");
          // Expand environment variables in baseUrl
          const config = { ...DEFAULT_CONFIG, ...parsed.dmr };
          if (config.baseUrl) {
            config.baseUrl = expandEnvVars(config.baseUrl);
          }
          // Ensure port is set from baseUrl or environment
          if (!config.port) {
            config.port = parseInt(DMR_PORT, 10);
          }
          return config;
        }
      } catch (error) {
        log(`Failed to parse DMR config at ${configPath}`, "warning", error);
      }
    }
  }

  log("No DMR config found, using defaults", "info");
  return DEFAULT_CONFIG;
}

/**
 * Initialize the DMR client
 */
export function initializeDMRClient(): OpenAI {
  if (!dmrClient) {
    dmrConfig = loadDMRConfig();

    dmrClient = new OpenAI({
      baseURL: dmrConfig.baseUrl,
      apiKey: "not-required", // DMR ignores auth
      timeout: dmrConfig.timeout,
      maxRetries: dmrConfig.connection.maxRetries,
    });

    log(`DMR client initialized`, "info", {
      baseUrl: dmrConfig.baseUrl,
      defaultModel: dmrConfig.defaultModel,
    });
  }

  return dmrClient;
}

/**
 * Check if DMR is available
 */
export async function checkDMRAvailability(): Promise<boolean> {
  const now = Date.now();

  // Use cached result if recent
  if (
    isAvailable !== null &&
    now - lastHealthCheck < dmrConfig.connection.healthCheckInterval
  ) {
    return isAvailable;
  }

  try {
    const client = initializeDMRClient();
    const models = await client.models.list();

    isAvailable = true;
    lastHealthCheck = now;

    log(`DMR available with ${models.data?.length || 0} models`, "info");
    return true;
  } catch (error: any) {
    isAvailable = false;
    lastHealthCheck = now;

    log(`DMR not available: ${error.message}`, "warning");
    return false;
  }
}

/**
 * Get the model to use for a specific agent
 */
export function getModelForAgent(agentId?: string): string {
  if (agentId && dmrConfig.modelOverrides[agentId]) {
    return dmrConfig.modelOverrides[agentId];
  }
  return dmrConfig.defaultModel;
}

/**
 * Call DMR for chat completion
 */
export async function callDMR(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: {
    agentId?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<DMRResponse> {
  const client = initializeDMRClient();

  // Determine model: explicit > agent override > default
  const model =
    options.model || getModelForAgent(options.agentId) || dmrConfig.defaultModel;

  log(`Calling DMR with model ${model}`, "info", {
    agentId: options.agentId,
    messageCount: messages.length,
  });

  const startTime = Date.now();

  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      max_tokens: options.maxTokens || dmrConfig.maxTokens,
      temperature: options.temperature ?? dmrConfig.temperature,
      stream: false,
    });

    const content = response.choices[0]?.message?.content || "";
    const usage = response.usage;
    const duration = Date.now() - startTime;

    log(`DMR call completed in ${duration}ms`, "info", {
      model,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
    });

    return {
      content,
      provider: "dmr",
      model,
      tokenUsage: {
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
      },
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    log(`DMR call failed after ${duration}ms: ${error.message}`, "error");

    // Mark as unavailable if connection failed
    if (
      error.code === "ECONNREFUSED" ||
      error.message?.includes("ECONNREFUSED")
    ) {
      isAvailable = false;
    }

    throw error;
  }
}

/**
 * Simple wrapper for single prompt calls
 */
export async function callDMRWithPrompt(
  prompt: string,
  options: {
    agentId?: string;
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  } = {}
): Promise<DMRResponse> {
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [];

  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }

  messages.push({ role: "user", content: prompt });

  return callDMR(messages, options);
}

/**
 * Get DMR configuration (for debugging/UI display)
 */
export function getDMRConfig(): DMRConfig {
  return { ...dmrConfig };
}

/**
 * Get DMR status
 */
export function getDMRStatus(): {
  available: boolean | null;
  lastCheck: number;
  config: DMRConfig;
} {
  return {
    available: isAvailable,
    lastCheck: lastHealthCheck,
    config: dmrConfig,
  };
}

// Export for use in semantic-analyzer
export default {
  initializeDMRClient,
  checkDMRAvailability,
  callDMR,
  callDMRWithPrompt,
  getModelForAgent,
  getDMRConfig,
  getDMRStatus,
};

/**
 * Phase 42.2 Plan 02 Gap 2 — direct-fetch LLM client that sets `process` on
 * the rapid-llm-proxy `/api/complete` request body.
 *
 * Why this exists: the `@rapid/llm-proxy` SDK's `LLMService.complete()` does
 * not expose a `process` field (verified at
 * `_work/rapid-llm-proxy/src/types.ts:35-54` — LLMCompletionRequest has
 * messages/maxTokens/temperature/operationType/taskType/tier/agentId, but no
 * process). The proxy server reads `body.process` and defaults to `'unknown'`
 * when absent (`_work/rapid-llm-proxy/proxy-bridge/server.mjs:1561`). Without
 * `process`, every wave-analysis LLM call lands in token-usage telemetry as
 * `process='unknown'`, breaking operator per-step attribution.
 *
 * Forensics report `report-42.2-00-canonical-emit.md` §2.3 chose Option B
 * (single-repo wrapper) over Option A (cross-repo SDK release). This module
 * IS Option B — a thin direct-fetch helper mirroring the canonical client
 * pattern at `scripts/backfill-raw-observations.mjs:63,95`.
 *
 * Design decisions:
 *   - Keeps the SDK's `LLMService` alive for metrics (wave1/2/3 agents call
 *     `getMetricsTracker()` for tracer instrumentation per
 *     wave1-project-agent.ts:79-88). This wrapper PARALLELS the SDK; it does
 *     not replace it.
 *   - Returns a response shape compatible with what the existing call-sites
 *     expect from `llmService.complete()`: `{ content, model, provider,
 *     tokens: { total, ... }, latencyMs }`. Maps the proxy's flat
 *     `{tokens: number}` into the SDK's `{tokens: { total: number, ... }}`
 *     shape so downstream code (`result.tokens.total`) keeps working.
 *   - Honors CLAUDE.md `/api/complete` request body shape:
 *     `{ process, messages, taskType? }`. Server-side at port 3033 (per
 *     CLAUDE.md `km-core LLM proxy endpoint`).
 *   - No `console.*` — uses `process.stderr.write` if logging needed.
 *
 * @module agents/llm-with-process
 */

/** Minimal interface for an SDK MetricsTracker — duck-typed so this module
 *  has no compile-time dependency on `@rapid/llm-proxy`. When a wave-agent
 *  passes its `llmService.getMetricsTracker()` here, the wrapper records the
 *  proxy-fetch call into the same tracker the SDK uses, so existing
 *  `wave1Agent.getDetailedCalls()` and `getLLMMetrics()` consumers in
 *  wave-controller.ts (lines 622, 645, 812, 992, 1762) keep working
 *  unchanged. */
export interface MetricsTrackerLike {
  recordCall(
    provider: string,
    model: string,
    tokens: { input: number; output: number; total: number },
    latencyMs: number,
    operationType?: string,
    promptPreview?: string,
    responsePreview?: string,
  ): void;
}

/** Subset of LLMCompletionRequest the wave-agent call-sites use today. */
export interface LLMWithProcessRequest {
  /** Required: free-form telemetry tag set into `body.process` so the proxy
   *  stores per-call attribution in `.data/llm-proxy/token-usage.db`. */
  process: string;
  /** Standard OpenAI-style messages array. */
  messages: Array<{ role: string; content: string }>;
  /** Optional: routing hint that the local proxy uses for taskType-based
   *  provider selection (per CLAUDE.md). */
  taskType?: string;
  /** Optional: per-agent attribution label distinct from `process`. */
  agentId?: string;
  /** Optional: routing tier (`'standard'` etc). */
  tier?: string;
  /** Optional: per-call token cap. */
  maxTokens?: number;
  /** Optional: sampling temperature. */
  temperature?: number;
  /** Optional: request timeout in ms. Defaults to 60_000 (matches existing
   *  wave-agent call-site default). */
  timeout?: number;
  /** Optional: OpenAI-style response_format passthrough (e.g.
   *  `{ type: 'json_object' }`). */
  responseFormat?: Record<string, unknown>;
}

/** Response shape compatible with the existing `llmService.complete()`
 *  return type that wave-agent call-sites consume. */
export interface LLMWithProcessResponse {
  /** LLM-generated text content (matches SDK shape). */
  content: string;
  /** Resolved model name from the proxy (e.g. `claude-haiku-3-5`). */
  model: string;
  /** Resolved provider name from the proxy (e.g. `copilot`, `claude-code`). */
  provider: string;
  /** Token usage — SDK shape uses `{ total, input?, output? }`. */
  tokens: { total: number; input?: number; output?: number };
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
}

// Phase 42.2 Plan 06 follow-up — port 3033 is the health-API, NOT the LLM
// proxy. The real rapid-llm-proxy `/api/complete` endpoint is served by the
// `rapid-llm-proxy` daemon at port 12435 (host) reached from inside the
// coding-services container via `host.docker.internal`. The container is
// pre-configured with the `LLM_CLI_PROXY_URL=http://host.docker.internal:12435`
// env var by docker/docker-compose.yml.
//
// Resolution order matches the SDK's `cli-provider-base.ts` convention:
//   1. RAPID_LLM_PROXY_URL (explicit override for this wrapper)
//   2. LLM_CLI_PROXY_URL (container/host-wide env, set in docker-compose.yml)
//   3. LLM_PROXY_URL (alternate name used by `proxy-provider.ts`)
//   4. `http://localhost:<LLM_CLI_PROXY_PORT>` (port-only override; default 12435)
//
// Every consumer URL gets `/api/complete` appended exactly once.
const DEFAULT_PROXY_PORT = '12435';
const DEFAULT_TIMEOUT_MS = 60_000;

function resolveProxyCompleteUrl(): string {
  const explicit =
    process.env.RAPID_LLM_PROXY_URL ??
    process.env.LLM_CLI_PROXY_URL ??
    process.env.LLM_PROXY_URL;
  const base = explicit ?? `http://localhost:${process.env.LLM_CLI_PROXY_PORT ?? DEFAULT_PROXY_PORT}`;
  return base.endsWith('/api/complete') ? base : `${base.replace(/\/+$/, '')}/api/complete`;
}

/**
 * Call the rapid-llm-proxy `/api/complete` endpoint with an explicit `process`
 * tag in the request body. Returns an SDK-shape response so the wave-agent
 * call-sites don't need any other downstream changes.
 *
 * Throws on non-2xx HTTP responses (matches the SDK's throw-on-error contract).
 *
 * Optionally records the call into a passed-in MetricsTrackerLike (typically
 * the agent's `llmService.getMetricsTracker()`) so wave-controller's tracer
 * instrumentation (`getDetailedCalls()`) keeps seeing the call.
 */
export async function llmWithProcessComplete(
  request: LLMWithProcessRequest,
  metricsTracker?: MetricsTrackerLike,
): Promise<LLMWithProcessResponse> {
  const url = resolveProxyCompleteUrl();
  const timeoutMs = request.timeout ?? DEFAULT_TIMEOUT_MS;

  // Body honors the CLAUDE.md `/api/complete` shape exactly:
  //   { process, messages, taskType? } plus optional routing hints.
  const body: Record<string, unknown> = {
    process: request.process,
    messages: request.messages,
  };
  if (typeof request.taskType === 'string') body.taskType = request.taskType;
  if (typeof request.agentId === 'string') body.agentId = request.agentId;
  if (typeof request.tier === 'string') body.tier = request.tier;
  if (typeof request.maxTokens === 'number') body.maxTokens = request.maxTokens;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (request.responseFormat) body.responseFormat = request.responseFormat;

  const startedAt = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `llm-with-process: HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`,
    );
  }

  const parsed = (await resp.json()) as {
    content?: string;
    model?: string;
    provider?: string;
    tokens?: number | { total?: number; input?: number; output?: number };
    latencyMs?: number;
  };

  // Normalize the proxy's flat `{tokens: number}` into the SDK shape that
  // wave-agent call-sites read as `result.tokens.total`. Falls back to 0 when
  // the proxy returns no token usage info.
  let tokens: { total: number; input?: number; output?: number };
  if (typeof parsed.tokens === 'number') {
    tokens = { total: parsed.tokens };
  } else if (parsed.tokens && typeof parsed.tokens === 'object') {
    tokens = {
      total: typeof parsed.tokens.total === 'number' ? parsed.tokens.total : 0,
      ...(typeof parsed.tokens.input === 'number' ? { input: parsed.tokens.input } : {}),
      ...(typeof parsed.tokens.output === 'number' ? { output: parsed.tokens.output } : {}),
    };
  } else {
    tokens = { total: 0 };
  }

  const response: LLMWithProcessResponse = {
    content: typeof parsed.content === 'string' ? parsed.content : '',
    model: typeof parsed.model === 'string' ? parsed.model : 'unknown',
    provider: typeof parsed.provider === 'string' ? parsed.provider : 'unknown',
    tokens,
    latencyMs:
      typeof parsed.latencyMs === 'number' ? parsed.latencyMs : Date.now() - startedAt,
  };

  // Record into SDK metrics tracker if provided — keeps wave-controller's
  // tracer instrumentation (getDetailedCalls / getLLMMetrics) seeing every
  // call uniformly regardless of which client surface (SDK vs this wrapper)
  // dispatched it.
  if (metricsTracker) {
    try {
      metricsTracker.recordCall(
        response.provider,
        response.model,
        {
          input: response.tokens.input ?? 0,
          output: response.tokens.output ?? 0,
          total: response.tokens.total,
        },
        response.latencyMs,
        request.taskType ?? request.process,
      );
    } catch {
      // Metrics recording is best-effort — never fail the LLM call because
      // a tracker push threw.
    }
  }

  return response;
}

/** Convenience factory — bind a `process` tag (and optional metrics tracker)
 *  once and return a partial client. Each wave-agent constructs its own
 *  (`process='wave-analysis-wave1'` etc.) so call-sites don't repeat the tag.
 *
 *  Pass the agent's `llmService.getMetricsTracker()` so SDK-side
 *  `getDetailedCalls()` consumers still see the calls — Phase 42.2-02 Gap 2
 *  preserves the trace-instrumentation contract.
 */
export function createLLMWithProcess(
  processTag: string,
  metricsTracker?: MetricsTrackerLike,
): {
  complete: (
    req: Omit<LLMWithProcessRequest, 'process'>,
  ) => Promise<LLMWithProcessResponse>;
} {
  return {
    complete: (req) =>
      llmWithProcessComplete({ ...req, process: processTag }, metricsTracker),
  };
}

# mcp-server-semantic-analysis

> MCP server driving the **wave-analysis** workflow, ingest, and ontology classification for the coding knowledge graph — 14 agents (8 LLM-enhanced, 2 infrastructure, orchestration + persistence) writing through `@fwornle/km-core`.

## Configurations Owned

- **Ontology:** — (owned by `coding` — this server READS `.data/ontologies/coding-ontology.json` for classification, but does not own it)
- **LLM providers:** `lib/llm/` (6-tier provider chain: Groq → Gemini → Custom → Anthropic → OpenAI → Ollama) + `config/agents/*.json` (per-agent prompts) + `config/workflows/*.json` (wave-analysis `processOverrides` routing — see `scripts/configure-wave-analysis-routing.sh`)
- **Ingest adapters:** `src/agents/*.ts` — each agent ingests via `PersistenceAgent`, which writes through `@fwornle/km-core`'s REST router (`POST /api/v1/entities`)
- **Domain dedup:** `src/agents/dedup-agent.ts` — OpenAI `text-embedding-3-small` + cosine similarity overlay on top of km-core's baseline `LayeredDeduplicator` (with Jaccard text-similarity fallback)

## Architecture

![B architecture](../../docs/images/b-architecture.png)

This server exposes 12 MCP tools over stdio (local) or HTTP/SSE on port `3848` (Docker mode). The `CoordinatorAgent` orchestrates the 14-agent pipeline via workflow definitions in `config/workflows/*.json`; `WaveController` drives the multi-wave analysis flow (extract → analyze → classify → persist → dedup → predict → merge). The 8 LLM-enhanced agents share a `SemanticAnalyzer` service with automatic provider failover; the 2 infrastructure agents handle embedding-based dedup and stale-entity detection. All persistence converges on `PersistenceAgent`, which writes through km-core's REST contract — `mcp-server-semantic-analysis` owns no graph storage itself.

**14-Agent Catalog** (names + 1-line roles):

- **LLM-Enhanced (8):**
  1. `GitHistoryAgent` — git commits since checkpoint + architectural decisions
  2. `VibeHistoryAgent` — LLM session summaries + pattern analysis
  3. `SemanticAnalysisAgent` — deep code-vs-conversation correlation
  4. `WebSearchAgent` — 40% keyword + 60% semantic relevance scoring
  5. `InsightGenerationAgent` — LLM insight + PlantUML diagram generation
  6. `ObservationGenerationAgent` — structured observation extraction + domain classification
  7. `QualityAssuranceAgent` — semantic validation (fragments, generic content)
  8. `PersistenceAgent` — ontology classifier + canonical write path via km-core
- **Infrastructure (2):**
  9. `DeduplicationAgent` — embedding cosine similarity, Jaccard fallback
  10. `ContentValidationAgent` — stale-entity detection + refresh recommendations
- **Orchestration:**
  11. `CoordinatorAgent` — workflow orchestration, `{{step}}` templating
  12. `WaveController` — wave-analysis driver, sub-step events for dashboard progress

For per-agent enhancement detail, the 6-tier LLM provider chain, ontology classification internals, MCP tool reference, use cases, and project structure, see [docs/AGENTS.md](docs/AGENTS.md).

## Where to Edit

| To add… | Edit… | Verify |
|---------|-------|--------|
| A new agent | New file `src/agents/<NewAgent>.ts` + register in `src/agents/index.ts` + add step in `src/coordinator.ts` workflow | `npm run build && npm test -- agents` |
| Change LLM routing for a process | `config/workflows/<workflow>.json` `processOverrides` block | Restart container + check `/api/ukb/llm-mode` on the dashboard |
| A new wave step | `src/wave-controller.ts` (step registration) + step implementation | `npm test -- wave-controller` |
| A new dedup rule | `src/agents/dedup-agent.ts` (`calculateNameSimilarity` / fuzzy thresholds) | `npm test -- dedup` |

## Related Systems

- [KM-Core](../../lib/km-core/README.md) — shared store + REST contracts this server writes through (Phase 44 wire-shape lock)
- [coding](../../README.md) — host runtime + observation source (obs-api at `localhost:12436`)
- [operational-knowledge-management](https://bmw.ghe.com/adpnext-apps/operational-knowledge-management) — sister system consuming the same km-core core for RaaS / KPI-FW / business ontologies ("OKM" for short, external BMW GHE repo)

## Tests / Verify

```bash
cd integrations/mcp-server-semantic-analysis
npm run build
npm test
```

> **Submodule build pipeline:** B is a git submodule. After any TypeScript source change, BOTH `npm run build` (inside this submodule) AND a Docker rebuild of `coding-services` are required for the change to take effect at runtime. See the **Rebuilding After Code Changes** section in the parent repo's [CLAUDE.md](../../CLAUDE.md) for the full two-step recipe. The README + `docs/AGENTS.md` rewrite in Phase 46 does NOT require a rebuild (docs-only).

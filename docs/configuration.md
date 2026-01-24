# Configuration Reference

All runtime behavior of the MCP Semantic Analysis Server is controlled through externalized YAML configuration files in the `config/` directory. This eliminates hardcoded constants and makes tuning possible without code changes.

## Directory Structure

```
config/
  orchestrator.yaml       # Coordinator orchestration & debug settings
  workflow-runner.yaml    # Standalone workflow runner process settings
  agent-tuning.yaml       # Per-agent batch sizes, timeouts, tuning params
  agents.yaml             # Agent definitions (names, icons, grid positions)
  model-tiers.yaml        # LLM model tier mappings (premium/standard/economy)
  transcript-formats.json # Transcript extraction format definitions
  workflows/
    batch-analysis.yaml   # Main batch workflow (14-agent, iterative)
    complete-analysis.yaml    # Full single-pass analysis workflow
    incremental-analysis.yaml # Incremental (since-last-checkpoint) workflow
```

## orchestrator.yaml

Controls the SmartOrchestrator behavior, single-step debug mode, and LLM mock mode.

```yaml
orchestrator:
  max_retries: 3              # Max retries per step before failure
  retry_threshold: 0.5        # Quality score below which to retry
  skip_threshold: 0.3         # Quality score below which to skip entirely
  use_llm_routing: true       # Enable LLM-based adaptive step routing
  max_concurrent_steps: 3     # Max parallel step execution
  default_step_timeout: 120000  # Per-step timeout in ms

single_step_debug:
  poll_interval_ms: 500       # Poll frequency for resume signal
  log_interval_ms: 300000     # Log reminder interval (5 minutes)
  max_consecutive_errors: 10  # Tolerate up to N transient read errors

mock_mode:
  min_step_time_ms: 200       # Minimum mock step execution time
```

**Key concepts:**
- `retry_threshold` / `skip_threshold`: The orchestrator evaluates step output quality. If below retry threshold, it retries; if below skip threshold, it skips the step entirely.
- `single_step_debug`: Controls the debugging pause mechanism. When single-step mode is active, the coordinator polls for a resume signal at `poll_interval_ms` intervals.
- `mock_mode`: In mock/debug mode, LLM calls are simulated. `min_step_time_ms` prevents instant completion so the UI can visualize progress.

## workflow-runner.yaml

Controls the standalone workflow runner process (spawned by the dashboard to execute workflows independently).

```yaml
runner:
  heartbeat_interval_ms: 30000    # 30 seconds (must be < 120s stale threshold)
  max_duration_ms: 7200000        # 2 hours maximum workflow duration
```

**Key concepts:**
- `heartbeat_interval_ms`: The runner updates its heartbeat timestamp at this interval. The dashboard marks workflows as "stale" after 120 seconds without a heartbeat, and "frozen" after 300 seconds.
- `max_duration_ms`: Watchdog timer to prevent indefinite workflow hangs. The runner terminates after this duration regardless of progress.

## agent-tuning.yaml

Default batch sizes, timeouts, and tuning parameters for individual agents.

```yaml
code_graph:
  memgraph_check_timeout_ms: 5000   # Memgraph connectivity check timeout
  uv_process_timeout_ms: 300000     # UV process timeout for large codebases

documentation_linker:
  reference_batch_size: 10          # Batch size for resolving unresolved references

deduplication:
  batch_size: 100                   # Similarity detection batch size
```

**Adding new agent parameters:** Add a new top-level key matching the agent's step name, then add parameters underneath. The coordinator reads these at workflow initialization.

## Workflow Definition Files

Workflow YAML files define the step sequence, agent assignments, dependencies, and phases for each workflow type.

### batch-analysis.yaml

The primary workflow. Processes git history in chronological batches of N commits.

**Structure:**
```yaml
workflow:
  name: batch-analysis
  version: "1.3"
  type: iterative            # Signals batch iteration mode

config:
  batch_size: 50             # Default commits per batch
  max_batches: 0             # 0 = process all
  checkpoint_enabled: true   # Per-batch checkpointing

parameters:
  repositoryPath: ...
  team: ...
  batchSize: ...
  # ... (passed at workflow start)

steps:
  - name: step_name
    agent: agent_id
    action: methodName
    tier: premium|standard|economy    # LLM model tier (optional)
    substeps: [sub1, sub2, ...]       # Sub-step IDs for progress tracking
    parameters: { ... }
    timeout: 120                      # Seconds
    dependencies: [other_step]        # Must complete before this step runs
    phase: initialization|batch|finalization
    operator: extract|analyze|...     # Semantic operator category
```

**Phases:**
- `initialization`: Runs once at workflow start (e.g., `plan_batches`)
- `batch`: Repeated for each batch in sequence
- `finalization`: Runs once after all batches complete (e.g., CGR, persistence)

**Sub-steps:**
Steps with complex internal processing define `substeps` arrays. These enable:
1. Fine-grained progress tracking in the dashboard graph (arcs around agent nodes)
2. Single-step debugging at sub-step granularity (via "Step Into" button)

Current steps with sub-steps:
| Step | Sub-steps |
|------|-----------|
| `batch_semantic_analysis` | `sem_data_prep`, `sem_llm_analysis`, `sem_observation_gen`, `sem_entity_transform` |
| `generate_batch_observations` | `obs_llm_generate`, `obs_accumulate` |
| `classify_with_ontology` | `onto_data_prep`, `onto_llm_classify`, `onto_apply_results` |

**Dashboard progress calculation:**
The dashboard calculates batch progress using `batchPhaseStepCount` (derived from `steps.filter(s => s.phase === 'batch' || s.phase === 'initialization').length`). Sub-steps are excluded from the main progress count to avoid inflation.

### complete-analysis.yaml / incremental-analysis.yaml

Similar structure but simpler: no batch iteration, runs steps in a single pass.
- `complete-analysis`: Analyzes the entire repository from scratch
- `incremental-analysis`: Only analyzes changes since last checkpoint

## agents.yaml

Defines agent metadata for the dashboard workflow graph visualization (names, icons, grid positions).

## model-tiers.yaml

Maps tier names (`premium`, `standard`, `economy`) to specific LLM models and providers. Steps reference tiers rather than specific models, allowing model upgrades without workflow changes.

## How Configuration is Loaded

1. The `CoordinatorAgent` reads config files at workflow initialization
2. Workflow YAML is parsed to determine steps, phases, and dependencies
3. `orchestrator.yaml` settings control the SmartOrchestrator behavior
4. `agent-tuning.yaml` values are passed to individual agents as defaults
5. `workflow-runner.yaml` is read by the standalone runner process
6. The dashboard reads `batchPhaseStepCount` from the progress file (computed by the coordinator from the workflow definition)

## Adding New Configuration

1. **New orchestrator setting**: Add to `orchestrator.yaml`, read in `coordinator.ts` via `loadOrchestratorConfig()`
2. **New agent parameter**: Add to `agent-tuning.yaml` under the agent's key, read in the agent's constructor
3. **New workflow step**: Add to the relevant workflow YAML with proper `phase`, `dependencies`, and `agent` fields
4. **New sub-steps**: Add `substeps: [id1, id2]` to the step definition, implement sub-step progress reporting in the agent, and add the sub-step IDs to `AGENT_SUBSTEPS` in the dashboard graph component

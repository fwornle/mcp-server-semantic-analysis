# UKB Workflow Features

This document describes the features available in the UKB (Update Knowledge Base) workflow system.

## Single-Step Debugging Mode

The single-step debugging mode allows you to pause the workflow after each step, giving you time to inspect the results before proceeding to the next step.

### How to Enable

1. Open the **UKB Workflow Monitor** in the System Health Dashboard
2. Check the **Single-step** checkbox in the toolbar (top-right, next to "View Trace")
3. The indicator will show "(waiting)" until the workflow pauses

### How It Works

When single-step mode is enabled:

1. **Workflow Pauses After Each Step**: After any step completes (e.g., `extract_batch_commits`, `batch_semantic_analysis`), the workflow pauses automatically
2. **Step Button Appears**: A "Step" button becomes visible in the toolbar
3. **Click "Step" to Continue**: Click the "Step" button to advance to the next step
4. **Mode Persists**: Single-step mode remains active until you uncheck the checkbox

### Use Cases

- **Debugging**: Inspect intermediate results to understand workflow behavior
- **Learning**: Step through the workflow to understand the pipeline
- **Troubleshooting**: Pause at specific steps to diagnose issues
- **Quality Assurance**: Verify each step's output before proceeding

### Technical Details

- Single-step state is stored in `.data/workflow-progress.json`
- The state persists across progress file updates (won't reset during workflow)
- Timeout: Single-step mode automatically disables after 30 minutes of inactivity
- API Endpoints:
  - `POST /api/ukb/single-step-mode` - Enable/disable mode
  - `POST /api/ukb/step-advance` - Advance to next step

---

## Workflow Cancellation

You can cancel a running workflow at any point.

### How to Cancel

1. Click the red **Cancel Workflow** button in the UKB Workflow Monitor
2. The workflow stops immediately and skips all remaining steps

### What Happens When Cancelled

- Current batch processing stops
- Finalization steps are skipped
- Progress file is updated with `cancelled` status
- Any accumulated data is preserved in checkpoints

---

## Tracer View

The tracer provides a timeline view of workflow execution with detailed metrics.

### Features

- **Step Timeline**: See each step with timing and status
- **LLM Metrics**: View LLM calls, tokens used, and providers
- **Step Outputs**: Expand each step to see detailed outputs
- **Truncation Indicators**: Large data sets show "X of Y (...)" to indicate truncation

### Display Limits

To keep the UI responsive, step outputs are truncated:

| Data Type | Display Limit | Full Data Location |
|-----------|---------------|-------------------|
| Commits | 5 per batch | Accumulated in final analysis |
| Sessions | 5 per batch | Accumulated in final analysis |
| Entities | 5 names shown | Full list in step results |
| Observations | 5 names shown | Accumulated for insights |

---

## Workflow Phases

The UKB workflow runs in three phases:

### 1. Initialization Phase
- `plan_batches`: Determine batches to process based on checkpoint

### 2. Batch Phase (Iterative)
For each batch:
- `extract_batch_commits`: Get git commits
- `extract_batch_sessions`: Get coding sessions
- `batch_semantic_analysis`: LLM-powered entity extraction
- `generate_batch_observations`: Create observations
- `classify_with_ontology`: Assign entity types
- `kg_operators`: Run knowledge graph operations
- `batch_qa`: Quality assurance checks
- `save_checkpoint`: Persist progress

### 3. Finalization Phase
- `generate_insights`: Create insight documents
- `persist_to_graph`: Save to knowledge base

---

## Monitoring Health

The workflow health indicator shows:

- **Healthy** (green): Steps completing normally
- **Degraded** (yellow): Some steps failing or slow
- **Unhealthy** (red): Critical failures or stalled

---

## API Reference

### Start Workflow
```bash
POST /api/ukb/start
Body: { "workflowName": "complete-analysis", "team": "coding" }
```

### Check Status
```bash
GET /api/ukb/status
GET /api/ukb/processes
```

### Cancel Workflow
```bash
POST /api/ukb/cancel
Body: { "killProcesses": true }
```

### Single-Step Mode
```bash
POST /api/ukb/single-step-mode
Body: { "enabled": true }
```

### Advance Step
```bash
POST /api/ukb/step-advance
```

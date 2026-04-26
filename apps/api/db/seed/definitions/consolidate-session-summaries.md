---
key: consolidate-session-summaries
name: Consolidate Session Summaries
description: Merge multiple summary snapshots of the same session into a single deduplicated summary
is_system: true
inputs:
  - type: prompt
    required: true
    description: Consolidation prompt for merging summaries
    example: "Merge the following session summaries into one, removing duplicates."
  - type: transcript
    required: true
    description: All existing summary snapshots joined together (with per-snapshot headers)
steps:
  - key: consolidate
    name: Consolidate Summaries
    step_type: prompt
    prompt_handle: consolidate-session-summaries
    input_source: job_input
    input_config:
      input_type: transcript
    timeout_ms: 300000
---

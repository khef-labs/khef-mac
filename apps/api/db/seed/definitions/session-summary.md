---
key: session-summary
name: Session Summary
description: Summarize a synced session transcript using map-reduce for large sessions
is_system: true
inputs:
  - type: prompt
    required: true
    description: Synthesis prompt for the final summary
    example: "Summarize the key decisions, action items, and technical context from this session"
  - type: transcript
    required: true
    description: Session transcript content
  - type: chunk_prompt
    required: true
    description: Prompt for summarizing individual chunks
    example: "Summarize this segment of the session, focusing on decisions and outcomes"
  - type: existing_summary
    required: false
    description: Previous summary for incremental updates
steps:
  - key: summarize
    name: Summarize Transcript
    step_type: map_reduce
    prompt_handle: summarize-session
    input_source: job_input
    input_config:
      input_type: transcript
    timeout_ms: 300000
    config:
      chunk_size: 50000
      threshold: 100000
      batch_prompt_handle: summarize-session-chunk
      single_prompt_handle: summarize-session-single
      update_prompt_handle: update-session-summary
      include_generated_at: true
      merge_template: "## Segment {{index}}\n\n{{output}}"
      synthesis_timeout_ms: 600000
---

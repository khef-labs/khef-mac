---
key: session-summary-v2
name: Session Summary v2
description: One-shot pipeline that mirrors session-summary, then folds in consolidate-session-summaries and the historian-style editorial pruning. Replaces running session-summary + consolidate-session-summaries + /rem-summary as three separate jobs.
is_system: true
inputs:
  - type: prompt
    required: true
    description: Synthesis prompt for the final (post-historian) summary
    example: "Summarize the key decisions, action items, and technical context from this session"
  - type: transcript
    required: true
    description: Session transcript content
  - type: chunk_prompt
    required: true
    description: Prompt for summarizing individual chunks during map_reduce
    example: "Summarize this segment of the session, focusing on decisions and outcomes"
  - type: existing_summary
    required: false
    description: Previous summary snapshot (joined or single). When present, the consolidate step merges it with the freshly-generated summary. When absent, consolidate acts as a light cleanup on the single fresh summary.
steps:
  - key: summarize
    name: Summarize Transcript
    step_type: map_reduce
    prompt_handle: summarize-session
    input_source: job_input
    input_config:
      input_type: transcript
    timeout_ms: 12000000
    config:
      chunk_size: 50000
      threshold: 100000
      batch_prompt_handle: summarize-session-chunk
      single_prompt_handle: summarize-session-single
      include_generated_at: true
      merge_template: "## Segment {{index}}\n\n{{output}}"
      synthesis_timeout_ms: 12000000
  - key: consolidate
    name: Consolidate Against Prior Snapshot
    step_type: prompt
    prompt_handle: consolidate-session-summaries
    input_source: template
    input_config:
      template: "## Summary Snapshot 1 (prior)\n\n{{job_input.existing_summary}}\n\n---\n\n## Summary Snapshot 2 (newly generated)\n\n{{step.summarize}}"
    timeout_ms: 12000000
  - key: historian_review
    name: Historian Editorial Prune
    step_type: prompt
    prompt_handle: session-historian-prune
    input_source: previous_step
    input_config:
      step_key: consolidate
    timeout_ms: 12000000
---

---
key: extract-and-create
name: Extract & Create
description: Summarize a session transcript, then extract decisions and action items as structured output
is_system: false
inputs:
  - type: prompt
    required: true
    description: Synthesis prompt for the summary step
  - type: transcript
    required: true
    description: Session transcript to analyze
  - type: chunk_prompt
    required: true
    description: Prompt for summarizing individual chunks
steps:
  - key: summarize
    name: Summarize
    step_type: map_reduce
    prompt_handle: summarize-session
    input_source: job_input
    input_config:
      input_type: transcript
    config:
      chunk_size: 50000
      threshold: 100000
      batch_prompt_handle: summarize-session-chunk
      merge_template: "## Segment {{index}}\n\n{{output}}"
    timeout_ms: 120000
  - key: extract
    name: Extract Decisions & Actions
    step_type: prompt
    input_source: previous_step
    input_config:
      step_key: summarize
    timeout_ms: 120000
---

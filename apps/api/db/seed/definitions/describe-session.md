---
key: describe-session
name: Describe Session
description: Generate a short description for a session. Fetches content, generates a detailed summary, distills to a concise label, and saves it to the session.
is_system: true
inputs:
  - type: session_id
    required: true
    description: Session UUID (file UUID or DB row ID) to describe
    example: "dd092605-2ef3-41d4-82bd-77a6db5169e0"
  - type: prompt
    required: false
    description: Custom synthesis prompt (overrides default summarize-session prompt)
  - type: chunk_prompt
    required: false
    description: Custom chunk summarization prompt (overrides default summarize-session-chunk prompt)
steps:
  - key: fetch
    name: Fetch Session Content
    step_type: code
    input_source: job_input
    input_config:
      input_type: session_id
    config:
      script_path: scripts/kdag/fetch-session-content.ts
    timeout_ms: 30000
  - key: summarize
    name: Summarize Content
    step_type: map_reduce
    input_source: previous_step
    input_config:
      step_key: fetch
    prompt_handle: summarize-session
    config:
      threshold: 100000
      chunk_size: 50000
      merge_template: "## Segment {{index}}\n\n{{output}}"
      batch_prompt_handle: summarize-session-chunk
      single_prompt_handle: summarize-session-single
    timeout_ms: 300000
  - key: distill
    name: Distill to Label
    step_type: prompt
    input_source: previous_step
    input_config:
      step_key: summarize
    prompt_handle: distill-session-label
    timeout_ms: 30000
  - key: save
    name: Save Description
    step_type: code
    input_source: template
    input_config:
      template: "{\"session_id\": \"{{job_input.session_id}}\", \"description\": \"{{step.distill}}\"}"
    config:
      script_path: scripts/kdag/save-session-description.ts
    timeout_ms: 15000
---

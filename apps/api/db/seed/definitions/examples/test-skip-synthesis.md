---
key: test-skip-synthesis
name: Test Skip Synthesis
description: Test map_reduce with skip_synthesis=true. Splits by character count, concatenates batch outputs directly without a final LLM call.
is_system: false
inputs:
  - type: chunk_prompt
    required: true
    description: Prompt for each chunk
  - type: prompt
    required: true
    description: Synthesis prompt (unused with skip_synthesis)
  - type: transcript
    required: true
    description: Content to split and process
steps:
  - key: extract
    name: Extract Items
    step_type: map_reduce
    input_source: job_input
    input_config:
      input_type: transcript
    config:
      chunk_size: 200
      threshold: 0
      merge_template: "{{output}}"
      skip_synthesis: true
---

---
key: line-split-test
name: Line Split Test
description: Test definition for line split mode. Processes each line individually.
is_system: false
inputs:
  - type: chunk_prompt
    required: true
    description: Prompt for processing each line
  - type: prompt
    required: true
    description: Line-delimited data to process
steps:
  - key: process
    name: Process Lines
    step_type: map_reduce
    input_source: job_input
    input_config:
      input_type: prompt
    config:
      split_mode: line
      batch_size: 1
      threshold: 0
      skip_synthesis: true
    timeout_ms: 60000
---

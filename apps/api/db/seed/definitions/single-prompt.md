---
key: custom
name: Single Prompt
description: Run a single prompt through one LLM call
is_system: true
inputs:
  - type: prompt
    required: true
    description: Prompt text to execute
    example: "Analyze the following code for potential security vulnerabilities"
steps:
  - key: execute
    name: Execute Prompt
    step_type: prompt
    input_source: job_input
    input_config:
      input_type: prompt
---

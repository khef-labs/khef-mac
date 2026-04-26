---
key: classify-and-score
name: Classify and Score Fields
description: Two-step pipeline. LLM classifies raw data into structured fields with confidence and source type, then a code step computes scores. Demonstrates code step type with previous_step wiring.
is_system: false
inputs:
  - type: prompt
    required: true
    description: Raw data to classify and score. The LLM extracts fields with source_type and confidence, then the code step scores them.
steps:
  - key: classify
    name: Classify Fields
    step_type: prompt
    assistant_handle: gemini
    input_source: job_input
    input_config:
      input_type: prompt
    timeout_ms: 60000
  - key: score
    name: Compute Scores
    step_type: code
    input_source: previous_step
    input_config:
      step_key: classify
    config:
      script_path: scripts/kdag/score-fields.ts
    timeout_ms: 30000
---

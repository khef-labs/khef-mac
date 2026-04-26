---
key: gemini-search-research
name: Gemini Search Research
description: Single prompt with Gemini using Google Search grounding and thinking for research tasks. Demonstrates Gemini-specific config options.
is_system: false
inputs:
  - type: prompt
    required: true
    description: Research question or topic
steps:
  - key: research
    name: Research with Google Search
    step_type: prompt
    assistant_handle: gemini
    model: gemini-2.5-pro
    input_source: job_input
    input_config:
      input_type: prompt
    config:
      use_thinking: true
      use_google_search: true
    timeout_ms: 180000
---

---
key: test-delimiter-grounding
name: "Test: Delimiters + Search Grounding"
description: "2-step test. Step 1: Gemini answers the prompt. Step 2: Gemini enriches step 1's output using Google Search. Demonstrates template input source and search grounding."
is_system: false
inputs:
  - type: prompt
    required: true
    description: Topic or question for step 1 to draft a response about
    example: "List 3 recent developments in WebAssembly (2025-2026). Keep it brief — just bullet points."
steps:
  - key: draft
    name: Draft Response
    step_type: prompt
    assistant_handle: gemini
    input_source: job_input
    input_config:
      input_type: prompt
  - key: research
    name: Enrich with Web Search
    step_type: prompt
    assistant_handle: gemini
    input_source: template
    input_config:
      template: "Take the following draft and enrich it with current information from the web. Add sources where possible.\n\n{{step.draft}}"
    config:
      use_google_search: true
---

---
key: multi-agent-comparison
name: Multi-Agent Comparison
description: Run the same prompt through Claude, Gemini, and Codex, then synthesize a comparison
is_system: false
inputs:
  - type: prompt
    required: true
    description: Prompt to send to all three agents
steps:
  - key: claude-run
    name: Claude
    step_type: prompt
    assistant_handle: claude-code
    input_source: job_input
    input_config:
      input_type: prompt
    timeout_ms: 300000
  - key: gemini-run
    name: Gemini
    step_type: prompt
    assistant_handle: gemini
    input_source: job_input
    input_config:
      input_type: prompt
    timeout_ms: 300000
  - key: codex-run
    name: Codex
    step_type: prompt
    assistant_handle: codex-cli
    input_source: job_input
    input_config:
      input_type: prompt
    timeout_ms: 300000
  - key: compare
    name: Compare
    step_type: prompt
    assistant_handle: claude-code
    input_source: template
    input_config:
      template: "Compare these three responses to the same prompt and analyze their strengths, weaknesses, and differences.\n\n## Claude\n\n{{step.claude-run}}\n\n## Gemini\n\n{{step.gemini-run}}\n\n## Codex\n\n{{step.codex-run}}"
    timeout_ms: 300000
---

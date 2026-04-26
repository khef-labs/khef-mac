---
key: chained-refinement
name: Word Chain Poem
description: Find synonyms, then antonyms, then compose a poem from the results
is_system: false
inputs:
  - type: prompt
    required: true
    description: Starting word or phrase for the chain
steps:
  - key: synonyms
    name: Find Synonyms
    step_type: prompt
    assistant_handle: claude-code
    prompt_handle: find-synonyms
    input_source: job_input
    input_config:
      input_type: prompt
    timeout_ms: 120000
  - key: antonyms
    name: Find Antonyms
    step_type: prompt
    assistant_handle: claude-code
    prompt_handle: find-antonyms
    input_source: previous_step
    input_config:
      step_key: synonyms
    timeout_ms: 120000
  - key: poem
    name: Compose Poem
    step_type: prompt
    assistant_handle: claude-code
    prompt_handle: compose-poem
    input_source: previous_step
    input_config:
      step_key: antonyms
    timeout_ms: 120000
---

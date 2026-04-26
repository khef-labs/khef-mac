---
key: bulk-import-md
name: Bulk Import Markdown
description: Scan a directory of .md files, enrich with AI-suggested tags, and import as khef memories
is_system: false
inputs:
  - type: source_dir
    required: true
    description: Absolute path to directory containing .md files to import
  - type: project_handle
    required: true
    description: Target khef project handle
  - type: memory_type
    required: false
    description: Memory type for imported files (default user-note)
  - type: collection_handle
    required: false
    description: Collection handle to add imported memories to
  - type: prompt
    required: false
    description: Enrichment instructions for the AI tag step. Defaults are provided — use this to add extra guidance.
steps:
  - key: scan
    name: Scan Directory
    step_type: code
    input_source: template
    input_config:
      template: '{"source_dir":"{{job_input.source_dir}}","project_handle":"{{job_input.project_handle}}","memory_type":"{{job_input.memory_type}}","collection_handle":"{{job_input.collection_handle}}"}'
    config:
      script_path: scripts/kdag/scan-directory.ts
    timeout_ms: 30000
  - key: enrich
    name: Enrich Tags
    step_type: prompt
    prompt_handle: enrich-memory-import-tags
    input_source: template
    input_config:
      template: "{{step.scan}}\n\nUser guidance: {{job_input.prompt}}"
    timeout_ms: 120000
  - key: import
    name: Import Memories
    step_type: code
    input_source: previous_step
    input_config:
      step_key: enrich
    config:
      script_path: scripts/kdag/import-memories.ts
    timeout_ms: 120000
---

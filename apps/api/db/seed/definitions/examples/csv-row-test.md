---
key: csv-row-test
name: CSV Row Split Test
description: Test definition for csv_row split mode. Processes each CSV row individually.
is_system: false
inputs:
  - type: chunk_prompt
    required: true
    description: Prompt for processing each row
  - type: prompt
    required: true
    description: CSV data to process
steps:
  - key: process
    name: Process CSV Rows
    step_type: map_reduce
    input_source: job_input
    input_config:
      input_type: prompt
    config:
      split_mode: csv_row
      batch_size: 1
      threshold: 0
      skip_synthesis: true
    timeout_ms: 60000
---

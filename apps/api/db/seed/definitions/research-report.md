---
key: research-report
name: Research Report
description: Research a topic across multiple angles, compile findings, and produce a polished report with diagrams (Mermaid, D2, PlantUML, or Graphviz)
is_system: false
inputs:
  - type: prompt
    required: true
    description: Topic or question to research (e.g., "Compare event-driven vs request-driven architectures for microservices")
steps:
  - key: research-breadth
    name: Broad Research
    step_type: prompt
    assistant_handle: claude-code
    input_source: template
    input_config:
      template: "You are a technical researcher. Given the topic below, identify 4-6 key dimensions to investigate. For each dimension, provide:\n- A clear definition\n- Current state of the art\n- Key tradeoffs and considerations\n- Notable examples or case studies\n\nBe thorough and cite specific technologies, papers, or projects where relevant.\n\n## Topic\n\n{{job_input.prompt}}"
    timeout_ms: 300000
  - key: research-depth
    name: Deep Analysis
    step_type: prompt
    assistant_handle: gemini
    input_source: template
    input_config:
      template: "You are a senior technical analyst. Review the broad research below and perform a deeper analysis:\n\n1. Identify patterns and connections across the dimensions\n2. Highlight areas of consensus and disagreement\n3. Assess maturity and adoption levels\n4. Identify emerging trends and future directions\n5. Note any gaps or blind spots in the initial research\n\n## Broad Research\n\n{{step.research-breadth}}"
    timeout_ms: 300000
  - key: compile
    name: Compile & Structure
    step_type: prompt
    assistant_handle: claude-code
    input_source: template
    input_config:
      template: "You are a technical writer compiling a research report. Using the research and analysis below, produce a comprehensive, well-structured report in markdown.\n\n## Requirements\n\n1. **Executive Summary** (2-3 paragraphs)\n2. **Key Findings** (bulleted, prioritized)\n3. **Detailed Analysis** (one section per dimension, with subsections)\n4. **Comparison Matrix** (if applicable, as a markdown table)\n5. **Diagrams** — include at least 2 diagrams using fenced code blocks:\n   - An architecture or flow diagram (use ```mermaid or ```d2)\n   - A component relationship or comparison diagram (use ```plantuml or ```graphviz)\n   - Optionally: a timeline, mindmap, or quadrant chart\n6. **Recommendations** (actionable, ranked)\n7. **References & Further Reading**\n\nMake diagrams substantive — they should convey real information, not just decorative structure.\n\n## Broad Research\n\n{{step.research-breadth}}\n\n## Deep Analysis\n\n{{step.research-depth}}"
    timeout_ms: 300000
---

---
key: code-review-pipeline
name: Code Review Pipeline
description: Analyze a code diff or PR from multiple angles (security, performance, maintainability) and produce a unified review
is_system: false
inputs:
  - type: prompt
    required: true
    description: Code diff, PR description, or file contents to review
steps:
  - key: security-review
    name: Security Review
    step_type: prompt
    assistant_handle: claude-code
    input_source: template
    input_config:
      template: "You are a security-focused code reviewer. Analyze the code below for:\n\n- Injection vulnerabilities (SQL, XSS, command injection)\n- Authentication and authorization gaps\n- Data exposure or leakage risks\n- Insecure dependencies or configurations\n- OWASP Top 10 concerns\n\nRate severity (critical/high/medium/low) for each finding. If no issues found, state that explicitly.\n\n## Code\n\n{{job_input.prompt}}"
    timeout_ms: 180000
  - key: performance-review
    name: Performance Review
    step_type: prompt
    assistant_handle: claude-code
    input_source: template
    input_config:
      template: "You are a performance-focused code reviewer. Analyze the code below for:\n\n- Algorithm complexity (time and space)\n- N+1 query patterns or unnecessary database calls\n- Memory leaks or unbounded growth\n- Missing caching opportunities\n- Blocking operations that could be async\n- Resource cleanup issues\n\nRate impact (critical/high/medium/low) for each finding.\n\n## Code\n\n{{job_input.prompt}}"
    timeout_ms: 180000
  - key: maintainability-review
    name: Maintainability Review
    step_type: prompt
    assistant_handle: gemini
    input_source: template
    input_config:
      template: "You are a senior engineer reviewing code for long-term maintainability. Analyze:\n\n- Naming clarity and consistency\n- Function/method complexity (cognitive load)\n- Error handling completeness\n- Test coverage gaps\n- Adherence to SOLID principles\n- Documentation needs\n- Code duplication\n\nRate importance (critical/high/medium/low) for each suggestion.\n\n## Code\n\n{{job_input.prompt}}"
    timeout_ms: 180000
  - key: synthesize
    name: Synthesize Review
    step_type: prompt
    assistant_handle: claude-code
    input_source: template
    input_config:
      template: "You are a tech lead synthesizing code review feedback from three specialized reviewers. Produce a unified review report:\n\n1. **Summary** — overall assessment (approve / request changes / needs discussion)\n2. **Critical Issues** — must fix before merge (from any reviewer)\n3. **Improvements** — recommended changes, prioritized\n4. **Positive Notes** — things done well\n5. **Action Items** — checklist of specific changes needed\n\nDeduplicate overlapping findings. Resolve conflicting advice with your judgment.\n\n## Security Review\n\n{{step.security-review}}\n\n## Performance Review\n\n{{step.performance-review}}\n\n## Maintainability Review\n\n{{step.maintainability-review}}"
    timeout_ms: 300000
---

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Use CommonJS require to load the script module
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyClaudeRules } = require('../../scripts/rules/user/agents/claude.js');

describe('sync:user-rules-to-disk (Claude imports)', () => {
  const originalHome = os.homedir();
  const originalEnvHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome: string;

  beforeAll(() => {
    // Create a temporary HOME directory for this test
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-home-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome; // for cross-compat
    // Ensure ~/.claude exists with a baseline CLAUDE.md
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeMain = path.join(claudeDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMain, '# Claude Config\n\nSome initial content.\n', 'utf8');
  });

  afterAll(() => {
    // Restore HOME environment
    if (originalEnvHome !== undefined) process.env.HOME = originalEnvHome; else delete process.env.HOME;
    if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile; else delete process.env.USERPROFILE;
    // Best-effort cleanup
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  });

  it('writes KF-RULES.md, inserts single import in CLAUDE.md, and avoids duplicating rules in CLAUDE.md', () => {
    const rules = [
      { title: 'Sample Rule A', content: 'Alpha guidance' },
      { title: 'Sample Rule B', content: 'Bravo guidance' },
    ];

    // First apply
    const results1 = applyClaudeRules(rules);
    const claudeDir = path.join(tempHome, '.claude');
    const rulesFile = path.join(claudeDir, 'KF-RULES.md');
    const claudeMain = path.join(claudeDir, 'CLAUDE.md');

    expect(fs.existsSync(rulesFile)).toBe(true);
    const rulesContent = fs.readFileSync(rulesFile, 'utf8');
    expect(rulesContent).not.toContain('BEGIN MEM-ZEN RULES');
    const titleCount = (rulesContent.match(/Sample Rule A/g) || []).length;
    expect(titleCount).toBe(1);

    const mainContent = fs.readFileSync(claudeMain, 'utf8');
    const importLine = '@~/.claude/KF-RULES.md';
    const importCount = (mainContent.match(new RegExp(importLine, 'g')) || []).length;
    expect(importCount).toBe(1);
    // Ensure CLAUDE.md does not contain the auto-generated rules block
    expect(mainContent).not.toContain('BEGIN MEM-ZEN RULES');
    // Preserve formatting: original header remains and a blank line before import
    expect(mainContent).toContain('# Claude Config');
    expect(mainContent).toContain('Some initial content.');
    expect(mainContent).toMatch(/Some initial content\.[\s\S]*\n\n@~\/\.claude\/KF-RULES\.md/);

    // Second apply (idempotency)
    const results2 = applyClaudeRules(rules);
    const mainContent2 = fs.readFileSync(claudeMain, 'utf8');
    const importCount2 = (mainContent2.match(new RegExp(importLine, 'g')) || []).length;
    expect(importCount2).toBe(1); // no duplicate imports

    // At least one operation should have reported a target update on first run
    expect(results1.length).toBeGreaterThan(0);
    // Second run may or may not change anything (idempotent), but should not error
    expect(Array.isArray(results2)).toBe(true);
  });
});

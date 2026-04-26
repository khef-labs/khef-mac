import { describe, it, expect } from 'vitest';
import { resolveCodeStepRuntime } from '../../src/services/kdag-executor';

describe('resolveCodeStepRuntime', () => {
  it('uses tsx for TypeScript code steps', () => {
    expect(resolveCodeStepRuntime('scripts/transform.ts')).toEqual({
      command: 'tsx',
      args: ['scripts/transform.ts'],
    });

    expect(resolveCodeStepRuntime('scripts/transform.tsx')).toEqual({
      command: 'tsx',
      args: ['scripts/transform.tsx'],
    });
  });

  it('uses python3 for Python code steps', () => {
    expect(resolveCodeStepRuntime('scripts/transform.py')).toEqual({
      command: 'python3',
      args: ['scripts/transform.py'],
    });
  });

  it('defaults to node for non-ts/python scripts', () => {
    expect(resolveCodeStepRuntime('scripts/transform.js')).toEqual({
      command: 'node',
      args: ['scripts/transform.js'],
    });
  });

  it('matches file extensions case-insensitively', () => {
    expect(resolveCodeStepRuntime('scripts/transform.PY')).toEqual({
      command: 'python3',
      args: ['scripts/transform.PY'],
    });
  });
});

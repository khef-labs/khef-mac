import { describe, it, expect } from 'vitest';
import { resolveMapReduceTimeouts } from '../../src/services/kdag-executor';

const STEP = 300_000;

describe('resolveMapReduceTimeouts', () => {
  it('falls back to the step timeout for both phases when neither override is set', () => {
    expect(resolveMapReduceTimeouts({}, STEP)).toEqual({
      batchTimeoutMs: STEP,
      synthTimeoutMs: STEP,
    });
  });

  it('applies batch_timeout_ms only to batches, leaving synthesis on the step timeout', () => {
    expect(
      resolveMapReduceTimeouts({ batch_timeout_ms: 60_000 }, STEP)
    ).toEqual({
      batchTimeoutMs: 60_000,
      synthTimeoutMs: STEP,
    });
  });

  it('applies synthesis_timeout_ms only to synthesis, leaving batches on the step timeout', () => {
    expect(
      resolveMapReduceTimeouts({ synthesis_timeout_ms: 600_000 }, STEP)
    ).toEqual({
      batchTimeoutMs: STEP,
      synthTimeoutMs: 600_000,
    });
  });

  it('applies both overrides independently when both are set', () => {
    expect(
      resolveMapReduceTimeouts(
        { batch_timeout_ms: 120_000, synthesis_timeout_ms: 600_000 },
        STEP
      )
    ).toEqual({
      batchTimeoutMs: 120_000,
      synthTimeoutMs: 600_000,
    });
  });

  it('treats explicit 0 as a valid override, not a falsy fallback', () => {
    expect(
      resolveMapReduceTimeouts(
        { batch_timeout_ms: 0, synthesis_timeout_ms: 0 },
        STEP
      )
    ).toEqual({
      batchTimeoutMs: 0,
      synthTimeoutMs: 0,
    });
  });

  it('ignores non-number values and falls back to the step timeout', () => {
    expect(
      resolveMapReduceTimeouts(
        { batch_timeout_ms: '90000' as any, synthesis_timeout_ms: null as any },
        STEP
      )
    ).toEqual({
      batchTimeoutMs: STEP,
      synthTimeoutMs: STEP,
    });
  });

  it('tolerates null/undefined config', () => {
    expect(resolveMapReduceTimeouts(null, STEP)).toEqual({
      batchTimeoutMs: STEP,
      synthTimeoutMs: STEP,
    });
    expect(resolveMapReduceTimeouts(undefined, STEP)).toEqual({
      batchTimeoutMs: STEP,
      synthTimeoutMs: STEP,
    });
  });
});

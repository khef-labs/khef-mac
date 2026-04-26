import { describe, it, expect } from 'vitest';
import { randomNickname, uniqueNickname, namespaceSize } from '../../src/services/nickname-generator';

describe('nickname-generator', () => {
  describe('randomNickname', () => {
    it('returns a lowercase string', () => {
      for (let i = 0; i < 50; i++) {
        const name = randomNickname();
        expect(name).toMatch(/^[a-z]+$/);
      }
    });

    it('generates varied names', () => {
      const names = new Set<string>();
      for (let i = 0; i < 50; i++) {
        names.add(randomNickname());
      }
      // Allow rare collision from 4,940 pool
      expect(names.size).toBeGreaterThanOrEqual(45);
    });
  });

  describe('uniqueNickname', () => {
    it('returns a name not in the used set', () => {
      const used = new Set(['alpha', 'beta', 'gamma']);
      for (let i = 0; i < 50; i++) {
        const name = uniqueNickname(used);
        expect(used.has(name)).toBe(false);
      }
    });

    it('cascades to later pools when names pool is crowded', () => {
      // Fill used set with a lot of names to increase cascade likelihood
      const used = new Set<string>();
      for (let i = 0; i < 500; i++) {
        used.add(randomNickname());
      }
      // Should still find a unique name (from any pool)
      const name = uniqueNickname(used);
      expect(used.has(name)).toBe(false);
    });

    it('cascades to color-animal pool when earlier pools are fully exhausted', () => {
      // Fill used set with ALL names from the first 3 pools to force cascade
      const { animals, colors, names: namesList } = require('unique-names-generator');
      const used = new Set<string>();
      for (const n of namesList) used.add(n.toLowerCase());
      for (const c of colors) used.add(c.toLowerCase());
      for (const a of animals) used.add(a.toLowerCase());

      const result = uniqueNickname(used);
      expect(result).toContain('-');
      expect(used.has(result)).toBe(false);
    });
  });

  describe('uniqueNickname with preferred names', () => {
    it('returns a preferred name when available', () => {
      const used = new Set<string>();
      const preferred = ['ridge', 'peak', 'ember'];
      const result = uniqueNickname(used, preferred);
      expect(preferred).toContain(result);
    });

    it('skips preferred names that are already in use', () => {
      const used = new Set(['ridge', 'peak']);
      const preferred = ['ridge', 'peak', 'ember'];
      const result = uniqueNickname(used, preferred);
      expect(result).toBe('ember');
    });

    it('falls back to auto-generated when all preferred names are taken', () => {
      const preferred = ['ridge', 'peak', 'ember'];
      const used = new Set(preferred);
      const result = uniqueNickname(used, preferred);
      expect(preferred).not.toContain(result);
      expect(result.length).toBeGreaterThan(0);
    });

    it('normalizes preferred names to lowercase', () => {
      const used = new Set<string>();
      const preferred = ['  Ridge ', 'PEAK'];
      const result = uniqueNickname(used, preferred);
      expect(result).toMatch(/^[a-z]+$/);
    });

    it('ignores empty/whitespace preferred names', () => {
      const used = new Set<string>();
      const preferred = ['', '  ', 'ember'];
      const result = uniqueNickname(used, preferred);
      expect(result).toBe('ember');
    });
  });

  describe('uniqueNickname with length constraints', () => {
    it('respects maxLength constraint', () => {
      const used = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const result = uniqueNickname(used, undefined, { maxLength: 5 });
        expect(result.length).toBeLessThanOrEqual(5);
      }
    });

    it('respects minLength constraint', () => {
      const used = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const result = uniqueNickname(used, undefined, { minLength: 6 });
        expect(result.length).toBeGreaterThanOrEqual(6);
      }
    });

    it('respects both min and max together', () => {
      const used = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const result = uniqueNickname(used, undefined, { minLength: 4, maxLength: 6 });
        expect(result.length).toBeGreaterThanOrEqual(4);
        expect(result.length).toBeLessThanOrEqual(6);
      }
    });

    it('does not apply length constraints to preferred names', () => {
      const used = new Set<string>();
      const preferred = ['ab']; // 2 chars, below minLength of 5
      const result = uniqueNickname(used, preferred, { minLength: 5 });
      expect(result).toBe('ab');
    });

    it('treats 0 as no constraint', () => {
      const used = new Set<string>();
      const result = uniqueNickname(used, undefined, { minLength: 0, maxLength: 0 });
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('namespaceSize', () => {
    it('reports combined size of all pools', () => {
      const size = namespaceSize();
      // names(4940) + colors(52) + animals(355) + colors*animals(18460) ≈ 23807
      expect(size).toBeGreaterThan(20_000);
      console.log(`Namespace size: ${size.toLocaleString()} possible nicknames`);
    });
  });

  describe('sample output', () => {
    it('prints 20 sample nicknames', () => {
      const samples = Array.from({ length: 20 }, () => randomNickname());
      console.log('Sample nicknames:', samples.join(', '));
      expect(samples).toHaveLength(20);
    });
  });
});

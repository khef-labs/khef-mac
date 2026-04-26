import { describe, it, expect } from 'vitest';
import { normalizeExportImageTheme, resolveExportImageTheme, getValidThemes } from '../../src/services/export-image-theme';

describe('export image theme helpers', () => {
  describe('normalizeExportImageTheme', () => {
    it('returns null for empty values', () => {
      expect(normalizeExportImageTheme(undefined)).toBeNull();
      expect(normalizeExportImageTheme(null)).toBeNull();
      expect(normalizeExportImageTheme('')).toBeNull();
    });

    it('normalizes valid themes', () => {
      expect(normalizeExportImageTheme('light')).toBe('light');
      expect(normalizeExportImageTheme('dark')).toBe('dark');
      expect(normalizeExportImageTheme('neutral')).toBe('neutral');
      expect(normalizeExportImageTheme('forest')).toBe('forest');
      expect(normalizeExportImageTheme('ocean')).toBe('ocean');
      expect(normalizeExportImageTheme(' Light ')).toBe('light');
      expect(normalizeExportImageTheme('FOREST')).toBe('forest');
    });

    it('returns null for invalid themes', () => {
      expect(normalizeExportImageTheme('blue')).toBeNull();
      expect(normalizeExportImageTheme('midnight')).toBeNull();
    });
  });

  describe('getValidThemes', () => {
    it('returns all valid theme names', () => {
      const themes = getValidThemes();
      expect(themes).toContain('dark');
      expect(themes).toContain('light');
      expect(themes).toContain('neutral');
      expect(themes).toContain('forest');
      expect(themes).toContain('ocean');
      expect(themes).toHaveLength(5);
    });
  });

  describe('resolveExportImageTheme', () => {
    it('prefers memory metadata over global setting', () => {
      const theme = resolveExportImageTheme({
        memoryMetadata: 'dark',
        globalSetting: 'light',
      });
      expect(theme).toBe('dark');
    });

    it('falls back to global setting when metadata is missing', () => {
      const theme = resolveExportImageTheme({
        globalSetting: 'light',
      });
      expect(theme).toBe('light');
    });

    it('uses fallback when both values are invalid', () => {
      const theme = resolveExportImageTheme({
        memoryMetadata: 'blue',
        globalSetting: 'purple',
        fallback: 'light',
      });
      expect(theme).toBe('light');
    });

    it('defaults to light when no values provided', () => {
      const theme = resolveExportImageTheme({});
      expect(theme).toBe('light');
    });
  });
});

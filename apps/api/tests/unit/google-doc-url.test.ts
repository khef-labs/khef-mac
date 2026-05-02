import { describe, it, expect } from 'vitest';
import { parseGoogleDocId, parseGoogleDocTabId } from '../../src/services/google';

describe('google-doc-url', () => {
  describe('parseGoogleDocId', () => {
    it('extracts ID from a standard /edit URL', () => {
      expect(
        parseGoogleDocId('https://docs.google.com/document/d/1AbCdEf-Ghi_JklMnoPqr12345678901234567890/edit')
      ).toBe('1AbCdEf-Ghi_JklMnoPqr12345678901234567890');
    });

    it('extracts ID when the URL also has a tab parameter', () => {
      expect(
        parseGoogleDocId(
          'https://docs.google.com/document/d/1AbCdEf-Ghi_JklMnoPqr12345678901234567890/edit?tab=t.abc123'
        )
      ).toBe('1AbCdEf-Ghi_JklMnoPqr12345678901234567890');
    });

    it('passes through a bare doc ID unchanged', () => {
      const id = '1AbCdEf-Ghi_JklMnoPqr12345678901234567890';
      expect(parseGoogleDocId(id)).toBe(id);
    });

    it('returns null for unrelated input', () => {
      expect(parseGoogleDocId('https://example.com/foo')).toBeNull();
    });
  });

  describe('parseGoogleDocTabId', () => {
    it('extracts the tab id from a ?tab= query string', () => {
      expect(
        parseGoogleDocTabId(
          'https://docs.google.com/document/d/abc/edit?tab=t.abc123def456'
        )
      ).toBe('t.abc123def456');
    });

    it('extracts the tab id when it follows other query params', () => {
      expect(
        parseGoogleDocTabId(
          'https://docs.google.com/document/d/abc/edit?usp=drivesdk&tab=t.zzz'
        )
      ).toBe('t.zzz');
    });

    it('extracts the tab id from a #tab= fragment', () => {
      expect(
        parseGoogleDocTabId(
          'https://docs.google.com/document/d/abc/edit#tab=t.frag'
        )
      ).toBe('t.frag');
    });

    it('returns null when no tab parameter is present', () => {
      expect(
        parseGoogleDocTabId('https://docs.google.com/document/d/abc/edit')
      ).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseGoogleDocTabId('')).toBeNull();
    });

    it('ignores tab values that do not match the t.<id> shape', () => {
      expect(
        parseGoogleDocTabId('https://docs.google.com/document/d/abc/edit?tab=foo')
      ).toBeNull();
    });
  });
});

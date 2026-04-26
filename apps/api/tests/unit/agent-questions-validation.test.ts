import { describe, it, expect } from 'vitest';
import {
  validateAnswerValues,
  ValidationError,
  type QuestionField,
} from '../../src/services/agent-questions';

describe('agent-questions validation', () => {
  describe('validateAnswerValues', () => {
    it('accepts valid text and required check', () => {
      const fields: QuestionField[] = [
        { key: 'name', type: 'text', label: 'Name', required: true },
      ];
      expect(validateAnswerValues(fields, { name: 'roger' })).toEqual({ name: 'roger' });
      expect(() => validateAnswerValues(fields, {})).toThrow(ValidationError);
    });

    it('coerces stringified booleans for toggles', () => {
      const fields: QuestionField[] = [{ key: 'on', type: 'toggle', label: 'On' }];
      expect(validateAnswerValues(fields, { on: 'true' })).toEqual({ on: true });
      expect(validateAnswerValues(fields, { on: false })).toEqual({ on: false });
      expect(() => validateAnswerValues(fields, { on: 'yes' })).toThrow(ValidationError);
    });

    it('enforces number ranges', () => {
      const fields: QuestionField[] = [
        { key: 'age', type: 'number', label: 'Age', min: 1, max: 120 },
      ];
      expect(validateAnswerValues(fields, { age: 30 })).toEqual({ age: 30 });
      expect(validateAnswerValues(fields, { age: '42' })).toEqual({ age: 42 });
      expect(() => validateAnswerValues(fields, { age: 0 })).toThrow(ValidationError);
      expect(() => validateAnswerValues(fields, { age: 121 })).toThrow(ValidationError);
      expect(() => validateAnswerValues(fields, { age: 'not a number' })).toThrow(ValidationError);
    });

    it('validates single-choice option values', () => {
      const fields: QuestionField[] = [
        {
          key: 'host',
          type: 'single-choice',
          label: 'Host',
          required: true,
          options: [
            { value: 'cf', label: 'Cloudflare' },
            { value: 'vercel', label: 'Vercel' },
          ],
        },
      ];
      expect(validateAnswerValues(fields, { host: 'cf' })).toEqual({ host: 'cf' });
      expect(() => validateAnswerValues(fields, { host: 'aws' })).toThrow(ValidationError);
      expect(() => validateAnswerValues(fields, {})).toThrow(ValidationError);
    });

    it('validates multi-choice arrays of allowed values', () => {
      const fields: QuestionField[] = [
        {
          key: 'tags',
          type: 'multi-choice',
          label: 'Tags',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
          ],
        },
      ];
      expect(validateAnswerValues(fields, { tags: ['a', 'c'] })).toEqual({ tags: ['a', 'c'] });
      expect(() => validateAnswerValues(fields, { tags: ['a', 'z'] })).toThrow(ValidationError);
      expect(() => validateAnswerValues(fields, { tags: 'a' })).toThrow(ValidationError);
    });

    it('skips optional empty fields without error', () => {
      const fields: QuestionField[] = [
        { key: 'notes', type: 'textarea', label: 'Notes' },
      ];
      expect(validateAnswerValues(fields, {})).toEqual({});
      expect(validateAnswerValues(fields, { notes: '' })).toEqual({});
      expect(validateAnswerValues(fields, { notes: 'hi' })).toEqual({ notes: 'hi' });
    });

    it('rejects non-object payloads', () => {
      const fields: QuestionField[] = [{ key: 'name', type: 'text', label: 'Name' }];
      expect(() => validateAnswerValues(fields, null)).toThrow(ValidationError);
      expect(() => validateAnswerValues(fields, [])).toThrow(ValidationError);
      expect(() => validateAnswerValues(fields, 'string')).toThrow(ValidationError);
    });
  });
});

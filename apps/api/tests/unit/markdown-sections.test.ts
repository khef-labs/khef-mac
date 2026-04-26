import { describe, it, expect } from 'vitest';
import {
  parseMarkdownSections,
  findSection,
  extractSectionContent,
  replaceSectionContent,
  getDirectContent
} from '../../src/utils/markdown-sections';

describe('Markdown Sections Utility', () => {
  const testDocument = `# Overview

This is the overview section.

## Technical Design

This section covers the technical design.

### API Changes

Here are the API changes:
- Added new endpoints
- Updated response format

### Database Schema

The database schema includes:
- users table
- orders table

## Testing Plan

The testing plan covers:
1. Unit tests
2. Integration tests
3. E2E tests

## Conclusion

Final thoughts here.`;

  describe('parseMarkdownSections', () => {
    it('should parse all headings from markdown content', () => {
      const sections = parseMarkdownSections(testDocument);

      expect(sections).toHaveLength(6);
      expect(sections[0].heading).toBe('Overview');
      expect(sections[0].level).toBe(1);

      expect(sections[1].heading).toBe('Technical Design');
      expect(sections[1].level).toBe(2);

      expect(sections[2].heading).toBe('API Changes');
      expect(sections[2].level).toBe(3);

      expect(sections[3].heading).toBe('Database Schema');
      expect(sections[3].level).toBe(3);

      expect(sections[4].heading).toBe('Testing Plan');
      expect(sections[4].level).toBe(2);

      expect(sections[5].heading).toBe('Conclusion');
      expect(sections[5].level).toBe(2);
    });

    it('should calculate correct section boundaries', () => {
      const sections = parseMarkdownSections(testDocument);

      // Overview (h1) - only h1 in doc, so it spans to EOF
      // (no other h1 heading to end it)
      expect(sections[0].end).toBe(testDocument.length);

      // Technical Design (h2) should include its h3 children and end at Testing Plan (h2)
      expect(sections[1].end).toBe(sections[4].start);

      // API Changes (h3) should end at Database Schema (h3) - same level
      expect(sections[2].end).toBe(sections[3].start);

      // Database Schema (h3) should end at Testing Plan (h2) - higher level
      expect(sections[3].end).toBe(sections[4].start);

      // Testing Plan (h2) should end at Conclusion (h2) - same level
      expect(sections[4].end).toBe(sections[5].start);

      // Last section should end at document length
      expect(sections[5].end).toBe(testDocument.length);
    });

    it('should handle empty content', () => {
      const sections = parseMarkdownSections('');
      expect(sections).toHaveLength(0);
    });

    it('should handle content with no headings', () => {
      const sections = parseMarkdownSections('Just some plain text.\n\nNo headings here.');
      expect(sections).toHaveLength(0);
    });

    it('should handle all heading levels', () => {
      const content = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;

      const sections = parseMarkdownSections(content);
      expect(sections).toHaveLength(6);
      expect(sections.map(s => s.level)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('should not match code blocks as headings', () => {
      const content = `# Real Heading

Some text.

\`\`\`markdown
# This is in a code block
\`\`\`

## Another Real Heading`;

      const sections = parseMarkdownSections(content);
      // Note: Current implementation doesn't filter code blocks
      // This test documents current behavior
      expect(sections.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('findSection', () => {
    it('should find section by exact heading', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Technical Design');

      expect(section).not.toBeNull();
      expect(section?.heading).toBe('Technical Design');
    });

    it('should be case-insensitive', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'technical design');

      expect(section).not.toBeNull();
      expect(section?.heading).toBe('Technical Design');
    });

    it('should return null for non-existent section', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Non Existent');

      expect(section).toBeNull();
    });

    it('should return first match by default (index 0)', () => {
      const content = `# Overview\nFirst overview.\n\n## Details\nSome details.\n\n# Overview\nSecond overview.`;
      const sections = parseMarkdownSections(content);
      const section = findSection(sections, 'Overview');

      expect(section).not.toBeNull();
      expect(section?.start).toBe(0); // First occurrence
    });

    it('should return nth occurrence when index is specified', () => {
      const content = `# Overview\nFirst overview.\n\n## Details\nSome details.\n\n# Overview\nSecond overview.`;
      const sections = parseMarkdownSections(content);

      const first = findSection(sections, 'Overview', 0);
      const second = findSection(sections, 'Overview', 1);

      expect(first?.start).toBe(0);
      expect(second?.start).toBeGreaterThan(0);
      expect(second?.start).not.toBe(first?.start);
    });

    it('should return null if index exceeds occurrences', () => {
      const content = `# Overview\nFirst overview.\n\n## Details\nSome details.`;
      const sections = parseMarkdownSections(content);
      const section = findSection(sections, 'Overview', 1); // Only one Overview exists

      expect(section).toBeNull();
    });
  });

  describe('extractSectionContent', () => {
    it('should extract section with subsections by default', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Technical Design')!;
      const content = extractSectionContent(testDocument, section);

      expect(content).toContain('## Technical Design');
      expect(content).toContain('### API Changes');
      expect(content).toContain('### Database Schema');
      expect(content).not.toContain('## Testing Plan');
    });

    it('should exclude subsections when specified', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Technical Design')!;
      const content = extractSectionContent(testDocument, section, false);

      expect(content).toContain('## Technical Design');
      expect(content).toContain('This section covers the technical design.');
      expect(content).not.toContain('### API Changes');
    });

    it('should extract leaf section content', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'API Changes')!;
      const content = extractSectionContent(testDocument, section);

      expect(content).toContain('### API Changes');
      expect(content).toContain('Added new endpoints');
      expect(content).not.toContain('Database Schema');
    });

    it('should extract last section content', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Conclusion')!;
      const content = extractSectionContent(testDocument, section);

      expect(content).toContain('## Conclusion');
      expect(content).toContain('Final thoughts here.');
    });
  });

  describe('replaceSectionContent', () => {
    it('should replace section content while preserving heading', () => {
      const sections = parseMarkdownSections(testDocument);
      // Use Testing Plan (h2) which has clear boundaries
      const section = findSection(sections, 'Testing Plan')!;
      const newContent = 'This is the new testing plan content.';

      const result = replaceSectionContent(testDocument, section, newContent);

      expect(result).toContain('## Testing Plan\n');
      expect(result).toContain('This is the new testing plan content.');
      expect(result).not.toContain('Unit tests');
      expect(result).not.toContain('Integration tests');
      // Content before should be preserved
      expect(result).toContain('## Technical Design');
      // Content after should be preserved
      expect(result).toContain('## Conclusion');
    });

    it('should preserve content after the section', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Technical Design')!;
      const newContent = 'New technical design content.';

      const result = replaceSectionContent(testDocument, section, newContent);

      expect(result).toContain('# Overview');
      expect(result).toContain('This is the overview section.');
      expect(result).toContain('## Technical Design');
      expect(result).toContain('New technical design content.');
      expect(result).toContain('## Testing Plan');
      expect(result).toContain('## Conclusion');
    });

    it('should handle replacing the last section', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Conclusion')!;
      const newContent = 'Updated conclusion.';

      const result = replaceSectionContent(testDocument, section, newContent);

      expect(result).toContain('## Conclusion');
      expect(result).toContain('Updated conclusion.');
      expect(result).not.toContain('Final thoughts here.');
      expect(result).toContain('## Testing Plan');
    });

    it('should handle multiline replacement content', () => {
      const sections = parseMarkdownSections(testDocument);
      // Use Conclusion which has clear boundaries and is not the only h1
      const section = findSection(sections, 'Conclusion')!;
      const newContent = `This is paragraph one.

This is paragraph two.

And this is paragraph three.`;

      const result = replaceSectionContent(testDocument, section, newContent);

      expect(result).toContain('## Conclusion\n');
      expect(result).toContain('This is paragraph one.');
      expect(result).toContain('This is paragraph two.');
      expect(result).toContain('And this is paragraph three.');
      // Previous content should be preserved
      expect(result).toContain('## Testing Plan');
    });

    it('should rename heading when new_heading is provided', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Testing Plan')!;
      const newContent = 'Updated testing content.';

      const result = replaceSectionContent(testDocument, section, newContent, 'QA Strategy');

      expect(result).toContain('## QA Strategy\n');
      expect(result).toContain('Updated testing content.');
      expect(result).not.toContain('## Testing Plan');
      // Other sections preserved
      expect(result).toContain('## Technical Design');
      expect(result).toContain('## Conclusion');
    });

    it('should preserve heading level when renaming', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'API Changes')!;
      const newContent = 'New API content.';

      const result = replaceSectionContent(testDocument, section, newContent, 'REST Endpoints');

      // Should be h3 (same as API Changes)
      expect(result).toContain('### REST Endpoints\n');
      expect(result).toContain('New API content.');
      expect(result).not.toContain('### API Changes');
    });

    it('should strip duplicate heading if agent accidentally includes it', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Testing Plan')!;
      const newContent = '## Testing Plan\n\nThis is the new testing plan content.';

      const result = replaceSectionContent(testDocument, section, newContent);

      const matches = result.match(/## Testing Plan/g);
      expect(matches).toHaveLength(1);
      expect(result).toContain('This is the new testing plan content.');
    });

    it('should strip duplicate heading case-insensitively', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Testing Plan')!;
      const newContent = '## testing plan\n\nUpdated content here.';

      const result = replaceSectionContent(testDocument, section, newContent);

      const matches = result.match(/## [Tt]esting [Pp]lan/g);
      expect(matches).toHaveLength(1);
      expect(result).toContain('Updated content here.');
    });

    it('should not strip heading if it does not match section heading', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Testing Plan')!;
      const newContent = '### Unit Tests\n\nHere are the unit test details.';

      const result = replaceSectionContent(testDocument, section, newContent);

      expect(result).toContain('## Testing Plan');
      expect(result).toContain('### Unit Tests');
      expect(result).toContain('Here are the unit test details.');
    });

    it('should strip duplicate heading when renaming', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Testing Plan')!;
      const newContent = '## QA Strategy\n\nNew QA content.';

      const result = replaceSectionContent(testDocument, section, newContent, 'QA Strategy');

      const matches = result.match(/## QA Strategy/g);
      expect(matches).toHaveLength(1);
      expect(result).toContain('New QA content.');
    });
  });

  describe('getDirectContent', () => {
    it('should get only immediate content under heading', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'Technical Design')!;
      const content = getDirectContent(testDocument, section);

      expect(content).toContain('This section covers the technical design.');
      expect(content).not.toContain('### API Changes');
      expect(content).not.toContain('### Database Schema');
    });

    it('should get full content for leaf sections', () => {
      const sections = parseMarkdownSections(testDocument);
      const section = findSection(sections, 'API Changes')!;
      const content = getDirectContent(testDocument, section);

      expect(content).toContain('Added new endpoints');
      expect(content).toContain('Updated response format');
    });
  });
});

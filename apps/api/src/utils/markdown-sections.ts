/**
 * Markdown section parsing utilities for section-based memory operations.
 * Enables reading/updating specific sections of large documents without
 * fetching or modifying the entire content.
 */

export interface MarkdownSection {
  heading: string;
  level: number;        // 1-6 for h1-h6
  start: number;        // char offset of heading line start
  end: number;          // char offset of section end (exclusive)
  contentStart: number; // char offset after heading line (where content begins)
}

export interface MemoryOutline {
  memory_id: string;
  title: string;
  sections: Array<{
    heading: string;
    level: number;
    start: number;
    end: number;
    content?: string;
  }>;
  total_length: number;
}

export interface SectionContent {
  memory_id: string;
  heading: string;
  level: number;
  content: string;
  start: number;
  end: number;
}

export interface WithinMemorySearchHit {
  excerpt: string;
  match_start: number;
  match_end: number;
}

export interface WithinMemorySearchSectionResult {
  heading: string;
  level: number;
  start: number;
  end: number;
  hits: WithinMemorySearchHit[];
}

export interface WithinMemorySearchResult {
  memory_id: string;
  title: string;
  query: string;
  match_count: number;
  sections: WithinMemorySearchSectionResult[];
  markdown: string;
}

/**
 * Parse markdown content and extract section boundaries.
 * Sections end at the next heading of same or higher level, or EOF.
 */
export function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  // Match markdown headings at the start of a line
  // This regex matches: beginning of line, 1-6 # chars, whitespace, heading text
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let match;

  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const heading = match[2].trim();
    const start = match.index;
    // contentStart is after the heading line (including the newline if present)
    const headingLineEnd = start + match[0].length;
    const contentStart = content[headingLineEnd] === '\n' ? headingLineEnd + 1 : headingLineEnd;

    sections.push({
      heading,
      level,
      start,
      end: content.length, // will be updated below
      contentStart
    });
  }

  // Calculate end positions (next heading of same/higher level or EOF)
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].level <= sections[i].level) {
        sections[i].end = sections[j].start;
        break;
      }
    }
  }

  return sections;
}

/**
 * Find a section by heading text (case-insensitive).
 * @param sections - Parsed sections array
 * @param heading - Heading text to find
 * @param index - Which occurrence to return (0-based, default 0 for first match)
 */
export function findSection(sections: MarkdownSection[], heading: string, index: number = 0): MarkdownSection | null {
  const matches = sections.filter(s => s.heading.toLowerCase() === heading.toLowerCase());
  return matches[index] || null;
}

/**
 * Find the deepest section that contains the provided character offset.
 */
export function findSectionForOffset(sections: MarkdownSection[], offset: number): MarkdownSection | null {
  let bestMatch: MarkdownSection | null = null;

  for (const section of sections) {
    if (offset < section.start || offset >= section.end) {
      continue;
    }

    if (!bestMatch || section.level >= bestMatch.level) {
      bestMatch = section;
    }
  }

  return bestMatch;
}

/**
 * Extract section content from full text.
 * @param content - The full markdown content
 * @param section - The section to extract
 * @param includeSubsections - If true, include all nested subsections; if false, stop at next heading
 */
export function extractSectionContent(
  content: string,
  section: MarkdownSection,
  includeSubsections: boolean = true
): string {
  if (includeSubsections) {
    return content.slice(section.start, section.end).trim();
  }

  // For non-subsection mode, find the next heading (any level) after this one
  const afterHeading = content.slice(section.contentStart);
  const nextHeadingMatch = afterHeading.match(/^#{1,6}\s+/m);

  if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
    // Return from section start to just before the next heading
    const endOffset = section.contentStart + nextHeadingMatch.index;
    return content.slice(section.start, endOffset).trim();
  }

  // No more headings, return to end
  return content.slice(section.start, section.end).trim();
}

/**
 * Replace a section's content, optionally updating the heading.
 * By default, only the direct content under the heading is replaced — child
 * subsections are preserved intact. Set `replaceSubsections: true` to replace
 * the entire section range including all subsections.
 *
 * @param content - The full markdown content
 * @param section - The section to replace
 * @param newContent - New content for the section (without the heading, but will be sanitized if included)
 * @param newHeading - Optional new heading text (replaces existing heading)
 * @param options - Optional flags: `replaceSubsections` (default false)
 */
export function replaceSectionContent(
  content: string,
  section: MarkdownSection,
  newContent: string,
  newHeading?: string,
  options?: { replaceSubsections?: boolean }
): string {
  const replaceSubsections = options?.replaceSubsections ?? false;

  // Sanitize: strip leading heading if agent accidentally included it
  // Match heading at start of newContent (same level or any level)
  let sanitizedContent = newContent.trim();
  const leadingHeadingMatch = sanitizedContent.match(/^(#{1,6})\s+(.+?)(?:\n|$)/);
  if (leadingHeadingMatch) {
    const matchedLevel = leadingHeadingMatch[1].length;
    const matchedHeading = leadingHeadingMatch[2].trim();
    // Strip if it matches the section heading (case-insensitive) or the newHeading
    const targetHeading = newHeading || section.heading;
    if (matchedHeading.toLowerCase() === targetHeading.toLowerCase() && matchedLevel === section.level) {
      // Remove the duplicate heading line
      sanitizedContent = sanitizedContent.slice(leadingHeadingMatch[0].length).trim();
    }
  }

  // Build the heading line - either new or preserve existing
  let headingLine: string;
  if (newHeading) {
    const hashes = '#'.repeat(section.level);
    headingLine = `${hashes} ${newHeading}\n`;
  } else {
    headingLine = content.slice(section.start, section.contentStart);
  }

  // Get content before the section
  const before = content.slice(0, section.start);

  // Determine the boundary: replace only direct content or the full section range
  let subsectionsTail = '';
  let sectionEnd = section.end;

  if (!replaceSubsections) {
    // Find the first child heading within the section's bounds
    const allSections = parseMarkdownSections(content);
    const firstChild = allSections.find(s =>
      s.start > section.contentStart && s.start < section.end
    );

    if (firstChild) {
      // Only replace from contentStart to firstChild.start; preserve subsections
      subsectionsTail = content.slice(firstChild.start, section.end);
      sectionEnd = section.end;
    }
  }

  // Get content after the section
  const after = content.slice(sectionEnd);

  // Ensure newContent has proper spacing
  const trimmedNewContent = sanitizedContent;

  // Build the new document
  if (subsectionsTail) {
    // Subsections follow the new content
    const combined = before + headingLine + trimmedNewContent + '\n\n' + subsectionsTail;
    if (after.trim()) {
      return combined.replace(/\n*$/, '\n\n') + after.trimStart();
    }
    return combined.replace(/\n*$/, '\n');
  }

  // No subsections to preserve (leaf section or replaceSubsections mode)
  if (after.trim()) {
    return before + headingLine + trimmedNewContent + '\n\n' + after.trimStart();
  }

  // No content after, just append
  return before + headingLine + trimmedNewContent + '\n';
}

/**
 * Get section content by heading, excluding subsections' content.
 * Returns just the immediate content under the heading.
 */
export function getDirectContent(content: string, section: MarkdownSection): string {
  // Get all sections to find direct subsections
  const allSections = parseMarkdownSections(content);

  // Find first child section (any section after this one that's within its bounds)
  const firstChild = allSections.find(s =>
    s.start > section.contentStart &&
    s.start < section.end
  );

  if (firstChild) {
    // Return content from after heading to first child
    return content.slice(section.contentStart, firstChild.start).trim();
  }

  // No children, return all content
  return content.slice(section.contentStart, section.end).trim();
}

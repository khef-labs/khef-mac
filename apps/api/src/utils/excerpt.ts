const EXCERPT_LENGTH = 240;

/**
 * Strip common markdown formatting from text.
 * Removes: headers, links, images, bold/italic, code blocks, inline code, blockquotes, lists markers.
 */
function stripMarkdown(text: string): string {
  return text
    // Remove code blocks (fenced)
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`[^`]+`/g, '')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Convert links to just text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove list markers
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Collapse multiple newlines
    .replace(/\n{2,}/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate text at a word boundary, adding ellipsis if truncated.
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Find the last space before maxLength
  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  // If no space found or space is too early, just use the maxLength
  if (lastSpace < maxLength * 0.5) {
    return truncated.trim() + '...';
  }

  return truncated.slice(0, lastSpace).trim() + '...';
}

/**
 * Generate a content excerpt for compact search results.
 * Strips markdown formatting and truncates at word boundary with ellipsis.
 */
export function generateExcerpt(content: string, maxLength: number = EXCERPT_LENGTH): string {
  const stripped = stripMarkdown(content);
  return truncateAtWordBoundary(stripped, maxLength);
}

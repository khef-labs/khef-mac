/**
 * Markdown-to-Slack mrkdwn conversion service.
 * Converts standard markdown (with optional YAML frontmatter) into Slack's mrkdwn format.
 */

export function markdownToSlack(md: string): string {
  const lines = md.split('\n');
  const output: string[] = [];

  let inCodeBlock = false;

  for (const line of lines) {
    // Toggle code block state
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      output.push(line);
      continue;
    }

    // Inside code block — pass through unchanged
    if (inCodeBlock) {
      output.push(line);
      continue;
    }

    let converted = line;

    // Headings: # Heading → *Heading*
    const headingMatch = converted.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      output.push(`*${headingMatch[2]}*`);
      continue;
    }

    // Bullet lists: - item → • item (preserve indentation)
    const bulletMatch = converted.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      output.push(`${bulletMatch[1]}• ${bulletMatch[2]}`);
      continue;
    }

    // Bold: **text** → *text* (Slack uses single asterisks for bold)
    converted = converted.replace(/\*\*(.+?)\*\*/g, '*$1*');

    // Links: [text](url) → <url|text>
    converted = converted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    output.push(converted);
  }

  // Collapse consecutive blank lines to max 2
  const collapsed: string[] = [];
  let blankCount = 0;
  for (const line of output) {
    if (line.trim() === '') {
      blankCount++;
      if (blankCount <= 2) collapsed.push(line);
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }

  return collapsed.join('\n').trim() + '\n';
}

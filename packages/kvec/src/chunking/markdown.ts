import { Chunker, ChunkResult, ChunkerOptions } from '../types';
import { getCharPerTokenRatio, estimateTokenCount } from './token-aware';
import { TokenAwareChunker } from './token-aware';

const DEFAULT_CHUNK_SIZE_TOKENS = 430;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;

/**
 * Markdown heading-aware chunker.
 * Splits markdown text at heading boundaries while respecting token limits.
 * Preserves heading hierarchy metadata for each chunk.
 * Ported from chroma-embedded's chunk_utils.py chunk_markdown_heading_aware().
 */
export class MarkdownChunker implements Chunker {
  private fallback = new TokenAwareChunker();

  chunk(text: string, options?: ChunkerOptions): ChunkResult[] {
    const chunkSizeTokens = options?.chunkSizeTokens ?? DEFAULT_CHUNK_SIZE_TOKENS;
    const modelName = options?.modelName ?? 'default';

    const charsPerToken = getCharPerTokenRatio(modelName);
    const maxChunkChars = Math.floor(chunkSizeTokens * charsPerToken);

    const lines = text.split('\n');
    const results: ChunkResult[] = [];
    let currentChunk: string[] = [];
    let currentHeadings: string[] = [];
    let chunkIndex = 0;

    const flushChunk = () => {
      const chunkText = currentChunk.join('\n');
      if (!chunkText.trim()) return;

      results.push({
        content: chunkText,
        index: chunkIndex,
        tokenCount: estimateTokenCount(chunkText, modelName),
        method: 'markdown_heading',
        metadata: {
          markdown_headings: currentHeadings.join(' > '),
          markdown_primary_heading: currentHeadings[currentHeadings.length - 1] ?? '',
          markdown_section_depth: currentHeadings.length,
          markdown_heading_aware: true,
        },
      });
      chunkIndex++;
      currentChunk = [];
    };

    for (const line of lines) {
      const match = line.match(HEADING_PATTERN);

      if (match) {
        const level = match[1].length;
        const headingText = match[2].trim();

        // If current chunk exceeds max size, flush it
        const chunkText = currentChunk.join('\n');
        if (chunkText.length > maxChunkChars && currentChunk.length > 0) {
          flushChunk();
        }

        // Update heading hierarchy: trim to current level, add new heading
        currentHeadings = currentHeadings.slice(0, level - 1);
        currentHeadings.push(headingText);

        currentChunk.push(line);
      } else {
        currentChunk.push(line);

        // Check if chunk is getting too large (allow 20% overflow)
        const chunkText = currentChunk.join('\n');
        if (chunkText.length > maxChunkChars * 1.2 && currentChunk.length > 0) {
          flushChunk();
        }
      }
    }

    // Flush remaining content
    flushChunk();

    // If no chunks produced (empty text or parse failure), fall back to token-aware
    if (results.length === 0 && text.trim()) {
      return this.fallback.chunk(text, options);
    }

    return results;
  }
}

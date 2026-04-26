import { Chunker, ChunkResult, ChunkerOptions } from '../types';

/** Model-specific character-to-token ratios based on tokenizer research */
const MODEL_CHAR_RATIOS: Record<string, number> = {
  'stella': 3.2,
  'modernbert': 3.4,
  'bge-large': 3.3,
  'all-mpnet-base-v2': 3.5,
  'all-MiniLM-L6-v2': 3.5,
  'all-MiniLM-L12-v2': 3.5,
  'default': 3.5,
};

const DEFAULT_CHUNK_SIZE_TOKENS = 460;
const DEFAULT_OVERLAP_TOKENS = 46;

export function getCharPerTokenRatio(modelName: string): number {
  return MODEL_CHAR_RATIOS[modelName] ?? MODEL_CHAR_RATIOS['default'];
}

/**
 * Estimate token count from character count using model-specific ratios.
 */
export function estimateTokenCount(text: string, modelName: string = 'default'): number {
  const ratio = getCharPerTokenRatio(modelName);
  return Math.ceil(text.length / ratio);
}

/**
 * Token-aware text chunker.
 * Splits text into chunks based on model-specific character-to-token ratios.
 * Ported from chroma-embedded's chunk_utils.py chunk_text_token_aware().
 */
export class TokenAwareChunker implements Chunker {
  chunk(text: string, options?: ChunkerOptions): ChunkResult[] {
    const chunkSizeTokens = options?.chunkSizeTokens ?? DEFAULT_CHUNK_SIZE_TOKENS;
    const overlapTokens = options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    const modelName = options?.modelName ?? 'default';

    const charsPerToken = getCharPerTokenRatio(modelName);
    const chunkSizeChars = Math.floor(chunkSizeTokens * charsPerToken);
    const overlapChars = Math.floor(overlapTokens * charsPerToken);

    const results: ChunkResult[] = [];
    let start = 0;
    let index = 0;

    while (start < text.length) {
      const end = start + chunkSizeChars;
      const chunk = text.slice(start, end);

      if (chunk.trim()) {
        results.push({
          content: chunk,
          index,
          tokenCount: estimateTokenCount(chunk, modelName),
          method: 'token_aware',
        });
        index++;
      }

      start = end - overlapChars;
      if (start >= text.length) break;
    }

    return results;
  }
}

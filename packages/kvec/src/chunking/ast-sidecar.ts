import path from 'path';
import { Chunker, ChunkResult, ChunkerOptions } from '../types';
import { estimateTokenCount } from './token-aware';
import { TokenAwareChunker } from './token-aware';

const LANGUAGE_MAP: Record<string, string> = {
  // Primary languages
  '.py': 'python',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cs': 'c_sharp',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.rb': 'ruby',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.swift': 'swift',
  // Additional languages
  '.html': 'html',
  '.css': 'css',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.sql': 'sql',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.r': 'r',
  '.R': 'r',
  '.lua': 'lua',
  '.vim': 'vim',
  '.el': 'elisp',
  '.clj': 'clojure',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.pl': 'perl',
  '.pm': 'perl',
  '.proto': 'proto',
};

// All mapped languages are supported — the server falls back to line-based chunking
// if tree-sitter parsing fails for a specific language, so we send everything through.
const AST_SUPPORTED = new Set(Object.values(LANGUAGE_MAP));

interface ChunkResponse {
  chunks: Array<{ content: string; index: number }>;
  method: string;
}

/**
 * AST-aware chunker that calls the embed server's /chunk endpoint.
 * Falls back to TokenAwareChunker for unsupported languages or if the server is unavailable.
 */
export class ASTSidecarChunker implements Chunker {
  private serverUrl: string;
  private fallback: TokenAwareChunker;
  /** Tracks the file path for the current chunk call */
  private currentFilePath: string | null = null;

  constructor(serverUrl: string = 'http://127.0.0.1:9100') {
    this.serverUrl = serverUrl;
    this.fallback = new TokenAwareChunker();
  }

  /**
   * Set the file path before calling chunk().
   * This is needed because the Chunker interface doesn't include file path.
   */
  setFilePath(filePath: string): void {
    this.currentFilePath = filePath;
  }

  chunk(text: string, options?: ChunkerOptions): ChunkResult[] {
    // Detect language from file path
    const filePath = this.currentFilePath;
    this.currentFilePath = null; // reset after use

    if (!filePath) {
      return this.fallback.chunk(text, options);
    }

    const ext = path.extname(filePath).toLowerCase();
    const language = LANGUAGE_MAP[ext];

    if (!language || !AST_SUPPORTED.has(language)) {
      return this.fallback.chunk(text, options);
    }

    // Call the sidecar synchronously using a sync HTTP request
    // We use the Node.js child_process to make a sync HTTP call since the Chunker interface is sync
    try {
      const result = this.callSidecarSync(text, language, options);
      if (result) return result;
    } catch {
      // fall through to fallback
    }

    return this.fallback.chunk(text, options);
  }

  private callSidecarSync(text: string, language: string, options?: ChunkerOptions): ChunkResult[] | null {
    const { execSync } = require('child_process');
    const modelName = options?.modelName ?? 'default';

    // Calculate max_chunk_size in characters (matching chroma-embedded's approach)
    const chunkSizeTokens = options?.chunkSizeTokens ?? 400;
    const maxChunkSize = Math.floor(chunkSizeTokens * 3.2 * 0.50);

    const payload = JSON.stringify({
      code: text,
      language,
      max_chunk_size: maxChunkSize,
    });

    try {
      const curlCmd = `curl -s -m 30 -X POST ${this.serverUrl}/chunk -H "Content-Type: application/json" -d @-`;
      const stdout = execSync(curlCmd, {
        input: payload,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });

      const response: ChunkResponse = JSON.parse(stdout);

      if (!response.chunks || response.chunks.length === 0) return null;

      return response.chunks.map((c) => ({
        content: c.content,
        index: c.index,
        tokenCount: estimateTokenCount(c.content, modelName),
        method: response.method,
      }));
    } catch {
      return null;
    }
  }
}

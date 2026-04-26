#!/usr/bin/env python3
"""
Persistent embedding server for khef.
Loads model once at startup, serves embeddings via HTTP.

Usage:
  python3 embed_server.py [--port 9100] [--model all-mpnet-base-v2]

API:
  POST /embed
  Body: {"texts": ["text1", "text2", ...]}
  Response: {"embeddings": [[...], [...]], "model": "...", "dimensions": 768}

  POST /chunk
  Body: {"code": "...", "language": "typescript", "max_chunk_size": 640}
  Response: {"chunks": [{"content": "...", "index": 0}, ...], "method": "astchunk_typescript"}

  GET /health
  Response: {"status": "ok", "model": "...", "dimensions": 768}
"""

import argparse
import contextlib
import gc
import json
import logging
import os
import sys
import time
import warnings
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

# Load .env from project root before checking VECTOR_ENABLED
try:
    from dotenv import load_dotenv
    project_root = Path(__file__).resolve().parent.parent.parent.parent
    load_dotenv(project_root / '.env')
except ImportError:
    pass  # python-dotenv not installed, rely on environment

# Suppress noisy model loading warnings
logging.getLogger('sentence_transformers').setLevel(logging.ERROR)
logging.getLogger('mlx').setLevel(logging.ERROR)
logging.getLogger('tqdm').setLevel(logging.ERROR)
logging.getLogger('huggingface_hub').setLevel(logging.ERROR)
os.environ['TQDM_DISABLE'] = '1'  # Disable progress bars
os.environ['MLX_VERBOSE'] = '0'  # Disable MLX verbose output
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'  # Disable HF progress bars
os.environ['TOKENIZERS_PARALLELISM'] = 'false'  # Suppress tokenizer warnings
os.environ['HF_HUB_OFFLINE'] = '1'  # Use cached model only, never call huggingface
warnings.filterwarnings('ignore', message='.*UNEXPECTED.*')
warnings.filterwarnings('ignore', category=FutureWarning)

from sentence_transformers import SentenceTransformer

try:
    import torch
    _HAS_TORCH = True
except ImportError:
    _HAS_TORCH = False


def _release_memory():
    """Drop PyTorch/MPS/CUDA caches and run a GC pass. Called after each encode batch."""
    gc.collect()
    if not _HAS_TORCH:
        return
    try:
        if hasattr(torch, 'mps') and torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


@contextlib.contextmanager
def suppress_output():
    """Suppress stdout/stderr at file descriptor level to catch native library output."""
    # Save original file descriptors
    stdout_fd = sys.stdout.fileno()
    stderr_fd = sys.stderr.fileno()
    saved_stdout_fd = os.dup(stdout_fd)
    saved_stderr_fd = os.dup(stderr_fd)

    # Redirect to /dev/null
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, stdout_fd)
    os.dup2(devnull, stderr_fd)
    os.close(devnull)

    try:
        yield
    finally:
        # Restore original file descriptors
        os.dup2(saved_stdout_fd, stdout_fd)
        os.dup2(saved_stderr_fd, stderr_fd)
        os.close(saved_stdout_fd)
        os.close(saved_stderr_fd)

# Global model instance
model = None
model_name = None
dimensions = None

# Self-restart guards — exit cleanly so the supervisor respawns a fresh process.
# Prevents the long-term memory creep observed in sentence-transformers + MPS.
START_TIME = time.monotonic()
REQUEST_COUNT = 0
MAX_REQUESTS = int(os.environ.get('EMBED_MAX_REQUESTS', '2000'))
MAX_UPTIME_SECONDS = int(os.environ.get('EMBED_MAX_HOURS', '12')) * 3600


def _maybe_self_restart():
    """Exit cleanly when request or uptime thresholds are exceeded. Supervisor respawns."""
    if MAX_REQUESTS > 0 and REQUEST_COUNT >= MAX_REQUESTS:
        print(f'[embed-server] Reached {REQUEST_COUNT} requests; exiting for respawn', flush=True)
        os._exit(0)
    if MAX_UPTIME_SECONDS > 0 and (time.monotonic() - START_TIME) >= MAX_UPTIME_SECONDS:
        print(f'[embed-server] Reached uptime cap ({MAX_UPTIME_SECONDS}s); exiting for respawn', flush=True)
        os._exit(0)

# ---------------------------------------------------------------------------
# AST-aware code chunking via LlamaIndex CodeSplitter + tree-sitter
# Ported from arcaneum's ASTCodeChunker — supports 35+ languages
# ---------------------------------------------------------------------------

try:
    from llama_index.core.node_parser import CodeSplitter
    _HAS_CODE_SPLITTER = True
except ImportError:
    _HAS_CODE_SPLITTER = False

log = logging.getLogger('embed-server')

# Characters per token (conservative estimate for code)
CHARS_PER_TOKEN = 3.5

# File extension -> tree-sitter language name
LANGUAGE_MAP = {
    # Primary languages
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
    # Additional languages
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
}


def ast_chunk(code: str, language: str, max_chunk_size: int = 640) -> tuple[list[str], str]:
    """Chunk source code using tree-sitter AST parsing. Falls back to line-based splitting."""
    if not code or not code.strip():
        return [], 'empty'

    if not _HAS_CODE_SPLITTER:
        log.warning('llama-index-core not available, using line-based chunking')
        return _line_chunk(code, max_chunk_size), 'line_based_no_dep'

    try:
        # chunk_lines ~ tokens, max_chars controls hard character limit
        splitter = CodeSplitter(
            language=language,
            chunk_lines=max(10, max_chunk_size // 10),  # rough lines estimate
            chunk_lines_overlap=2,
            max_chars=max_chunk_size,
        )
        chunks = splitter.split_text(code)
        chunks = [c for c in chunks if c and c.strip()]

        if not chunks:
            raise ValueError('CodeSplitter returned empty chunks')

        return chunks, f'ast_{language}'

    except Exception as e:
        log.warning('AST chunking failed for %s: %s', language, e)
        return _line_chunk(code, max_chunk_size), 'line_based_fallback'


def _line_chunk(text: str, max_chunk_size: int = 640) -> list[str]:
    """Line-based chunking fallback with long-line splitting (from arcaneum)."""
    if not text.strip():
        return []

    raw_lines = text.split('\n')
    chunk_tokens = max_chunk_size / CHARS_PER_TOKEN

    # Split very long lines (handles minified code)
    lines: list[str] = []
    for line in raw_lines:
        if len(line) > max_chunk_size:
            lines.extend(_split_long_line(line, max_chunk_size))
        else:
            lines.append(line)

    chunks: list[str] = []
    current: list[str] = []
    current_tokens = 0.0

    for line in lines:
        line_tokens = len(line) / CHARS_PER_TOKEN
        if current_tokens + line_tokens > chunk_tokens and current:
            chunks.append('\n'.join(current))
            current = []
            current_tokens = 0.0
        current.append(line)
        current_tokens += line_tokens

    if current:
        chunks.append('\n'.join(current))

    chunks = [c for c in chunks if c and c.strip()]
    return chunks if chunks else [text]


def _split_long_line(line: str, max_chars: int) -> list[str]:
    """Split a very long line at natural break points (semicolons, braces, commas)."""
    if len(line) <= max_chars:
        return [line]

    segments: list[str] = []
    pos = 0

    while pos < len(line):
        end = min(pos + max_chars, len(line))
        if end < len(line):
            search_start = pos + int(max_chars * 0.8)
            best_break = -1
            for break_char in [';', ',', '}', ')', ']']:
                bp = line.rfind(break_char, search_start, end)
                if bp > best_break:
                    best_break = bp
            if best_break > search_start:
                end = best_break + 1
        segments.append(line[pos:end])
        pos = end

    return segments


class EmbedHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self._json_response(200, {
                'status': 'ok',
                'model': model_name,
                'dimensions': dimensions
            })
        else:
            try:
                self.send_response(404)
                self.end_headers()
            except BrokenPipeError:
                pass

    MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB

    def _read_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length > self.MAX_BODY_SIZE:
            raise ValueError(f'Request body too large: {content_length}')
        return self.rfile.read(content_length)

    def _json_response(self, status, data):
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())
        except BrokenPipeError:
            pass

    def do_POST(self):
        if self.path == '/embed':
            self._handle_embed()
        elif self.path == '/chunk':
            self._handle_chunk()
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_embed(self):
        global REQUEST_COUNT
        try:
            data = json.loads(self._read_body())
            texts = data.get('texts', [])

            if not texts:
                self._json_response(200, {
                    'embeddings': [],
                    'model': model_name,
                    'dimensions': dimensions
                })
                return

            embeddings = model.encode(texts, convert_to_numpy=True)
            payload = {
                'embeddings': embeddings.tolist(),
                'model': model_name,
                'dimensions': embeddings.shape[1] if len(embeddings.shape) > 1 else len(embeddings)
            }
            del embeddings
            self._json_response(200, payload)
        except Exception as e:
            self._json_response(500, {'error': str(e)})
        finally:
            REQUEST_COUNT += 1
            _release_memory()
            _maybe_self_restart()

    def _handle_chunk(self):
        try:
            data = json.loads(self._read_body())
            code = data.get('code', '')
            language = data.get('language', '')
            max_chunk_size = data.get('max_chunk_size', 640)

            if not code or not language:
                self._json_response(400, {'error': 'code and language are required'})
                return

            chunks, method = ast_chunk(code, language, max_chunk_size)
            self._json_response(200, {
                'chunks': [{'content': c, 'index': i} for i, c in enumerate(chunks)],
                'method': method
            })
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def log_message(self, format, *args):
        # Suppress default logging
        pass


def main():
    global model, model_name, dimensions

    # Check if vector search is enabled
    if os.environ.get('VECTOR_ENABLED', '').lower() != 'true':
        print('[embed-server] Vector search disabled, skipping')
        return

    logging.basicConfig(level=logging.INFO, format='[embed-server] %(levelname)s %(message)s')

    print('[embed-server] Vector search enabled, starting embedding server...')

    parser = argparse.ArgumentParser(description='Embedding server')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
    parser.add_argument('--port', type=int, default=9100, help='Port to listen on')
    parser.add_argument('--model', default='all-mpnet-base-v2', help='Model name')
    args = parser.parse_args()

    model_name = args.model
    print(f'[embed-server] Loading model: {model_name}...')
    with suppress_output():
        model = SentenceTransformer(model_name)
        # Get dimensions from a test embedding
        test_emb = model.encode(['test'], convert_to_numpy=True)
        dimensions = test_emb.shape[1]
    print(f'[embed-server] Model loaded ({dimensions} dimensions)')

    server = HTTPServer((args.host, args.port), EmbedHandler)
    print(f'[embed-server] Listening on http://{args.host}:{args.port}')

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[embed-server] Shutting down...')
        server.shutdown()


if __name__ == '__main__':
    main()

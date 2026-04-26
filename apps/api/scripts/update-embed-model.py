#!/usr/bin/env python3
"""Check for embedding model updates on Hugging Face and download if available."""

import logging
import os
import sys
import warnings

MODEL = "all-mpnet-base-v2"
CACHE_DIR = os.path.expanduser("~/.cache/huggingface/hub/models--sentence-transformers--all-mpnet-base-v2")

# Allow network access for this script
os.environ.pop("HF_HUB_OFFLINE", None)

# Suppress noisy output
logging.getLogger('sentence_transformers').setLevel(logging.ERROR)
logging.getLogger('mlx').setLevel(logging.ERROR)
logging.getLogger('tqdm').setLevel(logging.ERROR)
logging.getLogger('huggingface_hub').setLevel(logging.ERROR)
os.environ['TQDM_DISABLE'] = '1'
os.environ['MLX_VERBOSE'] = '0'
os.environ['HF_HUB_DISABLE_PROGRESS_BARS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
warnings.filterwarnings('ignore', message='.*UNEXPECTED.*')
warnings.filterwarnings('ignore', category=FutureWarning)

import contextlib

@contextlib.contextmanager
def suppress_output():
    """Suppress stdout/stderr at file descriptor level to catch native library output."""
    stdout_fd = sys.stdout.fileno()
    stderr_fd = sys.stderr.fileno()
    saved_stdout = os.dup(stdout_fd)
    saved_stderr = os.dup(stderr_fd)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, stdout_fd)
    os.dup2(devnull, stderr_fd)
    os.close(devnull)
    try:
        yield
    finally:
        os.dup2(saved_stdout, stdout_fd)
        os.dup2(saved_stderr, stderr_fd)
        os.close(saved_stdout)
        os.close(saved_stderr)

before = os.path.getmtime(CACHE_DIR) if os.path.exists(CACHE_DIR) else 0

with suppress_output():
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL)
    dims = model.get_sentence_embedding_dimension()

after = os.path.getmtime(CACHE_DIR)

if after > before:
    print(f"Model updated: {MODEL} ({dims} dims)")
else:
    print(f"Already up to date: {MODEL} ({dims} dims)")

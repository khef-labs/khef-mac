#!/usr/bin/env python3
"""
Embedding service for khef.
Reads JSON from stdin, generates embeddings, outputs JSON to stdout.

Usage:
  echo '{"texts": ["hello world"]}' | python3 embed.py
  echo '{"texts": ["hello", "world"], "model": "all-mpnet-base-v2"}' | python3 embed.py

Input JSON:
  {
    "texts": ["text1", "text2", ...],
    "model": "all-mpnet-base-v2"  // optional, defaults to all-mpnet-base-v2
  }

Output JSON:
  {
    "embeddings": [[0.1, 0.2, ...], [0.3, 0.4, ...]],
    "model": "all-mpnet-base-v2",
    "dimensions": 768
  }
"""

import sys
import json

def main():
    try:
        # Read input from stdin
        input_data = json.load(sys.stdin)
        texts = input_data.get("texts", [])
        model_name = input_data.get("model", "all-mpnet-base-v2")

        if not texts:
            print(json.dumps({"embeddings": [], "model": model_name, "dimensions": 0}))
            return

        # Import here to avoid slow startup when just checking help
        from sentence_transformers import SentenceTransformer

        # Load model (cached after first load)
        model = SentenceTransformer(model_name)

        # Generate embeddings
        embeddings = model.encode(texts, convert_to_numpy=True)

        # Output as JSON
        result = {
            "embeddings": embeddings.tolist(),
            "model": model_name,
            "dimensions": embeddings.shape[1] if len(embeddings.shape) > 1 else len(embeddings)
        }

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

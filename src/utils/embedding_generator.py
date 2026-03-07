#!/usr/bin/env python3
"""
Embedding generator using sentence-transformers.
Reads JSON array of strings from stdin, outputs JSON array of float arrays to stdout.
Model: all-MiniLM-L6-v2 (384-dimensional embeddings)
"""

import sys
import json

def main():
    try:
        raw = sys.stdin.read()
        texts = json.loads(raw)

        if not isinstance(texts, list):
            print(json.dumps([]), flush=True)
            sys.exit(0)

        if len(texts) == 0:
            print(json.dumps([]), flush=True)
            sys.exit(0)

        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer('all-MiniLM-L6-v2')
        embeddings = model.encode(texts, show_progress_bar=False)
        result = [emb.tolist() for emb in embeddings]
        print(json.dumps(result), flush=True)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        print(json.dumps([]), flush=True)
        sys.exit(1)

if __name__ == '__main__':
    main()

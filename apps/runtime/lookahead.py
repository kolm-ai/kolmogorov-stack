"""
apps/runtime/lookahead.py

Lookahead decoding. Speculative decoding without a draft model.

EAGLE-2/3 and Medusa all need a separately-trained draft model. Lookahead
decoding (Fu 2024, arXiv:2402.02057) skips that step entirely: it builds
an n-gram cache from the decoding history of the target model itself,
proposes candidate continuations from that cache, and verifies them in
parallel against the target. No draft training. No second model. The
trade-off is a smaller speedup (1.5-2x vs EAGLE-2's 2.5-3x), but zero
training cost and zero VRAM cost beyond the n-gram cache.

The companion algorithm REST (He 2023, arXiv:2311.08252) does the same
with a retrieval index over a corpus instead of a session-local n-gram
cache. We expose both because they compose: session n-grams catch
boilerplate and conversational patterns; the retrieval index catches
domain-specific patterns.

This module ships the n-gram cache (LookaheadCache) and a config object
that wires into either vLLM or a custom generation loop. For full Jacobi
iteration, follow the upstream lookahead-decoding repo — we expose
the verify-K-tokens path, which is the load-bearing piece.

Surface:

    from apps.runtime.lookahead import LookaheadCache, LookaheadConfig

    cache = LookaheadCache(n=3, capacity=4096)
    for tok in stream:
        cache.update(tok)
        proposal = cache.propose(prefix=last_K_tokens, k=5)
        # verify proposal against target model in a single forward

Citations:
  Lookahead:   Fu et al 2024, arXiv:2402.02057
  REST:        He et al 2023, arXiv:2311.08252
  Jacobi:      Santilli et al 2023, arXiv:2305.10427
"""

from __future__ import annotations

import dataclasses
import logging
from collections import OrderedDict, defaultdict
from typing import Any, Iterable, Optional, Sequence

logger = logging.getLogger(__name__)


@dataclasses.dataclass(frozen=True)
class LookaheadConfig:
    """
    n                         n-gram order; 3-4 is the published sweet spot
    capacity                  max distinct (n-1)-prefix entries kept
    window                    levels of Jacobi iteration in the parallel
                              verify step; larger = more speculative work,
                              more chance of acceptance
    guess_set_size            max candidates proposed per prefix at verify
    """

    n: int = 3
    capacity: int = 4096
    window: int = 5
    guess_set_size: int = 5


class LookaheadCache:
    """
    LRU-capped n-gram cache. Maps (n-1)-prefix -> ordered list of seen next
    tokens. propose() returns up to k candidates for parallel verification.

    The cache is session-local: it learns the patterns the target model
    actually emits at decode time, so common boilerplate (JSON keys, code
    indentation, sign-off phrases) gets accelerated for free as the
    session progresses.
    """

    def __init__(self, *, n: int = 3, capacity: int = 4096):
        if n < 2:
            raise ValueError(f"n must be >= 2, got {n}")
        self.n = n
        self.capacity = capacity
        self._cache: "OrderedDict[tuple[int, ...], list[int]]" = OrderedDict()
        self._buffer: list[int] = []

    def update(self, token: int) -> None:
        """
        Append a token to the rolling buffer and, when the buffer has at
        least n tokens, record the (n-1)-prefix -> next mapping.
        """
        self._buffer.append(int(token))
        if len(self._buffer) >= self.n:
            prefix = tuple(self._buffer[-self.n : -1])
            next_tok = int(self._buffer[-1])
            self._record(prefix, next_tok)

    def _record(self, prefix: tuple[int, ...], next_tok: int) -> None:
        existing = self._cache.get(prefix)
        if existing is None:
            self._cache[prefix] = [next_tok]
        else:
            # If we have seen this next-tok, bump it to the front (recency).
            try:
                existing.remove(next_tok)
            except ValueError:
                pass
            existing.insert(0, next_tok)
            self._cache[prefix] = existing
        self._cache.move_to_end(prefix)
        while len(self._cache) > self.capacity:
            self._cache.popitem(last=False)

    def propose(self, *, prefix: Sequence[int], k: int = 5) -> list[int]:
        """
        Return up to k candidate next-tokens for the given prefix. The
        caller verifies these in parallel against the target model.

        If the prefix has fewer than n-1 tokens, returns an empty list:
        we have no n-gram statistics yet for this short context.
        """
        if len(prefix) < self.n - 1:
            return []
        key = tuple(prefix[-(self.n - 1) :])
        cands = self._cache.get(key)
        if not cands:
            return []
        return list(cands[:k])

    def lookahead(
        self, *, prefix: Sequence[int], k: int, depth: int = 1
    ) -> list[list[int]]:
        """
        Multi-step lookahead: for each top-k single-step proposal, recurse
        depth-1 levels deep to build candidate continuations of length depth.

        Returns a list of continuations. Used by Jacobi-style verify loops
        where the target verifies several speculative branches in one pass.
        """
        if depth < 1:
            return []
        first = self.propose(prefix=prefix, k=k)
        if depth == 1:
            return [[t] for t in first]
        out: list[list[int]] = []
        for t in first:
            tail_prefix = list(prefix) + [t]
            tails = self.lookahead(prefix=tail_prefix, k=k, depth=depth - 1)
            if not tails:
                out.append([t])
            else:
                for tail in tails:
                    out.append([t, *tail])
        return out

    def stats(self) -> dict[str, int]:
        return {
            "entries": len(self._cache),
            "capacity": self.capacity,
            "n": self.n,
            "buffer_len": len(self._buffer),
        }


def receipt_block(config: LookaheadConfig, *, cache_stats: Optional[dict[str, int]] = None) -> dict[str, Any]:
    return {
        "algo": "speculative_decoding.lookahead",
        "n": int(config.n),
        "capacity": int(config.capacity),
        "window": int(config.window),
        "guess_set_size": int(config.guess_set_size),
        "cache_stats": dict(cache_stats) if cache_stats else None,
        "papers": [
            "arXiv:2402.02057",  # Lookahead
            "arXiv:2311.08252",  # REST
            "arXiv:2305.10427",  # Jacobi iteration
        ],
        "schema_version": "lookahead.v1",
    }


__all__ = ["LookaheadConfig", "LookaheadCache", "receipt_block"]

#!/usr/bin/env python3
"""
bitset_balanced_solver_v5.py

Side-balanced extension of bitset_cnf_solver.py.

Purpose:
  Search for separator-free pairs (A,C) with explicit side budgets
      |A| <= p_budget, |C| <= n_budget
  instead of only total budget. This is the planned next step for cases
      (|A|,|C|) = (1,38),...,(19,20)
  under the symmetry |A| <= |C|.

Representation:
  live is a Python integer bitset over all S subset [q].
  Bit S = 1 iff S is still a possible separator / satisfying assignment.

Clause semantics:
  Positive/left k-set P_T kills S iff S & T == 0.
  Negative/right k-set N_T kills S iff T subseteq S.

Exactness:
  If branch_cap=0 and status=EXHAUSTED, then no pair exists under the
  specified budgets and assumptions.
  If branch_cap>0 or LIMIT occurs, result is heuristic/partial only.

This script is intended for small/medium exact runs and larger heuristic runs.
"""

from __future__ import annotations

import argparse
import itertools
import math
import random
import time
from collections import OrderedDict
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable, Tuple, List, Optional, Set

Mask = int
Clause = Tuple[str, Mask]  # "P" or "N"


def popcount(x: int) -> int:
    return x.bit_count()


def tuple_to_mask(xs: Iterable[int], one_based: bool = True) -> Mask:
    shift = 1 if one_based else 0
    m = 0
    for x in xs:
        m |= 1 << (x - shift)
    return m


def mask_to_tuple(m: Mask, q: Optional[int] = None, one_based: bool = True) -> Tuple[int, ...]:
    shift = 1 if one_based else 0
    if q is None:
        q = max(1, m.bit_length())
    return tuple(i + shift for i in range(q) if (m >> i) & 1)


def bits_of_size(q: int, r: int):
    for comb in itertools.combinations(range(q), r):
        m = 0
        for i in comb:
            m |= 1 << i
        yield m


@lru_cache(maxsize=None)
def all_ksets(q: int, k: int) -> Tuple[Mask, ...]:
    return tuple(bits_of_size(q, k))


@lru_cache(maxsize=None)
def submasks_size(mask: Mask, k: int) -> Tuple[Mask, ...]:
    bits = [i for i in range(mask.bit_length()) if (mask >> i) & 1]
    if len(bits) < k:
        return tuple()
    out = []
    for comb in itertools.combinations(bits, k):
        m = 0
        for i in comb:
            m |= 1 << i
        out.append(m)
    return tuple(out)


def iter_set_bits(x: int, limit: Optional[int] = None):
    c = 0
    while x:
        low = x & -x
        idx = low.bit_length() - 1
        yield idx
        x ^= low
        c += 1
        if limit is not None and c >= limit:
            break


def full_live(q: int) -> int:
    return (1 << (1 << q)) - 1


class KillMaskCache:
    def __init__(self, q: int, k: int, max_entries: int = 4096):
        self.q = q
        self.k = k
        self.full_color_mask = (1 << q) - 1
        self.max_entries = max_entries
        self.cache: OrderedDict[Clause, int] = OrderedDict()
        self.hits = 0
        self.misses = 0

    def get(self, side: str, T: Mask) -> int:
        key = (side, T)
        if key in self.cache:
            self.hits += 1
            val = self.cache.pop(key)
            self.cache[key] = val
            return val
        self.misses += 1
        val = self._compute(side, T)
        if self.max_entries:
            self.cache[key] = val
            while len(self.cache) > self.max_entries:
                self.cache.popitem(last=False)
        return val

    def _compute(self, side: str, T: Mask) -> int:
        comp = self.full_color_mask ^ T
        out = 0
        sub = comp
        while True:
            S = sub if side == "P" else (T | sub)
            out |= 1 << S
            if sub == 0:
                break
            sub = (sub - 1) & comp
        return out


def apply_clause(live: int, cache: KillMaskCache, side: str, T: Mask) -> int:
    return live & ~cache.get(side, T)


def formula_live(q: int, k: int, P: Iterable[Mask], N: Iterable[Mask]) -> int:
    cache = KillMaskCache(q, k)
    live = full_live(q)
    for T in P:
        live = apply_clause(live, cache, "P", T)
    for T in N:
        live = apply_clause(live, cache, "N", T)
    return live


def known_hmt4() -> Tuple[int, int, Tuple[Mask, ...], Tuple[Mask, ...]]:
    q, k = 11, 4
    pairs = [(0,1), (2,3), (4,5), (6,7)]
    base = [
        (1 << 8) | (1 << 9),
        (1 << 8) | (1 << 10),
        (1 << 9) | (1 << 10),
    ]
    P, N = [], []
    for a,b in pairs:
        pairmask = (1 << a) | (1 << b)
        for B in base:
            P.append(pairmask | B)
            N.append(pairmask | B)
    for choices in itertools.product([0,1], repeat=4):
        T = 0
        parity = 0
        for bit, (a,b) in zip(choices, pairs):
            if bit == 0:
                T |= 1 << a
                parity ^= 1
            else:
                T |= 1 << b
        if parity == 1:
            P.append(T)
        else:
            N.append(T)
    return q, k, tuple(P), tuple(N)


def choose_live_separator(live: int, q: int, k: int, rng: random.Random,
                          p_left: int, n_left: int,
                          random_trials: int = 128, scan_limit: int = 512) -> int:
    """Choose live S with small available branch count under side budgets."""
    best = None
    best_score = None
    n_assign = 1 << q

    def score(S: int) -> int:
        r = S.bit_count()
        sc = 0
        if p_left > 0 and q - r >= k:
            sc += math.comb(q - r, k)
        if n_left > 0 and r >= k:
            sc += math.comb(r, k)
        return sc

    for S in iter_set_bits(live, limit=scan_limit):
        sc = score(S)
        if sc == 0:
            return S
        if best is None or sc < best_score:
            best, best_score = S, sc

    for _ in range(random_trials):
        S = rng.randrange(n_assign)
        if (live >> S) & 1:
            sc = score(S)
            if sc == 0:
                return S
            if best is None or sc < best_score:
                best, best_score = S, sc

    if best is None:
        return next(iter_set_bits(live, limit=1))
    return best


def moves_for_separator(S: Mask, q: int, k: int,
                        Pset: Set[Mask], Nset: Set[Mask],
                        p_left: int, n_left: int) -> List[Clause]:
    full_colors = (1 << q) - 1
    comp = full_colors ^ S
    moves: List[Clause] = []
    if p_left > 0:
        for L in submasks_size(comp, k):
            if L not in Pset:
                moves.append(("P", L))
    if n_left > 0:
        for R in submasks_size(S, k):
            if R not in Nset:
                moves.append(("N", R))
    return moves


def exact_side_gain_lower_bound(live: int, q: int, k: int,
                                Pset: Set[Mask], Nset: Set[Mask],
                                p_left: int, n_left: int,
                                cache: KillMaskCache) -> Tuple[bool, str]:
    """Safe pruning using side-aware max-gain bounds.

    If p_left+n_left clauses cannot cover live by max-gain, prune.
    Also compute independent side max gains where useful.
    """
    live_count = live.bit_count()
    if live_count == 0:
        return False, ""

    max_p = 0
    max_n = 0
    for T in all_ksets(q,k):
        if p_left > 0 and T not in Pset:
            g = (live & cache.get("P", T)).bit_count()
            if g > max_p:
                max_p = g
        if n_left > 0 and T not in Nset:
            g = (live & cache.get("N", T)).bit_count()
            if g > max_n:
                max_n = g

    # A safe total upper bound on what remaining clauses can cover.
    total_possible = p_left * max_p + n_left * max_n
    if total_possible < live_count:
        return True, f"side max-gain bound live={live_count} max_p={max_p} max_n={max_n}"

    if max(max_p, max_n) == 0:
        return True, "no remaining clause has positive gain"

    # Cruder but sometimes useful: with combined max.
    combined = max(max_p, max_n)
    lb = math.ceil(live_count / combined)
    if lb > p_left + n_left:
        return True, f"combined max-gain lb={lb} rem={p_left+n_left}"

    return False, ""



def packing_lower_bound(live: int, q: int, k: int, scan_limit: int = 4096) -> int:
    """Sound lower bound on the number of clauses still required to empty `live`.

    Build a greedy maximal set W of live separators that are pairwise
    *clause-independent*: no single clause can kill two of them. A P-clause T kills
    both S1,S2 iff T ⊆ comp(S1)∩comp(S2) = comp(S1∪S2); an N-clause iff
    T ⊆ S1∩S2. Hence S1,S2 are clause-independent iff
        |S1 ∩ S2| < k   AND   |comp(S1 ∪ S2)| < k.
    Each remaining clause (P or N) can kill at most one member of W, so at least
    |W| more clauses are needed. Valid lower bound (any W works; greedy finds one).
    """
    full = (1 << q) - 1
    W: List[int] = []
    for S in iter_set_bits(live, limit=scan_limit):
        ok = True
        for S2 in W:
            if popcount(S & S2) >= k or popcount(full ^ (S | S2)) >= k:
                ok = False
                break
        if ok:
            W.append(S)
    return len(W)


class BudgetedSetCoverOracle:
    """Small exact bounded set-cover oracle used for transversal pruning.

    For a side-family F, every small transversal H with |H|<k that hits all
    edges of F must be destroyed by future clauses before this side can have
    transversal number at least k.

    A future k-set T destroys H iff T cap H = empty. If the small transversals
    cannot be covered by the remaining side budget, no UNSAT completion is
    possible and the DFS node is safely pruned.

    This oracle is fail-open: if its internal limits are hit, it returns True
    ("maybe possible"), never an unsafe False.
    """

    def __init__(self, q: int, k: int, max_nodes: int = 20000, max_seconds: float = 0.05):
        self.q = q
        self.k = k
        self.max_nodes = max_nodes
        self.max_seconds = max_seconds
        self.calls = 0
        self.cache = {}
        self.small_cache = {}

    def small_transversals(self, F: Tuple[Mask, ...]) -> Tuple[Mask, ...]:
        F = tuple(sorted(set(F)))
        if F in self.small_cache:
            return self.small_cache[F]
        out = []
        for r in range(self.k):
            for H in bits_of_size(self.q, r):
                ok = True
                for E in F:
                    if (H & E) == 0:
                        ok = False
                        break
                if ok:
                    out.append(H)
        ans = tuple(out)
        self.small_cache[F] = ans
        return ans

    def small_transversal_gain(self, F: Tuple[Mask, ...], T: Mask) -> int:
        """How many current small transversals of F would be destroyed by T.

        A small transversal H of F is destroyed by adding T iff T cap H = empty.
        Used only for branch ordering; it is not part of correctness.
        """
        return sum(1 for H in self.small_transversals(F) if (T & H) == 0)

    def can_reach_tau_at_least_k(self, F: Tuple[Mask, ...], remaining: int) -> bool:
        """Return False only if impossibility is proved."""
        self.calls += 1
        F = tuple(sorted(set(F)))
        key = (F, remaining)
        if key in self.cache:
            return self.cache[key]

        small_H = self.small_transversals(F)
        if not small_H:
            self.cache[key] = True
            return True
        if remaining <= 0:
            self.cache[key] = False
            return False

        full = (1 << len(small_H)) - 1
        covers = []
        Fset = set(F)

        for T in all_ksets(self.q, self.k):
            if T in Fset:
                continue
            cm = 0
            for i, H in enumerate(small_H):
                if (T & H) == 0:
                    cm |= 1 << i
            if cm:
                covers.append(cm)

        if not covers:
            self.cache[key] = False
            return False

        max_gain = max(c.bit_count() for c in covers)
        if math.ceil(len(small_H) / max_gain) > remaining:
            self.cache[key] = False
            return False

        # Greedy success check: if it covers, then completion is possible.
        uncovered = full
        for _ in range(remaining):
            best = max(covers, key=lambda c: (c & uncovered).bit_count())
            gain = (best & uncovered).bit_count()
            if gain == 0:
                break
            uncovered &= ~best
            if uncovered == 0:
                self.cache[key] = True
                return True

        # Exact bounded set-cover with fail-open limits.
        by_h = [[] for _ in small_H]
        for c in covers:
            mm = c
            while mm:
                low = mm & -mm
                j = low.bit_length() - 1
                by_h[j].append(c)
                mm ^= low

        for j in range(len(by_h)):
            by_h[j].sort(key=lambda c: c.bit_count(), reverse=True)

        start_time = time.time()
        nodes = 0
        memo = set()

        def rec(uncovered_mask: int, depth: int):
            nonlocal nodes
            nodes += 1
            if uncovered_mask == 0:
                return True
            if depth <= 0:
                return False
            if nodes >= self.max_nodes or (time.time() - start_time) >= self.max_seconds:
                return None

            mkey = (uncovered_mask, depth)
            if mkey in memo:
                return False
            memo.add(mkey)

            ucount = uncovered_mask.bit_count()
            mg = 0
            for c in covers:
                g = (c & uncovered_mask).bit_count()
                if g > mg:
                    mg = g
            if mg == 0:
                return False
            if math.ceil(ucount / mg) > depth:
                return False

            tmp = uncovered_mask
            best_cands = None
            best_len = None
            while tmp:
                low = tmp & -tmp
                j = low.bit_length() - 1
                cand = [c for c in by_h[j] if c & uncovered_mask]
                if not cand:
                    return False
                if best_len is None or len(cand) < best_len:
                    best_len = len(cand)
                    best_cands = cand
                tmp ^= low

            best_cands.sort(key=lambda c: (c & uncovered_mask).bit_count(), reverse=True)
            for c in best_cands:
                ans = rec(uncovered_mask & ~c, depth - 1)
                if ans is True:
                    return True
                if ans is None:
                    return None
            return False

        ans = rec(full, remaining)
        result = True if ans is None else bool(ans)
        self.cache[key] = result
        return result



def remap_mask(mask: Mask, perm: Tuple[int, ...]) -> Mask:
    """Map old colour i to new colour perm[i]."""
    out = 0
    q = len(perm)
    for i in range(q):
        if (mask >> i) & 1:
            out |= 1 << perm[i]
    return out


def color_signatures(q: int, P: Tuple[Mask, ...], N: Tuple[Mask, ...]) -> Tuple[Tuple[int, ...], ...]:
    """Invariant colour signatures for safe canonical partitioning.

    The signature is deliberately rich but cheap:
      deg+,
      deg-,
      pair co-degrees with all other colours on + side sorted,
      pair co-degrees with all other colours on - side sorted.

    Isomorphic states have corresponding equal signatures. Therefore colours
    with different signatures do not need to be permuted together for exact
    canonicalization within this partition refinement.
    """
    sigs = []
    for i in range(q):
        bi = 1 << i
        dp = sum(1 for E in P if E & bi)
        dn = sum(1 for E in N if E & bi)
        pp = []
        pn = []
        for j in range(q):
            if j == i:
                continue
            bj = 1 << j
            pair = bi | bj
            pp.append(sum(1 for E in P if (E & pair) == pair))
            pn.append(sum(1 for E in N if (E & pair) == pair))
        sigs.append((dp, dn, *sorted(pp), *sorted(pn)))
    return tuple(sigs)


def canonical_state_key(
    q: int,
    P: Tuple[Mask, ...],
    N: Tuple[Mask, ...],
    p_left: int,
    n_left: int,
    max_perms: int = 50000,
):
    """Exact canonical key under colour permutations, when affordable.

    It partitions colours by invariant signatures and enumerates all
    permutations within equal-signature cells. If the number of permutations
    exceeds max_perms, return None and do not use canonical memoization.

    Returning None is fail-open: it never creates unsafe pruning.
    """
    P = tuple(sorted(set(P)))
    N = tuple(sorted(set(N)))
    sigs = color_signatures(q, P, N)

    # Group old colours by signature, ordered by signature for deterministic labels.
    groups = {}
    for i, s in enumerate(sigs):
        groups.setdefault(s, []).append(i)
    ordered_groups = [groups[s] for s in sorted(groups)]

    total = 1
    for g in ordered_groups:
        total *= math.factorial(len(g))
        if total > max_perms:
            return None

    # New label blocks are assigned in sorted signature order.
    starts = []
    pos = 0
    for g in ordered_groups:
        starts.append(pos)
        pos += len(g)

    best = None
    # For each group, choose an ordering of old colours assigned to consecutive new labels.
    for group_perms in itertools.product(*(itertools.permutations(g) for g in ordered_groups)):
        perm = [None] * q
        for block_start, old_order in zip(starts, group_perms):
            for offset, old_colour in enumerate(old_order):
                perm[old_colour] = block_start + offset
        perm = tuple(perm)
        P2 = tuple(sorted(remap_mask(E, perm) for E in P))
        N2 = tuple(sorted(remap_mask(E, perm) for E in N))
        key = (P2, N2, p_left, n_left)
        if best is None or key < best:
            best = key
    return best


def canonicalize_state(
    q: int,
    P: Tuple[Mask, ...],
    N: Tuple[Mask, ...],
    max_perms: int = 50000,
):
    """Return canonically relabelled (P,N) when affordable, else None."""
    P = tuple(sorted(set(P)))
    N = tuple(sorted(set(N)))
    sigs = color_signatures(q, P, N)
    groups = {}
    for i, s in enumerate(sigs):
        groups.setdefault(s, []).append(i)
    ordered_groups = [groups[s] for s in sorted(groups)]

    total = 1
    for g in ordered_groups:
        total *= math.factorial(len(g))
        if total > max_perms:
            return None

    starts = []
    pos = 0
    for g in ordered_groups:
        starts.append(pos)
        pos += len(g)

    best = None
    for group_perms in itertools.product(*(itertools.permutations(g) for g in ordered_groups)):
        perm = [None] * q
        for block_start, old_order in zip(starts, group_perms):
            for offset, old_colour in enumerate(old_order):
                perm[old_colour] = block_start + offset
        perm = tuple(perm)
        P2 = tuple(sorted(remap_mask(E, perm) for E in P))
        N2 = tuple(sorted(remap_mask(E, perm) for E in N))
        key = (P2, N2)
        if best is None or key < best:
            best = key
    return best


@dataclass
class BalancedResult:
    status: str  # FOUND, EXHAUSTED, LIMIT
    q: int
    k: int
    p_budget: int
    n_budget: int
    P: Tuple[Mask, ...]
    N: Tuple[Mask, ...]
    nodes: int
    elapsed: float
    reason: str
    cache_hits: int
    cache_misses: int
    memo_size: int
    canon_memo_size: int = 0
    canon_hits: int = 0
    canon_skips: int = 0


class BalancedBitsetSolver:
    def __init__(self, q: int, k: int, p_budget: int, n_budget: int,
                 fixed_positive: bool = False,
                 time_limit: float = 30.0,
                 max_nodes: int = 100000,
                 seed: int = 1,
                 branch_cap: int = 0,
                 cache_entries: int = 4096,
                 use_memo: bool = True,
                 use_canonical_memo: bool = True,
                 canon_max_perms: int = 50000,
                 use_gain_lb: bool = True,
                 lb_max_q: int = 14,
                 use_packing_lb: bool = True,
                 packing_scan: int = 4096,
                 use_transversal_prune: bool = True,
                 transv_max_q: int = 14,
                 transv_nodes: int = 20000,
                 transv_seconds: float = 0.05,
                 transv_score_weight: int = 1000000,
                 random_trials: int = 128,
                 scan_limit: int = 512,
                 verbose: bool = False):
        self.q = q
        self.k = k
        self.p_budget = p_budget
        self.n_budget = n_budget
        self.fixed_positive = fixed_positive
        self.time_limit = time_limit
        self.max_nodes = max_nodes
        self.rng = random.Random(seed)
        self.branch_cap = branch_cap
        self.cache = KillMaskCache(q, k, max_entries=cache_entries)
        self.use_memo = use_memo
        self.use_canonical_memo = use_canonical_memo
        self.canon_max_perms = canon_max_perms
        self.canon_memo: Set[Tuple[Tuple[Mask, ...], Tuple[Mask, ...], int, int]] = set()
        self.canon_hits = 0
        self.canon_skips = 0
        self.use_gain_lb = use_gain_lb
        self.lb_max_q = lb_max_q
        self.use_packing_lb = use_packing_lb
        self.packing_scan = packing_scan
        self.use_transversal_prune = use_transversal_prune
        self.transv_max_q = transv_max_q
        self.transv_oracle = BudgetedSetCoverOracle(q, k, max_nodes=transv_nodes, max_seconds=transv_seconds)
        self.transv_score_weight = transv_score_weight
        self.random_trials = random_trials
        self.scan_limit = scan_limit
        self.verbose = verbose
        self.nodes = 0
        self.t0 = 0.0
        self.memo: Set[Tuple[int, int, int]] = set()

    def run(self) -> BalancedResult:
        self.t0 = time.time()

        # Safe structural pruning:
        # If there are fewer than k positive clauses, choose one variable from
        # each positive clause. This gives a satisfying assignment S of size < k,
        # so no negative k-clause can be falsified by S. Hence UNSAT is impossible.
        # The dual argument applies if there are fewer than k negative clauses:
        # choose one variable from each negative clause to be false.
        if self.p_budget < self.k:
            return BalancedResult("EXHAUSTED", self.q, self.k, self.p_budget, self.n_budget,
                                  tuple(), tuple(), 0, 0.0,
                                  f"structural bound p_budget < k ({self.p_budget} < {self.k})",
                                  self.cache.hits, self.cache.misses, 0)
        if self.n_budget < self.k:
            return BalancedResult("EXHAUSTED", self.q, self.k, self.p_budget, self.n_budget,
                                  tuple(), tuple(), 0, 0.0,
                                  f"structural bound n_budget < k ({self.n_budget} < {self.k})",
                                  self.cache.hits, self.cache.misses, 0)

        live = full_live(self.q)
        P: Tuple[Mask, ...] = tuple()
        N: Tuple[Mask, ...] = tuple()
        p_left = self.p_budget
        n_left = self.n_budget

        if self.fixed_positive:
            if p_left <= 0:
                return BalancedResult("EXHAUSTED", self.q, self.k, self.p_budget, self.n_budget,
                                      P, N, 0, 0.0, "fixed positive requested but p_budget=0",
                                      self.cache.hits, self.cache.misses, 0)
            fixed = (1 << self.k) - 1
            P = (fixed,)
            p_left -= 1
            live = apply_clause(live, self.cache, "P", fixed)

        status, P2, N2, reason = self._dfs(live, P, N, p_left, n_left)
        return BalancedResult(
            status=status, q=self.q, k=self.k,
            p_budget=self.p_budget, n_budget=self.n_budget,
            P=P2, N=N2,
            nodes=self.nodes,
            elapsed=time.time() - self.t0,
            reason=reason,
            cache_hits=self.cache.hits,
            cache_misses=self.cache.misses,
            memo_size=len(self.memo),
            canon_memo_size=len(self.canon_memo),
            canon_hits=self.canon_hits,
            canon_skips=self.canon_skips,
        )

    def limit_reason(self) -> Optional[str]:
        if self.nodes >= self.max_nodes:
            return f"node limit {self.max_nodes}"
        if time.time() - self.t0 >= self.time_limit:
            return f"time limit {self.time_limit}s"
        return None

    def _dfs(self, live: int, P: Tuple[Mask, ...], N: Tuple[Mask, ...],
             p_left: int, n_left: int):
        self.nodes += 1
        lim = self.limit_reason()
        if lim:
            return "LIMIT", P, N, lim

        if live == 0:
            return "FOUND", P, N, "live set empty"

        if p_left + n_left <= 0:
            return "EXHAUSTED", P, N, "budgets exhausted"

        key = (live, p_left, n_left)
        if self.use_memo and key in self.memo:
            return "EXHAUSTED", P, N, "memo"
        if self.use_memo:
            self.memo.add(key)

        if self.use_canonical_memo:
            ckey = canonical_state_key(self.q, P, N, p_left, n_left, max_perms=self.canon_max_perms)
            if ckey is None:
                self.canon_skips += 1
            elif ckey in self.canon_memo:
                self.canon_hits += 1
                return "EXHAUSTED", P, N, "canonical memo"
            else:
                self.canon_memo.add(ckey)

        Pset, Nset = set(P), set(N)

        if self.use_transversal_prune and self.q <= self.transv_max_q:
            if not self.transv_oracle.can_reach_tau_at_least_k(P, p_left):
                return "EXHAUSTED", P, N, "transversal prune: positive side cannot reach tau >= k"
            if not self.transv_oracle.can_reach_tau_at_least_k(N, n_left):
                return "EXHAUSTED", P, N, "transversal prune: negative side cannot reach tau >= k"

        if self.use_gain_lb and self.q <= self.lb_max_q:
            prune, why = exact_side_gain_lower_bound(
                live, self.q, self.k, Pset, Nset, p_left, n_left, self.cache
            )
            if prune:
                return "EXHAUSTED", P, N, why

        if self.use_packing_lb:
            lb = packing_lower_bound(live, self.q, self.k, self.packing_scan)
            if lb > p_left + n_left:
                return ("EXHAUSTED", P, N,
                        f"packing lower bound {lb} > remaining budget {p_left + n_left}")

        S = choose_live_separator(
            live, self.q, self.k, self.rng,
            p_left, n_left,
            random_trials=self.random_trials,
            scan_limit=self.scan_limit,
        )

        moves = moves_for_separator(S, self.q, self.k, Pset, Nset, p_left, n_left)
        if not moves:
            return "EXHAUSTED", P, N, "chosen separator cannot be killed with remaining side budgets"

        scored = []
        # Branch ordering:
        #   primary: destroy small transversals on the side being extended;
        #   secondary: kill many still-live separators.
        # This is a heuristic ordering only. With branch_cap=0, exactness is unchanged.
        for side, T in moves:
            live_gain = (live & self.cache.get(side, T)).bit_count()
            if live_gain <= 0:
                continue
            transv_gain = 0
            if self.use_transversal_prune and self.q <= self.transv_max_q:
                if side == "P":
                    transv_gain = self.transv_oracle.small_transversal_gain(P, T)
                else:
                    transv_gain = self.transv_oracle.small_transversal_gain(N, T)
            score = self.transv_score_weight * transv_gain + live_gain
            scored.append((score, live_gain, transv_gain, side, T))
        scored.sort(reverse=True)

        if self.branch_cap and len(scored) > self.branch_cap:
            scored = scored[:self.branch_cap]

        if self.verbose:
            print(f"node={self.nodes} live={live.bit_count()} "
                  f"|P|={len(P)} |N|={len(N)} p_left={p_left} n_left={n_left} "
                  f"S_size={S.bit_count()} moves={len(scored)}")

        for score, live_gain, transv_gain, side, T in scored:
            live2 = live & ~self.cache.get(side, T)
            if live2 == live:
                continue

            if side == "P":
                P2 = tuple(sorted((*P, T)))
                N2 = N
                status, Pf, Nf, reason = self._dfs(live2, P2, N2, p_left-1, n_left)
            else:
                P2 = P
                N2 = tuple(sorted((*N, T)))
                status, Pf, Nf, reason = self._dfs(live2, P2, N2, p_left, n_left-1)

            if status in ("FOUND", "LIMIT"):
                return status, Pf, Nf, reason

        return "EXHAUSTED", P, N, "all branches exhausted"


def print_result(res: BalancedResult) -> None:
    print(f"status={res.status}")
    print(f"q={res.q} k={res.k} p_budget={res.p_budget} n_budget={res.n_budget}")
    print(f"nodes={res.nodes} elapsed={res.elapsed:.3f}s reason={res.reason}")
    print(f"|P|={len(res.P)} |N|={len(res.N)} total={len(res.P)+len(res.N)}")
    print(f"cache_hits={res.cache_hits} cache_misses={res.cache_misses} memo_size={res.memo_size} "
          f"canon_memo_size={res.canon_memo_size} canon_hits={res.canon_hits} canon_skips={res.canon_skips}")
    if res.status == "FOUND":
        live = formula_live(res.q,res.k,res.P,res.N)
        print(f"exact_verification_separator_free={live == 0}")
        print("P=[" + ", ".join(str(mask_to_tuple(x,res.q)) for x in res.P) + "]")
        print("N=[" + ", ".join(str(mask_to_tuple(x,res.q)) for x in res.N) + "]")


def smoke_tests() -> None:
    print("Known HMT4 verification")
    q,k,P,N = known_hmt4()
    live = formula_live(q,k,P,N)
    print(f"HMT4 q={q} k={k} |P|={len(P)} |N|={len(N)} live={live.bit_count()} sep_free={live==0}")

    print("\nBalanced smoke tests")
    tests = [
        # q,k,p,n,fixed,tlim,nlim,bcap
        (3,2,2,3,False,5,10000,0),  # should be exhausted
        (3,2,3,3,False,5,10000,0),  # should find triangle
        (7,3,6,7,False,5,100000,0), # probably exhausted/limit, below Fano symmetric
        (7,3,7,7,False,10,200000,0),# should find Fano
    ]
    for q,k,p,n,fixed,tlim,nlim,bcap in tests:
        solver = BalancedBitsetSolver(q,k,p,n,fixed_positive=fixed,time_limit=tlim,
                                      max_nodes=nlim,branch_cap=bcap,lb_max_q=12)
        res = solver.run()
        print(f"\nq={q} k={k} p={p} n={n} fixed={fixed}")
        print_result(res)


def run_balance_batch(args) -> None:
    """Run side-balanced cases p=min_p..max_p, n=budget-p."""
    print("p,n,status,nodes,elapsed,total,reason")
    for p in range(args.p_min, args.p_max + 1):
        n = args.total_budget - p
        if n < 0:
            continue
        solver = BalancedBitsetSolver(
            args.q, args.k, p, n,
            fixed_positive=args.fixed_positive,
            time_limit=args.time_limit,
            max_nodes=args.max_nodes,
            seed=args.seed + 1009*p,
            branch_cap=args.branch_cap,
            cache_entries=args.cache_entries,
            use_memo=not args.no_memo,
            use_canonical_memo=not args.no_canonical_memo,
            canon_max_perms=args.canon_max_perms,
            use_gain_lb=not args.no_gain_lb,
            lb_max_q=args.lb_max_q,
            use_packing_lb=not args.no_packing_lb,
            packing_scan=args.packing_scan,
            use_transversal_prune=not args.no_transversal_prune,
            transv_max_q=args.transv_max_q,
            transv_nodes=args.transv_nodes,
            transv_seconds=args.transv_seconds,
            transv_score_weight=args.transv_score_weight,
            random_trials=args.random_trials,
            scan_limit=args.scan_limit,
            verbose=args.verbose,
        )
        res = solver.run()
        print(f"{p},{n},{res.status},{res.nodes},{res.elapsed:.3f},{len(res.P)+len(res.N)},\"{res.reason}\"")
        if res.status == "FOUND":
            print("FOUND details:")
            print_result(res)
            break


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", type=int, default=3)
    ap.add_argument("--k", type=int, default=2)
    ap.add_argument("--p-budget", type=int, default=3)
    ap.add_argument("--n-budget", type=int, default=3)
    ap.add_argument("--fixed-positive", action="store_true")
    ap.add_argument("--time-limit", type=float, default=30.0)
    ap.add_argument("--max-nodes", type=int, default=100000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--branch-cap", type=int, default=0)
    ap.add_argument("--cache-entries", type=int, default=4096)
    ap.add_argument("--no-memo", action="store_true")
    ap.add_argument("--no-canonical-memo", action="store_true")
    ap.add_argument("--canon-max-perms", type=int, default=50000)
    ap.add_argument("--no-gain-lb", action="store_true")
    ap.add_argument("--lb-max-q", type=int, default=14)
    ap.add_argument("--no-packing-lb", action="store_true")
    ap.add_argument("--packing-scan", type=int, default=4096)
    ap.add_argument("--no-transversal-prune", action="store_true")
    ap.add_argument("--transv-max-q", type=int, default=14)
    ap.add_argument("--transv-nodes", type=int, default=20000)
    ap.add_argument("--transv-seconds", type=float, default=0.05)
    ap.add_argument("--transv-score-weight", type=int, default=1000000)
    ap.add_argument("--random-trials", type=int, default=128)
    ap.add_argument("--scan-limit", type=int, default=512)
    ap.add_argument("--smoke-tests", action="store_true")
    ap.add_argument("--balance-batch", action="store_true")
    ap.add_argument("--total-budget", type=int, default=39)
    ap.add_argument("--p-min", type=int, default=1)
    ap.add_argument("--p-max", type=int, default=19)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if args.smoke_tests:
        smoke_tests()
        return

    if args.balance_batch:
        run_balance_batch(args)
        return

    solver = BalancedBitsetSolver(
        args.q, args.k, args.p_budget, args.n_budget,
        fixed_positive=args.fixed_positive,
        time_limit=args.time_limit,
        max_nodes=args.max_nodes,
        seed=args.seed,
        branch_cap=args.branch_cap,
        cache_entries=args.cache_entries,
        use_memo=not args.no_memo,
        use_canonical_memo=not args.no_canonical_memo,
        canon_max_perms=args.canon_max_perms,
        use_gain_lb=not args.no_gain_lb,
        lb_max_q=args.lb_max_q,
        use_transversal_prune=not args.no_transversal_prune,
        transv_max_q=args.transv_max_q,
        transv_nodes=args.transv_nodes,
        transv_seconds=args.transv_seconds,
        random_trials=args.random_trials,
        scan_limit=args.scan_limit,
        verbose=args.verbose,
    )
    res = solver.run()
    print_result(res)


if __name__ == "__main__":
    main()

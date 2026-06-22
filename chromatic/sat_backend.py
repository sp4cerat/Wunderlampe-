#!/usr/bin/env python3
"""SAT backend for the separator-free-pair search.

Encodes the question "does a separator-free pair (P,N) of k-sets over [q] exist with
|P| <= p_budget, |N| <= n_budget?" as CNF and solves it with CaDiCaL (via python-sat).

  SAT   -> such a pair exists (decoded + verified formula_live == 0)
  UNSAT -> no such pair exists  (an exact exclusion, same meaning as DFS EXHAUSTED)
  UNKNOWN -> solver interrupted by the time limit

Encoding:
  vars  p[T], n[T]  for every k-set T over [q].
  cover for every assignment S subset [q]:
          OR{ p[T] : T cap S = 0 }  union  OR{ n[T] : T subset S }
        (S must be killed by some chosen clause; empty disjunction => UNSAT).
  budgets  sum_T p[T] <= p_budget ,  sum_T n[T] <= n_budget   (CardEnc).
  optional: fix the positive clause {0..k-1} (WLOG by colour symmetry, P is nonempty).

This is method-orthogonal to the DFS solver and is used to cross-validate exclusions
and to attack instances (e.g. q=11) that the DFS cannot finish.
"""
from __future__ import annotations

import argparse
import threading
import time
from typing import List, Optional, Tuple

from pysat.card import CardEnc, EncType
from pysat.formula import IDPool
from pysat.solvers import Solver as PySatSolver

import bitset_balanced_solver_v5 as S

Mask = int


def _swap_bits(T: Mask, c: int) -> Mask:
    """Swap colour bits c and c+1 in mask T (adjacent transposition action)."""
    bc = (T >> c) & 1
    bc1 = (T >> (c + 1)) & 1
    if bc == bc1:
        return T
    return T ^ (1 << c) ^ (1 << (c + 1))


def _lex_le_clauses(X: List[int], Y: List[int], pool: IDPool, tag) -> List[List[int]]:
    """CNF for X <=_lex Y (standard lex-leader). X,Y are equal-length variable lists;
    Y is a permutation of X. Fresh eq-prefix vars from `pool`. Sound symmetry-breaking."""
    out: List[List[int]] = []
    eq_prev = None  # None represents the constant TRUE (empty prefix all-equal)
    for i, (a, b) in enumerate(zip(X, Y)):
        if a == b:
            continue  # fixed point: x_i == y_i always, prefix-equality unchanged
        # prefix-equal => (a -> b)
        out.append([-a, b] if eq_prev is None else [-eq_prev, -a, b])
        eq_i = pool.id(("eq", tag, i))
        if eq_prev is None:
            # eq_i <-> (a <-> b)
            out += [[-eq_i, -a, b], [-eq_i, a, -b], [-a, -b, eq_i], [a, b, eq_i]]
        else:
            # eq_i <-> eq_prev AND (a <-> b)
            out += [[-eq_i, eq_prev], [-eq_i, -a, b], [-eq_i, a, -b],
                    [-eq_prev, -a, -b, eq_i], [-eq_prev, a, b, eq_i]]
        eq_prev = eq_i
    return out


def build_clauses(q: int, k: int, p_budget: int, n_budget: int,
                  fix_first_positive: bool = True,
                  card_enc: int = EncType.seqcounter,
                  sym_break: bool = False,
                  total_budget: Optional[int] = None):
    """Return (clauses, pool, p_var, n_var, U).

    sym_break: add lex-leader symmetry-breaking over the colour-permutation
    generators (adjacent transpositions). MUST NOT be combined with
    fix_first_positive (two different representative choices can jointly empty an
    orbit -> false UNSAT); the caller enforces this.
    """
    U = list(S.all_ksets(q, k))
    pool = IDPool(start_from=1)
    p_var = {T: pool.id(("p", T)) for T in U}
    n_var = {T: pool.id(("n", T)) for T in U}

    clauses: List[List[int]] = []

    # Cover clauses: every assignment S must be killed.
    for Sset in range(1 << q):
        lits = [p_var[T] for T in U if (T & Sset) == 0]      # T subset comp(S)
        lits += [n_var[T] for T in U if (T & Sset) == T]     # T subset S
        clauses.append(lits)                                 # empty => UNSAT

    # Budgets. With total_budget set, bound |P|+|N| jointly (the record-attack query
    # "is there a construction with <= total vertices?", split chosen by the solver);
    # otherwise bound each side separately.
    p_lits = [p_var[T] for T in U]
    n_lits = [n_var[T] for T in U]
    if total_budget is not None:
        clauses += CardEnc.atmost(p_lits + n_lits, bound=total_budget,
                                  vpool=pool, encoding=card_enc).clauses
    else:
        clauses += CardEnc.atmost(p_lits, bound=p_budget, vpool=pool, encoding=card_enc).clauses
        clauses += CardEnc.atmost(n_lits, bound=n_budget, vpool=pool, encoding=card_enc).clauses

    # WLOG fix one positive clause {0..k-1} (colour symmetry; P is nonempty since the
    # all-colour-2 assignment S=empty is only killable by a positive clause).
    if fix_first_positive:
        first = (1 << k) - 1
        clauses.append([p_var[first]])

    # Lex-leader symmetry breaking over colour-permutation generators (c,c+1).
    # Variable vector = [p[T] for T in U] + [n[T] for T in U] in fixed order;
    # generator g swaps colour bits c,c+1, permuting p[T]<->p[swap(T)], n[T]<->n[swap(T)].
    if sym_break:
        order = [p_var[T] for T in U] + [n_var[T] for T in U]
        for c in range(q - 1):
            img = ([p_var[_swap_bits(T, c)] for T in U]
                   + [n_var[_swap_bits(T, c)] for T in U])
            clauses += _lex_le_clauses(order, img, pool, tag=c)

    return clauses, pool, p_var, n_var, U


def solve(q: int, k: int, p_budget: int, n_budget: int,
          fix_first_positive: bool = True,
          card_enc: int = EncType.seqcounter,
          time_limit: Optional[float] = None,
          sym_break: bool = False,
          solver_name: str = "cadical195",
          total_budget: Optional[int] = None,
          verbose: bool = False) -> Tuple[str, Tuple[Mask, ...], Tuple[Mask, ...], dict]:
    # Guard: lex-leader SB and fix-first are two different representative choices;
    # combining them can empty an orbit -> false UNSAT. SB replaces fix-first.
    if sym_break:
        fix_first_positive = False
    # Structural: P and N must each be nonempty and need >= k clauses is NOT required
    # here; the SAT encoding handles it. But k-set universe must exist.
    if q < k:
        return "UNSAT", tuple(), tuple(), {"reason": "q < k"}

    t0 = time.time()
    clauses, pool, p_var, n_var, U = build_clauses(
        q, k, p_budget, n_budget, fix_first_positive, card_enc, sym_break, total_budget)
    build_t = time.time() - t0

    solver = PySatSolver(name=solver_name, bootstrap_with=clauses, use_timer=False)

    interrupted = {"v": False}
    timer = None
    if time_limit:
        def _interrupt(s=solver):
            interrupted["v"] = True
            s.interrupt()
        timer = threading.Timer(time_limit, _interrupt)
        timer.start()

    t1 = time.time()
    if time_limit:
        res = solver.solve_limited(expect_interrupt=True)
    else:
        res = solver.solve()
    solve_t = time.time() - t1
    if timer:
        timer.cancel()

    stats = {
        "vars": pool.top, "clauses": len(clauses),
        "build_s": round(build_t, 3), "solve_s": round(solve_t, 3),
        "k_sets": len(U), "solver": solver_name,
    }

    if res is None:
        solver.delete()
        return "UNKNOWN", tuple(), tuple(), {**stats, "reason": "time limit"}

    if not res:
        solver.delete()
        return "UNSAT", tuple(), tuple(), stats

    model = set(x for x in solver.get_model() if x > 0)
    solver.delete()
    P = tuple(sorted(T for T in U if p_var[T] in model))
    N = tuple(sorted(T for T in U if n_var[T] in model))
    # Independent verification.
    live = S.formula_live(q, k, P, N)
    stats["verified_sep_free"] = (live == 0)
    return "SAT", P, N, stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", type=int, required=True)
    ap.add_argument("--k", type=int, required=True)
    ap.add_argument("--p-budget", type=int, default=None)
    ap.add_argument("--n-budget", type=int, default=None)
    ap.add_argument("--total-budget", type=int, default=None,
                    help="bound |P|+|N| jointly (record-attack); overrides side budgets")
    ap.add_argument("--no-fix-first", action="store_true")
    ap.add_argument("--sym-break", action="store_true",
                    help="lex-leader colour-symmetry breaking (replaces fix-first)")
    ap.add_argument("--card-enc", default="seqcounter",
                    choices=["seqcounter", "totalizer", "mtotalizer", "kmtotalizer",
                             "sortnetwrk", "cardnetwrk", "ladder"],
                    help="cardinality encoding for the budgets")
    ap.add_argument("--solver", default="cadical195",
                    help="pysat solver name (cadical195, glucose42, minisat22, ...)")
    ap.add_argument("--time-limit", type=float, default=None)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if args.total_budget is None and (args.p_budget is None or args.n_budget is None):
        ap.error("give either --total-budget or both --p-budget and --n-budget")
    pb = args.p_budget if args.p_budget is not None else (args.total_budget or 0)
    nb = args.n_budget if args.n_budget is not None else (args.total_budget or 0)

    status, P, N, stats = solve(
        args.q, args.k, pb, nb,
        fix_first_positive=not args.no_fix_first,
        card_enc=getattr(EncType, args.card_enc),
        time_limit=args.time_limit, sym_break=args.sym_break,
        solver_name=args.solver, total_budget=args.total_budget, verbose=args.verbose)

    print(f"status={status}")
    print(f"q={args.q} k={args.k} p_budget={pb} n_budget={nb} total_budget={args.total_budget}")
    print(f"stats={stats}")
    if status == "SAT":
        print(f"|P|={len(P)} |N|={len(N)} total={len(P)+len(N)}")
        print("P=[" + ", ".join(str(S.mask_to_tuple(x, args.q)) for x in P) + "]")
        print("N=[" + ", ".join(str(S.mask_to_tuple(x, args.q)) for x in N) + "]")


if __name__ == "__main__":
    main()

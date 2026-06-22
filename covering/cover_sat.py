#!/usr/bin/env python3
"""Odd distinct covering systems — SAT / MaxSAT obstruction search.

Erdős problem #629-adjacent (the "odd covering problem"):

    Is there a covering system of Z whose moduli are DISTINCT and all ODD (>1)?

A covering system is a finite set of congruences a_i (mod n_i) such that every
integer satisfies at least one. We allow overlaps (NON-disjoint covering — the
disjoint/exact version with distinct moduli > 1 is already impossible by
Mirsky–Newman/Davenport–Rado, so it is not the interesting question).

MODEL.  Fix a bound B and let M = {3,5,7,...,B} (all odd moduli, 3..B).
Distinct moduli  =>  each modulus n is used in AT MOST one congruence, i.e. we
pick one residue a_n in [0,n).  Using a modulus can only help cover more
integers, so for the EXISTENCE question it is WLOG to use every n in M with
exactly one residue.  Boolean variables:

    x[n][a] = 1   iff  the chosen residue for modulus n is a        (a in [0,n))

Hard constraints:  exactly-one residue per modulus.
Cover of integer t:  clause  OR_{n in M} x[n][ t mod n ]   (some modulus hits t).

- period mode  : cover ALL t in [0, N), N = lcm(M).  This is EXACT:
                 SAT   => a genuine odd distinct covering system exists (max mod ≤ B);
                 UNSAT => NONE exists with max modulus ≤ B.   (limited by N growth)
- interval mode: cover only t in [0, L).  A cheaper NECESSARY relaxation:
                 UNSAT => exclusion (no covering can even cover [0,L));
                 SAT   => inconclusive (we report the first integer it misses).
- maxsat mode  : maximise the number of covered residues over [0, N) (RC2),
                 to measure HOW FAR short the best choice falls.

Every SAT model is re-verified independently before any claim is made.
"""
from __future__ import annotations
import argparse
import math
import time
from typing import Dict, List, Tuple


def odd_moduli(B: int) -> List[int]:
    """All odd moduli 3..B (covering systems exclude the trivial modulus 1)."""
    return list(range(3, B + 1, 2))


def density(M: List[int]) -> float:
    return sum(1.0 / n for n in M)


class VarPool:
    """Maps (n, a) -> positive DIMACS variable id, allocated on demand."""
    def __init__(self) -> None:
        self._d: Dict[Tuple[int, int], int] = {}
        self.top = 0

    def vid(self, n: int, a: int) -> int:
        key = (n, a)
        v = self._d.get(key)
        if v is None:
            self.top += 1
            v = self._d[key] = self.top
        return v


def exactly_one_clauses(pool: VarPool, M: List[int]) -> List[List[int]]:
    """Exactly-one residue per modulus: at-least-one + pairwise at-most-one.

    Pairwise AMO is O(n^2) per modulus; fine for the n we reach (n ≤ a few hundred)."""
    clauses: List[List[int]] = []
    for n in M:
        lits = [pool.vid(n, a) for a in range(n)]
        clauses.append(lits[:])                      # at least one
        for i in range(len(lits)):                   # at most one (pairwise)
            for j in range(i + 1, len(lits)):
                clauses.append([-lits[i], -lits[j]])
    return clauses


def cover_clause(pool: VarPool, M: List[int], t: int) -> List[int]:
    """t is covered iff some modulus n has chosen residue (t mod n)."""
    return [pool.vid(n, t % n) for n in M]


def _build(M: List[int], points: range):
    pool = VarPool()
    clauses = exactly_one_clauses(pool, M)
    for t in points:
        clauses.append(cover_clause(pool, M, t))
    return pool, clauses


def _model_residues(pool: VarPool, M: List[int], model_set) -> Dict[int, int]:
    chosen: Dict[int, int] = {}
    for n in M:
        for a in range(n):
            if pool.vid(n, a) in model_set:
                chosen[n] = a
                break
    return chosen


def _covers(chosen: Dict[int, int], t: int) -> bool:
    return any(t % n == a for n, a in chosen.items())


def _first_uncovered(chosen: Dict[int, int], upto: int) -> int:
    for t in range(upto):
        if not _covers(chosen, t):
            return t
    return -1


def solve_period(B: int, solver: str = "cadical195", time_limit: float | None = None):
    """EXACT: cover all of [0, lcm(M)).  SAT => covering exists; UNSAT => excluded."""
    from pysat.solvers import Solver
    M = odd_moduli(B)
    N = math.lcm(*M)
    t0 = time.time()
    pool, clauses = _build(M, range(N))
    with Solver(name=solver, bootstrap_with=clauses, use_timer=True) as s:
        sat = s.solve()
        secs = time.time() - t0
        if sat:
            chosen = _model_residues(pool, M, set(s.get_model()))
            bad = _first_uncovered(chosen, N)               # independent re-verify
            verified = (bad == -1)
            return "SAT" if verified else "SAT-UNVERIFIED", dict(M=M, N=N, chosen=chosen,
                                                                 verified=verified, secs=secs)
        return "UNSAT", dict(M=M, N=N, chosen=None, verified=True, secs=secs)


def solve_interval(B: int, L: int, solver: str = "cadical195"):
    """RELAXATION: cover [0, L).  UNSAT => exclusion; SAT => inconclusive."""
    from pysat.solvers import Solver
    M = odd_moduli(B)
    t0 = time.time()
    pool, clauses = _build(M, range(L))
    with Solver(name=solver, bootstrap_with=clauses) as s:
        sat = s.solve()
        secs = time.time() - t0
        if sat:
            chosen = _model_residues(pool, M, set(s.get_model()))
            N = math.lcm(*M)
            miss = _first_uncovered(chosen, N)              # first miss in full period
            return "SAT", dict(M=M, L=L, chosen=chosen, first_miss=miss, period=N, secs=secs)
        return "UNSAT", dict(M=M, L=L, chosen=None, secs=secs)


def max_coverage(B: int):
    """MaxSAT (RC2): best possible coverage of [0, N).  Returns covered / N."""
    from pysat.formula import WCNF
    from pysat.examples.rc2 import RC2
    M = odd_moduli(B)
    N = math.lcm(*M)
    t0 = time.time()
    pool = VarPool()
    wcnf = WCNF()
    for cl in exactly_one_clauses(pool, M):
        wcnf.append(cl)                                     # hard
    for t in range(N):
        wcnf.append(cover_clause(pool, M, t), weight=1)     # soft: cover t
    with RC2(wcnf) as rc2:
        model = rc2.compute()
        cost = rc2.cost                                     # # of unsatisfied soft = uncovered
        secs = time.time() - t0
    chosen = _model_residues(pool, M, set(v for v in model if v > 0))
    covered = N - cost
    return dict(M=M, N=N, covered=covered, uncovered=cost,
                pct=100.0 * covered / N, chosen=chosen, secs=secs)


def _fmt_chosen(chosen: Dict[int, int]) -> str:
    return ", ".join(f"{a}(mod {n})" for n, a in sorted(chosen.items()))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--B", type=int, default=15, help="max odd modulus (uses {3,5,...,B})")
    ap.add_argument("--mode", choices=["period", "interval", "maxsat", "density"],
                    default="period")
    ap.add_argument("--L", type=int, default=100, help="interval length for --mode interval")
    ap.add_argument("--solver", default="cadical195")
    args = ap.parse_args()

    M = odd_moduli(args.B)
    d = density(M)
    print(f"M = {{3,5,...,{args.B}}}  ({len(M)} moduli)   density Σ1/n = {d:.4f}"
          f"  ({'≥1 OK' if d >= 1 else '<1 — cannot cover (necessary cond. fails)'})")

    if args.mode == "density":
        return

    if args.mode == "period":
        N = math.lcm(*M)
        print(f"period N = lcm = {N}  → exact full-period SAT")
        status, info = solve_period(args.B, args.solver)
        if status.startswith("SAT") and info["verified"]:
            print(f"*** SAT (VERIFIED): odd distinct COVERING SYSTEM exists, max mod ≤ {args.B}!")
            print(f"    {_fmt_chosen(info['chosen'])}")
        elif status == "UNSAT":
            print(f"UNSAT in {info['secs']:.2f}s  → NO odd distinct covering with max modulus ≤ {args.B}")
        else:
            print(f"status={status} (verification failed — investigate)")

    elif args.mode == "interval":
        status, info = solve_interval(args.B, args.L, args.solver)
        if status == "UNSAT":
            print(f"UNSAT covering [0,{args.L}) in {info['secs']:.2f}s "
                  f"→ exclusion: no odd distinct covering with max modulus ≤ {args.B}")
        else:
            miss = info["first_miss"]
            print(f"SAT for [0,{args.L}) in {info['secs']:.2f}s (inconclusive). "
                  f"First integer this choice misses in full period: "
                  f"{miss if miss != -1 else 'none — actually a full cover!'}")
            if miss != -1:
                print(f"    {_fmt_chosen(info['chosen'])}")

    elif args.mode == "maxsat":
        r = max_coverage(args.B)
        print(f"MaxSAT best coverage of [0,{r['N']}): {r['covered']}/{r['N']} "
              f"= {r['pct']:.2f}%  (uncovered {r['uncovered']})  [{r['secs']:.2f}s]")
        print(f"    best choice: {_fmt_chosen(r['chosen'])}")


if __name__ == "__main__":
    main()

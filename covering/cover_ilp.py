#!/usr/bin/env python3
"""Odd distinct covering systems — ILP (CBC) backend.

Same model as cover_sat.py, but solved as an integer program. The point of using
an ILP here: proving a finite point set UNcoverable is an INFEASIBILITY proof, and
CBC's LP relaxation + cutting planes refute these covering ILPs far faster than CDCL
SAT does — which is why an ILP reaches max modulus ~31 where plain SAT stalls at ~25.

Variables  x[n,a] in {0,1}  (residue a chosen for odd modulus n in M = {3,5,...,B}).
  exactly-one per modulus:   sum_a x[n,a] = 1
  cover integer t:           sum_{n in M} x[n, t mod n] >= 1
Feasible  => those integers are coverable;  Infeasible => exclusion.

Modes:
  interval L : feasibility of covering [0, L).  Infeasible => no odd distinct covering
               with max modulus <= B (since [0,L) ⊂ Z).
  cegar      : lazily grow the point set (add the first uncovered integer each round)
               until Infeasible (=> a finite obstruction certificate) or a model covers
               the whole period (=> a real covering system).  --minimize shrinks the cert.
"""
from __future__ import annotations
import argparse
import math
import time
from typing import Dict, List

import pulp

from cover_sat import odd_moduli, _covers, _first_uncovered


def _solver(time_limit: float | None):
    return pulp.PULP_CBC_CMD(msg=0, timeLimit=time_limit)


def _build(M: List[int], points):
    prob = pulp.LpProblem("cover", pulp.LpMinimize)
    x: Dict = {(n, a): pulp.LpVariable(f"x_{n}_{a}", cat="Binary")
               for n in M for a in range(n)}
    prob += 0                                            # pure feasibility
    for n in M:
        prob += pulp.lpSum(x[(n, a)] for a in range(n)) == 1
    for t in points:
        prob += pulp.lpSum(x[(n, t % n)] for n in M) >= 1
    return prob, x


def _status(prob) -> str:
    return pulp.LpStatus[prob.status]                    # 'Optimal' | 'Infeasible' | ...


def _chosen(M: List[int], x) -> Dict[int, int]:
    out: Dict[int, int] = {}
    for n in M:
        for a in range(n):
            v = x[(n, a)].value()
            if v is not None and v > 0.5:
                out[n] = a
                break
    return out


def is_infeasible(M: List[int], points, time_limit: float | None = None) -> bool:
    """True iff M provably cannot cover the given finite integer set (CBC Infeasible)."""
    prob, _ = _build(M, points)
    prob.solve(_solver(time_limit))
    return _status(prob) == "Infeasible"


def solve_interval(B: int, L: int, time_limit: float | None = None):
    M = odd_moduli(B)
    t0 = time.time()
    prob, x = _build(M, range(L))
    prob.solve(_solver(time_limit))
    st = _status(prob)
    secs = time.time() - t0
    if st == "Infeasible":
        return "INFEASIBLE", dict(M=M, L=L, secs=secs)
    if st == "Optimal":
        chosen = _chosen(M, x)
        N = math.lcm(*M)
        miss = _first_uncovered(chosen, N)
        return "FEASIBLE", dict(M=M, L=L, chosen=chosen, first_miss=miss, period=N, secs=secs)
    return st.upper(), dict(M=M, L=L, secs=secs)          # NOT SOLVED / UNDEFINED (time-out)


def _minimize(M: List[int], points, time_limit: float | None = None):
    keep = list(points)
    i = 0
    while i < len(keep):
        trial = keep[:i] + keep[i + 1:]
        if trial and is_infeasible(M, trial, time_limit):
            keep = trial
        else:
            i += 1
    return keep


def cegar(B: int, scan_limit: int = 200_000, max_iters: int = 20000,
          time_limit: float | None = None, per_solve: float | None = None,
          minimize: bool = False):
    """Lazy growing-window CEGAR with an ILP feasibility oracle.

    PuLP has no incremental API, so each round rebuilds the model over the accumulated
    points (cheap relative to the solve).  Infeasible => obstruction; full cover => system.
    """
    M = odd_moduli(B)
    N = math.lcm(*M)
    scan_cap = min(N, scan_limit)
    t0 = time.time()
    added = list(range(min(N, 3 * B)))                    # seed window
    seen = set(added)

    it = 0
    while True:
        it += 1
        prob, x = _build(M, added)
        prob.solve(_solver(per_solve))
        st = _status(prob)
        if st == "Infeasible":
            secs = time.time() - t0
            obstruction = _minimize(M, added, per_solve) if minimize else added
            return "INFEASIBLE", dict(M=M, N=N, obstruction=sorted(obstruction),
                                      n_points=len(obstruction), raw_points=len(added),
                                      iters=it, secs=secs)
        if st != "Optimal":                               # time-out / undefined
            return st.upper(), dict(M=M, N=N, iters=it, n_points=len(added),
                                    secs=time.time() - t0)
        chosen = _chosen(M, x)
        miss = -1
        for t in range(scan_cap):
            if t not in seen and not _covers(chosen, t):
                miss = t
                break
        if miss == -1:
            secs = time.time() - t0
            if scan_cap >= N and _first_uncovered(chosen, N) == -1:
                return "COVER", dict(M=M, N=N, chosen=chosen, iters=it, secs=secs)
            return "INCONCLUSIVE", dict(M=M, N=N, chosen=chosen, scanned=scan_cap,
                                        iters=it, secs=secs)
        added.append(miss)
        seen.add(miss)
        if time_limit is not None and time.time() - t0 > time_limit:
            return "TIMEOUT", dict(M=M, N=N, iters=it, n_points=len(added),
                                   secs=time.time() - t0)
        if it >= max_iters:
            return "MAXITERS", dict(M=M, N=N, iters=it, n_points=len(added),
                                    secs=time.time() - t0)


def _fmt_chosen(chosen: Dict[int, int]) -> str:
    return ", ".join(f"{a}(mod {n})" for n, a in sorted(chosen.items()))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--B", type=int, default=31)
    ap.add_argument("--mode", choices=["interval", "cegar"], default="interval")
    ap.add_argument("--L", type=int, default=100)
    ap.add_argument("--scan-limit", type=int, default=200_000)
    ap.add_argument("--max-iters", type=int, default=20000)
    ap.add_argument("--time-limit", type=float, default=None, help="overall seconds cap")
    ap.add_argument("--per-solve", type=float, default=None, help="CBC time limit per solve (s)")
    ap.add_argument("--minimize", action="store_true")
    args = ap.parse_args()

    M = odd_moduli(args.B)
    print(f"M = {{3,5,...,{args.B}}}  ({len(M)} moduli)   density Σ1/n = {sum(1/n for n in M):.4f}")

    if args.mode == "interval":
        status, info = solve_interval(args.B, args.L, args.time_limit)
        if status == "INFEASIBLE":
            print(f"INFEASIBLE covering [0,{args.L}) in {info['secs']:.2f}s "
                  f"→ exclusion: no odd distinct covering with max modulus ≤ {args.B}")
        elif status == "FEASIBLE":
            m = info["first_miss"]
            print(f"FEASIBLE for [0,{args.L}) in {info['secs']:.2f}s (inconclusive). "
                  f"First integer missed in full period: "
                  f"{m if m != -1 else 'none — actually a full cover!'}")
        else:
            print(f"{status} in {info['secs']:.2f}s (CBC did not decide — raise --time-limit)")

    else:  # cegar
        status, info = cegar(args.B, scan_limit=args.scan_limit, max_iters=args.max_iters,
                             time_limit=args.time_limit, per_solve=args.per_solve,
                             minimize=args.minimize)
        if status == "INFEASIBLE":
            print(f"INFEASIBLE in {info['secs']:.2f}s ({info['iters']} rounds) → exclusion: "
                  f"no odd distinct covering with max modulus ≤ {args.B}")
            obs = info["obstruction"]
            tag = "minimal" if args.minimize else "lazy"
            print(f"    obstruction certificate ({tag}, {info['n_points']} integers): {obs}")
            print(f"    re-verified infeasible: {is_infeasible(info['M'], obs)}")
        elif status == "COVER":
            print(f"*** COVER (VERIFIED): odd distinct covering system exists, max mod ≤ {args.B}!")
            print(f"    {_fmt_chosen(info['chosen'])}")
        elif status == "INCONCLUSIVE":
            print(f"INCONCLUSIVE in {info['secs']:.2f}s: feasible, no miss within "
                  f"scan_limit={info['scanned']} (< period {info['N']}). Raise --scan-limit.")
        else:
            print(f"{status} after {info['iters']} rounds / {info['secs']:.2f}s "
                  f"({info.get('n_points','?')} points).")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Binary-search the smallest L such that covering [0, L) is infeasible for moduli <= B.

Infeasibility is monotone in L (adding an integer to cover can only make it harder),
so we can binary-search the feasible->infeasible threshold. The resulting window
[0, L_min) is a clean consecutive-integer obstruction certificate.
"""
import sys
import time

from cover_sat import odd_moduli
import cover_ilp


def find_min_window(B, lo=1, hi=200, per_solve=200.0):
    M = odd_moduli(B)
    # ensure hi is infeasible; grow if needed
    while not cover_ilp.is_infeasible(M, range(hi), per_solve):
        lo = hi + 1
        hi *= 2
        print(f"  [0,{hi//2}) feasible/undecided -> raise hi to {hi}", flush=True)
    # invariant: [0,lo-1) feasible-ish, [0,hi) infeasible
    while lo < hi:
        mid = (lo + hi) // 2
        t0 = time.time()
        inf = cover_ilp.is_infeasible(M, range(mid), per_solve)
        print(f"  L={mid}: {'INFEASIBLE' if inf else 'feasible/undecided'} "
              f"({time.time()-t0:.1f}s)", flush=True)
        if inf:
            hi = mid
        else:
            lo = mid + 1
    return lo


if __name__ == "__main__":
    B = int(sys.argv[1]) if len(sys.argv) > 1 else 33
    per = float(sys.argv[2]) if len(sys.argv) > 2 else 200.0
    print(f"B={B}: searching minimal infeasible window...", flush=True)
    Lmin = find_min_window(B, per_solve=per)
    print(f"\nB={B}: minimal infeasible window = [0,{Lmin})  "
          f"=> {Lmin} consecutive integers cannot be covered by odd distinct moduli <= {B}")

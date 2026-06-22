#!/usr/bin/env python3
"""Alon–Tarsi / Combinatorial-Nullstellensatz choosability tester.

Graph polynomial P_G = prod_{(i,j) in E} (x_i - x_j). Alon's theorem:
if some monomial with ALL exponents <= k-1 has a nonzero coefficient, then G is
k-choosable (AT(G) <= k). We never expand P_G fully: multiply the edge factors one
at a time as an integer-coefficient dict {exponent-tuple: coeff}, and after each
factor PRUNE any partial monomial whose exponent in some variable already reaches k
(exponents only grow, so it can never end <= k-1). The peak dict size is the real
feasibility metric.

choosable-certified  <=>  AT(G) <= k  =>  ch(G) <= k   (sufficient, not necessary:
AT can exceed the choice number, so "no good monomial" only means AT>k, a *candidate*
for non-k-choosable, to be confirmed separately).
"""
from __future__ import annotations
import time
from typing import List, Tuple


def at_choosable(n: int, edges: List[Tuple[int, int]], k: int):
    """Return (certified_choosable: bool, peak_terms: int, seconds: float).

    certified_choosable = True  iff some monomial with all exponents <= k-1 has
    nonzero coefficient in P_G  (=> G is k-choosable, AT(G) <= k).
    """
    t0 = time.time()
    cap = k - 1                       # max allowed exponent per variable
    # quick necessary check: a valid monomial has total degree |E|, each exp <= cap
    if len(edges) > n * cap:
        return False, 0, time.time() - t0
    poly = {(0,) * n: 1}              # start at constant 1
    peak = 1
    for (i, j) in edges:
        nxt: dict = {}
        for exp, c in poly.items():
            # term * x_i  (coefficient +c)
            ei = exp[i] + 1
            if ei <= cap:
                ke = exp[:i] + (ei,) + exp[i+1:]
                v = nxt.get(ke, 0) + c
                if v: nxt[ke] = v
                else: nxt.pop(ke, None)
            # term * (-x_j)  (coefficient -c)
            ej = exp[j] + 1
            if ej <= cap:
                ke = exp[:j] + (ej,) + exp[j+1:]
                v = nxt.get(ke, 0) - c
                if v: nxt[ke] = v
                else: nxt.pop(ke, None)
        poly = nxt
        peak = max(peak, len(poly))
        if not poly:                 # everything pruned -> no valid monomial
            return False, peak, time.time() - t0
    # any surviving monomial of full degree |E| with all exp<=cap and nonzero coeff?
    certified = any(c != 0 for c in poly.values())
    return certified, peak, time.time() - t0


def cycle(nn):
    return nn, [(a, (a + 1) % nn) for a in range(nn)]


def complete_bipartite(a, b):
    n = a + b
    return n, [(i, a + j) for i in range(a) for j in range(b)]


def _main():
    print("== Validierung: AT-Zertifizierbarkeit (HINREICHEND, nicht notwendig) ==")
    print("   erwartet = ob Alon-Tarsi k-Wählbarkeit ZERTIFIZIEREN kann.")
    print("   Achtung: AT-cert=False heißt NICHT 'nicht wählbar' (einseitig!).\n")
    cases = [
        # name, (n,edges), k, erwartet-AT-zertifizierbar, kommentar
        ("C3 (Dreieck), k=2",  cycle(3),                 2, False, "auch echt nicht 2-wb"),
        ("C4, k=2",            cycle(4),                  2, True,  "AT zertifiziert"),
        ("C5, k=2",            cycle(5),                  2, False, "auch echt nicht 2-wb"),
        ("C5, k=3",            cycle(5),                  3, True,  "AT zertifiziert"),
        # K2,3 IST 2-wählbar, aber AT scheitert: deg=|E|=6 > n=5 Variablen -> Lücke!
        ("K2,3, k=2",          complete_bipartite(2, 3),  2, False, "2-wb, aber AT-LUECKE (deg>n)"),
        ("K2,4, k=2",          complete_bipartite(2, 4),  2, False, "echt nicht 2-wb (n(2)=6)"),
        # K4 ist echt NICHT 3-wählbar (chi=4) -> AT kann nicht zertifizieren, korrekt.
        ("K4, k=3",            (4, [(0,1),(0,2),(0,3),(1,2),(1,3),(2,3)]), 3, False, "echt nicht 3-wb (chi=4)"),
        ("K3,3, k=2",          complete_bipartite(3, 3),  2, False, "echt nicht 2-wb"),
    ]
    ok = 0
    for name, (n, E), k, exp, note in cases:
        cert, peak, s = at_choosable(n, E, k)
        tag = "OK" if cert == exp else "*** MISMATCH ***"
        print(f"  {name:18s} -> AT-zert={cert!s:5s} (erwartet {exp!s:5s}) "
              f"peak={peak:5d} {s*1000:6.1f}ms  {tag:4s} [{note}]")
        ok += (cert == exp)
    print(f"  {ok}/{len(cases)} korrekt")

    print("\n== Machbarkeits-Grenze: K_{m,m}, k=4 (peak terms) ==")
    for m in range(2, 9):
        n, E = complete_bipartite(m, m)
        cert, peak, s = at_choosable(n, E, 4)
        print(f"  K_{m},{m}  (n={n}, |E|={len(E)})  cert={cert!s:5s}  peak={peak:8d}  {s*1000:8.1f}ms")


if __name__ == "__main__":
    _main()

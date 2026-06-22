#!/usr/bin/env python3
"""Schnelle Regressionstests für bitset_balanced_solver_v5.

Nagelt die validierten Resultate fest (FOUND-Zertifikate + EXHAUSTED-Ausschlüsse)
und prüft, dass die cleveren Prunes keine Falsch-Ausschlüsse erzeugen (Quervergleich
mit Basis-DFS auf kleinen Fällen). Lauf:  python3 test_solver.py
"""
import bitset_balanced_solver_v5 as S


def solve(q, k, p, n, **kw):
    return S.BalancedBitsetSolver(q, k, p, n, branch_cap=0, time_limit=120,
                                  max_nodes=10_000_000, **kw).run()


def cert_ok(res):
    return S.formula_live(res.q, res.k, res.P, res.N) == 0


def main():
    # 1. bekannte Konstruktionen
    q, k, P, N = S.known_hmt4()
    assert S.formula_live(q, k, P, N) == 0, "HMT4 sollte separator-frei sein"

    # 2. FOUND-Fälle tragen ein gültiges Zertifikat
    r = solve(3, 2, 3, 3)
    assert r.status == "FOUND" and cert_ok(r), r.status            # Dreieck
    r = solve(7, 3, 7, 7)
    assert r.status == "FOUND" and cert_ok(r), r.status            # Fano

    # 3. EXHAUSTED-Ausschlüsse (volle Prunes)
    assert solve(3, 2, 2, 3).status == "EXHAUSTED"
    assert solve(7, 3, 6, 7).status == "EXHAUSTED"                 # (7,3,6,7) unmöglich

    # 4. Soundness: gleiche Ausschlüsse mit ALLEN cleveren Prunes AUS (Basis-DFS).
    #    (kleine Fälle, damit der Test schnell bleibt)
    off = dict(use_canonical_memo=False, use_gain_lb=False,
               use_transversal_prune=False, use_packing_lb=False)
    assert solve(3, 2, 2, 3, **off).status == "EXHAUSTED"
    r = solve(3, 2, 3, 3, **off)
    assert r.status == "FOUND" and cert_ok(r)
    # (7,3,6,7) prunes-off ist ~57s — als Doku in NOTES.md, hier weggelassen.

    # 5. canonical-memo-Resultat == base-DFS-Resultat auf einem nicht-trivialen Fall
    full = solve(7, 3, 5, 7)
    base = solve(7, 3, 5, 7, **off)
    assert full.status == base.status, (full.status, base.status)

    print("ALL PASS")


if __name__ == "__main__":
    main()

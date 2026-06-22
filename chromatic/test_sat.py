#!/usr/bin/env python3
"""Regression + correctness tests for the SAT backend.

Run with the venv:  ./.venv/bin/python test_sat.py
"""
import itertools
import random

from pysat.formula import IDPool
from pysat.solvers import Cadical195

import sat_backend as SB


def test_lex_encoding_exhaustive():
    """_lex_le_clauses(X, perm(X)) is SAT under a fixed X iff X <=_lex perm(X)."""
    random.seed(0)
    checks = fails = 0
    for m in range(1, 7):
        for _ in range(40):
            perm = list(range(m))
            random.shuffle(perm)
            pool = IDPool(start_from=1)
            X = [pool.id(("x", i)) for i in range(m)]
            Y = [X[perm[i]] for i in range(m)]
            cl = SB._lex_le_clauses(X, Y, pool, tag="t")
            for bits in itertools.product([0, 1], repeat=m):
                yv = [bits[perm[i]] for i in range(m)]
                want = list(bits) <= yv
                s = Cadical195(bootstrap_with=cl)
                got = bool(s.solve(assumptions=[X[i] if bits[i] else -X[i] for i in range(m)]))
                s.delete()
                checks += 1
                fails += (got != want)
    assert fails == 0, f"lex encoding bug: {fails}/{checks}"
    return checks


def test_known_cases():
    """SAT backend agrees with the known DFS results, and --sym-break preserves them."""
    cases = [(3, 2, 2, 3, "UNSAT"), (3, 2, 3, 3, "SAT"),
             (7, 3, 6, 7, "UNSAT"), (7, 3, 7, 7, "SAT")]
    for q, k, p, n, want in cases:
        for sb in (False, True):
            st, P, N, _ = SB.solve(q, k, p, n, sym_break=sb)
            assert st == want, f"({q},{k},{p},{n}) sb={sb}: {st} != {want}"
            if st == "SAT":
                assert SB.S.formula_live(q, k, P, N) == 0, "SAT cert invalid"


def main():
    c = test_lex_encoding_exhaustive()
    test_known_cases()
    print(f"ALL PASS (lex checks={c})")


if __name__ == "__main__":
    main()

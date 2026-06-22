#!/usr/bin/env python3
"""Regression tests for the odd distinct covering search."""
import math
from cover_sat import (odd_moduli, density, solve_period, solve_interval,
                       cegar_exclude, _is_unsat, _covers, _first_uncovered)


def test_odd_moduli():
    assert odd_moduli(15) == [3, 5, 7, 9, 11, 13, 15]
    assert odd_moduli(3) == [3]
    assert 1 not in odd_moduli(99) and 2 not in odd_moduli(99)


def test_density_crossover():
    # density first reaches >= 1 only when 15 is included
    assert density(odd_moduli(13)) < 1.0
    assert density(odd_moduli(15)) >= 1.0
    assert abs(density(odd_moduli(13)) - 0.95513) < 1e-4
    assert abs(density(odd_moduli(15)) - 1.02180) < 1e-4


def test_period_B15_unsat():
    # {3,5,...,15} has density > 1 but admits NO full covering.
    status, info = solve_period(15)
    assert status == "UNSAT", status
    assert info["N"] == 45045 == math.lcm(3, 5, 7, 9, 11, 13, 15)


def test_interval_excludes_small_B():
    # No odd distinct covering can even cover [0,100) for these max moduli.
    # (Kept <=21 so the suite stays fast; larger B are confirmed in NOTES.md.)
    for B in (15, 19, 21):
        status, info = solve_interval(B, 100)
        assert status == "UNSAT", (B, status)


def test_cegar_excludes_and_certifies():
    # CEGAR must reach the same exclusion as the full period for B=15, and the
    # minimised obstruction it returns must be independently uncoverable.
    status, info = cegar_exclude(15, minimize=True)
    assert status == "UNSAT", status
    assert info["n_points"] > 0
    assert _is_unsat(info["M"], info["obstruction"])        # re-verify certificate
    # and the certificate is truly minimal: dropping any point makes it coverable
    obs = info["obstruction"]
    for i in range(len(obs)):
        assert not _is_unsat(info["M"], obs[:i] + obs[i + 1:])


def test_verify_helpers():
    chosen = {3: 0, 5: 1}            # covers t with t%3==0 or t%5==1
    assert _covers(chosen, 0) and _covers(chosen, 6) and _covers(chosen, 1)
    assert not _covers(chosen, 2)    # 2%3=2, 2%5=2 -> uncovered
    assert _first_uncovered(chosen, 10) == 2


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ok  {fn.__name__}")
    print(f"{len(fns)}/{len(fns)} passed")

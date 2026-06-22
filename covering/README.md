# covering — searching for an odd distinct covering system

A SAT/MaxSAT search around a classic **open** problem of Erdős:

> **Is there a covering system of the integers whose moduli are distinct and all odd (> 1)?**

A *covering system* is a finite set of congruences `a_i (mod n_i)` such that every
integer satisfies at least one. The question asks for one in which the moduli `n_i` are
**pairwise distinct** and **all odd**. This is open (Erdős, Selfridge, Schinzel offered
prizes); only partial and computational results are known.

### A distinction worth making first

- The **disjoint / exact** version (each integer covered *exactly* once) with distinct
  moduli `> 1` is **already impossible** — by Mirsky–Newman / Davenport–Rado the largest
  modulus must repeat, so "odd" adds nothing there. Not the interesting question.
- The **open** problem is the *non-disjoint* covering above (overlaps allowed). That is
  what this code models.

This repo provides a small, **self-verifying** tool: every "covering exists" answer is
independently re-checked, and every exclusion is an exact UNSAT.

---

## The model

Fix a bound `B` and let `M = {3, 5, 7, …, B}` (all odd moduli; `1` is excluded as trivial).
Distinct moduli ⟹ each `n ∈ M` is used in **at most one** congruence, i.e. we pick one
residue `a_n ∈ [0, n)`. Adding a congruence can only cover *more* integers, so for the
**existence** question it is WLOG to use every `n ∈ M` with exactly one residue.

Boolean variables `x[n][a]` (residue of modulus `n` is `a`), with:
- **hard:** exactly one residue per modulus;
- **cover of integer `t`:** clause `OR_{n∈M} x[n][ t mod n ]` (some modulus hits `t`).

Three modes:

| mode | covers | meaning |
|------|--------|---------|
| `period` | all of `[0, N)`, `N = lcm(M)` | **exact**: SAT ⟹ a real covering system exists (max mod ≤ B); UNSAT ⟹ none does. Limited by how fast `N` grows. |
| `interval L` | `[0, L)` | cheaper **necessary** relaxation: UNSAT ⟹ exclusion (can't even cover `[0,L)`); SAT ⟹ inconclusive (reports first integer it misses). |
| `maxsat` | maximise covered residues in `[0, N)` | how far short the *best* choice falls (RC2). |

Both `period`-UNSAT and `interval`-UNSAT are valid exclusions: `[0, L) ⊂ Z`, so failing to
cover a finite window already rules out covering `Z`.

---

## Results (this tool, reproduced)

- **Density is not the obstruction.** The necessary condition `Σ 1/n ≥ 1` first holds at
  `B = 15`: `Σ_{3,5,…,13} 1/n = 0.9551 < 1`, `Σ_{3,…,15} 1/n = 1.0218 ≥ 1`. Yet:
- **`B = 15` and `B = 17`: full-period UNSAT** (definitive over the complete period
  `N = 45045` resp. `765765`, ~0.1 s / 3 s) ⟹ **no odd distinct covering with max modulus
  ≤ 17**, despite density > 1.
- **Interval `[0,100)` UNSAT for `B ≤ 25`** (≤ 100 s) ⟹ exclusion: any odd distinct
  covering must use a **modulus ≥ 27**. (An ILP reaches `B ≤ 31` ⟹ modulus ≥ 33; see
  "what doesn't help" for why plain SAT lags here.)
- **The interval relaxation breaks down for large `B`.** At `B = 41` a choice covers
  `[0,100)` (SAT) but first misses `103` in the full period — so a fixed short window stops
  being an obstruction once `B` is large enough to cover it. Longer/structured windows are
  needed.
- **Best coverage (`B = 15`):** the best possible choice covers `32805 / 45045 = 72.83 %`
  of the period — short by `12240` residues, not narrowly. (Reported value; RC2 MaxSAT
  times out at this scale here — see NOTES.)

These are honest *partial* results: they bound how small a counterexample could be, but do
**not** settle the open problem.

---

## What helps

- **Full-period SAT** gives *definitive* answers (not just necessary conditions) wherever
  `N = lcm(M)` is small enough to enumerate — clean and fast up to `B = 17`.
- **Interval UNSAT** is a cheap, valid exclusion that reaches higher `B` than the full
  period, because it avoids the `lcm` blow-up.
- **Quantifying the gap** (how badly a bound fails — the 72.83 % at `B = 15`) is more
  informative than a bare UNSAT, when a fast-enough optimiser is available.

## What does *not* help

- **Density counting.** `Σ 1/n ≥ 1` is necessary but far too weak — it holds from `B = 15`
  on, where covering is still impossible.
- **A fixed short test window.** `[0, L)` stops obstructing once `B` is large enough to
  cover those `L` points (the `B = 41` case misses only at `103`). The window must grow
  with `B`, or be chosen structurally (e.g. around CRT-aligned residues).
- **Plain SAT on the hard UNSAT instances.** Proving `[0,100)` uncoverable gets ~10× harder
  per step (`B=21`: 0.8 s, `B=23`: 9 s, `B=25`: 100 s), so this encoding stalls past
  `B = 25` where an ILP still decides `B = 31`. Better cardinality/symmetry handling (or
  MILP) is needed to push the modulus bound higher.

## Next steps

- **Lazy-constraint / growing-window search:** start from `[0, L)`, and when a model is
  found, add its first uncovered integer as a new point and re-solve — converging to a
  minimal finite obstruction set per `B` (the most promising engineering lever).
- **Stronger encoding:** sequential/totalizer at-most-one, colour/residue symmetry
  breaking, or an ILP backend to push the excluded-modulus bound past 31.
- **Full period for `B = 19`** (`N ≈ 1.45·10⁷`) to extend the definitive bound — memory-bound.
- **Structure mining:** inspect the near-optimal MaxSAT assignments for the CRT pattern of
  the uncovered residues, à la the "largest prime power" arguments, to look for a provable
  obstruction.

---

## Reproduce

```bash
python3 -m venv .venv && ./.venv/bin/pip install python-sat
./.venv/bin/python test_cover.py                          # regression suite

./.venv/bin/python cover_sat.py --B 15 --mode density     # density crossover
./.venv/bin/python cover_sat.py --B 17 --mode period      # definitive UNSAT (max mod ≤ 17)
./.venv/bin/python cover_sat.py --B 25 --mode interval --L 100   # exclusion (~100 s)
./.venv/bin/python cover_sat.py --B 41 --mode interval --L 100   # SAT, but misses 103
./.venv/bin/python cover_sat.py --B 15 --mode maxsat      # 72.83% best coverage (slow: RC2)
```

See `NOTES.md` for the full timing table and the validated assignments.

## References

- P. Erdős, *On integers of the form 2^k + p and some related problems*, 1950 (covering systems).
- R. K. Guy, *Unsolved Problems in Number Theory*, F13 / F14 (odd covering problem).
- B. Hough, *Solution of the minimum modulus problem for covering systems*, Ann. of Math. 2015.
- Mirsky–Newman / Davenport–Rado: no exact (disjoint) covering with distinct moduli > 1.

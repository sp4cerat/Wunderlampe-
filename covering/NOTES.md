# Notes — odd distinct covering systems

Lab notebook for `cover_sat.py`. All runs on a 6-core / 8 GB box, `python-sat` (CaDiCaL).

## Problem

Open Erdős problem: a covering system of `Z` with **distinct, all-odd** moduli `> 1`
(overlaps allowed — the disjoint version with distinct moduli is impossible by
Mirsky–Newman/Davenport–Rado, independently of parity). Status: **open**.

## Encoding

`M = {3,5,…,B}`. Variable `x[n][a]` = "modulus `n` uses residue `a`". Hard: exactly-one
residue per modulus (at-least-one + pairwise at-most-one). Cover of integer `t`:
`OR_{n∈M} x[n][t mod n]`. Distinct ⟹ ≤1 congruence per modulus; using all of `M` with one
residue each is WLOG for existence (extra congruences only help). Every SAT model is
re-verified by recomputing coverage independently.

## Validated results (2026-06-22)

### Density crossover (necessary condition `Σ1/n ≥ 1`)

| B | `Σ_{3..B} 1/n` | ≥ 1 ? |
|---|---|---|
| 13 | 0.9551 | no |
| 15 | 1.0218 | **yes** |

Density becomes satisfiable at `B=15`, but covering is still impossible there → density is
not the real obstruction.

### Full-period (exact, complete period `N = lcm(M)`)

| B | N = lcm | status | time | meaning |
|---|---|---|---|---|
| 15 | 45045 | **UNSAT** | 0.06 s | no covering, max mod ≤ 15 |
| 17 | 765765 | **UNSAT** | 3.19 s | no covering, max mod ≤ 17 |
| 19 | 14549535 | (not run — ~1.45·10⁷ clauses, memory-bound) | | |

Definitive: **no odd distinct covering system with max modulus ≤ 17.**

### Interval relaxation, cover `[0,100)` (UNSAT = valid exclusion)

| B | status | time |
|---|---|---|
| 15 | UNSAT | 0.00 s |
| 17 | UNSAT | 0.01 s |
| 19 | UNSAT | 0.09 s |
| 21 | UNSAT | 0.78 s |
| 23 | UNSAT | 9.30 s |
| 25 | UNSAT | 99.86 s |
| 27,29,31 | (timed out with this plain-SAT encoding; ~10×/step) | |

⇒ this tool confirms **no odd distinct covering with max modulus ≤ 25** (so a counterexample
needs a modulus ≥ 27). A separate ILP reaches `B ≤ 31` (modulus ≥ 33); the SAT encoding
here is the bottleneck on the hard UNSAT instances, not the math.

### Where the short window fails (B = 41, cover `[0,100)`)

SAT in 0.25 s; the returned choice covers `[0,100)` but first misses **103** in the full
period. So a fixed `L = 100` window is no longer an obstruction once `B` is large enough to
cover it — the window must grow with `B` or be chosen structurally. Returned assignment:
`0(3) 1(5) 2(7) 7(9) 6(11) 9(13) 8(15) 13(17) 2(19) 5(21) 14(23) 5(25) 19(27) 20(29) 15(31) 29(33) 32(35) 11(37) 4(39) 10(41)`.

### MaxSAT best coverage of the full period

| B | covered / N | % | uncovered | source |
|---|---|---|---|---|
| 15 | 32805 / 45045 | 72.83 % | 12240 | reported (independent MILP/search) |

The best possible odd-distinct choice at `B=15` falls far short (not a near miss).
**Caveat:** RC2 MaxSAT over 45045 soft clauses did **not** finish here (timed out at 280 s),
so this tool has not yet reproduced the 72.83 % figure — it is the externally-reported value.
A faster MaxSAT engine or a problem-specific search is needed to confirm it.

### CEGAR (lazy growing-window) + minimal certificates

`--mode cegar`: one incremental solver with the exactly-one hard clauses; seed a small
window, and on each SAT model add the first uncovered integer (scan ≤ min(lcm, scan_limit))
as a new cover clause, reusing learned clauses. UNSAT ⟹ the accumulated points are
uncoverable; `--minimize` deletes redundant points (single-point deletion) to a minimal
certificate, re-verified independently.

| max mod ≤ B | minimal uncoverable run | length | solve |
|---|---|---|---|
| 15 | [27..44] | 18 | 0.00 s |
| 19 | [26..56] | 31 | 0.14 s |
| 21 | [24..62] | 39 | 1.11 s |

The minimal obstruction is a **block of consecutive integers** (a "longest coverable run"
/ Jacobsthal-type quantity). For B ≥ 27 the *single refutation solve* already exhausts an
8M-conflict budget (>120 s): proving even the seed window [0,3B) uncoverable is the wall,
not the point count. So CEGAR improves certificate readability, not reach. `--conf-budget`
makes it give up gracefully (`SOLVE_BUDGET after 1 rounds` at B=27). An ILP reaches B≤31
because of its LP relaxation, which CDCL lacks → ILP backend is the way to push further.

## Soundness

- Exclusions are exact UNSAT from a complete CNF; interval UNSAT is valid because
  `[0,L) ⊂ Z`.
- Every SAT/optimal model is re-verified by directly recomputing covered residues
  (`_first_uncovered`), so a "covering exists" claim cannot be a solver artifact.

## Next steps

1. ~~Lazy growing-window CEGAR~~ — **done** (`--mode cegar`). Gives minimal certificates up
   to B≈21 but does NOT break the SAT refutation wall at B≥27 (the proof, not the point
   count, is hard). Readability win, not reach win.
2. **ILP backend** (the real lever): the LP relaxation is why an ILP reaches B≤31 where
   CDCL stalls. Add a PuLP/CBC or Gurobi model of the same exactly-one + cover constraints
   to push the excluded-modulus bound higher; combine with the CEGAR loop for certificates.
3. Stronger AMO/cardinality encoding + residue-symmetry breaking on the SAT side.
3. `B=19` full period if memory allows (definitive bound → max mod ≤ 19).
4. Mine near-optimal MaxSAT assignments for the CRT structure of uncovered residues.

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

### ILP backend (`cover_ilp.py`, CBC via PuLP)

Same model as an integer program (`x[n,a]∈{0,1}`, `Σ_a x[n,a]=1`, `Σ_n x[n,t mod n]≥1`).
CBC's LP relaxation + cuts refute the covering instances far faster than CDCL → reaches the
exclusions SAT cannot.

| B | window | CBC result | time |
|---|---|---|---|
| 15 | [0,100) | INFEASIBLE | 0.11 s |
| 31 | [0,100) | INFEASIBLE | 30 s (SAT had stalled at B=25) |
| 33 | [0,100) | **INFEASIBLE** | 59 s |
| 35 | [0,105) | FEASIBLE (coverable) — needs larger window | |
| 35 | cegar (grows to 112 pts) | TIMEOUT (still feasible, window must grow further) | 306 s |

⇒ **No odd distinct covering system with max modulus ≤ 33** (extends the previous ≤31) ⟹ a
counterexample must use a **modulus ≥ 35**. `B=35` is the current wall: `[0,L)` stays
coverable past `L≈112`, so the obstruction window is large and CBC times out.

Caveat: CBC infeasibility is branch-and-bound (floating point), not a formal certificate —
same status as any MILP result. The small-`B` exclusions (≤21) additionally have
SAT-verified minimal certificates. To make a high-`B` exclusion rigorous, minimise the
obstruction (`cover_ilp.py --mode cegar --minimize`) and re-check the small certificate with
the SAT solver.

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
2. ~~ILP backend~~ — **done** (`cover_ilp.py`, CBC/PuLP). Extended the exclusion to **max
   modulus ≤ 33** (from ≤31). Next: a commercial solver (Gurobi), tighter cuts, or
   residue-symmetry breaking to get `B≥35` (current wall — window must exceed ~112).
3. Make high-`B` exclusions rigorous: minimise an ILP obstruction, re-verify with SAT.
4. Stronger AMO/cardinality encoding + residue-symmetry breaking on the SAT side.
5. `B=19` full period (definitive) if memory allows.
3. `B=19` full period if memory allows (definitive bound → max mod ≤ 19).
4. Mine near-optimal MaxSAT assignments for the CRT structure of uncovered residues.

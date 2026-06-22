# chromatic — searching for small non-choosable bipartite graphs

An exact + SAT-based search around **Erdős–Rubin–Taylor problem #629**:

> Determine `n(k)`, the **minimum number of vertices** of a *bipartite* graph `G`
> with list-chromatic number `χ_L(G) > k`.

Known values: `n(2) = 6`, `n(3) = 14` (Hanson–MacGillivray–Toft 1996).
**`n(4)` is open**, with `23 ≤ n(4) ≤ 40`; the upper bound 40 comes from the "HMT4"
construction, which is reproduced and verified in this repo.

The point of this repository is twofold:

1. a **self-verifying** toolchain (every construction it finds carries an independently
   re-checkable certificate `formula_live == 0`), and
2. an **honest map of what helps and what doesn't** for attacking `n(4)` — so anyone
   with more compute or a better idea can pick up where this leaves off.

---

## The encoding (why this is a 2-colouring / property-B search)

We search for a **separator-free pair** `(P, N)` of `k`-element subsets ("clauses") over
a colour ground set `[q]`:

- A 2-colouring is a set `S ⊆ [q]` (colour-1 = `S`, colour-2 = its complement).
- A *positive* clause `P_T` kills `S` iff `S ∩ T = ∅` (i.e. `T` is all colour-2).
- A *negative* clause `N_T` kills `S` iff `T ⊆ S`   (i.e. `T` is all colour-1).
- `live` = the set of colourings not killed by any clause.
- **`live = ∅` (separator-free) ⇔ no proper 2-colouring exists ⇔ `χ ≥ 3`.**

So a separator-free `(P, N)` is a signed non-2-colourable family (property B). The
**total number of clauses `|P| + |N|` equals the bipartite vertex count `n(k)`** in the
standard reduction, which is exactly the quantity ERT #629 asks us to minimise.

**Exactness contract:**
- `branch_cap = 0` **and** `EXHAUSTED` ⇒ a genuine impossibility proof under the budgets.
- `FOUND` always carries a certificate, re-verified independently (`formula_live == 0`).
- A SAT `UNSAT` is an exact exclusion; a SAT model is a verified construction.

---

## What's in here

| File | Role |
|------|------|
| `bitset_balanced_solver_v5.py` | Exact DFS solver (bitset live sets, packing/transversal/canonical prunes). Best on the **small-case ladder**; cannot finish `q = 11`. |
| `sat_backend.py` | CNF encoding solved with CaDiCaL/Glucose (`python-sat`). The workhorse for `q = 11`. Lex-leader colour-symmetry breaking (unit-proven). |
| `alon_tarsi.py` | Alon–Tarsi / Combinatorial-Nullstellensatz choosability *certifier* (see "what doesn't help"). |
| `race.sh`, `race_p9.sh`, `search_record.sh` | tmux-friendly portfolio runners (multiple solver/encoding configs race one instance). |
| `test_solver.py`, `test_sat.py` | Regression tests; `test_sat.py` includes a 5040-check exhaustive proof of the lex-symmetry encoding. |
| `NOTES.md` | Detailed lab notebook: every validated result, cross-check, and timing. |

---

## Results that are solid

- **Re-derives `n(3) = 14`** exactly (`q = 7, k = 3`: all total-budget-13 splits
  `EXHAUSTED`, total 14 achieved by the Fano plane in both `P` and `N`). This is a
  *sanity check* against the published value, not a new result.
- Reproduces and verifies the **HMT4 `n(4) ≤ 40`** construction (`q = 11`, separator-free).
- New **`q = 11, k = 4` budget exclusions** via SAT: with `|A| + |C| = 39` and `|A| ≤ |C|`,
  the cases `|A| ∈ {5, 6, 7, 8, 9}` are `UNSAT` (shrinking the open balance range from
  `[5,19]` to `[10,19]`). **Caveat below — these are *not* a bound on `n(4)`.**
- The exact DFS impossibilities were cross-checked with **all clever prunes disabled**
  (plain complete set-cover DFS) and agreed — so the prune stack does not over-prune.

### The honest novelty caveat

Our "total clauses" `= n(k)`. The `q = 11` exclusions are for **fixed `q = 11` and a
restricted construction family**, so they are **not** a lower bound on `n(4)`. The only
genuinely new, publishable outcome would be:

> **a separator-free construction with total `≤ 39` for *any* `q` ⇒ beats `n(4) ≤ 40`.**

A SAT witness for that is self-verifying, so there's zero false-claim risk — but the
probability is low (40 is an established record).

---

## What helps

- **SAT over DFS at `q = 11`.** CDCL learning + cardinality budgets crack instances the
  bitset DFS cannot touch (DFS `LIMIT`s on `q=11` at ~4k nodes/s; CaDiCaL decides them).
- **Lex-leader colour-symmetry breaking** (`--sym-break`): ~21× on the hardest settled
  case (`(11,4,7,32)`: 106 s → 5 s). Unit-proven sound; must *replace*, not combine with,
  the fix-first WLOG unit.
- **Solver/encoding portfolio.** `p = 9` only fell to `cadical195 + totalizer` in a 6-way
  race after `cadical + seqcounter` stalled — the right cardinality encoding mattered only
  in combination with the right solver.
- **Exact DFS prunes on the small ladder.** Packing lower bound, transversal-number prune,
  and a canonical colour-permutation memo cut `(7,3,6,7)` ~1000× vs base DFS.

## What does *not* help (ruled out, with reasons)

- **GPUs / massive thread fan-out.** CDCL is inherently sequential (clause learning is a
  dependency chain) and SIMD-hostile; "one permutation per thread" just re-enumerates the
  colour symmetry we already eliminate with one lex constraint.
- **A faster single machine.** Growth is exponential (`p=8 → p=9` ≈ 36×; `p=10` ≈ 18 h
  extrapolated). A constant-factor speedup buys ~one more budget step, not a category.
- **Blind stochastic sampling.** Random total-39 constructions leave 75–800+ colourings
  live, with no near-misses — the feasible region (if any) is not hit by Monte-Carlo.
- **QBF.** The non-`k`-choosability decision is genuinely `Σ₂ᵖ` (∃ graph+lists ∀ colourings),
  so QBF is the *correct* framework — but it is strictly harder than the SAT we're already
  stuck on, with no tooling payoff here.
- **Alon–Tarsi / Combinatorial Nullstellensatz** (`alon_tarsi.py`). Wrong tool for two
  independent reasons: **(1) direction** — it can only *certify* `k`-choosability
  (`AT(G) ≤ k ⇒ k`-choosable), never *disprove* it, and `n(4)` needs the lower-bound
  (non-choosability) side; **(2) density** — it requires average degree `≤ 2(k−1)`, so for
  `k = 4` any graph denser than `K_{6,6}` is pruned to nothing instantly. The `n(4)`-relevant
  graphs (~24–40 dense vertices) lie far past both walls. (The tester is correct and
  self-validating; it's just structurally unable to reach our regime.)

## Where the wall is (next steps)

- `q = 11, k = 4`, `|A| = 10` (`p=10, n=29`): ~18 h extrapolated single-machine — the
  current frontier. Needs either a long/distributed run or a stronger method.
- **Incremental / assumption-based SAT** reusing learned clauses across successive `p`
  (instead of solving each split cold) is the most promising engineering lever.
- **Fuller symmetry breaking** (beyond adjacent-transposition lex-leader; e.g. full
  set-stabiliser or static lex over a stronger generating set).
- **Fractional / LP-dual relaxations** are the most promising *mathematical* lever, because
  unlike Alon–Tarsi they can produce genuine **lower** bounds (the direction `n(4)` needs).
- **DRAT proof certificates** for the `UNSAT` exclusions, to make them externally checkable.
- The genuine jackpot remains: any separator-free construction with total `≤ 39`.

---

## Reproduce

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt

# exact small cases + known constructions (DFS):
./.venv/bin/python bitset_balanced_solver_v5.py --smoke-tests
./.venv/bin/python test_solver.py
./.venv/bin/python test_sat.py          # includes the 5040-check lex-encoding proof

# re-derive n(3)=14 (exact exclusion of total ≤ 13):
./.venv/bin/python bitset_balanced_solver_v5.py --q 7 --k 3 --p-budget 6 --n-budget 7 --branch-cap 0

# a new q=11 exclusion via SAT (UNSAT = exact):
./.venv/bin/python sat_backend.py --q 11 --k 4 --p-budget 8 --n-budget 31 --sym-break --time-limit 600

# Alon–Tarsi certifier self-test + feasibility frontier:
./.venv/bin/python alon_tarsi.py
```

See `NOTES.md` for the full table of results, timings, and soundness cross-checks.

## References

- P. Erdős, A. L. Rubin, H. Taylor, *Choosability in graphs*, 1979 (problem #629).
- D. Hanson, G. MacGillivray, B. Toft, *Choosability of bipartite graphs*, 1996 (`n(3) = 14`).
- N. Alon, *Combinatorial Nullstellensatz*, 1999 (the `AT(G) ≤ k` choosability criterion).

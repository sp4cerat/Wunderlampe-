# Chromatic — list-chromatic / property-B search

## Status update 2026-06-22

- **Record attack finished, negative.** Both unattended runs hit their 24 h cap:
  `search_record.sh` (`q ∈ {9..13}`, total ≤ 39) and the separate `q = 14` run found
  **no** separator-free construction with total ≤ 39. No new `n(4)` record from SAT.
- **`p = 10` run was interrupted** (last heartbeat 05:12, no `RESULT` line) → `|A| = 10`
  remains **open**, not excluded. Open balance range stays `[10, 19]`.
- **Alon–Tarsi / Combinatorial Nullstellensatz ruled out** (`alon_tarsi.py`, 8/8 self-test
  correct). It is structurally the wrong tool: (1) it only *certifies* choosability
  (`AT(G) ≤ k ⇒ k`-choosable), never disproves it, while `n(4)` needs the lower-bound side;
  (2) it requires average degree `≤ 2(k−1)`, so for `k = 4` anything denser than `K_{6,6}`
  is pruned to nothing instantly (`K_{7,7}` already fails). Measured frontier:
  `K_{6,6}` 26k terms / 76 ms, `K_{7,7}` → 0. See README "what does not help".

---
# Chromatic — list-chromatic / property-B search

Problem (Erdős–Rubin–Taylor #629): minimal vertices `n(k)` of a **bipartite**
graph `G` with list-chromatic number `χ_L(G) > k`. Known: `2^{k-1} < n(k) < k²·2^{k+2}`,
and `m(k) ≤ n(k) ≤ m(k+1)` where `m(k)` = smallest number of `k`-sets in a
`k`-uniform hypergraph that is **not 2-colourable** (no property B, χ ≥ 3).
`m(2)=3` (triangle), `m(3)=7` (Fano), `m(4)=23`.

## What the solver searches

`bitset_balanced_solver_v5.py` searches for a **separator-free pair** `(P, N)` of
`k`-sets over a colour ground set `[q]`:

- A 2-colouring is `S ⊆ [q]` (colour-1 = `S`, colour-2 = complement).
- Positive clause `P_T` kills `S` iff `S ∩ T = ∅` (T all colour-2).
- Negative clause `N_T` kills `S` iff `T ⊆ S`   (T all colour-1).
- `live` = bitset of all `S` not yet killed.
- **`live = 0` (separator-free) ⇔ no proper 2-colouring exists ⇔ χ ≥ 3.**

So a separator-free `(P,N)` is a signed/oriented non-2-colourable family; putting the
same `k`-set in both `P` and `N` forbids both monochromatic colourings.

Budgets: `|P| ≤ p_budget`, `|N| ≤ n_budget` (side-balanced search, `|A|≤|C|` symmetry).

## Exactness contract

- `branch_cap = 0` **and** `status = EXHAUSTED` ⇒ **no pair exists** under the budgets
  (a real impossibility proof).
- `branch_cap > 0` or `status = LIMIT` ⇒ heuristic/partial only.
- `FOUND` always carries a certificate: `formula_live(P,N) == 0`, re-verified independently.

## Validated results (reproduced 2026-06-21)

| q | k | p | n | status | note |
|---|---|---|---|--------|------|
| 3 | 2 | 2 | 3 | EXHAUSTED | below triangle |
| 3 | 2 | 3 | 3 | FOUND | triangle in P and N (cert ✓) |
| 7 | 3 | 6 | 7 | **EXHAUSTED** | (q,k,p,n)=(7,3,6,7) impossible |
| 7 | 3 | 7 | 7 | FOUND | Fano in P and N, 14 clauses (cert ✓) |
| 11| 4 | 20| 20| FOUND (HMT4) | known construction, sep_free ✓ |

### q=7, k=3 — minimum total clauses = 14 (new, 2026-06-21)

All splits of total budget 13 are EXHAUSTED, so **no separator-free pair at q=7,k=3
has ≤ 13 clauses**; 14 is achieved (Fano in both P and N). Min total = 14.

| split (p,n) | status | nodes (full) | cross-check (prunes off) |
|-------------|--------|--------------|--------------------------|
| 3,10 | EXHAUSTED | 1 (transv root-prune) | EXHAUSTED, 18 473 nodes ✓ |
| 4,9  | EXHAUSTED | 1 (transv root-prune) | EXHAUSTED, 159 625 nodes ✓ |
| 5,8  | EXHAUSTED | 1 126 | (full prunes) |
| 6,7  | EXHAUSTED | 4 624 | EXHAUSTED, 4.67M nodes ✓ |

The two root-pruned splits were re-verified with all clever prunes disabled, so the
transversal prune did not over-prune.

### Soundness cross-check (important)

Every EXHAUSTED above was re-run with **all clever prunes disabled**
(`--no-canonical-memo --no-gain-lb --no-transversal-prune`, i.e. base DFS + plain
`(live,budget)` memo only, which is a straightforwardly complete exact set-cover
search). Results agreed:

- `(7,3,6,7)` base DFS: EXHAUSTED, 4 670 292 nodes / ~57 s
  vs v5 full prunes: EXHAUSTED, 4 624 nodes / ~0.3 s (~1000× fewer nodes).

⇒ The pruning stack (canonical colour-permutation memo, side max-gain LB,
transversal-number prune) does **not** cause false exclusions on these cases, and
the impossibility claims are trustworthy.

## SAT backend (`sat_backend.py`, added 2026-06-21) — cracks q=11 exclusions

Method-orthogonal CNF encoding solved with CaDiCaL (`python-sat` in `.venv`):
vars `p[T],n[T]` per k-set; one cover clause per assignment `S` (must be killed);
two at-most cardinality budgets; optional WLOG unit `p[{0..k-1}]` (fix-first).
`SAT` → construction (verified `formula_live==0`); `UNSAT` → exact exclusion.

Validated identical to the DFS on all small cases (FOUND↔SAT, EXHAUSTED↔UNSAT),
with and without fix-first (so fix-first is WLOG-sound here).

**Key:** SAT difficulty scales with the *smaller* side budget, exactly the regime of
the open small-`|A|` exclusions. The DFS cannot finish q=11; CaDiCaL does:

| (q,k,p,n) total | status | solve time | verified |
|---|---|---|---|
| (11,4,4,35) | UNSAT | 0.015 s | known `|A|≤4` |
| (11,4,5,34) | **UNSAT** | 0.33 s (fix) / 6.8 s (no-fix) | **new** |
| (11,4,6,33) | **UNSAT** | 6.3 s (fix) / 70.8 s (no-fix) | **new** |
| (11,4,7,32) | **UNSAT** | 106 s (fix) | **new** (fix-first only) |

### Lex-leader colour-symmetry breaking (`--sym-break`)

Breaks the colour group `S_q` via lex-leader constraints over adjacent-transposition
generators `(c,c+1)`. **Replaces** fix-first (combining two different representative
choices can empty an orbit → false UNSAT; the code enforces SB ⇒ fix-first off).

Correctness:
- the lex-clause encoding is **exhaustively unit-proven** (`test_sat.py`: 5040 checks,
  all assignments × random permutations, SAT iff `X ≤_lex perm(X)`);
- lex-leader on generators always retains each orbit's global lex-min ⇒ sound;
- preserves SAT/UNSAT on all small cases and on the settled q=11 cases.

Speedup: `(11,4,7,32)` UNSAT **5.0 s with `--sym-break`** vs **106 s** baseline (~21×).

### q=11 exclusions with `--sym-break`

| (q,k,p,n) total=39 | status | solve time |
|---|---|---|
| (11,4,7,32) | UNSAT | 5.0 s (cadical/seqcounter) |
| (11,4,8,31) | **UNSAT** | 53 s (**new**) |
| (11,4,9,30) | **UNSAT** | 1806 s (**new**, cadical/**totalizer**, portfolio) |

`p=9` is hard for the default config but a 6-way solver/encoding **portfolio**
(`race_p9.sh`, 6 cores) cracked it: cadical195 + totalizer won at ~30 min where
cadical + seqcounter had stalled past 18 min. Cardinality encoding mattered only in
combination with the right solver — neither alone helped on the easier p=8.
Growth p=8→p=9 ≈ 36× ⇒ `p=10` ≈ ~18 h, impractical here.

Run: `./.venv/bin/python sat_backend.py --q 11 --k 4 --p-budget 8 --n-budget 31 --sym-break --time-limit 600`

## Open target

`q=11, k=4`, total budget `B=39`, normalized `|A| ≤ |C|`, `|A|+|C| = 39`.

- Previously open: `5 ≤ |A| ≤ 19`.
- **Now (SAT backend, 2026-06-21): `|A| ∈ {5,6,7,8,9}` excluded → open range is `10 ≤ |A| ≤ 19`.**
  - `|A|∈{5,6}` cross-checked baseline both with/without fix-first; `|A|=7` baseline
    (106 s) + `--sym-break` (5 s) agree; `|A|=8` `--sym-break` (53 s); `|A|=9`
    `--sym-break`+totalizer via portfolio (1806 s). Lex encoding unit-proven sound.
- `|A|=10` (`p=10,n=29`) ≈ ~18 h extrapolated — current wall. Would need a genuinely
  stronger method (incremental/assumption-based search reusing learned clauses across
  `p`, fuller symmetry breaking, or a dedicated long/distributed run).

## Reproduce

```bash
cd /root/chromatic
python3 bitset_balanced_solver_v5.py --smoke-tests          # known constructions + small cases
python3 test_solver.py                                      # regression assertions (fast)

# Exact exclusion example (full prunes):
python3 bitset_balanced_solver_v5.py --q 7 --k 3 --p-budget 6 --n-budget 7 --branch-cap 0

# Same, prunes OFF (slow, independent cross-check):
python3 bitset_balanced_solver_v5.py --q 7 --k 3 --p-budget 6 --n-budget 7 \
    --no-canonical-memo --no-gain-lb --no-transversal-prune --max-nodes 50000000 --time-limit 600
```

## Novelty reality-check (2026-06-21) — what would actually be new

Literature check: our "total clauses" = `n(k)` (the bipartite vertex count).
- `n(2)=6`, **`n(3)=14`** (Hanson–MacGillivray–Toft 1996) — our q=7,k=3,total=14 result
  just **re-derives the published `n(3)=14`** (good sanity check, not new).
- `m(4)=23` (min 4-uniform non-2-colourable, Östergård) — published exact.
- **`n(4)` is OPEN; best known upper bound `n(4) ≤ 40`, achieved by exactly the HMT4
  construction in this repo (q=11).** Lower bound weak (`> n(3)=14`).

⇒ Our q=11 budget-exclusions are NOT a bound on `n(4)` (fixed q=11, partial, a
restricted construction family). The single genuinely-new, publishable target:

> **find a separator-free construction with total ≤ 39 for ANY q ⇒ beats `n(4) ≤ 40`,
> a new record.** A SAT witness is self-verifying (`formula_live==0`) ⇒ zero
> false-claim risk. Probability low (40 is an established record) but it is the only
> real novelty path, and cheap to check.

`sat_backend.py --total-budget T` bounds `|P|+|N| ≤ T` jointly (solver picks the
split). Validated: q=7,k=3 total≤13 UNSAT / ≤14 SAT = `n(3)=14`.

### Record attack (running, `search_record.sh` + tmux `chromatic_record`)

Started 2026-06-21 05:16: `q ∈ {9,10,11,12,13}` (q=14 dropped — 688 MB RSS risked OOM
on this shared 8 GB box), each SAT-seeking `total ≤ 39`, k=4, `--sym-break --card-enc
totalizer`, 24 h cap. Any SAT = JACKPOT (new `n(4)` record). Logs:
`logs/record_k4_t39_*/main.log`.
```bash
tmux attach -t chromatic_record
tail -f /root/chromatic/logs/record_k4_t39_*/main.log
```

## Unattended runs (`race.sh` + tmux)

`race.sh <p> [n=39-p] [cap_s=86400] [heartbeat_s=120]` runs the 6-config portfolio
on `(11,4,p,n)` with `--sym-break`, first decisive config wins, persistent logs under
`logs/p<P>_<timestamp>/` with a periodic heartbeat (elapsed, alive configs, RAM).

Currently running (started 2026-06-21 05:02): **p=10** in tmux session `chromatic_p10`,
cap 24 h, heartbeat 5 min → `logs/p10_20260621_050255/main.log`.

Monitor:
```bash
tmux attach -t chromatic_p10                 # watch live (Ctrl-b d to detach)
tail -f /root/chromatic/logs/p10_*/main.log  # heartbeats + final RESULT
```
When it ends it logs `RESULT: (11,4,10,29) -> status=...` (UNSAT ⇒ `|A|=10` excluded ⇒
open range shrinks to `[11,19]`) or `NO DECISIVE RESULT within ...` if the 24 h cap hits.

## Solver pruning components

1. bitset live separators (Python int over `2^q` assignments)
2. side budgets `(|A|,|C|)`
3. `(live, p_left, n_left)` memo (sound: budgets strictly decrease ⇒ no cycle; a
   re-seen state was fully explored and not FOUND, else search would have stopped)
4. canonical colour-permutation memo (partition-refinement by invariant signatures,
   min over signature-respecting perms ⇒ isomorphic states deduped; `None`/fail-open
   when too many perms)
5. side max-gain lower bound prune
6. transversal-number prune (bounded set-cover oracle, fail-open)
7. branch ordering by small-transversal destruction then live-gain (heuristic only;
   exactness unaffected at `branch_cap=0`)
8. **packing lower bound** (added 2026-06-21): greedy maximal set `W` of live
   separators that are pairwise clause-independent (`|S1∩S2|<k` and
   `|comp(S1∪S2)|<k`); each clause kills ≤1 member, so `|W|` clauses are required.
   Prune if `|W| > p_left+n_left`. Sound (validated full==base in `test_solver.py`);
   cut `(7,3,6,7)` from 4624 → 1986 nodes (~2.3×). Toggle: `--no-packing-lb`.

## Feasibility of the q=11,k=4 target (measured 2026-06-21)

Exact exclusion of the open `q=11,k=4,B=39` balance cases is **not feasible** with
this solver. Probe `(11,4, p=5, n=34)`, fixed-positive, `branch_cap=0`, packing LB on:
LIMIT after 60 s at only 252 945 nodes (memo 250k, ~4200 nodes/s) — the tree is far
larger. Cracking q=11 would need a different engine (SAT/ILP with symmetry breaking)
or a mathematical argument, not more DFS prunes. The prunes here remain valuable for
the exact small-case ladder.

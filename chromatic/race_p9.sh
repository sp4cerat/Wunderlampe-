#!/bin/bash
# Portfolio race on a single hard instance: q=11,k=4,(p,n), --sym-break.
# 6 solver/encoding configs in parallel; first DECISIVE (UNSAT/SAT) wins, rest killed.
set -u
cd "$(dirname "$0")"
P=${1:-9}; N=${2:-$((39-P))}; CAP=${3:-2700}
PY=./.venv/bin/python
LOG=/tmp/race_p${P}; rm -rf "$LOG"; mkdir -p "$LOG"

configs=(
  "cadical195 seqcounter"
  "cadical195 totalizer"
  "cadical195 sortnetwrk"
  "glucose42 seqcounter"
  "glucose42 totalizer"
  "mergesat3 seqcounter"
)
pids=()
i=0
for c in "${configs[@]}"; do
  set -- $c
  $PY sat_backend.py --q 11 --k 4 --p-budget "$P" --n-budget "$N" \
      --sym-break --solver "$1" --card-enc "$2" > "$LOG/$i.$1.$2.log" 2>&1 &
  pids+=($!)
  i=$((i+1))
done
echo "launched ${#pids[@]} configs for (11,4,$P,$N), cap ${CAP}s"

start=$(date +%s)
winner=""
while :; do
  for f in "$LOG"/*.log; do
    if grep -qE "status=(UNSAT|SAT)" "$f" 2>/dev/null; then
      winner="$f"; break
    fi
  done
  [ -n "$winner" ] && break
  # all dead without result?
  alive=0; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
  [ "$alive" = 0 ] && break
  now=$(date +%s); [ $((now-start)) -ge "$CAP" ] && break
  sleep 3
done

for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
wait 2>/dev/null

if [ -n "$winner" ]; then
  echo "WINNER: $(basename "$winner")"
  grep -E "status|solve_s|solver" "$winner"
else
  echo "NO DECISIVE RESULT within ${CAP}s"
  for f in "$LOG"/*.log; do echo "-- $(basename "$f"):"; tail -1 "$f"; done
fi

#!/bin/bash
# Unattended portfolio race on one instance: q=11,k=4,(p,n=39-p), --sym-break.
# 6 solver/encoding configs in parallel; first DECISIVE (UNSAT/SAT) wins, rest killed.
# Persistent logs + periodic heartbeat so progress is visible while it runs for hours.
#
# Usage: ./race.sh <p> [n] [cap_seconds] [heartbeat_seconds]
set -u
cd "$(dirname "$0")"
P=${1:-10}; N=${2:-$((39-P))}; CAP=${3:-86400}; HB=${4:-120}
PY=./.venv/bin/python
TS=$(date +%Y%m%d_%H%M%S)
DIR="logs/p${P}_${TS}"
mkdir -p "$DIR"
MAIN="$DIR/main.log"

log(){ echo "[$(date '+%F %T')] $*" | tee -a "$MAIN"; }

configs=(
  "cadical195 totalizer"
  "cadical195 seqcounter"
  "cadical195 sortnetwrk"
  "glucose42 totalizer"
  "glucose42 seqcounter"
  "mergesat3 totalizer"
)

log "START race q=11 k=4 (p=$P, n=$N) total=$((P+N)) sym-break  cap=${CAP}s heartbeat=${HB}s"
log "configs: ${#configs[@]}  logdir: $DIR"

pids=(); names=()
i=0
for c in "${configs[@]}"; do
  set -- $c
  name="$1.$2"
  $PY sat_backend.py --q 11 --k 4 --p-budget "$P" --n-budget "$N" \
      --sym-break --solver "$1" --card-enc "$2" > "$DIR/$i.$name.log" 2>&1 &
  pids+=($!); names+=("$name")
  log "  launched [$i] $name pid=${pids[-1]}"
  i=$((i+1))
done

start=$(date +%s)
winner=""
last_hb=0
while :; do
  for j in "${!pids[@]}"; do
    f="$DIR/$j.${names[$j]}.log"
    if grep -qE "status=(UNSAT|SAT)" "$f" 2>/dev/null; then winner="$f"; break; fi
  done
  [ -n "$winner" ] && break

  alive=0; alivenames=""
  for j in "${!pids[@]}"; do
    if kill -0 "${pids[$j]}" 2>/dev/null; then alive=1; alivenames="$alivenames ${names[$j]}"; fi
  done
  [ "$alive" = 0 ] && break

  now=$(date +%s); el=$((now-start))
  [ "$el" -ge "$CAP" ] && break
  if [ $((now-last_hb)) -ge "$HB" ]; then
    memav=$(free -m | awk '/Mem/{print $7}')
    log "heartbeat: elapsed=${el}s alive[$alive]:$alivenames  mem_avail=${memav}MB"
    last_hb=$now
  fi
  sleep 10
done

for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
wait 2>/dev/null

if [ -n "$winner" ]; then
  log "WINNER: $(basename "$winner")"
  grep -E "status|stats" "$winner" | while read -r l; do log "  $l"; done
  log "RESULT: (11,4,$P,$N) -> $(grep -oE 'status=[A-Z]+' "$winner" | head -1)"
else
  log "NO DECISIVE RESULT within ${CAP}s"
  for j in "${!pids[@]}"; do log "  last[$j ${names[$j]}]: $(tail -1 "$DIR/$j.${names[$j]}.log")"; done
fi
log "DONE"

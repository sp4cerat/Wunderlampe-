#!/bin/bash
# Record attack on n(4): search for a separator-free construction with
# |P|+|N| <= TOTAL over a range of colour counts q. A SAT result is a construction
# with <= TOTAL vertices; TOTAL=39 would BEAT the current best known n(4) <= 40.
#
# One job per q (parallel). SAT anywhere = jackpot (logged + dumped). Every UNSAT
# means "that q cannot reach <= TOTAL". Runs unattended with heartbeat logging.
#
# Usage: ./search_record.sh "<q-list>" [total=39] [k=4] [cap_s=86400] [hb_s=300]
set -u
cd "$(dirname "$0")"
QLIST=${1:-"9 10 11 12 13 14"}
TOTAL=${2:-39}; K=${3:-4}; CAP=${4:-86400}; HB=${5:-300}
PY=./.venv/bin/python
TS=$(date +%Y%m%d_%H%M%S)
DIR="logs/record_k${K}_t${TOTAL}_${TS}"; mkdir -p "$DIR"
MAIN="$DIR/main.log"
log(){ echo "[$(date '+%F %T')] $*" | tee -a "$MAIN"; }

log "RECORD ATTACK k=$K total<=$TOTAL  (beat n(4)<=40 if k=4,total=39)  q in: $QLIST"
log "logdir: $DIR  cap=${CAP}s heartbeat=${HB}s  config: --sym-break --card-enc totalizer"

pids=(); qs=()
for q in $QLIST; do
  $PY sat_backend.py --q "$q" --k "$K" --total-budget "$TOTAL" \
      --sym-break --card-enc totalizer > "$DIR/q$q.log" 2>&1 &
  pids+=($!); qs+=("$q")
  log "  launched q=$q pid=${pids[-1]}"
done

start=$(date +%s); last_hb=0; jackpot=""
while :; do
  for j in "${!qs[@]}"; do
    f="$DIR/q${qs[$j]}.log"
    if grep -q "status=SAT" "$f" 2>/dev/null; then jackpot="${qs[$j]}"; break; fi
  done
  [ -n "$jackpot" ] && break

  alive=0; av=""
  for j in "${!pids[@]}"; do kill -0 "${pids[$j]}" 2>/dev/null && { alive=1; av="$av q${qs[$j]}"; }; done
  [ "$alive" = 0 ] && break
  now=$(date +%s); el=$((now-start)); [ "$el" -ge "$CAP" ] && break
  if [ $((now-last_hb)) -ge "$HB" ]; then
    done_lines=$(grep -l "status=" "$DIR"/q*.log 2>/dev/null | wc -l)
    log "heartbeat: elapsed=${el}s alive[$alive]:$av  finished=$done_lines/${#qs[@]}  mem_avail=$(free -m|awk '/Mem/{print $7}')MB"
    last_hb=$now
  fi
  sleep 10
done

if [ -n "$jackpot" ]; then
  log "*** JACKPOT: q=$jackpot SAT — construction with total<=$TOTAL (BEATS n(4)<=40 if k=$K,total=$TOTAL) ***"
  grep -E "status|total=|^P=|^N=|stats" "$DIR/q$jackpot.log" | while read -r l; do log "  $l"; done
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
else
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  log "no construction found within cap. per-q final status:"
  for j in "${!qs[@]}"; do log "  q=${qs[$j]}: $(grep -oE 'status=[A-Z]+' "$DIR/q${qs[$j]}.log" | head -1 || echo running/none)"; done
fi
wait 2>/dev/null
log "DONE"

#!/usr/bin/env bash
# Interactive launcher for `make start`. Press Enter through the prompts for the default
# flagship battle (GLB models · Siege · Mid · control 2 armies). Env AI0/AI1/AITURN
# override the LLM models. Frees the port first so a stale server never blocks the launch.
set -e
PORT="${1:-8321}"; SEED="${2:-42}"

# --- free the port (kill any stale server holding it) ---
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
elif command -v fuser >/dev/null 2>&1; then
  pids=$(fuser "$PORT"/tcp 2>/dev/null || true)
fi
if [ -n "${pids:-}" ]; then printf '  freeing port %s (killing %s)\n' "$PORT" "$pids"; kill -9 $pids 2>/dev/null || true; sleep 0.3; fi

printf '\n  ═══ ROME ARENA ═══\n\n'

printf '  Characters:\n'
printf '    1) GLB gladiators   (light, scales far)   [default]\n'
printf '    2) VRM avatars      (prettier, heavier — physics ragdolls)\n'
read -rp '  Characters [1-2] (1): ' c; c="${c:-1}"
[ "$c" = 2 ] && chars=vrm || chars=glb

printf '\n  Mode:\n'
printf '    1) Battle        (open field)\n'
printf '    2) Siege         (two cities, both attack)   [default]\n'
printf '    3) Invasion      (one defended city, the other rams in)\n'
printf '    4) Domination    (hold capture zones)\n'
printf '    5) Capture the Flag\n'
printf '    6) AI generals   (LLM vs LLM, auto-plays)\n'
read -rp '  Mode [1-6] (2): ' mode; mode="${mode:-2}"

printf '\n  Tier: low  mid  high  ultra  xt   (bigger = more troops)\n'
read -rp '  Tier (mid): ' tier; tier="${tier:-mid}"
case "$tier" in low) maxseat=4;; mid) maxseat=6;; high) maxseat=8;; ultra) maxseat=10;; xt) maxseat=12;; *) maxseat=6;; esac

args="--port $PORT --seed $SEED --tier $tier --chars $chars"
case "$mode" in
  1) label="Battle" ;;
  2) args="$args --fort 1"; label="Siege" ;;
  3) args="$args --invasion 1"; label="Invasion" ;;
  4) read -rp '  Add castles too? [y/N]: ' f; args="$args --dom 1"; { [ "$f" = y ] || [ "$f" = Y ]; } && args="$args --fort 1"; label="Domination" ;;
  5) args="$args --ctf 1"; label="Capture the Flag" ;;
  6) MODELS=( "groq:llama-3.3-70b-versatile" "groq:llama-3.1-8b-instant" "groq:openai/gpt-oss-120b" "groq:openai/gpt-oss-20b" )
     printf '\n  Models (2 & 4 are lighter — kinder to rate limits):\n'
     printf '    1) %s\n' "${MODELS[0]}"
     printf '    2) %s   (fast)\n' "${MODELS[1]}"
     printf '    3) %s\n' "${MODELS[2]}"
     printf '    4) %s   (fast)\n' "${MODELS[3]}"
     printf '    L) list every model your key has\n'
     read -rp '  Red general  [1-4] (1): ' r
     if [ "$r" = L ] || [ "$r" = l ]; then bun ai/models.js groq; read -rp '  Red general  [1-4] (1): ' r; fi
     read -rp '  Blue general [1-4] (4): ' b
     ai0="${MODELS[$(( ${r:-1} - 1 ))]}"; ai1="${MODELS[$(( ${b:-4} - 1 ))]}"
     read -rp '  Scenario: 1) siege  2) invasion  3) domination  4) open  (1): ' s; s="${s:-1}"
     [ "$s" = 1 ] && args="$args --fort 1"
     [ "$s" = 2 ] && args="$args --invasion 1"
     [ "$s" = 3 ] && args="$args --dom 1 --fort 1"
     args="$args --ai0 ${AI0:-$ai0} --ai1 ${AI1:-$ai1} --aiturn ${AITURN:-10} --autostart 1"
     label="AI generals" ;;
  *) echo "  unknown mode '$mode'"; exit 1 ;;
esac

# how many armies (slots) you personally command — the rest are filled by the built-in AI
if [ "$mode" != 6 ]; then
  read -rp "  Armies you control [1-$maxseat] (2): " seats; seats="${seats:-2}"
  [ "$seats" -gt "$maxseat" ] 2>/dev/null && seats="$maxseat"
  [ "$seats" -lt 1 ] 2>/dev/null && seats=1
  args="$args --seats $seats"
  seatlbl=" · you: $seats"
fi

printf '\n  ▶ %s · %s · tier %s%s   →  http://localhost:%s\n\n' "$label" "$chars" "$tier" "${seatlbl:-}" "$PORT"
exec bun server.js $args

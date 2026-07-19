#!/usr/bin/env bash
# Interactive launcher for `make start`. Just press Enter through the prompts for the
# default flagship battle (Siege, Ultra). Env AI0/AI1/AITURN override the LLM models.
set -e
PORT="${1:-8321}"; SEED="${2:-42}"

printf '\n  ═══ ROME ARENA ═══\n\n'
printf '  Mode:\n'
printf '    1) Battle        (open field)\n'
printf '    2) Siege         (two cities + castles)   [default]\n'
printf '    3) Domination    (hold capture zones)\n'
printf '    4) Capture the Flag\n'
printf '    5) AI generals   (LLM vs LLM, auto-plays)\n'
read -rp '  Mode [1-5] (2): ' mode; mode="${mode:-2}"

printf '\n  Tier: low  mid  high  ultra  xt   (bigger = more troops)\n'
read -rp '  Tier (ultra): ' tier; tier="${tier:-ultra}"

args="--port $PORT --seed $SEED --tier $tier"
case "$mode" in
  1) label="Battle" ;;
  2) args="$args --fort 1"; label="Siege" ;;
  3) read -rp '  Add castles too? [y/N]: ' f; args="$args --dom 1"; [ "$f" = y ] || [ "$f" = Y ] && args="$args --fort 1"; label="Domination" ;;
  4) args="$args --ctf 1"; label="Capture the Flag" ;;
  5) read -rp '  Scenario: 1) siege  2) domination  3) open  (1): ' s; s="${s:-1}"
     [ "$s" = 1 ] && args="$args --fort 1"
     [ "$s" = 2 ] && args="$args --dom 1 --fort 1"
     args="$args --ai0 ${AI0:-groq:llama-3.3-70b-versatile} --ai1 ${AI1:-groq:openai/gpt-oss-120b} --aiturn ${AITURN:-10} --autostart 1"
     label="AI generals" ;;
  *) echo "  unknown mode '$mode'"; exit 1 ;;
esac

printf '\n  ▶ %s · tier %s   →  http://localhost:%s\n\n' "$label" "$tier" "$PORT"
exec bun server.js $args

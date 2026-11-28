#!/bin/sh
# Convert the show sounds to AAC for the app: jr-esu-sound-profiles, the E235 clips in tools/train/local/sounds, the synth chime.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
ESU="${ESU_READY:-$ROOT/../jr-esu-sound-profiles/work/e235-0/esu_ready}"
OUT="$HERE/../public/sounds/jr"
LOK="${LOKSOUND:-$ROOT/../jr-esu-sound-profiles/work/loksound-sounds}"
LOCAL="$ROOT/tools/train/local/sounds"
E235="${E235_WORK:-$ROOT/../jr-esu-sound-profiles/work/yamanote-e235-0}"
[ -d "$ESU" ] || { echo "no sounds at $ESU (set ESU_READY)"; exit 1; }
[ -d "$LOK" ] || { echo "no sounds at $LOK (set LOKSOUND)"; exit 1; }
[ -f "$ROOT/tools/train/local/sounds/horn.wav" ] || { echo "no JR horn: run python3 tools/train/import-sounds.py first"; exit 1; }
mkdir -p "$OUT"
pack='{'
sep=''
add() {   # id, source file
  name="$(echo "$1" | tr . -).m4a"
  afconvert -f m4af -d aac -b 48000 "$2" "$OUT/$name"
  pack="$pack$sep\"$1\":{\"file\":\"$name\"}"; sep=','
  echo "  $1 <- $(basename "$2") ($(wc -c < "$OUT/$name" | tr -d ' ') bytes)"
}
rm -f "$OUT"/*.m4a
add idle.compressor "$LOK/F02-power/compressor_loop.wav"
add chime.station "$ROOT/tools/train/packs/synth/chime.wav"
add brake.departure "$LOCAL/brake_departure.wav"
add air.hiss "$E235/E235_B緩解2.wav"
add horn.depart "$LOCAL/horn.wav"
add motion.accelerate "$LOCAL/accel_e235.wav"
add motion.run "$LOCAL/run_siv.wav"
add motion.decelerate "$LOCAL/decel_e235.wav"
add brake.squeal "$LOCAL/brake_squeal.wav"
add air.dump "$E235/非常吐出弁.wav"
add brake.loosen "$LOCAL/brake_yurume.wav"
echo "$pack}" > "$OUT/pack.json"
echo "wrote $OUT ($(du -sk "$OUT" | cut -f1) KB)"

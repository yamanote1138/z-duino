#!/bin/sh
# Convert the show sounds to AAC for the app: jr-esu-sound-profiles' curated set, the JR horn and the synth chime.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
ESU="${ESU_READY:-$ROOT/../jr-esu-sound-profiles/work/e235-0/esu_ready}"
OUT="$HERE/../public/sounds/jr"
[ -d "$ESU" ] || { echo "no sounds at $ESU (set ESU_READY)"; exit 1; }
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
add idle.compressor "$ESU/compressor_loop.wav"
add melody.seseragi "$ESU/melo_seseragi.wav"
add door.close "$ESU/door_close.wav"
add door.open "$ESU/door_open.wav"
add brake.release "$ESU/brake_release.wav"
add brake.squeal "$ESU/brake_squeal.wav"
add motion.accelerate "$ESU/vvvf_acceleration.wav"
add motion.coast "$ESU/vvvf_coast.wav"
add motion.decelerate "$ESU/vvvf_deceleration.wav"
add horn.depart "$ROOT/tools/train/local/sounds/horn.wav"
add chime.station "$ROOT/tools/train/packs/synth/chime.wav"
echo "$pack}" > "$OUT/pack.json"
echo "wrote $OUT ($(du -sk "$OUT" | cut -f1) KB)"

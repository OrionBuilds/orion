#!/usr/bin/env bash
# Regenerates the installable-app icons in public/icons from the Orion OS mark (needs ImageMagick).
#   bash scripts/make-pwa-icons.sh
# any      192/512: the mark as is (rounded square, transparent corners)
# maskable 512:     full-bleed #0D0E10 with the mark at 80% so Android's circle/squircle mask never clips the ring
# apple    180:     opaque (iOS fills transparency with black and rounds the corners itself)
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=public/assets/logo/orion-os-mark.png
OUT=public/icons
BG='#0D0E10'
mkdir -p "$OUT"
magick "$SRC" -resize 192x192 "$OUT/icon-192.png"
magick "$SRC" -resize 512x512 "$OUT/icon-512.png"
magick -size 512x512 "xc:$BG" \( "$SRC" -resize 410x410 \) -gravity center -composite -depth 8 "$OUT/icon-maskable-512.png"
magick -size 180x180 "xc:$BG" \( "$SRC" -resize 180x180 \) -gravity center -composite -depth 8 "$OUT/apple-touch-icon-180.png"
magick -size 96x96 "xc:$BG" \( "$SRC" -resize 96x96 \) -gravity center -composite -depth 8 "$OUT/shortcut-96.png"
ls -l "$OUT"

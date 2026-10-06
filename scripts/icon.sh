#!/bin/sh
# Renders assets/icon/conductor.svg to the PNGs the dock installers copy.
#
# Run it after editing the SVG, and commit what it writes. The installers only copy
# files, so installing needs no renderer: this is the one step that does.
#   brew install librsvg   ·   apt install librsvg2-bin
set -eu
cd "$(dirname "$0")/../assets/icon"
command -v rsvg-convert >/dev/null || { echo 'icon.sh: needs rsvg-convert (librsvg)' >&2; exit 1; }
mkdir -p png
for n in 16 24 32 48 64 128 256 512 1024; do
  rsvg-convert -w "$n" -h "$n" conductor.svg -o "png/conductor-$n.png"
done
set -- png/*.png
echo "icon.sh: wrote $# PNGs to assets/icon/png"

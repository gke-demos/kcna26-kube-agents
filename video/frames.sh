#!/usr/bin/env bash
# Tile frames from a take into one image for review.
# Usage: frames.sh <video> <out.png> <t1> <t2> <t3> <t4>   (seconds)
set -euo pipefail
readonly WIDTH=960
video="$1" out="$2"
shift 2
[[ $# -eq 4 ]] || { echo "need four times" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
i=0
for t in "$@"; do
  ffmpeg -loglevel error -y -ss "$t" -i "$video" -frames:v 1 -vf "scale=$WIDTH:-1" "$tmp/$i.png"
  i=$((i + 1))
done
ffmpeg -loglevel error -y -i "$tmp/0.png" -i "$tmp/1.png" -i "$tmp/2.png" -i "$tmp/3.png" \
  -filter_complex "[0][1]hstack[a];[2][3]hstack[b];[a][b]vstack" "$out"
echo "$out"

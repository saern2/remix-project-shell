#!/usr/bin/env bash
#
# Settles the x264 preset question on YOUR footage and YOUR hardware.
#
#   ./scripts/preset-benchmark.sh /path/to/a/real/chunk.mp4
#
# Synthetic sources mislead here: high-frequency test patterns exaggerate the
# size difference between presets, and smooth gradients understate it. Only real
# stock footage answers the question that matters, which is whether the encode
# time a faster preset saves is more or less than the upload time its larger
# output costs.
#
# Prints encode seconds, throughput and output size for each preset, plus the
# break-even upload share — the fraction of wall-clock spent uploading above
# which the faster preset becomes a net loss.
set -euo pipefail

SOURCE="${1:-}"
THREADS="${FFMPEG_THREADS:-2}"
CRF="${CRF:-23}"

if [[ -z "$SOURCE" || ! -f "$SOURCE" ]]; then
  echo "usage: $0 <source.mp4>" >&2
  echo "Use a real rendered chunk, not a test pattern." >&2
  exit 1
fi

DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SOURCE")
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "source:   $SOURCE"
echo "duration: ${DURATION}s   threads: $THREADS   crf: $CRF"
echo

printf "%-11s %9s %9s %14s %8s\n" preset seconds xrealtime bytes vs_base
BASE_BYTES=""
BASE_SECONDS=""

for preset in veryfast superfast ultrafast; do
  OUT="$WORKDIR/$preset.mp4"
  START=$(date +%s.%N)
  ffmpeg -v error -i "$SOURCE" \
    -c:v libx264 -preset "$preset" -crf "$CRF" -threads "$THREADS" \
    -pix_fmt yuv420p -c:a copy -y "$OUT"
  END=$(date +%s.%N)

  SECONDS_TAKEN=$(echo "$END - $START" | bc)
  BYTES=$(stat -c%s "$OUT")
  XREAL=$(echo "scale=2; $DURATION / $SECONDS_TAKEN" | bc)

  if [[ -z "$BASE_BYTES" ]]; then
    BASE_BYTES=$BYTES
    BASE_SECONDS=$SECONDS_TAKEN
    RATIO="1.00"
  else
    RATIO=$(echo "scale=2; $BYTES / $BASE_BYTES" | bc)
  fi

  printf "%-11s %9.1f %8sx %14s %8s\n" "$preset" "$SECONDS_TAKEN" "$XREAL" "$BYTES" "$RATIO"

  if [[ "$preset" != "veryfast" ]]; then
    # A faster preset wins only while the extra upload time is smaller than the
    # encode time it saved. With E = encode share and U = upload share of
    # wall-clock, it wins when E*(1 - 1/speedup) > U*(sizeRatio - 1).
    SPEEDUP=$(echo "scale=4; $BASE_SECONDS / $SECONDS_TAKEN" | bc)
    echo "            speedup ${SPEEDUP}x, size ${RATIO}x -> wins only while" \
         "encodeShare*(1 - 1/${SPEEDUP}) > uploadShare*(${RATIO} - 1)"
  fi
done

echo
echo "Set FFMPEG_PRESET in the worker environment to change it. Nothing else"
echo "needs to move; stitch does not re-encode video."

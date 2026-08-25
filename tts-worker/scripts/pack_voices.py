"""Packs the raw voice .bin files into the voices.npz kokoro-onnx loads.

kokoro-onnx does np.load(voices_path) and looks voices up BY NAME
(self.voices[name]), so the five .bin files — each a raw (510, 1, 256)
float32 dump, 522,240 bytes exactly — must become one .npz keyed by voice
name. Run at image build time; refuses anything that is not exactly the
verified byte length, because a truncated or substituted voice must fail the
build loudly, not produce garbled speech in production.

Usage: python pack_voices.py <bins_dir> <out.npz>
"""

from __future__ import annotations

import glob
import os
import sys

import numpy as np

VOICE_BIN_BYTES = 522_240  # (510, 1, 256) float32 — the app pins the same number
VOICE_SHAPE = (510, 1, 256)


def main() -> None:
    bins_dir, out_path = sys.argv[1], sys.argv[2]
    bin_paths = sorted(glob.glob(os.path.join(bins_dir, "*.bin")))
    if not bin_paths:
        print(f"FATAL: no .bin voice files in {bins_dir}", file=sys.stderr)
        sys.exit(1)

    voices: dict[str, np.ndarray] = {}
    for path in bin_paths:
        name = os.path.splitext(os.path.basename(path))[0]
        size = os.path.getsize(path)
        if size != VOICE_BIN_BYTES:
            print(
                f"FATAL: {path} is {size} bytes, expected {VOICE_BIN_BYTES}",
                file=sys.stderr,
            )
            sys.exit(1)
        voices[name] = np.fromfile(path, dtype=np.float32).reshape(VOICE_SHAPE)

    np.savez(out_path, **voices)
    print(f"packed {len(voices)} voices into {out_path}: {', '.join(sorted(voices))}")


if __name__ == "__main__":
    main()

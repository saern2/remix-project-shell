"""The Item 1 benchmark: replaces the 0.383 N=2 hypothesis with a measurement.

Reports, for N=1 and N=2 concurrent jobs sharing ONE session (intra_op=1):
  - aggregate RTF (compute wall / audio seconds) — LOWER is faster
  - per-sentence times
  - total audio duration (the fixed paragraph produced 57.6 s on the VPS
    bench; a materially different number means trimming or phonemization
    diverged and must be understood before anything ships)
  - peak RSS

Run INSIDE the container so the measurement sees the real cgroup limits:

  docker compose exec tts-worker python -m scripts.benchmark
  docker compose exec tts-worker python -m scripts.benchmark --n 2
  docker compose exec tts-worker python -m scripts.benchmark --text-file /path/to/paragraph.txt

Ship with TTS_CONCURRENCY=1 regardless of what N=2 shows (operator's C1):
raising concurrency is a separate decision with its own capture.
"""

from __future__ import annotations

import argparse
import resource
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

# The default paragraph is a stand-in; pass --text-file with the operator's
# fixed benchmark paragraph to compare against the recorded 57.6 s.
DEFAULT_TEXT = (
    "The render worker on this machine is capped at six of the host's eight "
    "processors, which leaves two entirely unallocated. "
    "Speech synthesis can live in that gap without taking anything from rendering. "
    "This benchmark measures exactly how fast it runs there, on one thread, "
    "with the same model file the browser path downloads. "
    "Every number it prints is a measurement, not an estimate. "
    "If the aggregate figure for two concurrent jobs is not clearly better "
    "than one, concurrency stays at one and nothing is lost."
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=1, help="concurrent jobs sharing one session")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--text-file", default=None)
    args = parser.parse_args()

    from src.config import get_config
    from src.engine import Engine

    config = get_config()
    text = DEFAULT_TEXT
    if args.text_file:
        with open(args.text_file, encoding="utf-8") as fh:
            text = fh.read()

    # Cheap sentence split for the benchmark only — production sentences come
    # pre-split from the app and this script never feeds production.
    sentences = [s.strip() + "." for s in text.split(".") if s.strip()]

    print(f"model={config.model_path} intra_op={config.intra_op_threads} trim={config.trim}")
    print(f"sentences={len(sentences)} voice={args.voice} N={args.n}")

    engine = Engine.load(
        config.model_path, config.voices_path, config.intra_op_threads, config.trim
    )

    # Warm-up: first inference pays arena allocation; exclude it.
    engine.synthesize_sentence(sentences[0], args.voice, 0)

    per_sentence: list[list[float]] = [[] for _ in range(args.n)]
    results = [None] * args.n

    def one_job(slot: int):
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            def on_sentence(i, total, samples, _t0=[time.monotonic()]):
                now = time.monotonic()
                per_sentence[slot].append(now - _t0[0])
                _t0[0] = now

            results[slot] = engine.synthesize_to_file(
                sentences, args.voice, tmp.name, on_sentence=on_sentence
            )

    started = time.monotonic()
    with ThreadPoolExecutor(args.n) as pool:
        list(pool.map(one_job, range(args.n)))
    wall = time.monotonic() - started

    total_audio = sum(r.audio_seconds for r in results)
    peak_rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

    print(f"wall: {wall:.1f}s  audio (all jobs): {total_audio:.1f}s")
    print(f"audio per job: {results[0].audio_seconds:.1f}s  <- compare to the recorded 57.6s")
    print(f"aggregate RTF (wall / total audio): {wall / total_audio:.3f}")
    print(f"peak RSS: {peak_rss_mb:.0f} MB")
    for slot in range(args.n):
        times = ", ".join(f"{t:.2f}" for t in per_sentence[slot])
        print(f"job {slot} per-sentence seconds: {times}")


if __name__ == "__main__":
    main()

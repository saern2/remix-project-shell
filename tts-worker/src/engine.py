"""Sentence array in, audio file + per-sentence sample counts out.

THE CONTRACT. The app owns sanitisation and sentence splitting
(src/lib/tts/script-input.ts); this worker performs ZERO text transformation
on the sentences it receives. Phonemization happens here because it is part
of synthesis itself (grapheme->phoneme, exactly as kokoro-js does internally
in the browser path) — the strings the scenes are built from are the strings
spoken, byte for byte, positionally.

TRIM IS OFF BY DEFAULT, deliberately. kokoro-onnx's create(trim=True) trims
silence around each phoneme batch; kokoro-js — the browser path this must
stay reproducible against — performs NO audio trimming (verified against the
installed 1.2.1 bundle: its only `trim` calls are string trims in the
tokenizer/splitter). Sample counts are measured from the returned audio either
way, so the arithmetic contract holds under both settings — TTS_TRIM exists
so the fixed-paragraph benchmark can compare pacing, not so production drifts.

FAILURES ARE LOUD AND NAMED (Round B, Item 3 / C4):
  - a sentence whose phonemes cannot fit kokoro's 510-phoneme context in one
    batch would be SILENTLY TRUNCATED by kokoro-onnx (log-warning only, at
    _create_audio) — the silent-audio-loss class. We pre-check with kokoro's
    own tokenizer and splitter and fail the job, naming the sentence.
  - a sentence that produces zero samples fails the job, naming the sentence.
Both errors are worded for the person who will read them in the project's
failure message.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np

from .wav_writer import SAMPLE_RATE, IncrementalWavWriter

try:
    # The authority when kokoro-onnx is installed (the container always has it).
    from kokoro_onnx.config import MAX_PHONEME_LENGTH
except ImportError:  # tests without the kokoro stack
    # Verified against the 0.4.9 wheel: MAX_PHONEME_LENGTH = 510.
    MAX_PHONEME_LENGTH = 510


class SentenceFailure(Exception):
    """A worded, user-readable failure attributable to one sentence."""

    def __init__(self, message: str, sentence_index: int):
        super().__init__(message)
        self.sentence_index = sentence_index


def _preview(text: str, limit: int = 60) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


@dataclass
class SynthesisResult:
    sample_counts: list[int]
    total_samples: int

    @property
    def audio_seconds(self) -> float:
        return self.total_samples / SAMPLE_RATE


class Engine:
    """One Kokoro instance around ONE shared InferenceSession.

    Concurrency model, measured in Phase 0: onnxruntime's run() is thread-safe
    on a single session and releases the GIL during native execution
    (aggregate throughput x2.14 at two threads with intra_op=1, outputs
    byte-identical under concurrency). One 325 MB weight copy serves every
    concurrent job. The phonemizer (espeak-ng via ctypes) is NOT documented
    thread-safe, so phonemization is serialised with a lock — it is
    milliseconds per sentence against seconds of inference, so the lock costs
    nothing measurable.
    """

    def __init__(self, kokoro, trim: bool = False):
        self._kokoro = kokoro
        self._trim = trim
        self._phoneme_lock = threading.Lock()

    @classmethod
    def load(cls, model_path: str, voices_path: str, intra_op_threads: int, trim: bool):
        """Builds the real engine. EXPLICIT thread budget, never detected:
        on the production box every parallelism API (os.cpu_count,
        availableParallelism) reports the host's 8 CPUs, not the cgroup quota.
        """
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        from .adapt import Adapt

        so = ort.SessionOptions()
        so.intra_op_num_threads = intra_op_threads
        so.inter_op_num_threads = 1
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
        kokoro = Kokoro.from_session(Adapt(session), voices_path)
        return cls(kokoro, trim=trim)

    def assert_sentence_fits(self, text: str, index: int, lang: str = "en-us") -> None:
        """C4: the 510-phoneme pre-check, using kokoro's own tokenizer/splitter.

        kokoro-onnx would truncate an over-long batch with only a log warning;
        spoken audio silently missing words is the duration-mismatch class.
        A sentence long enough to trip this is a user-fixable input problem
        and must be said out loud, never quietly shortened.
        """
        with self._phoneme_lock:
            phonemes = self._kokoro.tokenizer.phonemize(text, lang)
        batches = self._kokoro._split_phonemes(phonemes)
        for batch in batches:
            if len(batch) >= MAX_PHONEME_LENGTH:
                raise SentenceFailure(
                    f'Sentence {index + 1} is too long to narrate in one breath '
                    f'("{_preview(text)}"). Please split it into shorter sentences '
                    "and try again.",
                    sentence_index=index,
                )

    def synthesize_sentence(self, text: str, voice: str, index: int) -> np.ndarray:
        """One sentence to float audio. Fails loudly on empty output."""
        self.assert_sentence_fits(text, index)
        audio, sample_rate = self._kokoro.create(text, voice=voice, trim=self._trim)
        if sample_rate != SAMPLE_RATE:
            # The whole timing contract assumes 24 kHz; a different rate would
            # silently stretch every scene boundary.
            raise SentenceFailure(
                f"The voice engine produced audio at {sample_rate} Hz instead of "
                f"{SAMPLE_RATE} Hz. This is a platform bug, not a script problem.",
                sentence_index=index,
            )
        audio = np.asarray(audio)
        if audio.size == 0:
            raise SentenceFailure(
                f'Sentence {index + 1} produced no audio ("{_preview(text)}"). '
                "Please rephrase it and try again.",
                sentence_index=index,
            )
        return audio

    def synthesize_to_file(
        self,
        sentences: list[str],
        voice: str,
        out_path: str,
        on_sentence=None,
    ) -> SynthesisResult:
        """The whole job: every sentence, in order, into one WAV.

        The writer is closed only after every sentence succeeded; on any
        failure the partial file is aborted and deleted by the caller — a
        partial narration must never be uploaded or persisted anywhere.
        """
        writer = IncrementalWavWriter(out_path)
        counts: list[int] = []
        try:
            for index, text in enumerate(sentences):
                audio = self.synthesize_sentence(text, voice, index)
                counts.append(writer.write_sentence(audio))
                if on_sentence:
                    on_sentence(index, len(sentences), counts[-1])
            total = writer.close()
        except BaseException:
            writer.abort()
            raise
        # The duration gate, same shape as wav.ts assertSampleExact: both
        # numbers derive from the same accumulator, so inequality is a bug.
        if sum(counts) != total:
            raise RuntimeError(
                f"internal: sample accumulator mismatch (sum {sum(counts)} != file {total})"
            )
        return SynthesisResult(sample_counts=counts, total_samples=total)

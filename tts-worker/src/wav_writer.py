"""The WAV contract, mirrored byte-for-byte from src/lib/tts/wav.ts.

wav.ts is the spec, not an inspiration: RIFF/WAVE, PCM, mono, 24,000 Hz,
16-bit, 44-byte header, float->int16 with asymmetric scaling (0x8000 negative,
0x7fff positive) and clamping. The verification is arithmetic, not opinion:
(fileBytes - 44) / 48000 must exactly equal the last transcript end_ms / 1000.

INCREMENTAL BY DESIGN (Round 12's lesson, applied here at birth): a 45-minute
narration is ~129.6 MB of PCM; holding it as float32 plus an int16 copy is
~390 MB of RAM for no reason. Each sentence's samples are converted and
appended to the file as they are produced, and the header — written first with
zeroed sizes — is patched on close. Peak memory is one sentence's audio.
"""

from __future__ import annotations

import struct

import numpy as np

SAMPLE_RATE = 24_000
BYTES_PER_SECOND = SAMPLE_RATE * 2  # mono 16-bit
HEADER_BYTES = 44


def float_to_int16(chunk: np.ndarray) -> np.ndarray:
    """wav.ts floatToInt16, exactly.

    Clamp to [-1, 1]; scale negatives by 0x8000 and positives by 0x7fff (the
    asymmetry is the spec's — int16's range is itself asymmetric); truncate
    toward zero, because that is what JS Int16Array assignment (ToInt16) does
    to a fractional number. np.trunc mirrors it; a bare astype would also
    truncate, but saying it explicitly is the point of a spec mirror.
    """
    s = np.clip(np.asarray(chunk, dtype=np.float32), -1.0, 1.0)
    scaled = np.where(s < 0, s * 0x8000, s * 0x7FFF)
    return np.trunc(scaled).astype(np.int16)


def build_wav_header(total_samples: int) -> bytes:
    """wav.ts buildWavHeader, exactly: 44 bytes, little-endian throughout."""
    data_bytes = total_samples * 2
    return b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + data_bytes),
            b"WAVE",
            b"fmt ",
            struct.pack("<I", 16),  # fmt chunk size
            struct.pack("<H", 1),  # PCM
            struct.pack("<H", 1),  # mono
            struct.pack("<I", SAMPLE_RATE),
            struct.pack("<I", BYTES_PER_SECOND),
            struct.pack("<H", 2),  # block align
            struct.pack("<H", 16),  # bits per sample
            b"data",
            struct.pack("<I", data_bytes),
        ]
    )


class IncrementalWavWriter:
    """Streams int16 PCM to disk sentence by sentence; header patched on close.

    The placeholder header keeps the file recognisably a WAV at every moment,
    but the file is not the deliverable until close() has run — the upload step
    must never read a file whose writer has not closed, and the caller enforces
    that ordering (synthesis completes fully before the PUT begins; a partial
    file never leaves the container).
    """

    def __init__(self, path: str):
        self._path = path
        self._file = open(path, "wb")
        self._file.write(build_wav_header(0))
        self.total_samples = 0
        self._closed = False

    def write_sentence(self, chunk: np.ndarray) -> int:
        """Appends one sentence's float audio as int16; returns its sample count."""
        if self._closed:
            raise RuntimeError("writer is closed")
        pcm = float_to_int16(chunk)
        self._file.write(pcm.tobytes())
        self.total_samples += int(pcm.shape[0])
        return int(pcm.shape[0])

    def close(self) -> int:
        """Patches the RIFF sizes and returns the total sample count."""
        if self._closed:
            return self.total_samples
        self._file.flush()
        self._file.seek(0)
        self._file.write(build_wav_header(self.total_samples))
        self._file.close()
        self._closed = True
        return self.total_samples

    def abort(self) -> None:
        """Closes the handle without blessing the file. Callers delete it."""
        if not self._closed:
            self._file.close()
            self._closed = True

"""The WAV contract, held byte-for-byte against src/lib/tts/wav.ts.

wav.ts is the spec. These tests pin the header layout field by field, the
asymmetric float->int16 scaling with JS ToInt16 truncation semantics, and the
arithmetic check the whole round is verified by:
(fileBytes - 44) / 48000 == totalSamples / 24000.
"""

import os
import struct
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.wav_writer import (  # noqa: E402
    HEADER_BYTES,
    SAMPLE_RATE,
    IncrementalWavWriter,
    build_wav_header,
    float_to_int16,
)


class TestFloatToInt16:
    def test_asymmetric_scaling_matches_wav_ts(self):
        # wav.ts: s < 0 ? s * 0x8000 : s * 0x7fff
        out = float_to_int16(np.array([-1.0, 1.0, 0.0], dtype=np.float32))
        assert out.tolist() == [-32768, 32767, 0]

    def test_clamps_out_of_range(self):
        out = float_to_int16(np.array([-2.5, 2.5], dtype=np.float32))
        assert out.tolist() == [-32768, 32767]

    def test_truncates_toward_zero_like_js_toint16(self):
        # JS: Int16Array assignment truncates the fraction toward zero.
        # 0.5 * 0x7fff = 16383.5 -> 16383 ; -0.5 * 0x8000 = -16384.0 -> -16384
        out = float_to_int16(np.array([0.5, -0.5], dtype=np.float32))
        assert out.tolist() == [16383, -16384]

    def test_dtype_is_int16(self):
        assert float_to_int16(np.zeros(4, dtype=np.float32)).dtype == np.int16


class TestHeader:
    def test_44_bytes_field_by_field(self):
        total_samples = 12345
        header = build_wav_header(total_samples)
        data_bytes = total_samples * 2
        assert len(header) == HEADER_BYTES == 44
        assert header[0:4] == b"RIFF"
        assert struct.unpack("<I", header[4:8])[0] == 36 + data_bytes
        assert header[8:12] == b"WAVE"
        assert header[12:16] == b"fmt "
        assert struct.unpack("<I", header[16:20])[0] == 16
        assert struct.unpack("<H", header[20:22])[0] == 1  # PCM
        assert struct.unpack("<H", header[22:24])[0] == 1  # mono
        assert struct.unpack("<I", header[24:28])[0] == SAMPLE_RATE == 24_000
        assert struct.unpack("<I", header[28:32])[0] == SAMPLE_RATE * 2
        assert struct.unpack("<H", header[32:34])[0] == 2  # block align
        assert struct.unpack("<H", header[34:36])[0] == 16  # bits
        assert header[36:40] == b"data"
        assert struct.unpack("<I", header[40:44])[0] == data_bytes


class TestIncrementalWriter:
    def test_the_arithmetic_check_holds_exactly(self, tmp_path):
        # The round's verification is arithmetic, not opinion:
        # (fileBytes - 44) / 48000 == totalSamples / 24000, exactly.
        path = str(tmp_path / "out.wav")
        writer = IncrementalWavWriter(path)
        rng = np.random.default_rng(3)
        counts = []
        for n in (24_000, 1, 7_777, 240_000):
            counts.append(writer.write_sentence(rng.uniform(-1, 1, n).astype(np.float32)))
        total = writer.close()

        assert counts == [24_000, 1, 7_777, 240_000]
        assert total == sum(counts)
        file_bytes = os.path.getsize(path)
        assert (file_bytes - 44) / 48_000 == total / 24_000

    def test_header_is_patched_on_close(self, tmp_path):
        path = str(tmp_path / "out.wav")
        writer = IncrementalWavWriter(path)
        writer.write_sentence(np.zeros(1000, dtype=np.float32))
        writer.close()
        with open(path, "rb") as fh:
            header = fh.read(44)
        assert struct.unpack("<I", header[40:44])[0] == 2000
        assert struct.unpack("<I", header[4:8])[0] == 36 + 2000

    def test_file_bytes_are_the_int16_conversion_of_the_input(self, tmp_path):
        path = str(tmp_path / "out.wav")
        chunk = np.array([0.25, -0.25, 1.0, -1.0], dtype=np.float32)
        writer = IncrementalWavWriter(path)
        writer.write_sentence(chunk)
        writer.close()
        with open(path, "rb") as fh:
            fh.seek(44)
            pcm = np.frombuffer(fh.read(), dtype="<i2")
        assert pcm.tolist() == float_to_int16(chunk).tolist()

    def test_write_after_close_refuses(self, tmp_path):
        writer = IncrementalWavWriter(str(tmp_path / "out.wav"))
        writer.close()
        with pytest.raises(RuntimeError):
            writer.write_sentence(np.zeros(10, dtype=np.float32))

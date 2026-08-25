"""Engine contract and failure honesty (Item 3), against fakes.

The real model cannot run here; what CAN be pinned without it is everything
the app relies on: positional sample counts, the loud failure for a
zero-sample sentence, the C4 hard failure for a sentence past kokoro's
510-phoneme context (which kokoro-onnx would silently truncate), the
never-upload-a-partial rule, and the job payload validation.
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.engine import Engine, SentenceFailure  # noqa: E402
from src.jobs import validate_job_payload  # noqa: E402
from src.uploader import UploadFailure, upload_wav  # noqa: E402
from src.wav_writer import SAMPLE_RATE  # noqa: E402


class FakeKokoro:
    """Deterministic stand-in: sentence i yields (i+1)*100 samples."""

    def __init__(self, zero_at=None, sample_rate=SAMPLE_RATE):
        self.zero_at = zero_at
        self.sample_rate = sample_rate
        self.created = []

    class _Tok:
        def phonemize(self, text, lang):
            return text  # 1 char = 1 phoneme, close enough for length tests

    tokenizer = _Tok()

    def _split_phonemes(self, phonemes):
        # Mirror kokoro's contract: batches under MAX_PHONEME_LENGTH, except
        # an unsplittable run stays whole — which is the C4 case.
        return [phonemes]

    def create(self, text, voice, trim):
        index = len(self.created)
        self.created.append((text, voice, trim))
        if self.zero_at is not None and index == self.zero_at:
            return np.zeros(0, dtype=np.float32), self.sample_rate
        n = (index + 1) * 100
        return np.linspace(-0.5, 0.5, n, dtype=np.float32), self.sample_rate


class TestSampleCounts:
    def test_counts_are_positional_one_per_sentence(self, tmp_path):
        engine = Engine(FakeKokoro())
        result = engine.synthesize_to_file(
            ["One.", "Two.", "Three."], "af_heart", str(tmp_path / "o.wav")
        )
        assert result.sample_counts == [100, 200, 300]
        assert result.total_samples == 600
        assert result.audio_seconds == 600 / SAMPLE_RATE

    def test_file_bytes_match_the_counts_exactly(self, tmp_path):
        path = str(tmp_path / "o.wav")
        engine = Engine(FakeKokoro())
        result = engine.synthesize_to_file(["A.", "B."], "af_heart", path)
        assert os.path.getsize(path) == 44 + result.total_samples * 2

    def test_trim_flag_reaches_kokoro(self, tmp_path):
        fake = FakeKokoro()
        Engine(fake, trim=False).synthesize_to_file(["A."], "af_heart", str(tmp_path / "a.wav"))
        assert fake.created[0][2] is False  # matches kokoro-js: no audio trimming


class TestFailureHonesty:
    def test_zero_samples_fails_loudly_naming_the_sentence(self, tmp_path):
        engine = Engine(FakeKokoro(zero_at=1))
        with pytest.raises(SentenceFailure) as err:
            engine.synthesize_to_file(
                ["Fine.", "Broken.", "Never reached."], "af_heart", str(tmp_path / "o.wav")
            )
        assert err.value.sentence_index == 1
        assert "Sentence 2" in str(err.value)
        assert "no audio" in str(err.value)

    def test_wrong_sample_rate_is_a_platform_bug_not_a_script_problem(self, tmp_path):
        engine = Engine(FakeKokoro(sample_rate=22_050))
        with pytest.raises(SentenceFailure) as err:
            engine.synthesize_to_file(["A."], "af_heart", str(tmp_path / "o.wav"))
        assert "platform bug" in str(err.value)

    def test_c4_overlong_sentence_fails_instead_of_silent_truncation(self, tmp_path):
        # kokoro-onnx would truncate a 510+ phoneme batch with only a log
        # warning (verified at source, _create_audio). Here it is a worded
        # hard failure naming the sentence.
        engine = Engine(FakeKokoro())
        long_sentence = "word " * 200  # 1000 chars -> 1000 fake phonemes
        with pytest.raises(SentenceFailure) as err:
            engine.synthesize_to_file(
                ["Fine.", long_sentence], "af_heart", str(tmp_path / "o.wav")
            )
        assert err.value.sentence_index == 1
        assert "too long" in str(err.value)
        assert "split it into shorter sentences" in str(err.value)

    def test_no_partial_file_survives_a_failure(self, tmp_path):
        # The writer aborts and the engine re-raises; jobs.py deletes the tmp
        # file in a finally. Here: the aborted file is never blessed with a
        # patched header (its declared data size stays 0).
        path = str(tmp_path / "o.wav")
        engine = Engine(FakeKokoro(zero_at=1))
        with pytest.raises(SentenceFailure):
            engine.synthesize_to_file(["Fine.", "Broken."], "af_heart", path)
        with open(path, "rb") as fh:
            header = fh.read(44)
        import struct

        assert struct.unpack("<I", header[40:44])[0] == 0  # unblessed


class TestUploader:
    class _Resp:
        def __init__(self, status, text=""):
            self.status_code = status
            self.text = text

    def test_streams_the_file_object_not_the_bytes(self, tmp_path):
        # Round 12's rule: the body must be the file object (streamed), never
        # a read()-out byte blob.
        path = str(tmp_path / "a.wav")
        with open(path, "wb") as fh:
            fh.write(b"x" * 1000)
        seen = {}

        def fake_put(url, data=None, headers=None, timeout=None):
            seen["is_file"] = hasattr(data, "read")
            seen["length"] = headers["Content-Length"]
            return TestUploader._Resp(200)

        sent = upload_wav(path, "https://x/signed", put=fake_put)
        assert sent == 1000
        assert seen["is_file"] is True
        assert seen["length"] == "1000"

    def test_non_2xx_is_a_worded_failure(self, tmp_path):
        path = str(tmp_path / "a.wav")
        with open(path, "wb") as fh:
            fh.write(b"x")
        with pytest.raises(UploadFailure) as err:
            upload_wav(path, "https://x/signed", put=lambda *a, **k: TestUploader._Resp(403, "denied"))
        assert "could not be saved" in str(err.value)
        assert "403" in str(err.value)


class TestJobValidation:
    VOICES = ["af_heart", "bf_emma"]

    def good(self):
        return {
            "job_id": "tts-abc",
            "sentences": ["One.", "Two."],
            "voice": "af_heart",
            "upload_url": "https://x.supabase.co/storage/v1/object/upload/sign/audio/p/f.wav",
            "full_text": "One. Two.",
        }

    def test_accepts_the_contract_shape(self):
        out = validate_job_payload(self.good(), self.VOICES)
        assert out["job_id"] == "tts-abc"
        assert out["sentences"] == ["One.", "Two."]

    @pytest.mark.parametrize(
        "mutate,fragment",
        [
            (lambda d: d.pop("job_id"), "job_id"),
            (lambda d: d.update(sentences=[]), "non-empty"),
            (lambda d: d.update(sentences=["ok", ""]), "non-empty string"),
            (lambda d: d.update(sentences="not a list"), "array"),
            (lambda d: d.update(voice="unknown_voice"), "voice must be one of"),
            (lambda d: d.update(upload_url="http://insecure"), "https"),
            (lambda d: d.update(full_text="  "), "full_text"),
        ],
    )
    def test_refuses_malformed_payloads_with_named_reasons(self, mutate, fragment):
        data = self.good()
        mutate(data)
        with pytest.raises(ValueError) as err:
            validate_job_payload(data, self.VOICES)
        assert fragment in str(err.value)

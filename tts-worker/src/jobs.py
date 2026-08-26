"""The 'tts' BullMQ queue and its processor.

QUEUE ISOLATION (Round B, V4): everything this module writes lives under
bull:tts:* — disjoint from bull:render*, admission:*, render:* and cancel:*.
admissionControl.js reads only its own keys and its own queue names; it
structurally cannot observe this queue. Retention bounds (removeOnComplete /
removeOnFail) are mandatory because the shared Redis runs noeviction.

THE PROCESSOR IS A PURE FUNCTION AROUND FILES: sentences in, one WAV out via
a temp file that is deleted whether the job succeeds or fails. Nothing
partial ever leaves the container — the PUT happens only after every sentence
has rendered and the writer has closed. The job's return value carries the
per-sentence sample counts; the app reconstructs boundaries from them with
the same integer-sample arithmetic the browser path uses.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

from .config import get_config
from .engine import Engine, SentenceFailure
from .uploader import UploadFailure, upload_wav

log = logging.getLogger("tts-worker")


def job_options(config) -> dict:
    return {
        "attempts": config.job_attempts,
        "backoff": {"type": "exponential", "delay": config.job_backoff_ms},
        "removeOnComplete": config.remove_on_complete,
        "removeOnFail": config.remove_on_fail,
    }


def validate_job_payload(data: object, known_voices: list[str]) -> dict:
    """Everything the processor will trust, checked at the door.

    Returns {job_id, sentences, voice, upload_url} or raises ValueError with
    a message safe to return to the (authenticated) app caller.
    """
    if not isinstance(data, dict):
        raise ValueError("payload must be a JSON object")
    job_id = data.get("job_id")
    if not isinstance(job_id, str) or not job_id.strip():
        raise ValueError("job_id is required")
    sentences = data.get("sentences")
    if not isinstance(sentences, list) or not sentences:
        raise ValueError("sentences must be a non-empty array")
    if not all(isinstance(s, str) and s.strip() for s in sentences):
        raise ValueError("every sentence must be a non-empty string")
    voice = data.get("voice")
    if not isinstance(voice, str) or voice not in known_voices:
        raise ValueError(f"voice must be one of: {', '.join(known_voices)}")
    upload_url = data.get("upload_url")
    if not isinstance(upload_url, str) or not upload_url.startswith("https://"):
        raise ValueError("upload_url must be an https URL")
    # Carried, never spoken from: the original script text rides the job so
    # the completion handoff can persist the transcript from a fresh tab.
    # Synthesis reads ONLY the sentences array.
    full_text = data.get("full_text")
    if not isinstance(full_text, str) or not full_text.strip():
        raise ValueError("full_text is required")
    return {
        "job_id": job_id.strip(),
        "sentences": sentences,
        "voice": voice,
        "upload_url": upload_url,
        "full_text": full_text,
    }


class Processor:
    """Wraps the engine for BullMQ: async at the surface, threaded inside.

    Synthesis is CPU-bound native code that releases the GIL (measured in
    Phase 0), so it runs in a thread pool sized to TTS_CONCURRENCY while the
    asyncio loop keeps serving /health and job polls. Progress updates hop
    back to the loop fire-and-forget — progress must never fail a job.
    """

    def __init__(self, engine: Engine, config=None):
        self.engine = engine
        self.config = config or get_config()
        self._pool = ThreadPoolExecutor(max_workers=self.config.concurrency)
        os.makedirs(self.config.tmp_dir, exist_ok=True)

    async def process(self, job, _token=None):
        data = job.data
        sentences = data["sentences"]
        voice = data["voice"]
        upload_url = data["upload_url"]
        loop = asyncio.get_running_loop()

        def report_progress(index: int, total: int, _samples: int) -> None:
            pct = round(((index + 1) / total) * 100)
            asyncio.run_coroutine_threadsafe(
                self._safe_progress(job, pct), loop
            )

        out_path = os.path.join(self.config.tmp_dir, f"{uuid.uuid4()}.wav")

        def run_sync():
            try:
                result = self.engine.synthesize_to_file(
                    sentences, voice, out_path, on_sentence=report_progress
                )
                wav_bytes = upload_wav(out_path, upload_url)
                return {
                    "sample_counts": result.sample_counts,
                    "audio_seconds": result.audio_seconds,
                    "wav_bytes": wav_bytes,
                }
            finally:
                # Success or failure, the temp file never outlives the job —
                # partial narrations must not accumulate on disk either.
                try:
                    os.unlink(out_path)
                except FileNotFoundError:
                    pass

        try:
            return await loop.run_in_executor(self._pool, run_sync)
        except (SentenceFailure, UploadFailure):
            # Already worded for the person who will read the project failure.
            raise
        except Exception as err:
            log.exception("tts job failed unexpectedly: %s", job.id)
            raise RuntimeError(
                "The narration could not be generated. Please try again. "
                f"(internal: {type(err).__name__}: {err})"
            ) from err

    @staticmethod
    async def _safe_progress(job, pct: int) -> None:
        try:
            await job.updateProgress(pct)
        except Exception:  # noqa: BLE001 — progress is advisory, never fatal
            pass

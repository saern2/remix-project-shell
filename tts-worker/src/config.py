"""All configuration from environment variables — the render worker's rule,
kept: import this module, never read os.environ elsewhere.

EXPLICIT LIMITS, NEVER DETECTED (Round B, V6/C1). On this box every
parallelism API — os.cpu_count(), os.sched_getaffinity, Node's
availableParallelism — reports the host's 8 CPUs, not the container's cgroup
quota (cgroup v1 cfs quota is invisible to all of them; proven by Round A's
startup log reading osCpus: 8 beside cgroupQuotaCpus: 6). Auto-detection here
would size the TTS threadpool off a number that is wrong by design. So:
intra-op threads and job concurrency are explicit env values, and the first
deployment runs cpus: 1.0 / TTS_CONCURRENCY=1 (C1) — the box sat near-100%
CPU on 22 August and was throttled by the host; the budget widens only after
a real duty cycle has been observed.
"""

from __future__ import annotations

import os


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    if raw == "":
        return default
    try:
        return int(raw, 10)
    except ValueError as err:
        raise RuntimeError(f"{name} must be an integer, got: {raw!r}") from err


def bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "")
    if raw == "":
        return default
    return raw not in ("0", "false", "no")


class Config:
    def __init__(self) -> None:
        self.port = int_env("PORT", 3002)
        self.api_key = require_env("TTS_WORKER_API_KEY")
        self.redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")

        # C1: 1 job at a time, 1 intra-op thread, first deployment. Both are
        # env-changeable without a rebuild; raising either is a separate
        # decision with its own capture (Item 1's amended signal).
        self.concurrency = int_env("TTS_CONCURRENCY", 1)
        self.intra_op_threads = int_env("TTS_INTRA_OP_THREADS", 1)

        # trim=False matches kokoro-js (the browser path trims no audio);
        # see engine.py for the verification.
        self.trim = bool_env("TTS_TRIM", False)

        self.model_path = os.environ.get("TTS_MODEL_PATH", "/app/models/model.onnx")
        self.voices_path = os.environ.get("TTS_VOICES_PATH", "/app/models/voices.npz")
        self.tmp_dir = os.environ.get("TTS_TMP_DIR", "/tmp/tts-tmp")

        # BullMQ 'tts' queue: keys live under bull:tts:*, disjoint from every
        # render namespace (bull:render*, admission:*, render:*, cancel:*).
        self.queue_name = "tts"
        self.job_attempts = int_env("TTS_JOB_ATTEMPTS", 2)
        self.job_backoff_ms = int_env("TTS_JOB_BACKOFF_MS", 5000)
        # The box's Redis runs maxmemory 2gb with noeviction: retention bounds
        # are mandatory, exactly as the render queues set them.
        self.remove_on_complete = int_env("TTS_REMOVE_ON_COMPLETE", 50)
        self.remove_on_fail = int_env("TTS_REMOVE_ON_FAIL", 200)

        if self.concurrency < 1:
            raise RuntimeError(f"TTS_CONCURRENCY must be >= 1, got {self.concurrency}")
        if self.intra_op_threads < 1:
            raise RuntimeError(
                f"TTS_INTRA_OP_THREADS must be >= 1, got {self.intra_op_threads}"
            )


_config: Config | None = None


def get_config() -> Config:
    global _config
    if _config is None:
        _config = Config()
    return _config

"""HTTP surface, mirroring render-worker/src/server.js where it matters:
POST /jobs, GET /jobs/:id, GET /health, X-Api-Key on everything but /health.

The server accepts jobs into the durable 'tts' BullMQ queue and a Worker in
the same process executes them (the render worker's own deployment shape).
A queued job survives a container restart; a job the worker died holding is
re-run by BullMQ's stalled handling, bounded by attempts — and when the
attempts are gone, the job is FAILED with a worded reason the app's poll
turns into an honestly failed project. No silent partials, anywhere.

MODEL LOAD FAILURE IS FATAL, BY DESIGN (Item 3): if the session or voices
cannot load, this process logs and exits non-zero. Docker restarts it;
/health stays down; queued jobs sit untouched until the app-side staleness
ceiling fails their projects with a worded message. A worker that cannot
speak must not pretend to be a worker.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys

from aiohttp import web

from .config import get_config
from .engine import Engine
from .jobs import Processor, job_options, validate_job_payload

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
)
log = logging.getLogger("tts-worker")


def require_api_key(handler):
    async def wrapped(request: web.Request):
        config = request.app["config"]
        if request.headers.get("X-Api-Key") != config.api_key:
            return web.json_response({"error": "Unauthorized"}, status=401)
        return await handler(request)

    return wrapped


@require_api_key
async def post_job(request: web.Request):
    app = request.app
    try:
        raw = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "body must be JSON"}, status=422)
    try:
        payload = validate_job_payload(raw, app["voices"])
    except ValueError as err:
        return web.json_response({"error": str(err)}, status=422)

    queue = app["queue"]
    existing = await queue.getJobState(payload["job_id"])
    if existing == "failed":
        # A retry after an honest failure gets a fresh attempt cycle. The old
        # job is removed first so the deterministic id can be reused.
        from bullmq import Job

        old = await Job.fromId(queue, payload["job_id"])
        if old:
            await old.remove()
    elif existing != "unknown":
        # Idempotent resubmit: the app retries on network doubt; the same
        # job id must not become two narrations.
        return web.json_response({"job_id": payload["job_id"], "state": existing})

    await queue.add(
        "tts",
        payload,
        {**job_options(app["config"]), "jobId": payload["job_id"]},
    )
    log.info("tts job accepted: %s (%d sentences)", payload["job_id"], len(payload["sentences"]))
    return web.json_response({"job_id": payload["job_id"], "state": "queued"}, status=202)


@require_api_key
async def get_job(request: web.Request):
    from bullmq import Job

    app = request.app
    job_id = request.match_info["job_id"]
    queue = app["queue"]
    state = await queue.getJobState(job_id)
    if state == "unknown":
        return web.json_response({"error": "Job not found", "job_id": job_id}, status=404)

    body = {"job_id": job_id, "status": state}
    if state in ("waiting", "delayed", "prioritized", "waiting-children"):
        body["status"] = "queued"
        try:
            waiting = await queue.getWaiting()
            ids = [j.id for j in waiting if j]
            body["queue_position"] = ids.index(job_id) + 1 if job_id in ids else len(ids) + 1
        except Exception:  # noqa: BLE001 — position is advisory
            body["queue_position"] = None
    elif state == "active":
        body["status"] = "processing"
        job = await Job.fromId(queue, job_id)
        body["progress_pct"] = job.progress if job and isinstance(job.progress, (int, float)) else 0
    elif state == "completed":
        job = await Job.fromId(queue, job_id)
        result = job.returnvalue if job else None
        if not isinstance(result, dict) or "sample_counts" not in result:
            # A completed job whose result is unreadable is a failure, not a
            # success with blanks — the app must not persist a guess.
            return web.json_response(
                {"job_id": job_id, "status": "failed",
                 "error": "The narration finished but its result could not be read. Please try again."},
            )
        body.update(result)
        # The completion handoff may run from a fresh tab that never held the
        # script: hand back what the job was made from, so persisting needs
        # nothing the closed tab took with it.
        if isinstance(job.data, dict):
            body["sentences"] = job.data.get("sentences")
            body["voice"] = job.data.get("voice")
            body["full_text"] = job.data.get("full_text")
    elif state == "failed":
        job = await Job.fromId(queue, job_id)
        body["error"] = (job.failedReason if job else None) or "The narration failed. Please try again."
    return web.json_response(body)


async def health(request: web.Request):
    app = request.app
    try:
        await asyncio.wait_for(app["redis_ping"](), timeout=5)
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "reason": "redis unreachable"}, status=503)
    return web.json_response(
        {"ok": True, "voices": app["voices"], "concurrency": app["config"].concurrency}
    )


async def make_app(engine: Engine | None = None) -> web.Application:
    from bullmq import Queue, Worker
    from redis.asyncio import Redis

    config = get_config()
    if engine is None:
        # The model and voices are baked into the image; a load failure here
        # is a broken image or missing bake, and the process must not serve.
        log.info(
            "loading model (%s), intra_op=%d, trim=%s",
            config.model_path, config.intra_op_threads, config.trim,
        )
        engine = Engine.load(
            config.model_path, config.voices_path, config.intra_op_threads, config.trim
        )
        log.info("model loaded")

    app = web.Application(client_max_size=8 * 1024 * 1024)
    app["config"] = config
    app["engine"] = engine
    app["voices"] = sorted(list(engine._kokoro.voices.files))

    queue = Queue(config.queue_name, {"connection": config.redis_url})
    app["queue"] = queue

    ping_client = Redis.from_url(config.redis_url)
    app["redis_ping"] = ping_client.ping

    processor = Processor(engine, config)
    worker = Worker(
        config.queue_name,
        processor.process,
        {"connection": config.redis_url, "concurrency": config.concurrency},
    )
    app["worker"] = worker

    async def close_everything(_app):
        await worker.close()
        await queue.close()
        await ping_client.aclose()

    app.on_cleanup.append(close_everything)

    app.router.add_post("/jobs", post_job)
    app.router.add_get("/jobs/{job_id}", get_job)
    app.router.add_get("/health", health)
    return app


def main() -> None:
    config = get_config()
    log.info(
        "tts-worker starting on :%d (concurrency=%d, intra_op=%d)",
        config.port, config.concurrency, config.intra_op_threads,
    )
    try:
        # make_app() is awaited by run_app on the same loop the BullMQ worker
        # binds to — constructing them on a throwaway loop would strand the
        # worker's background tasks.
        web.run_app(make_app(), port=config.port, print=None)
    except Exception:
        log.exception("FATAL: engine failed to load; refusing to serve")
        sys.exit(1)


if __name__ == "__main__":
    main()

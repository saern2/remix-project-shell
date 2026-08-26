# tts-worker

Server-side narration for script-to-video (Round B). A sibling of
`render-worker/`, not a modification of it — `render-worker/` is untouched
this round, provable by `git log --stat`.

**The contract:** the app sends `{ sentences: string[], voice, upload_url }`;
the worker uploads a WAV (RIFF/PCM/mono/24 kHz/16-bit, byte-identical
structure to `src/lib/tts/wav.ts`) to the signed URL and returns
`sample_counts: number[]`, one per sentence. The worker performs **zero text
processing** — sanitisation and sentence splitting live app-side in
`script-input.ts`, so the spoken text and the scene text are the same array
by construction. Verification is arithmetic:
`(fileBytes − 44) ÷ 48000 == last end_ms ÷ 1000`, exactly.

## Deploy (on the VPS)

1. Fill `models/` per `models/README.md` (model.onnx + voice .bin files —
   the build fails loudly on wrong sizes).
2. Add to the box's compose file (the repo's compose is untouched; this is
   the whole stanza):

   ```yaml
   tts-worker:
     build: ../tts-worker        # path from the compose file to this directory
     restart: unless-stopped
     depends_on:
       redis:
         condition: service_healthy
     env_file:
       - .env                    # needs TTS_WORKER_API_KEY added
     environment:
       - REDIS_URL=redis://redis:6379
     cpus: 1.0                   # C1: first-deployment budget. Render holds 6
     mem_limit: 3GB              # of 8 CPUs; the 22 Aug throttling means the
     ports:                      # spare capacity is proven, not assumed.
       - "127.0.0.1:3002:3002"
   ```

3. `docker compose build tts-worker && docker compose up -d tts-worker`
4. Benchmark (Item 1's signal):
   `docker compose exec tts-worker python -m scripts.benchmark` (and `--n 2`).
   Expect ~57.6 s of audio for the fixed paragraph; report RTF, per-sentence
   times, duration, peak RSS.

**CPU budget (C1):** `cpus: 1.0` and `TTS_CONCURRENCY=1` for the first
deployment — peak box load ~87.5% instead of the ~97% that 1.8 CPUs would
allow. Hostinger throttled this box for sustained 100% on 22 August; the
ceiling rises only after a real concurrent render+TTS duty cycle has been
captured (chunk-seconds median 70–85 s AND host CPU sustained below ~90%).
Both knobs are env values; no rebuild to change them.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TTS_WORKER_API_KEY` | *(required)* | X-Api-Key for /jobs endpoints |
| `REDIS_URL` | redis://localhost:6379 | the box's existing Redis; queue keys live under `bull:tts:*` only |
| `TTS_CONCURRENCY` | 1 | concurrent jobs (one shared model session) |
| `TTS_INTRA_OP_THREADS` | 1 | ONNX Runtime intra-op threads — explicit, never detected |
| `TTS_TRIM` | 0 | audio trimming off, matching kokoro-js (the browser path trims no audio) |
| `PORT` | 3002 | HTTP port |

## Failure honesty (Item 3)

- A sentence too long for kokoro's 510-phoneme context **fails the job with
  a worded error naming the sentence** — kokoro-onnx would silently truncate
  it (verified at source), which is the silent-audio-loss class.
- A sentence producing zero samples fails the job, naming the sentence.
- Worker death mid-job: BullMQ stalled handling + attempts (2) → job failed
  with a reason; the app's poll turns that into a failed project.
- Model load failure: the process exits non-zero and `/health` stays down;
  queued jobs are failed app-side by the narration staleness ceiling.
- Nothing partial ever leaves the container: the WAV uploads only after every
  sentence rendered; the temp file is deleted on every exit path.

## Tests

```
cd tts-worker && python -m pytest tests/
```

Model-free: the WAV writer is tested byte-for-byte against the wav.ts spec,
the Adapt wrapper against a real (tiny) ONNX session with a float-declared
`speed` input and a (1, N) output, and the engine/job contract against fakes.
The real-model path is covered by `scripts/benchmark.py` on the VPS.

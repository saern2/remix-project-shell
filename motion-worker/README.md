# motion-worker

SaaS explainer generation (Round D): a brief plus the **user's own** AI
provider key in, a rendered MP4 out. A sibling of `render-worker/` and
`tts-worker/` — both untouched; the only shared thing is the box's Redis,
and this worker's keys live under `bull:motion:*` plus `motion:job-seconds`
only.

**Library-driven, never the CLI (D1).** The worker imports
`generateMotionGraphics` and `renderVideo` directly, which keeps Anymotion's
silent template fallback off the execution path entirely, avoids the CLI's
`saveConfig` round-trip that would write the API key to disk, and gives real
error propagation: a 402 arrives as a thrown error carrying Anymotion's own
worded message, and fails the job loudly.

## Security model — read before deploying (D9)

- **No Scene Smith secrets in this container.** No shared `.env` mount, no
  Supabase service key, no render worker credentials. Anymotion launches
  Chrome with `--no-sandbox --disable-web-security` (its own flags); the
  container's contents are the blast radius, so the contents are nothing.
  Do not mount `.env` "for convenience" — that undoes the whole model.
- **The user's key** exists in: the authenticated app→worker POST, worker
  memory, worker-secret ciphertext in the Redis payload (never plaintext —
  `MOTION_WORKER_KEY_SECRET` lives only in this worker's own env file), and
  the job child's memory, delivered **via stdin** (never argv, never env).
  The ciphertext is scrubbed from the job record when the job settles.
- The container carries **no `*_API_KEY` env vars**, which also closes
  Anymotion's `loadConfig()` environment-harvest path; the job child runs
  with an allowlisted env of exactly six variables.

## Deploy (on the VPS)

1. Create `motion-worker.env` next to the compose file (NOT the shared `.env`):

   ```
   MOTION_WORKER_API_KEY=<generate a long random token>
   MOTION_WORKER_KEY_SECRET=<generate a second long random token>
   ```

2. Add to the box's compose file:

   ```yaml
   motion-worker:
     build: ../motion-worker      # path from the compose file to this directory
     restart: unless-stopped
     depends_on:
       redis:
         condition: service_healthy
     env_file:
       - motion-worker.env        # its OWN env file — never the shared .env
     environment:
       - PORT=3003                # explicit: environment overrides env_file,
       - REDIS_URL=redis://redis:6379   # and the shared .env burned tts once
       - MOTION_TMP_DIR=/tmp/motion-tmp
     cpus: 1.5                    # D4: 6.0 render + 1.5 motion + 1.0 tts = 8.5
     mem_limit: 4GB               # committed on 8 cores — not the 9.0 that
     ports:                      # mirrored the 22 August overcommit
       - "127.0.0.1:3003:3003"
     volumes:
       - motion_tmp:/tmp/motion-tmp
   ```

   and `motion_tmp:` under `volumes:`.

3. `docker compose build motion-worker && docker compose up -d motion-worker`

**Disk**: one job peaks at 2–3.5 GB of PNG frames. `MOTION_TMP_DIR` needs
**≥ 10 GB headroom** (one live job + one orphan inside the sweep grace).
Anymotion keeps frame directories on every failure path by design; this
worker deletes the whole job directory in `finally` and runs an hourly
orphan sweep with a live-job guard — both layers are required (D6).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `MOTION_WORKER_API_KEY` | *(required)* | X-Api-Key for /jobs |
| `MOTION_WORKER_KEY_SECRET` | *(required)* | encrypts user keys before Redis (D5) |
| `MOTION_CONCURRENCY` | 1 | jobs at once (D7 — raise only after a concurrent capture) |
| `MOTION_MAX_TURNS` | 60 | agent-turn ceiling (Anymotion's own is 150) |
| `MOTION_WALL_CLOCK_S` | 3600 | wall-clock ceiling; 1.4× the measured 42-minute worst case |
| `RENDER_GATE_MAX_ACTIVE_CHUNKS` | 1 | hold new jobs while this many render chunks are active |
| `MOTION_QUEUE_MAX_DEPTH` | 4 | refuse submissions past this depth, with the wait stated |
| `PORT` | 3003 | set explicitly in compose `environment:` |

## Failure honesty (Item 3)

Every failure is a worded message the user can act on: 402 → out of credit
or Claude's daily-batch unavailability, with the GLM/DeepSeek alternative
named; 401 → key rejected; turn cap → simplify the brief; wall clock →
provider too slow; Chrome death → platform problem, not the user's. Exactly
one attempt per job — an automatic retry would silently spend the user's
provider credit twice. `usedFallback` from the engine is asserted false;
a true value fails the job loudly (belt and braces on an unreachable path).

## Tests

```
cd motion-worker && npm install && npx vitest run
```

Model-free: fault injection per failure case against the injected-deps job
core, crypto round-trips with a no-plaintext-in-payload pin, gate/sweep/ETA
logic against a real Redis where needed.

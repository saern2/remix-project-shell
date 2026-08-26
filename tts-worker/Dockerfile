# syntax=docker/dockerfile:1
# ─── tts-worker ───────────────────────────────────────────────────────────────
# Model and voices are BAKED INTO THE IMAGE, never downloaded per job: the
# operator places model.onnx (325,532,232 bytes) and the voice .bin files in
# ./models/ before building — see models/README.md. The build FAILS LOUDLY if
# they are missing or the wrong size; a worker that would fetch weights at
# runtime is one network blip away from the silent-failure class this
# platform keeps removing.

FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The model, verified byte-exact at build time (the onnx-community export the
# adaptations were tested against).
COPY models/model.onnx /app/models/model.onnx
RUN test "$(stat -c %s /app/models/model.onnx)" = "325532232" || \
    (echo "FATAL: model.onnx is not the verified 325,532,232-byte export" && exit 1)

# Voices: raw .bin files packed into the .npz kokoro-onnx loads by name.
# pack_voices.py refuses any file that is not exactly 522,240 bytes.
COPY models/*.bin /app/models/bins/
COPY scripts/pack_voices.py /app/scripts/pack_voices.py
RUN python /app/scripts/pack_voices.py /app/models/bins /app/models/voices.npz && \
    rm -rf /app/models/bins

COPY src/ /app/src/

RUN groupadd -r tts && useradd -r -g tts tts && \
    mkdir -p /tmp/tts-tmp && \
    chown -R tts:tts /app /tmp/tts-tmp

USER tts

# CPU limits are EXPLICIT, never detected (every parallelism API on this box
# reports the host's 8 CPUs, not the cgroup quota). These pair with the
# compose stanza's cpus: 1.0 (Round B, C1 — first deployment budget).
ENV TTS_INTRA_OP_THREADS=1 \
    TTS_CONCURRENCY=1 \
    OMP_NUM_THREADS=1 \
    PORT=3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://localhost:3002/health', timeout=8); sys.exit(0 if r.status==200 else 1)" || exit 1

EXPOSE 3002

# nice 19: TTS soaks up spare cycles and yields to everything else on the box
# — lowering our own priority needs no capability.
CMD ["nice", "-n", "19", "python", "-m", "src.server"]

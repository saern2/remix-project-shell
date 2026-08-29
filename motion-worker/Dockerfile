# syntax=docker/dockerfile:1
# ─── motion-worker ────────────────────────────────────────────────────────────
# SaaS explainer generation via Anymotion (library-driven — the CLI and its
# silent template fallback are never on the execution path).
#
# NO SCENE SMITH SECRETS IN THIS CONTAINER (D9). No .env mount, no Supabase
# key, no render credentials, no provider key of its own — the user's key
# arrives per job and exists only in memory and as worker-secret ciphertext
# in Redis. This rule is load-bearing, not tidiness: Anymotion launches
# Chrome with --no-sandbox --disable-web-security (its own flags,
# video-renderer.js:213-220), so the container's contents are the blast
# radius. Do not mount .env "for convenience."

FROM node:20-bookworm

# System Chromium + the fonts Chrome silently falls back without. A fresh
# image has almost none, and the wrong typeface in every frame is invisible
# until someone watches the video.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        ffmpeg \
        fonts-liberation \
        fonts-dejavu-core \
        fonts-noto-core \
        fonts-noto-color-emoji \
        fonts-inter \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# Non-root (D-list defect 3: the Chrome sandbox refuses to run as root).
RUN groupadd -r motion && useradd -r -g motion -m motion && \
    mkdir -p /tmp/motion-tmp && \
    chown -R motion:motion /app /tmp/motion-tmp
USER motion

# PORT is set explicitly in the compose environment: block — the shared .env
# sets PORT=3001 for the render worker and the tts-worker inherited exactly
# that once. This default is only the last resort.
ENV PORT=3003

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||3003)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" || exit 1

EXPOSE 3003

# nice 19: explainer work soaks up spare cycles and yields to everything
# else on the box — rendering above all.
CMD ["nice", "-n", "19", "node", "src/server.js"]

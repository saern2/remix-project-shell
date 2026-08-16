/**
 * The model comes from our bucket, and failure is loud — never a silent
 * third party.
 *
 * Context: Hugging Face served the 325.5 MB model at 0.96 MB/s (measured,
 * capture 69), so the bytes moved to Cloudflare R2. The property that matters
 * more than the feature working: if the bucket is wrong, private, or CORS-
 * broken, the user gets a plain sentence — the code must be INCAPABLE of
 * quietly reaching huggingface.co and appearing to work. A silent fallback
 * to a healthy third party is how the Pexels outage stayed invisible for
 * eleven days.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TTS_MODEL_BASE_URL,
  VOICE_BIN_BYTES,
  configureModelHost,
  resetSeededVoices,
  seedVoiceCache,
} from "../tts/model-host";

const PLAIN_SENTENCE = /narrator's voice could not be downloaded/i;

/** An in-memory CacheStorage with just the surface the seeding uses. */
function fakeCaches(overrides: { put?: () => Promise<void> } = {}) {
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: string) => store.get(key),
    put: overrides.put ?? (async (key: string, value: Response) => void store.set(key, value)),
  };
  return {
    storage: { open: async () => cache } as unknown as CacheStorage,
    store,
  };
}

const goodResponse = () => new Response(new ArrayBuffer(VOICE_BIN_BYTES), { status: 200 });

beforeEach(() => resetSeededVoices());

describe("no silent fallback, by construction", () => {
  it("fetches voices from the R2 origin and never from huggingface.co", async () => {
    const { storage, store } = fakeCaches();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL) => goodResponse());
    await seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const fetched = String(fetchImpl.mock.calls[0][0]);
    expect(fetched.startsWith(TTS_MODEL_BASE_URL)).toBe(true);
    expect(fetched).not.toContain("huggingface.co");

    // The cache KEY is the hardcoded HF URL — that is where kokoro-js LOOKS,
    // and priming it is exactly what makes its silent fetch unreachable. The
    // key names the lookup, not the source.
    const keys = [...store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
    );
  });

  it("configureModelHost replaces the only remote source transformers.js has", () => {
    const env = {
      remoteHost: "https://huggingface.co/",
      remotePathTemplate: "{model}/resolve/{revision}/",
    };
    configureModelHost(env);
    expect(env.remoteHost).toBe(TTS_MODEL_BASE_URL);
    expect(env.remotePathTemplate).toBe("{model}/{revision}/");
  });

  it("the R2 base URL exists in exactly one source file", () => {
    // Single constant, changed in one place — including the day the r2.dev
    // URL is replaced by a custom domain.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      `grep -rln 'pub-42a1fa5fb300434c9a06eaf5b7966394' src/ --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ || true`,
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(hits).toEqual(["src/lib/tts/model-host.ts"]);
  });

  it("huggingface.co appears in TTS source only as the documented cache key", () => {
    const { readFileSync, readdirSync } = require("node:fs") as typeof import("node:fs");
    const { resolve, join } = require("node:path") as typeof import("node:path");
    const dir = resolve(process.cwd(), "src/lib/tts");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(join(dir, file), "utf8");
      const mentions = source.split("huggingface.co").length - 1;
      if (file === "model-host.ts") {
        // The cache-key constant and its explanation — nothing else.
        expect(mentions).toBeGreaterThan(0);
        expect(source).toContain("KOKORO_VOICE_CACHE_KEY_PREFIX");
      } else {
        expect(mentions, `${file} must not reference huggingface.co`).toBe(0);
      }
    }
  });

  it("loadEngine configures the host before the model loads, and seeds before generating", () => {
    // Order in the source is the guarantee: remoteHost is set before
    // from_pretrained resolves any file, and the engine wrapper awaits the
    // voice seed before kokoro's generate can run — the ONLY path to
    // tts.generate goes through the seed's throw.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/tts/generate.ts"), "utf8");
    const configureAt = source.indexOf("configureModelHost(env)");
    const pretrainedAt = source.indexOf("KokoroTTS.from_pretrained(");
    const seedAt = source.indexOf("await seedVoiceCache(voice)");
    const generateAt = source.indexOf("await tts.generate(");
    expect(configureAt).toBeGreaterThan(-1);
    expect(configureAt).toBeLessThan(pretrainedAt);
    expect(seedAt).toBeGreaterThan(-1);
    expect(seedAt).toBeLessThan(generateAt);
  });
});

describe("seeding failure is fatal, with a plain sentence", () => {
  it("a failed fetch aborts before generation", async () => {
    const { storage } = fakeCaches();
    const fetchImpl = vi.fn(async () => {
      throw new Error("NetworkError: CORS");
    });
    await expect(seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage })).rejects.toThrow(
      PLAIN_SENTENCE,
    );
  });

  it("a non-200 (private bucket, wrong path) aborts", async () => {
    const { storage } = fakeCaches();
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage })).rejects.toThrow(
      PLAIN_SENTENCE,
    );
  });

  it("a wrong byte length aborts — a truncated voice must never reach the model", async () => {
    const { storage } = fakeCaches();
    const fetchImpl = vi.fn(async () => new Response(new ArrayBuffer(1000), { status: 200 }));
    await expect(seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage })).rejects.toThrow(
      PLAIN_SENTENCE,
    );
  });

  it("a rejected cache.put aborts — an unseeded cache means the fallback is reachable", async () => {
    const { storage } = fakeCaches({
      put: async () => {
        throw new Error("QuotaExceededError");
      },
    });
    const fetchImpl = vi.fn(async () => goodResponse());
    await expect(seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage })).rejects.toThrow(
      PLAIN_SENTENCE,
    );
  });

  it("no Cache API at all aborts, rather than degrading to a third-party fetch", async () => {
    await expect(
      seedVoiceCache("af_heart", { fetchImpl: vi.fn(), cacheStorage: undefined }),
    ).rejects.toThrow(PLAIN_SENTENCE);
  });

  it("the sentence survives describeUserFacingError untouched", async () => {
    const { describeUserFacingError } = await import("../user-errors");
    const { storage } = fakeCaches();
    const fetchImpl = vi.fn(async () => new Response("x", { status: 404 }));
    const err = await seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage }).catch(
      (e) => e,
    );
    expect(describeUserFacingError(err)).toMatch(PLAIN_SENTENCE);
  });
});

describe("seeding succeeds once, then costs nothing", () => {
  it("skips the network entirely on repeat calls and on a pre-populated cache", async () => {
    const { storage } = fakeCaches();
    const fetchImpl = vi.fn(async () => goodResponse());
    await seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage });
    await seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A different session (memory cleared) finds the browser cache primed.
    resetSeededVoices();
    await seedVoiceCache("af_heart", { fetchImpl, cacheStorage: storage });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

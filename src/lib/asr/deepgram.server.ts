// Deepgram ASR provider. Server-only.
//
// Uses Deepgram's pre-recorded transcription endpoint by URL. This is a
// SINGLE SYNCHRONOUS HTTP call — Deepgram processes the file and returns
// the completed transcript in one response. Fine for typical narration
// lengths (a few minutes up to ~15 min).
//
// KNOWN LIMITATION: For very long audio (roughly 1 hour+), Deepgram
// recommends the async callback flow instead of the sync endpoint. We
// intentionally do NOT silently truncate — a long-file failure surfaces
// as an error and the pipeline falls back to AssemblyAI in that case.
// If we later need first-class support for hour+ files, wire up
// Deepgram's async /listen?callback=... mode as a separate submit/poll
// provider.

import type { AsrSentence, AsrWord } from "../asr.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type DeepgramCompleted = {
  full_text: string;
  language: string | null;
  words: AsrWord[];
  sentences: AsrSentence[];
  duration_sec: number | null;
};

function parseDeepgramKeys(): string[] {
  const raw = process.env.DEEPGRAM_API_KEYS ?? "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return res.statusText;
  }
}

async function trackUsage() {
  try {
    await supabaseAdmin.rpc("increment_provider_usage", {
      p_provider: "deepgram",
      p_date: new Date().toISOString().slice(0, 10),
      p_cache_hit: false,
    });
  } catch {
    // usage tracking must never break the pipeline
  }
}

/**
 * Transcribe an audio URL with Deepgram. Rotates through comma-separated
 * DEEPGRAM_API_KEYS; retries once with a different key on 401/403, then
 * fails with a clear "tried N of M keys" message.
 */
export async function transcribeWithDeepgram(audioUrl: string): Promise<DeepgramCompleted> {
  const keys = parseDeepgramKeys();
  if (keys.length === 0) {
    throw new Error("DEEPGRAM_API_KEYS is not configured.");
  }

  const url =
    "https://api.deepgram.com/v1/listen?model=nova-3&punctuate=true&paragraphs=true&utterances=true&smart_format=true";

  // Randomize starting key, try up to 2 distinct keys total on auth failure.
  const shuffled = [...keys].sort(() => Math.random() - 0.5);
  const attemptOrder = shuffled.slice(0, Math.min(2, shuffled.length));

  let lastError = "";
  for (let i = 0; i < attemptOrder.length; i++) {
    const key = attemptOrder[i];
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: audioUrl }),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : "network error";
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      lastError = `Deepgram auth failed (${res.status}) on key ${i + 1}: ${await safeText(res)}`;
      continue; // rotate to next key
    }
    if (!res.ok) {
      lastError = `Deepgram error ${res.status}: ${await safeText(res)}`;
      throw new Error(
        `Deepgram request failed (${res.status}): ${lastError}`,
      );
    }

    const json = (await res.json()) as DeepgramResponse;
    await trackUsage();
    return mapDeepgramResponse(json);
  }

  throw new Error(
    `Deepgram failed: tried ${attemptOrder.length} of ${keys.length} keys. Last error: ${lastError}`,
  );
}

type DeepgramWord = {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
};

type DeepgramSentence = { text: string; start: number; end: number };

type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        languages?: string[];
        words?: DeepgramWord[];
        paragraphs?: {
          transcript?: string;
          paragraphs?: Array<{
            sentences?: DeepgramSentence[];
          }>;
        };
      }>;
      detected_language?: string;
    }>;
  };
};

function mapDeepgramResponse(json: DeepgramResponse): DeepgramCompleted {
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  const words: AsrWord[] = (alt?.words ?? []).map((w) => ({
    text: w.punctuated_word ?? w.word,
    start_ms: Math.round(w.start * 1000),
    end_ms: Math.round(w.end * 1000),
    confidence: w.confidence,
  }));

  const sentences: AsrSentence[] = [];
  const paragraphs = alt?.paragraphs?.paragraphs ?? [];
  for (const p of paragraphs) {
    for (const s of p.sentences ?? []) {
      sentences.push({
        text: s.text,
        start_ms: Math.round(s.start * 1000),
        end_ms: Math.round(s.end * 1000),
      });
    }
  }

  const language =
    json.results?.channels?.[0]?.detected_language ??
    alt?.languages?.[0] ??
    null;

  return {
    full_text: alt?.transcript ?? "",
    language,
    words,
    sentences,
    duration_sec:
      typeof json.metadata?.duration === "number" ? json.metadata.duration : null,
  };
}

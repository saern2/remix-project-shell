/**
 * Sample-exact audio assembly: Float32 chunks in, one WAV Blob out.
 *
 * WHY WAV AND NOT MP3. An MP3 encoder inserts codec delay and padding, and
 * that is cumulative-drift territory — the class round 11 spent a round
 * eliminating (37 ms measured). A WAV's duration is exactly
 * totalSamples / sampleRate, and every scene boundary here derives from the
 * same integer sample accumulator, so drift is excluded by construction
 * rather than mitigated. ~130 MB for 45 minutes is the price; it uploads in
 * ~10 s at the measured ~15 MB/s.
 *
 * WHY Int16 ON ARRIVAL. MEASURED 2026-08-15 in Chromium (356 chunks, 45 min
 * simulated): retaining Float32 chunks and converting at the end peaks at
 * 620 MB of JS heap; converting each chunk to Int16 as it arrives and
 * assembling the file as Blob parts rests at ~130 MB for the whole 4-5 minute
 * generation, with a ~1 s ~300 MB transient during final Blob assembly.
 * This is round 12's lesson (never retain the whole body twice) applied
 * client-side.
 */

/** Kokoro's output rate; everything here assumes it and asserts it upstream. */
export const TTS_SAMPLE_RATE = 24_000;

/** Samples per millisecond at 24 kHz — exact, which is what makes ms rounding safe. */
export const SAMPLES_PER_MS = TTS_SAMPLE_RATE / 1000;

/** Float32 [-1, 1] to 16-bit PCM, clamped. The Float32 is garbage after this. */
export function floatToInt16(chunk: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(chunk.length);
  for (let i = 0; i < chunk.length; i += 1) {
    const s = Math.max(-1, Math.min(1, chunk[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** The 44-byte RIFF/WAVE header for mono 16-bit PCM at 24 kHz. */
export function buildWavHeader(totalSamples: number): ArrayBuffer {
  const dataBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TTS_SAMPLE_RATE, true);
  view.setUint32(28, TTS_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

/**
 * One sentence's place on the timeline, in SAMPLES. Milliseconds exist only
 * at the boundary conversion — see sentenceBoundariesToMs.
 */
export type SampleSpan = { text: string; startSample: number; endSample: number };

/**
 * THE DURATION GATE. Zero tolerance, integer equality — both numbers derive
 * from the same accumulator, so any difference is a bug (a dropped chunk, a
 * double append), and this is the cheap place to catch it: before a byte is
 * uploaded and before any database row exists. Render is the expensive place.
 */
export function assertSampleExact(
  spans: SampleSpan[],
  totalSamples: number,
  partSamples: number,
): void {
  const lastEnd = spans.length ? spans[spans.length - 1].endSample : 0;
  if (lastEnd !== totalSamples || partSamples !== totalSamples) {
    throw new Error(
      "Something went wrong assembling the audio — nothing was saved. Please try again. " +
        `(internal: spans end ${lastEnd}, parts ${partSamples}, accumulator ${totalSamples})`,
    );
  }
  for (let i = 0; i < spans.length; i += 1) {
    const prevEnd = i === 0 ? 0 : spans[i - 1].endSample;
    if (spans[i].startSample !== prevEnd || spans[i].endSample <= spans[i].startSample) {
      throw new Error(
        "Something went wrong assembling the audio — nothing was saved. Please try again. " +
          `(internal: span ${i} [${spans[i].startSample}, ${spans[i].endSample}] after ${prevEnd})`,
      );
    }
  }
}

/**
 * Sample boundaries to the millisecond sentences the transcript stores.
 *
 * Each boundary is rounded FROM THE ACCUMULATOR, never by summing rounded
 * durations — so the error at any boundary is at most 0.5 ms and does not
 * accumulate. (The round-11 lesson, applied at the source.) Contiguity
 * survives rounding because consecutive sentences share the same boundary
 * sample and therefore round identically.
 */
export function sentenceBoundariesToMs(
  spans: SampleSpan[],
): Array<{ text: string; start_ms: number; end_ms: number }> {
  return spans.map((span) => ({
    text: span.text,
    start_ms: Math.round(span.startSample / SAMPLES_PER_MS),
    end_ms: Math.round(span.endSample / SAMPLES_PER_MS),
  }));
}

/**
 * The finished file, assembled from parts without ever building a contiguous
 * 130 MB ArrayBuffer in the JS heap. The Blob uploads as-is.
 */
export function buildWavBlob(parts: Array<Int16Array<ArrayBuffer>>, totalSamples: number): Blob {
  return new Blob([buildWavHeader(totalSamples), ...parts], { type: "audio/wav" });
}

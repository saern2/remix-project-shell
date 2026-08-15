/**
 * From a pasted script or an uploaded file to the sentence list TTS speaks.
 *
 * The sentences produced here become SCENES, one each — the same shape the
 * ASR path produces, where a Deepgram/AssemblyAI sentence becomes a scene.
 * Scene length therefore rides on this splitter: the platform averages ~6
 * seconds per scene, which is roughly one written sentence read aloud.
 */

import { APPROXIMATE_SECONDS_PER_SCENE, MAX_AUDIO_DURATION_SECONDS } from "@/lib/audio-limits";

/**
 * Words per minute of typical narration. Used ONLY for the pre-generation
 * estimate; the enforced ceiling is measured in actual generated samples.
 */
export const NARRATION_WORDS_PER_MINUTE = 150;

/** Abbreviations whose trailing period must not end a sentence. */
const NON_TERMINAL = new Set(
  "mr mrs ms dr prof sr jr st mt no vs etc inc ltd co corp approx est min max fig al".split(" "),
);

/**
 * Splits narration text into spoken sentences.
 *
 * Deliberately simple and deliberately conservative: a wrong merge costs one
 * long scene; a wrong split costs one short one. Handles the cases that occur
 * in real scripts — abbreviations ("Dr. Grant"), decimals ("2.5 million"),
 * closing quotes after terminators — and leaves linguistics to the model,
 * which only ever sees one sentence at a time.
 */
export function splitScriptIntoSentences(script: string): string[] {
  const text = script.replace(/\s+/g, " ").trim();
  if (!text) return [];

  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Decimal point: digit on both sides.
    if (ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;

    // Abbreviation: the word before the period is on the list.
    if (ch === ".") {
      const before = text.slice(start, i);
      const lastWord = before.split(" ").pop()?.toLowerCase() ?? "";
      if (NON_TERMINAL.has(lastWord.replace(/[^a-z]/g, ""))) continue;
      // Single capital initial ("J. Smith").
      if (/^[A-Z]$/.test(before.split(" ").pop() ?? "")) continue;
    }

    // Consume any run of terminators ("?!", "...") and a closing quote.
    let end = i + 1;
    while (end < text.length && /[.!?]/.test(text[end])) end += 1;
    if (end < text.length && /["'”’)]/.test(text[end])) end += 1;

    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    i = end - 1;
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);

  return sentences;
}

/** Rough spoken duration for the pre-check. The real ceiling is sample-counted. */
export function estimateSpokenSeconds(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return (words / NARRATION_WORDS_PER_MINUTE) * 60;
}

export type ScriptVerdict = { ok: true; warning?: string } | { ok: false; message: string };

/**
 * The pre-generation check. Refuses the empty and the absurd, warns near the
 * ceiling — but never blocks on the estimate alone, because words-per-minute
 * varies and the enforced limit is the measured one during generation.
 */
export function checkScript(script: string): ScriptVerdict {
  const trimmed = script.trim();
  if (!trimmed)
    return { ok: false, message: "The script is empty. Paste or upload some text first." };
  if (splitScriptIntoSentences(trimmed).length === 0) {
    return { ok: false, message: "The script is empty. Paste or upload some text first." };
  }

  const estimated = estimateSpokenSeconds(trimmed);
  const ceilingMin = Math.round(MAX_AUDIO_DURATION_SECONDS / 60);
  if (estimated > MAX_AUDIO_DURATION_SECONDS * 1.5) {
    // Half again over the ceiling: no plausible reading speed rescues it.
    return {
      ok: false,
      message:
        `This script would run about ${Math.round(estimated / 60)} minutes read aloud — the longest we can process is ${ceilingMin} minutes ` +
        `(about ${Math.round(MAX_AUDIO_DURATION_SECONDS / APPROXIMATE_SECONDS_PER_SCENE)} scenes). Split it and create a project for each part.`,
    };
  }
  if (estimated > MAX_AUDIO_DURATION_SECONDS) {
    return {
      ok: true,
      warning:
        `This script may run past the ${ceilingMin}-minute limit read aloud. Generation will stop and nothing will be saved if it does — ` +
        `consider trimming it first.`,
    };
  }
  return { ok: true };
}

/**
 * Extracts plain text from a pasted-alternative upload: .txt or .docx.
 *
 * mammoth is imported lazily and only here, so the ordinary app bundle never
 * carries a Word parser.
 */
export async function extractScriptText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const { default: mammoth } = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value ?? "";
  }
  if (name.endsWith(".txt") || file.type.startsWith("text/")) {
    return await file.text();
  }
  throw new Error("Please upload a .txt or .docx file, or paste the script directly.");
}

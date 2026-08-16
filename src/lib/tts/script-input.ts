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
 * Strips markdown STRUCTURE from a pasted script, keeping the words.
 *
 * PRODUCTION EVIDENCE, 2026-08-16: a pasted script containing
 * "--- ## CHAPTER ONE — THE KINGDOM OF EMBERS" had the dashes and hashes
 * SPOKEN by the TTS and persisted as scene 43 with visual query "chapter one
 * kingdom embers". Scripts arrive from Docs, Word and chat assistants wearing
 * markdown; the narration must wear none of it.
 *
 * ONE CLEANING, BEFORE THE SPLIT. splitScriptIntoSentences calls this first,
 * so the text TTS speaks and the text that becomes scenes are the same text
 * by construction — they cannot diverge.
 *
 * IDENTITY ON PLAIN PROSE — the regression guarantee. Every pattern here
 * anchors on markdown syntax (line-leading markers, paired delimiters,
 * bracket-paren links); ordinary narration passes through byte-identical, so
 * the working path's sentence arrays are unchanged. Paragraph breaks are NOT
 * newly preserved: the splitter has always collapsed all whitespace (the line
 * below this function's call site), and preserving them would move scene
 * boundaries on the path that works today — out of scope by instruction.
 */
export function sanitizeScript(text: string): string {
  return (
    text
      // Fenced code blocks: dropped whole — code is not narration.
      .replace(/```[\s\S]*?```/g, " ")
      // ATX headings: keep the heading text, lose the hashes.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      // Horizontal rules (---, ***, ___), a line of their own.
      .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
      // Blockquote markers.
      .replace(/^\s{0,3}>\s?/gm, "")
      // Bullet markers. The text of the item stays.
      .replace(/^\s{0,3}[-*+]\s+/gm, "")
      // Numbered-list markers ("1. " / "1) ") at line start only.
      .replace(/^\s{0,3}\d{1,3}[.)]\s+/gm, "")
      // Images: keep the alt text, lose the syntax.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Links: keep the link text.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Bold / italics / strikethrough: keep the emphasised words.
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/\*(?=\S)([^*]*\S)\*/g, "$1")
      // Underscore italics only at word boundaries, so snake_case survives.
      .replace(/\b_([^_\n]+)_\b/g, "$1")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      // Inline code: keep the content.
      .replace(/`([^`\n]+)`/g, "$1")
  );
}

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
  const text = sanitizeScript(script).replace(/\s+/g, " ").trim();
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
  const words = sanitizeScript(script).trim().split(/\s+/).filter(Boolean).length;
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

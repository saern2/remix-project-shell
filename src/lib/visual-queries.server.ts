// Server-only helper for turning scene sentences into concrete, visually
// searchable stock-footage phrases via Lovable AI Gateway.
//
// Matching is by explicit {idx}, never array position. The gateway is asked for
// JSON, but production model responses can still arrive fenced or malformed, so
// parsing is deliberately defensive and every missing item has a deterministic
// fallback query.

import { asyncPool } from "@/lib/clip-slices.server";

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";
const BATCH_SIZE = 12;
const BATCH_CONCURRENCY = 5;

const SYSTEM_PROMPT = `You convert narration sentences into short, CONCRETE, visually-searchable stock-footage phrases (3-8 words each).

Rules:
- Each phrase must describe something a camera can literally film: people, places, objects, actions, weather, scenery.
- Never output abstract nouns alone (e.g. "freedom", "success", "growth"). Ground abstractions in a concrete visual metaphor.
- Prefer everyday, common footage terms that would match stock libraries or public media archives.
- Preserve named entities, countries, cities, organizations, and public roles when they are visually searchable.
- Use the surrounding story context to keep consecutive clips coherent, but make each query specific to its own sentence.
- For geopolitics, diplomacy, and war analysis, prefer concrete visuals like country flags, maps, diplomats, press conferences, military briefings, borders, missiles, or newsrooms. Do not default every sentence to generic soldiers unless the sentence is actually about combat.
- No punctuation, no quotes, no leading articles ("the", "a"), lowercase preferred.
- 3-8 words. Never a full sentence.

Examples:
- "Success requires patience and discipline." -> "runner training empty stadium"
- "Our economy is entering a period of uncertainty." -> "stock market screens red charts"
- "She never gave up on her dream." -> "young woman painting late night"

Input: a JSON array of {"idx": number, "text": string} objects.
Output: STRICT JSON matching {"results": [{"idx": number, "query": string}, ...]}.
- Preserve each input's idx exactly in your output.
- Return one result per input idx. Never invent new idx values.
- No commentary, no extra keys.`;

type SceneInput = { idx: number; text: string };

export type VisualCategory = "war" | "crime" | "space";

export const CATEGORY_THEMES: Record<VisualCategory, string> = {
  war: "war military conflict",
  crime: "crime law enforcement",
  space: "space astronomy cosmos",
};

const KNOWN_ENTITY_TERMS: Array<[RegExp, string]> = [
  [/\b(?:u\.s\.|us|usa|united states|america|american|washington)\b/i, "united states"],
  [/\b(?:iran|iranian|tehran)\b/i, "iran"],
  [/\b(?:israel|israeli)\b/i, "israel"],
  [/\b(?:gaza|palestine|palestinian)\b/i, "palestine"],
  [/\b(?:russia|russian|moscow)\b/i, "russia"],
  [/\b(?:ukraine|ukrainian|kyiv|kiev)\b/i, "ukraine"],
  [/\b(?:china|chinese|beijing)\b/i, "china"],
  [/\b(?:white house|pentagon|congress|senate)\b/i, "washington politics"],
  [/\b(?:foreign minister|president|official|diplomat|negotiator)\b/i, "government officials"],
  [
    /\b(?:missile|drone|airstrike|ceasefire|negotiation\w*|sanction\w*|border)\b/i,
    "conflict diplomacy",
  ],
];

const STOP_WORDS = new Set([
  "a",
  "after",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "no",
  "of",
  "on",
  "or",
  "the",
  "their",
  "there",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

function categoryInstruction(category: VisualCategory): string {
  const examples = {
    war: "If the script mentions Iran and the United States, use visuals like iran united states flags, tehran washington map, diplomats press conference, missile defense system, or war room briefing when appropriate.",
    crime:
      "If the script mentions named people, cities, agencies, evidence, money, courts, or police, preserve those details in the query instead of using generic crime footage.",
    space:
      "Use literal astronomy subjects and mission-searchable terms such as rogue planet, solar system formation, milky way stars, space telescope, icy moon ocean, or planetary scientist. Keep calls to action visually inside the same cosmic story.",
  } satisfies Record<VisualCategory, string>;

  return `\n\nUse the ${CATEGORY_THEMES[category]} theme as a visual lane, not as a replacement for the sentence. Preserve concrete story entities first, then express them through the theme. ${examples[category]}`;
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractBalancedJson(content: string): string | null {
  const source = stripCodeFence(content);
  const objectStart = source.indexOf("{");
  const arrayStart = source.indexOf("[");
  const start =
    objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) return null;
      if (stack.length === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function parseVisualQueryContent(content: string): unknown {
  const direct = stripCodeFence(content);
  try {
    return JSON.parse(direct);
  } catch {
    const extracted = extractBalancedJson(content);
    if (!extracted) throw new Error("AI returned invalid JSON for visual queries.");
    try {
      return JSON.parse(extracted);
    } catch {
      throw new Error("AI returned invalid JSON for visual queries.");
    }
  }
}

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const normalized = normalizeQuery(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractKnownEntityTerms(text: string): string[] {
  return uniqueTerms(
    KNOWN_ENTITY_TERMS.filter(([pattern]) => pattern.test(text)).map(([, term]) => term),
  );
}

function narrativeContextTerms(items: SceneInput[]): string[] {
  const text = items.map((item) => item.text).join(" ");
  return uniqueTerms(extractKnownEntityTerms(text)).slice(0, 6);
}

function sceneContextTerms(items: SceneInput[], index: number): string[] {
  const windowText = items
    .slice(Math.max(0, index - 1), Math.min(items.length, index + 2))
    .map((item) => item.text)
    .join(" ");
  return uniqueTerms(extractKnownEntityTerms(windowText)).slice(0, 5);
}

function mapFromParsed(parsed: unknown, items: SceneInput[]): Map<number, string> {
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { results?: unknown }).results)
      ? (parsed as { results: unknown[] }).results
      : Array.isArray((parsed as { queries?: unknown }).queries)
        ? (parsed as { queries: unknown[] }).queries
        : null;
  if (!raw) throw new Error("AI response missing results array.");

  const allowed = new Set(items.map((i) => i.idx));
  const map = new Map<number, string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { idx?: unknown; query?: unknown };
    if (typeof e.idx !== "number" || !allowed.has(e.idx)) continue;
    if (typeof e.query !== "string") continue;
    const q = normalizeQuery(e.query);
    if (q) map.set(e.idx, q);
  }
  return map;
}

export function fallbackVisualQuery(text: string, category: VisualCategory | null = null): string {
  const entityTerms = extractKnownEntityTerms(text);
  const categoryWords = category ? CATEGORY_THEMES[category].split(/\s+/) : [];
  const entityWords = new Set([
    ...entityTerms.flatMap((term) => term.split(/\s+/)),
    ...categoryWords,
  ]);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !entityWords.has(word))
    .slice(0, 4);

  const baseTerms = [
    ...entityTerms,
    ...(words.length > 0 ? [words.join(" ")] : ["people outdoor scene"]),
  ];
  const base = uniqueTerms(baseTerms).join(" ");
  return category
    ? `${base} ${CATEGORY_THEMES[category]}`.split(/\s+/).slice(0, 8).join(" ")
    : base.split(/\s+/).slice(0, 8).join(" ");
}

async function callGateway(
  items: SceneInput[],
  category: VisualCategory | null,
): Promise<Map<number, string>> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured.");

  const systemPrompt =
    category === null ? SYSTEM_PROMPT : SYSTEM_PROMPT + categoryInstruction(category);

  const narrativeTerms = narrativeContextTerms(items);
  const contextualItems = items.map((item, index) => ({
    ...item,
    context_terms: sceneContextTerms(items, index),
  }));
  const userPrompt = `Convert each of the following ${items.length} narration sentences into a concrete visual stock-footage phrase. Return one entry per input idx.

Project context terms: ${narrativeTerms.length ? narrativeTerms.join(", ") : "none"}

Input:
${JSON.stringify(contextualItems)}`;

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    if (res.status === 429) throw new Error("AI rate limit reached. Please retry in a moment.");
    if (res.status === 402) throw new Error("AI credits exhausted. Add credits to continue.");
    throw new Error(`Visual query generation failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI response was empty.");

  return mapFromParsed(parseVisualQueryContent(content), items);
}

async function callGatewayWithRetry(
  items: SceneInput[],
  category: VisualCategory | null,
): Promise<Map<number, string>> {
  try {
    return await callGateway(items, category);
  } catch (firstErr) {
    try {
      return await callGateway(items, category);
    } catch {
      console.warn("[visual-queries:fallback]", {
        scenes: items.map((item) => item.idx),
        reason: firstErr instanceof Error ? firstErr.message : "gateway failed",
      });
      return new Map();
    }
  }
}

export async function generateVisualQueries(
  sentences: string[],
  category: VisualCategory | null = null,
): Promise<string[]> {
  if (sentences.length === 0) return [];

  const items: SceneInput[] = sentences.map((s, idx) => ({
    idx,
    text: s.replace(/\s+/g, " ").trim(),
  }));

  const map = new Map<number, string>();
  const batches = Array.from({ length: Math.ceil(items.length / BATCH_SIZE) }, (_, index) =>
    items.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
  );
  await asyncPool(batches, BATCH_CONCURRENCY, async (batch) => {
    const batchMap = await callGatewayWithRetry(batch, category);
    for (const [idx, q] of batchMap) map.set(idx, q);

    const missing = batch.filter((item) => !map.has(item.idx));
    if (missing.length > 0) {
      const retryMap = await callGatewayWithRetry(missing, category);
      for (const [idx, q] of retryMap) map.set(idx, q);
    }

    for (const item of batch) {
      if (!map.has(item.idx)) {
        map.set(item.idx, fallbackVisualQuery(item.text, category));
      }
    }
  });

  return items.map((item) => map.get(item.idx) ?? fallbackVisualQuery(item.text, category));
}

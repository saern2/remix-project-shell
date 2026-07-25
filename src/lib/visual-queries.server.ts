// Server-only helper for turning scene sentences into concrete, visually
// searchable stock-footage phrases via Lovable AI Gateway.
//
// Matching is by explicit {idx} — never by array position — because the
// model can drop, reorder, or duplicate entries. Missing idx values are
// retried once in a small follow-up call before we give up.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

const SYSTEM_PROMPT = `You convert narration sentences into short, CONCRETE, visually-searchable stock-footage phrases (3-6 words each).

Rules:
- Each phrase must describe something a camera can literally film: people, places, objects, actions, weather, scenery.
- Never output abstract nouns alone (e.g. "freedom", "success", "growth"). Ground abstractions in a concrete visual metaphor.
- Prefer everyday, common footage terms that would match stock libraries (Pexels, Pixabay).
- No punctuation, no quotes, no leading articles ("the", "a"), lowercase preferred.
- 3-6 words. Never a full sentence.

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

export type VisualCategory = "war" | "crime";

const CATEGORY_THEMES: Record<VisualCategory, string> = {
  war: "war/military conflict",
  crime: "crime/law enforcement",
};

function categoryInstruction(category: VisualCategory): string {
  return `\n\nEvery visual query you generate MUST stay within the ${CATEGORY_THEMES[category]} visual theme, even when the narration sentence itself is unrelated or neutral — find the closest on-theme concrete visual interpretation rather than a literal one.`;
}

async function callGateway(
  items: SceneInput[],
  category: VisualCategory | null,
): Promise<Map<number, string>> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured.");

  const systemPrompt =
    category === null ? SYSTEM_PROMPT : SYSTEM_PROMPT + categoryInstruction(category);

  const userPrompt = `Convert each of the following ${items.length} narration sentences into a concrete visual stock-footage phrase. Return one entry per input idx.\n\nInput:\n${JSON.stringify(items)}`;

  const res = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI returned invalid JSON for visual queries.");
  }

  // Accept either { results: [...] } or a bare array, for resilience.
  const raw =
    Array.isArray(parsed)
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
    const q = e.query.trim().toLowerCase();
    if (!q) continue;
    map.set(e.idx, q);
  }
  return map;
}

export async function generateVisualQueries(sentences: string[]): Promise<string[]> {
  if (sentences.length === 0) return [];

  const items: SceneInput[] = sentences.map((s, idx) => ({
    idx,
    text: s.replace(/\s+/g, " ").trim(),
  }));

  const map = await callGateway(items);

  // Retry only missing idx values, in one follow-up call.
  const missing = items.filter((i) => !map.has(i.idx));
  if (missing.length > 0) {
    try {
      const retryMap = await callGateway(missing);
      for (const [idx, q] of retryMap) map.set(idx, q);
    } catch {
      // Swallow retry error; the check below produces a clearer message.
    }
  }

  const result: string[] = [];
  for (const item of items) {
    const q = map.get(item.idx);
    if (!q) {
      throw new Error(
        `Visual query generation failed for scene ${item.idx + 1} after retry.`,
      );
    }
    result.push(q);
  }
  return result;
}

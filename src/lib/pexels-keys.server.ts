export type PexelsKeyValidation = {
  status: "valid" | "invalid" | "unverified";
  detail: string;
};

type ValidationOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

const VALIDATION_URL = "https://api.pexels.com/videos/search?query=nature&per_page=1";
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export function pexelsKeyActiveAfterValidation(
  currentlyActive: boolean,
  validation: PexelsKeyValidation["status"],
): boolean {
  if (validation === "valid") return true;
  if (validation === "invalid") return false;
  return currentlyActive;
}

export async function validatePexelsKey(
  key: string,
  options: ValidationOptions = {},
): Promise<PexelsKeyValidation> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let lastDetail = "Pexels validation was inconclusive.";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const response = await fetchImpl(VALIDATION_URL, {
        headers: { authorization: key },
      });
      if (response.ok) return { status: "valid", detail: "Pexels accepted the key." };
      if (response.status === 401 || response.status === 403) {
        return {
          status: "invalid",
          detail: `Pexels rejected the key (HTTP ${response.status}).`,
        };
      }
      lastDetail = `Pexels validation was inconclusive (HTTP ${response.status}).`;
    } catch (error) {
      lastDetail = `Pexels validation was inconclusive (${error instanceof Error ? error.message : "network error"}).`;
    }
  }

  return { status: "unverified", detail: lastDetail };
}

export async function pacePexelsValidation(
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<void> {
  await sleep(250);
}

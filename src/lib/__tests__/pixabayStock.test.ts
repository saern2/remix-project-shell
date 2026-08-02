import { afterEach, describe, expect, it, vi } from "vitest";

import { pixabayProvider } from "../pixabayStock.server";

describe("Pixabay stock provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PIXABAY_API_KEY;
  });

  it("uses the video API contract and maps renditions into stock videos", async () => {
    process.env.PIXABAY_API_KEY = "pixabay-test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          hits: [
            {
              id: 42,
              duration: 14,
              tags: "galaxy, stars, space",
              videos: {
                large: {
                  url: "https://cdn.example.test/large.mp4",
                  width: 1920,
                  height: 1080,
                  thumbnail: "https://cdn.example.test/thumb.jpg",
                },
                small: {
                  url: "https://cdn.example.test/small.mp4",
                  width: 640,
                  height: 360,
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await pixabayProvider.search("milky way", "landscape", 2);

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe("https://pixabay.com/api/videos/");
    expect(url.searchParams.get("orientation")).toBe("horizontal");
    expect(url.searchParams.get("per_page")).toBe("80");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("safesearch")).toBe("true");
    expect(result).toEqual([
      expect.objectContaining({
        provider: "pixabay",
        provider_clip_id: "42",
        duration_sec: 14,
        thumbnail_url: "https://cdn.example.test/thumb.jpg",
        keywords: ["galaxy", "stars", "space"],
      }),
    ]);
    expect(result[0].files).toHaveLength(2);
  });

  it("does not call Pixabay when no server-side key is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(pixabayProvider.search("planet", "landscape", 1)).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

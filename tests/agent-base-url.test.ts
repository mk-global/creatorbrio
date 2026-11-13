import { describe, it, expect } from "vitest";
import { resolveAppOrigin } from "@/lib/request-origin";
import { buildSystemPrompt, type PromptCarousel } from "@/lib/chat-system-prompt";
import { DEFAULT_BRAND } from "@/types/brand";

function requestOn(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("resolveAppOrigin", () => {
  it("uses the port the request actually arrived on", () => {
    expect(
      resolveAppOrigin(
        requestOn("http://localhost:3001/api/chat", { host: "localhost:3001" })
      )
    ).toBe("http://localhost:3001");
  });

  it("keeps the default port implicit when that is how the client addressed it", () => {
    expect(
      resolveAppOrigin(
        requestOn("http://localhost:3000/api/chat", { host: "localhost:3000" })
      )
    ).toBe("http://localhost:3000");
  });

  it("prefers the host header over the request URL's authority", () => {
    // The header is the authority the client actually reached, so it carries
    // the real port even when the URL seen by the handler says otherwise.
    expect(
      resolveAppOrigin(
        requestOn("http://localhost:3000/api/chat", { host: "127.0.0.1:4321" })
      )
    ).toBe("http://127.0.0.1:4321");
  });

  it("preserves the scheme of the request", () => {
    expect(
      resolveAppOrigin(
        requestOn("https://example.test/api/chat", { host: "example.test" })
      )
    ).toBe("https://example.test");
  });

  it("falls back to the request URL when there is no host header", () => {
    const request = new Request("http://localhost:3007/api/chat");
    request.headers.delete("host");
    expect(resolveAppOrigin(request)).toBe("http://localhost:3007");
  });
});

describe("buildSystemPrompt", () => {
  const carousel = {
    id: "carousel-abc",
    name: "Test",
    aspectRatio: "4:5",
    slides: [],
    referenceImages: [],
    chatSessionId: null,
    isTemplate: false,
    tags: [],
    createdAt: "",
    updatedAt: "",
  } as PromptCarousel;

  it("points every API example at the running instance", () => {
    const prompt = buildSystemPrompt({
      baseUrl: "http://localhost:3001",
      brand: DEFAULT_BRAND,
      carousel,
    });

    // The agent writes slides back through these commands. If they name the
    // wrong port the writes land somewhere else, or nowhere.
    expect(prompt).toContain(
      "http://localhost:3001/api/carousels/carousel-abc/slides"
    );
    expect(prompt).toContain(
      "http://localhost:3001/api/carousels/carousel-abc/caption"
    );
    expect(prompt).toContain("http://localhost:3001/api/style-presets");
  });

  it("never hardcodes a port the app is not running on", () => {
    const prompt = buildSystemPrompt({
      baseUrl: "http://localhost:4123",
      brand: DEFAULT_BRAND,
      carousel,
    });
    expect(prompt).not.toContain("localhost:3000");
  });

  it("uses the given origin even with no carousel in context", () => {
    const prompt = buildSystemPrompt({
      baseUrl: "http://127.0.0.1:8080",
      brand: DEFAULT_BRAND,
    });
    expect(prompt).toContain("http://127.0.0.1:8080/api/carousels/{ID}/slides");
    expect(prompt).not.toContain("localhost:3000");
  });
});

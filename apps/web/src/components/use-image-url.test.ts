import { describe, expect, it } from "vitest";
import { imageUrlPollInterval } from "./use-image-url";

describe("private image URL refresh", () => {
  it("bounds pending polling and refreshes ready URLs before expiry", () => {
    expect(
      imageUrlPollInterval({ status: "queued", expiresInSeconds: 0 }, 1),
    ).toBe(2000);
    expect(
      imageUrlPollInterval({ status: "processing", expiresInSeconds: 0 }, 12),
    ).toBe(false);
    expect(
      imageUrlPollInterval({ status: "ready", expiresInSeconds: 300 }, 1),
    ).toBe(270000);
  });
});

import { describe, expect, it } from "vitest";
import { isDisplayableImageUrl } from "./media-url";

describe("displayable image URLs", () => {
  it("accepts signed same-origin API paths used by local development storage", () => {
    expect(isDisplayableImageUrl("/api/local-files/payload.signature")).toBe(
      true,
    );
  });

  it("rejects protocol-relative and executable URLs", () => {
    expect(isDisplayableImageUrl("//example.test/image.png")).toBe(false);
    expect(isDisplayableImageUrl("javascript:alert(1)")).toBe(false);
  });
});

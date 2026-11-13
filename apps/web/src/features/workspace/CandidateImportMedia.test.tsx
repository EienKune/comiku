import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CandidateImportThumbnail } from "./CandidateImportMedia";
import { useImageUrl } from "../../components/use-image-url";

vi.mock("../../components/use-image-url", () => ({
  useImageUrl: vi.fn((key: readonly string[]) => ({
    data: { url: `https://example.invalid/${key.at(-1)}.png` },
  })),
}));
afterEach(() => {
  cleanup();
  vi.mocked(useImageUrl).mockClear();
});
test("unchanged thumbnail props retain query and visibility work while changed media updates the image", () => {
  const view = render(
    <CandidateImportThumbnail candidateId="post" mediaId="one" />,
  );
  const calls = vi.mocked(useImageUrl).mock.calls.length;
  for (let index = 0; index < 20; index++)
    view.rerender(
      <CandidateImportThumbnail candidateId="post" mediaId="one" />,
    );
  expect(vi.mocked(useImageUrl).mock.calls.length).toBe(calls);
  view.rerender(<CandidateImportThumbnail candidateId="post" mediaId="two" />);
  expect(vi.mocked(useImageUrl).mock.calls.length).toBeGreaterThan(calls);
  expect(screen.getByRole("presentation").getAttribute("src")).toBe(
    "https://example.invalid/two.png",
  );
});

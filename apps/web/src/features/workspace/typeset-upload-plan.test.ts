import { expect, test } from "vitest";
import {
  initialTypesetUploadImages,
  typesetUploadGroupProblem,
} from "./typeset-upload-plan";
import type { components } from "@comiku/api-client";

function session() {
  return {
    id: "session",
    status: "previewed",
    expiresAt: "2030-01-01T00:00:00Z",
    maxWorks: 20,
    maxTotalBytes: 512 * 1024 * 1024,
    files: [
      {
        id: "zip1",
        sourceName: "139.zip",
        archive: true,
        status: "processed",
        error: null,
        upload: null,
        images: [10, 2].map((page) => ({
          id: `image${page}`,
          uploadFileId: "zip1",
          sourceName: `139-${page}成图.png`,
          width: 100,
          height: 100,
          size: 20,
          workNumber: 139,
          pageNumber: page,
          warnings: [],
        })),
      },
    ],
  } satisfies components["schemas"]["TypesetUploadSessionDto"];
}
test("batch preview sorts unique numeric pages and retains arbitrary explanation order", () => {
  const input = session();
  expect(
    initialTypesetUploadImages(input).map((image) => image.pageNumber),
  ).toEqual([2, 10]);
  input.files[0].images[1] = {
    ...input.files[0].images[1],
    pageNumber: null,
    sourceName: "说明.png",
  } as never;
  expect(
    initialTypesetUploadImages(input).map((image) => image.sourceName),
  ).toEqual(["139-10成图.png", "说明.png"]);
});
test("batch preview requires explicit merge and catches original/rendered page duplication", () => {
  const images = initialTypesetUploadImages(session());
  images[1].uploadFileId = "zip2";
  expect(typesetUploadGroupProblem(images, false)).toMatch(/合并/);
  expect(typesetUploadGroupProblem(images, true)).toBeNull();
  images[1].archive = false;
  expect(typesetUploadGroupProblem(images, false)).toMatch(/合并/);
  images[1].pageNumber = images[0].pageNumber;
  expect(typesetUploadGroupProblem(images, true)).toMatch(/重复/);
});

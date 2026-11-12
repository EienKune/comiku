import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ImageSimilarityController } from "../src/image-similarity/image-similarity.controller.js";
import { ImageSimilarityService } from "../src/image-similarity/image-similarity.service.js";
import { WorkSeriesController } from "../src/work-series/work-series.controller.js";
import { WorkSeriesService } from "../src/work-series/work-series.service.js";
import { WorksController } from "../src/works/works.controller.js";
import { WorksService } from "../src/works/works.service.js";

test("work discovery contracts retain primitive identity types and complete route inputs", async () => {
  const module = await Test.createTestingModule({
    controllers: [
      ImageSimilarityController,
      WorkSeriesController,
      WorksController,
    ],
    providers: [ImageSimilarityService, WorkSeriesService, WorksService].map(
      (provide) => ({ provide, useValue: {} }),
    ),
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  try {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("Work discovery contract fixture").build(),
    );
    const schema = doc.components!.schemas!;
    const match = schema.ImageSimilarityMatchDto;
    assert.ok(!("$ref" in match));
    for (const [key, type] of Object.entries({
      workId: "string",
      workNumber: "number",
      imageId: "string",
      imageCount: "number",
      index: "number",
      archived: "boolean",
      distance: "number",
      authorId: "string",
      authorName: "string",
      matchKind: "string",
      reviewStatus: "string",
    })) {
      const property: unknown = match.properties![key];
      assert.ok(
        property &&
          typeof property === "object" &&
          "type" in property &&
          !("$ref" in property),
      );
      assert.equal(property.type, type, key);
    }
    const coverage = schema.ImageSimilarityCoverageDto;
    assert.ok(!("$ref" in coverage));
    for (const key of ["total", "ready", "pending", "failed"]) {
      const property: unknown = coverage.properties![key];
      assert.ok(
        property &&
          typeof property === "object" &&
          "type" in property &&
          !("$ref" in property),
      );
      assert.equal(property.type, "number", key);
    }
    const prepare =
      doc.paths[
        "/api/image-similarity/candidates/{candidateId}/media/{mediaId}/search"
      ]!.post!;
    assert.deepEqual(
      prepare.parameters!.map((p) => ("name" in p ? p.name : "")).sort(),
      ["candidateId", "mediaId"],
    );
    assert.ok(doc.paths["/api/work-series"]!.post!.requestBody);
    assert.ok(
      doc.paths["/api/work-series/{id}/entries/{entryId}"]!.patch!.requestBody,
    );
    const album = doc.paths["/api/works/album"]!.get!;
    assert.equal(album.operationId, "listWorkAlbumImages");
    assert.ok(
      album.parameters!.some((p) => "name" in p && p.name === "cursor"),
    );
  } finally {
    await app.close();
  }
});

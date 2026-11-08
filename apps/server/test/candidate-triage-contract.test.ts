import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CandidateQueryDto } from "../src/candidates/candidates.dto.js";
import { CandidatesController } from "../src/candidates/candidates.controller.js";

test("three review groups replace photo routing and the classification write endpoint", async () => {
  for (const triageGroup of ["priority", "uncertain", "low_priority"])
    assert.deepEqual(
      await validate(plainToInstance(CandidateQueryDto, { triageGroup })),
      [],
    );
  assert.ok(
    (
      await validate(
        plainToInstance(CandidateQueryDto, { triageGroup: "photo" }),
      )
    ).length > 0,
  );
  assert.equal("setClassification" in CandidatesController.prototype, false);
});

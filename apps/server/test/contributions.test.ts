import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ContributionDetailsQueryDto } from "../src/dashboard/contributions.dto.js";
import {
  contributionAchievements,
  shanghaiMonth,
} from "../src/dashboard/contributions.service.js";

test("Shanghai month boundaries use a half-open local month across UTC dates and years", () => {
  assert.deepEqual(shanghaiMonth(new Date("2026-10-31T15:59:59.999Z")), {
    month: "2026-10",
    start: new Date("2026-09-30T16:00:00Z"),
    end: new Date("2026-10-31T16:00:00Z"),
  });
  assert.deepEqual(shanghaiMonth(new Date("2026-12-31T16:00:00Z")), {
    month: "2027-01",
    start: new Date("2026-12-31T16:00:00Z"),
    end: new Date("2027-01-31T16:00:00Z"),
  });
});

test("achievements derive from current lifetime credits and can revert after cancellation", () => {
  const counts = {
    translate: 7,
    proofread: 0,
    typeset: 1,
    works: 7,
    published: 0,
    tasks: 3,
  };
  const result = contributionAchievements(counts, true);
  assert.equal(result.find((item) => item.id === "translate-10")?.progress, 7);
  assert.equal(
    result.find((item) => item.id === "translate-10")?.achieved,
    false,
  );
  assert.equal(result.find((item) => item.id === "versatile")?.achieved, true);
  const reverted = contributionAchievements(
    { ...counts, translate: 0, typeset: 0 },
    false,
  );
  assert.ok(reverted.every((item) => !item.achieved));
});

test("contribution details validate scope, stable identities and bounded pagination", async () => {
  assert.deepEqual(
    await validate(
      plainToInstance(ContributionDetailsQueryDto, {
        metric: "works",
        offset: "20",
        limit: "50",
      }),
    ),
    [],
  );
  for (const changed of [
    { metric: "publish" },
    { scope: "everyone" },
    { userId: "nickname" },
    { offset: -1 },
    { offset: 100001 },
    { limit: 51 },
    { limit: 0 },
    { period: "daily" },
  ])
    assert.ok(
      (
        await validate(
          plainToInstance(ContributionDetailsQueryDto, {
            metric: "works",
            ...changed,
          }),
        )
      ).length > 0,
    );
});

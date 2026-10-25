import assert from "node:assert/strict";
import test from "node:test";
import {
  LanguageCapability,
  Role,
  SourceLanguage,
  WorkStage,
} from "../src/generated/prisma/client.js";
import { canUserWorkStage } from "../src/workflow/workflow-policy.js";

test("Japanese and Korean text work requires the matching capability", () => {
  assert.equal(
    canUserWorkStage(
      [Role.translator],
      [LanguageCapability.ja],
      WorkStage.translate,
      SourceLanguage.ja,
    ),
    true,
  );
  assert.equal(
    canUserWorkStage(
      [Role.translator],
      [LanguageCapability.ja],
      WorkStage.translate,
      SourceLanguage.ko,
    ),
    false,
  );
  assert.equal(
    canUserWorkStage(
      [Role.proofreader],
      [LanguageCapability.ko],
      WorkStage.proofread,
      SourceLanguage.ko,
    ),
    true,
  );
});

test("English is implicit and typesetters may translate it", () => {
  assert.equal(
    canUserWorkStage(
      [Role.typesetter],
      [],
      WorkStage.translate,
      SourceLanguage.en,
    ),
    true,
  );
  assert.equal(
    canUserWorkStage(
      [Role.typesetter],
      [],
      WorkStage.proofread,
      SourceLanguage.en,
    ),
    false,
  );
  assert.equal(
    canUserWorkStage(
      [Role.proofreader],
      [],
      WorkStage.proofread,
      SourceLanguage.en,
    ),
    true,
  );
});

test("administration alone never grants coordinated work qualification", () => {
  for (const stage of [
    WorkStage.translate,
    WorkStage.proofread,
    WorkStage.typeset,
  ]) {
    for (const language of [SourceLanguage.ja, SourceLanguage.en]) {
      assert.equal(
        canUserWorkStage(
          [Role.admin],
          [LanguageCapability.ja],
          stage,
          language,
        ),
        false,
      );
    }
  }
  assert.equal(
    canUserWorkStage(
      [Role.admin, Role.proofreader],
      [LanguageCapability.ja],
      WorkStage.proofread,
      SourceLanguage.ja,
    ),
    true,
  );
  assert.equal(
    canUserWorkStage(
      [Role.admin, Role.translator],
      [],
      WorkStage.translate,
      SourceLanguage.ja,
    ),
    false,
  );
});

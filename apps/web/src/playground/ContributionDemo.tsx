import { useState } from "react";
import type { components } from "@comiku/api-client";
import {
  ContributionAchievements,
  ContributionOverview,
} from "../features/contributions/ContributionsPage";

const sample: components["schemas"]["ContributionSummaryDto"] = {
  period: "month",
  scope: "personal",
  userId: "00000000-0000-4000-8000-000000000001",
  month: "2026-11",
  timezone: "Asia/Shanghai",
  counts: {
    translate: 7,
    proofread: 2,
    typeset: 1,
    works: 8,
    published: 5,
    tasks: 3,
  },
  achievements: [
    {
      id: "first",
      name: "首次交付",
      condition: "完成任意一项制作职责",
      progress: 1,
      target: 1,
      achieved: true,
    },
    {
      id: "translate-10",
      name: "翻译 10 部",
      condition: "累计有效翻译交付 10 部",
      progress: 7,
      target: 10,
      achieved: false,
    },
    {
      id: "versatile",
      name: "多面手",
      condition: "至少两种制作职责各完成一次",
      progress: 2,
      target: 2,
      achieved: true,
    },
  ],
};
export function ContributionDemo() {
  const [selected, setSelected] = useState<keyof typeof sample.counts | null>(
    null,
  );
  return (
    <section className="contribution-page" aria-label="贡献与成就示例">
      <h3>贡献与成就</h3>
      <ContributionOverview
        summary={sample}
        selected={selected}
        onSelect={setSelected}
      />
      <ContributionAchievements achievements={sample.achievements} />
    </section>
  );
}

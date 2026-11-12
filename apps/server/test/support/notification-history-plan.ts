import assert from "node:assert/strict";

export type QueryPlan = {
  "Node Type": string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: QueryPlan[];
};
export type QueryExplain = { "QUERY PLAN": { Plan: QueryPlan }[] }[];
type Page = "unfiltered" | "common-status" | "sparse-status";
const timeIndex = "notification_deliveries_created_at_id_idx";
const statusIndex = "notification_deliveries_status_created_at_id_idx";

/** Assert bounded work, not one PostgreSQL version's preferred plan shape. */
export function assertNotificationHistoryPlan(
  label: Page,
  explain: QueryExplain,
) {
  const evidence = JSON.stringify({ label, explain });
  const root = explain[0]?.["QUERY PLAN"][0]?.Plan;
  assert.ok(root, evidence);
  const nodes = (plan: QueryPlan): QueryPlan[] => [
    plan,
    ...(plan.Plans ?? []).flatMap(nodes),
  ];
  const all = nodes(root);
  const maxScanned = label === "common-status" ? 150 : 75;
  const allowedIndexes =
    label === "unfiltered"
      ? [timeIndex]
      : label === "common-status"
        ? [timeIndex, statusIndex]
        : null;
  const work = (plan: QueryPlan) =>
    (plan["Actual Rows"] +
      (plan["Rows Removed by Filter"] ?? 0) +
      (plan["Rows Removed by Index Recheck"] ?? 0)) *
    plan["Actual Loops"];
  assert.equal(root["Node Type"], "Limit", evidence);
  assert.equal(root["Actual Rows"], 50, evidence);
  assert.ok(
    all.every((plan) => !/Seq Scan/.test(plan["Node Type"])),
    evidence,
  );
  const sorts = all.filter((plan) => /Sort/.test(plan["Node Type"]));
  assert.ok(
    sorts.length === 0 ||
      (label === "sparse-status" &&
        all.every((plan) => work(plan) <= maxScanned)),
    evidence,
  );
  const scans = all.filter((plan) => plan["Index Name"]);
  assert.equal(scans.length, 1, evidence);
  const scan = scans[0]!;
  if (allowedIndexes)
    assert.ok(allowedIndexes.includes(scan["Index Name"]!), evidence);
  if (label === "sparse-status") {
    assert.match(
      scan["Index Cond"] ?? "",
      /\bstatus\b.*=.*'cancelled'/,
      evidence,
    );
    // A lossy bitmap heap recheck must not hide work behind a small index node.
    assert.ok(
      all.every((plan) => work(plan) <= maxScanned),
      evidence,
    );
  }
  const scanned = work(scan);
  assert.ok(scanned >= 50 && scanned <= maxScanned, evidence);
  return {
    label,
    index: scan["Index Name"],
    node: scan["Node Type"],
    rows: scan["Actual Rows"],
    filtered: scan["Rows Removed by Filter"] ?? 0,
    scanned,
  };
}

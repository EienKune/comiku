import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNotificationHistoryPlan,
  type QueryPlan,
  type QueryExplain,
} from "./support/notification-history-plan.js";

const index = (extra: Partial<QueryPlan> = {}): QueryPlan => ({
  "Node Type": "Index Scan",
  "Index Name": "notification_deliveries_status_created_at_id_idx",
  "Index Cond": "((status)::text = 'cancelled'::text)",
  "Actual Rows": 50,
  "Actual Loops": 1,
  ...extra,
});
const explain = (child: QueryPlan): QueryExplain => [
  {
    "QUERY PLAN": [
      {
        Plan: {
          "Node Type": "Limit",
          "Actual Rows": 50,
          "Actual Loops": 1,
          Plans: [child],
        },
      },
    ],
  },
];
const bitmap = () =>
  explain({
    "Node Type": "Sort",
    "Actual Rows": 50,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Bitmap Heap Scan",
        "Actual Rows": 53,
        "Actual Loops": 1,
        Plans: [
          index({
            "Node Type": "Bitmap Index Scan",
            "Index Name":
              "notification_deliveries_status_next_attempt_at_created_at_idx",
            "Actual Rows": 57,
          }),
        ],
      },
    ],
  });

test("sparse history accepts PostgreSQL 17's bounded status bitmap range and small sort", () => {
  const result = assertNotificationHistoryPlan("sparse-status", bitmap());
  assert.equal(result.scanned, 57);
});
test("sparse history accepts ordered status scans and PostgreSQL 18's bounded skip scan", () => {
  assertNotificationHistoryPlan("sparse-status", explain(index()));
  assertNotificationHistoryPlan(
    "sparse-status",
    explain({
      "Node Type": "Sort",
      "Actual Rows": 50,
      "Actual Loops": 1,
      Plans: [
        index({
          "Index Name":
            "notification_deliveries_channel_id_status_resolved_at_idx",
          "Actual Rows": 53,
        }),
      ],
    }),
  );
});
test("sparse history still rejects excessive index work or repeated scans", () => {
  for (const extra of [
    { "Actual Rows": 76 },
    { "Rows Removed by Filter": 26 },
    { "Rows Removed by Index Recheck": 26 },
    { "Actual Loops": 2 },
  ])
    assert.throws(() =>
      assertNotificationHistoryPlan("sparse-status", explain(index(extra))),
    );
});
test("lossy bitmap heap filtering cannot escape the sparse history work limit", () => {
  for (const field of [
    "Rows Removed by Index Recheck",
    "Rows Removed by Filter",
  ] as const) {
    const value = bitmap();
    value[0]["QUERY PLAN"][0].Plan.Plans![0].Plans![0][field] = 30;
    assert.throws(() => assertNotificationHistoryPlan("sparse-status", value));
  }
});
test("LIMIT cannot conceal large sort inputs or multiple index scans", () => {
  const oversized = bitmap();
  oversized[0]["QUERY PLAN"][0].Plan.Plans![0].Plans![0]["Actual Rows"] = 76;
  assert.throws(() =>
    assertNotificationHistoryPlan("sparse-status", oversized),
  );
  const multiple = bitmap();
  multiple[0]["QUERY PLAN"][0].Plan.Plans![0].Plans![0].Plans!.push(index());
  assert.throws(() => assertNotificationHistoryPlan("sparse-status", multiple));
});
test("sparse history rejects a scan that does not constrain status at the index", () => {
  assert.throws(() =>
    assertNotificationHistoryPlan(
      "sparse-status",
      explain(index({ "Index Cond": "(created_at < now())" })),
    ),
  );
});
test("all history pages reject sequential scans and the normal pages reject sorts", () => {
  for (const label of ["unfiltered", "common-status", "sparse-status"] as const)
    assert.throws(() =>
      assertNotificationHistoryPlan(
        label,
        explain({
          "Node Type": "Append",
          "Actual Rows": 50,
          "Actual Loops": 1,
          Plans: [
            index({
              "Index Name":
                label === "sparse-status"
                  ? "notification_deliveries_status_created_at_id_idx"
                  : "notification_deliveries_created_at_id_idx",
            }),
            { "Node Type": "Seq Scan", "Actual Rows": 1, "Actual Loops": 1 },
          ],
        }),
      ),
    );
  for (const label of ["unfiltered", "common-status"] as const)
    assert.throws(() => assertNotificationHistoryPlan(label, bitmap()));
});
test("unfiltered and common-status history retain their existing index and scan budgets", () => {
  assertNotificationHistoryPlan(
    "unfiltered",
    explain(
      index({ "Index Name": "notification_deliveries_created_at_id_idx" }),
    ),
  );
  assertNotificationHistoryPlan(
    "common-status",
    explain(
      index({
        "Index Name": "notification_deliveries_created_at_id_idx",
        "Rows Removed by Filter": 100,
      }),
    ),
  );
  assert.throws(() =>
    assertNotificationHistoryPlan(
      "common-status",
      explain(index({ "Rows Removed by Filter": 101 })),
    ),
  );
  assert.throws(() =>
    assertNotificationHistoryPlan("unfiltered", explain(index())),
  );
});

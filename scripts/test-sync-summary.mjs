import assert from "node:assert/strict";
import { buildSyncSummary } from "./sync-summary.mjs";

const summary = buildSyncSummary({
  status: "성공",
  completedAt: "2026-07-28T01:02:03.000Z",
  sheetName: "4.2.2.59 (LS증권)",
  sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit?gid=123",
  snapshot: { previousColumn: "J", workColumn: "K" },
  schedule: {
    deadline: {
      cell: "K20",
      value: "2026.07.30",
      input: "2026.07.30"
    },
    testStartDate: "",
    testEndDate: ""
  },
  performance: { totalDurationMs: 12_345 },
  results: [
    {
      key: "MS-12756",
      action: "updated",
      rowNumber: 25,
      status: "개발완료"
    },
    {
      key: "MS-12847",
      action: "inserted",
      rowNumber: 26,
      status: "개발완료"
    }
  ],
  resultPath: "C:\\Result\\Jira-Sheets-작업결과-2026-07-28.txt"
});

assert.match(summary, /결과: 성공/);
assert.match(summary, /총 2건 \(추가 1건, 업데이트 1건\)/);
assert.match(summary, /MS-12756: 업데이트, 25행/);
assert.match(summary, /MS-12847: 추가, 26행/);
assert.match(summary, /배포 2026\.07\.30/);
assert.match(summary, /12\.3초/);
assert.match(summary, /Jira-Sheets-작업결과-2026-07-28\.txt/);

console.log("sync summary tests passed");

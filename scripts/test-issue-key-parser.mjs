import assert from "node:assert/strict";
import { extractIssueKeys } from "./issue-key-parser.mjs";

const pastedJiraResults = `
[MS-12045] - [KB증권] 자동결재선 기능
[MS-12816] - [KB증권] [231] [IMP-MS-091] 마이페이지 개선
새 기능
[MS-11586] - [KB증권] [REQ_MS_032-05] 그리드 정렬 기능 개선
버그\tMS-12871\t제목
MS-12045, MS-12877
QS-42 IRD-7 MDM-21 MDMS-3 MSUI-14 QSUI-8 MDMT-77
`;

assert.deepEqual(extractIssueKeys(pastedJiraResults), [
  "MS-12045",
  "MS-12816",
  "MS-11586",
  "MS-12871",
  "MS-12877",
  "QS-42",
  "IRD-7",
  "MDM-21",
  "MDMS-3",
  "MSUI-14",
  "QSUI-8",
  "MDMT-77"
]);
assert.deepEqual(extractIssueKeys("[REQ_MS_032-05] [IMP-MS-091]"), []);
assert.deepEqual(extractIssueKeys("ABC-123 OTHER-5"), []);
console.log("issue key parser tests passed");

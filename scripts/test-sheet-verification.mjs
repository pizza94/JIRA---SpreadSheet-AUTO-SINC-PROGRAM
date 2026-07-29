import assert from "node:assert/strict";
import {
  formatIssueRowMismatches,
  issueRowMismatches,
  normalizeVerificationValue
} from "./sheet-verification.mjs";

assert.equal(
  normalizeVerificationValue(
    "[QA] CDC 수정(I)테이블이 이관신청에서 조회되지않습니다 "
  ),
  "[QA] CDC 수정(I)테이블이 이관신청에서 조회되지않습니다"
);

assert.deepEqual(
  issueRowMismatches(
    {
      key: "ms-12872",
      title: "[QA] CDC 수정(I)테이블이 이관신청에서 조회되지않습니다",
      status: "테스트 완료",
      priority: "Medium",
      assignee: "한수진",
      snapshot: "테스트완료",
      reference: "n"
    },
    {
      key: "MS-12872",
      title: "[QA] CDC 수정(I)테이블이 이관신청에서 조회되지않습니다 ",
      status: "테스트 완료",
      priority: "Medium",
      assignee: "한수진",
      snapshot: "테스트완료",
      reference: "N"
    }
  ),
  []
);

const mismatches = issueRowMismatches(
  { key: "MS-12872", status: "개발완료" },
  { key: "MS-12872", status: "테스트 완료" }
);
assert.deepEqual(mismatches, [
  {
    field: "status",
    label: "상태",
    expected: "테스트 완료",
    actual: "개발완료"
  }
]);
assert.equal(
  formatIssueRowMismatches(mismatches),
  '상태(예상="테스트 완료", 실제="개발완료")'
);

console.log("sheet verification tests passed");

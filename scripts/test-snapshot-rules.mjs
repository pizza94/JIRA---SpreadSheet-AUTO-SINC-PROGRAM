import assert from "node:assert/strict";
import {
  carriedSnapshotValue,
  copiedSnapshotRepairValue,
  findBlankSnapshotWorkIndex,
  findHistoricalInactiveStyleSource,
  isKnownSnapshotDropdownValue,
  isSnapshotWorkHeader,
  isSnapshotWorkColumnReady,
  normalizeSnapshotValue,
  referenceValueForRun,
  SNAPSHOT_WORK_HEADER,
  snapshotCarryAction,
  snapshotValueForRun,
  shouldUseJiraStatusForSnapshot,
  shouldResetCarriedSnapshot
} from "./snapshot-rules.mjs";

assert.equal(SNAPSHOT_WORK_HEADER, "SNAPSHOT-");
assert.equal(isSnapshotWorkHeader("SNAPSHOT-"), true);
assert.equal(isSnapshotWorkHeader(" snapshot- "), true);
assert.equal(isSnapshotWorkHeader("SNAPSHOT-5"), false);
assert.equal(isKnownSnapshotDropdownValue("PASS"), true);
assert.equal(isKnownSnapshotDropdownValue("테스트완료"), true);
assert.equal(isKnownSnapshotDropdownValue("개발중"), true);
assert.equal(isKnownSnapshotDropdownValue("추가이슈"), true);
assert.equal(isKnownSnapshotDropdownValue(""), false);
assert.equal(isKnownSnapshotDropdownValue("임의값"), false);

assert.equal(referenceValueForRun("Y", false), "Y");
assert.equal(referenceValueForRun(" y ", false), "Y");
assert.equal(referenceValueForRun("N", false), "N");
assert.equal(referenceValueForRun("", false), "N");
assert.equal(referenceValueForRun("Y", true), "N");
assert.equal(
  isSnapshotWorkColumnReady(
    {
      hasBlankSnapshotWorkColumn: true,
      snapshotWorkIndex: 10,
      snapshotIndexes: [9],
      referenceIndex: 11
    },
    10
  ),
  true
);
assert.equal(
  isSnapshotWorkColumnReady(
    {
      hasBlankSnapshotWorkColumn: false,
      snapshotWorkIndex: 9,
      snapshotIndexes: [9],
      referenceIndex: 10
    },
    10
  ),
  false
);

assert.equal(normalizeSnapshotValue(" 재개발 요청 "), "재개발요청");
assert.equal(shouldResetCarriedSnapshot("inserted", "PASS"), true);
assert.equal(shouldResetCarriedSnapshot("updated", "추가이슈"), true);
assert.equal(shouldResetCarriedSnapshot("updated", "재개발 요청"), true);
assert.equal(shouldResetCarriedSnapshot("updated", "재개발"), true);
assert.equal(shouldResetCarriedSnapshot("updated", "PASS"), false);
assert.equal(shouldResetCarriedSnapshot("updated", "테스트완료"), false);
assert.equal(shouldResetCarriedSnapshot("updated", "테스트중"), false);
assert.equal(shouldResetCarriedSnapshot("updated", "보류"), false);
assert.equal(shouldResetCarriedSnapshot("updated", "반려"), false);
assert.equal(shouldResetCarriedSnapshot("updated", "현장확인"), false);
assert.equal(shouldResetCarriedSnapshot("updated", "테스트제외"), false);
assert.equal(carriedSnapshotValue("PASS"), "테스트완료");
assert.equal(carriedSnapshotValue(" pass "), "테스트완료");
assert.equal(carriedSnapshotValue("재개발요청"), "");
assert.equal(carriedSnapshotValue("재개발"), "");
assert.equal(carriedSnapshotValue("추가이슈"), "");
assert.equal(carriedSnapshotValue("테스트완료"), "테스트완료");
assert.equal(carriedSnapshotValue("테스트제외"), "테스트제외");
assert.equal(carriedSnapshotValue("테스트중"), "테스트중");
assert.equal(carriedSnapshotValue("개발중"), "개발중");
assert.equal(carriedSnapshotValue("보류"), "보류");
assert.equal(carriedSnapshotValue("반려"), "반려");
assert.equal(carriedSnapshotValue("현장확인"), "현장확인");
assert.equal(copiedSnapshotRepairValue("추가이슈", "추가이슈"), "");
assert.equal(copiedSnapshotRepairValue("재개발", "재개발"), "");
assert.equal(copiedSnapshotRepairValue("PASS", "PASS"), "테스트완료");
assert.equal(copiedSnapshotRepairValue("테스트중", "테스트중"), null);
assert.equal(copiedSnapshotRepairValue("테스트완료", "테스트완료"), null);
assert.equal(copiedSnapshotRepairValue("추가이슈", ""), null);
assert.equal(snapshotValueForRun("재개발", true), "");
assert.equal(snapshotValueForRun("재개발요청", true), "");
assert.equal(snapshotValueForRun("추가이슈", true), "");
assert.equal(shouldUseJiraStatusForSnapshot("테스트중", true), true);
assert.equal(shouldUseJiraStatusForSnapshot("개발중", true), true);
assert.equal(shouldUseJiraStatusForSnapshot("재개발", true), true);
assert.equal(shouldUseJiraStatusForSnapshot("재개발요청", true), true);
assert.equal(shouldUseJiraStatusForSnapshot("추가이슈", true), true);
assert.equal(shouldUseJiraStatusForSnapshot("테스트완료", true), false);
assert.equal(snapshotValueForRun("테스트중", true, "작업 진행중"), "개발중");
assert.equal(snapshotValueForRun("개발중", true, "개발 진행중"), "개발중");
assert.equal(snapshotValueForRun("재개발", true, "개발 예정"), "개발중");
assert.equal(snapshotValueForRun("재개발요청", true, "재 개발 요청"), "개발중");
assert.equal(snapshotValueForRun("추가이슈", true, "00.Backlog"), "개발중");
assert.equal(snapshotValueForRun("테스트중", true, "보류"), "보류");
assert.equal(snapshotValueForRun("개발중", true, "반려"), "반려");
assert.equal(snapshotValueForRun("추가이슈", true, "개발 완료"), "");
assert.equal(snapshotValueForRun("테스트중", true, "테스트 완료"), "");
assert.equal(snapshotValueForRun("테스트중", false, "개발 진행중"), "테스트중");
assert.equal(snapshotValueForRun("재개발", false), "");
assert.equal(snapshotValueForRun("PASS", false), "테스트완료");
assert.deepEqual(snapshotCarryAction("PASS", "테스트완료", false), {
  type: "none",
  value: "테스트완료"
});
assert.deepEqual(snapshotCarryAction("PASS", "PASS", false), {
  type: "set",
  value: "테스트완료"
});
assert.deepEqual(snapshotCarryAction("테스트중", "", false), {
  type: "set",
  value: "테스트중"
});
assert.deepEqual(snapshotCarryAction("테스트중", "테스트중", false), {
  type: "none",
  value: "테스트중"
});
assert.deepEqual(snapshotCarryAction("개발중", "", false), {
  type: "set",
  value: "개발중"
});
assert.deepEqual(snapshotCarryAction("개발중", "개발중", false), {
  type: "none",
  value: "개발중"
});
assert.deepEqual(snapshotCarryAction("테스트완료", "", false), {
  type: "set",
  value: "테스트완료"
});
assert.deepEqual(snapshotCarryAction("테스트완료", "테스트완료", false), {
  type: "none",
  value: "테스트완료"
});
assert.deepEqual(snapshotCarryAction("추가이슈", "", true), {
  type: "none",
  value: ""
});
assert.deepEqual(snapshotCarryAction("추가이슈", "추가이슈", true), {
  type: "clear",
  value: ""
});
assert.deepEqual(
  snapshotCarryAction("추가이슈", "", true, "개발 진행중"),
  {
    type: "set",
    value: "개발중"
  }
);
assert.deepEqual(
  snapshotCarryAction("테스트중", "테스트중", true, "개발 완료"),
  {
    type: "clear",
    value: ""
  }
);

assert.equal(
  findBlankSnapshotWorkIndex(
    ["번호", "", "", "SNAPSHOT-4", "", "참고사항여부"],
    [3],
    5
  ),
  4
);
assert.equal(
  findBlankSnapshotWorkIndex(
    ["번호", "", "", "SNAPSHOT-4", "SNAPSHOT-", "참고사항여부"],
    [3],
    5
  ),
  4
);
assert.equal(
  findBlankSnapshotWorkIndex(
    ["번호", "", "", "SNAPSHOT-4", "참고사항여부"],
    [3],
    4
  ),
  -1
);

const rows = [
  ["번호", "유형", "JIRA", "", "", "", "", "", "", "SNAPSHOT-1", "SNAPSHOT-2"],
  ["1", "버그", "MS-1", "", "", "", "", "", "", "", "PASS"]
];
assert.deepEqual(
  findHistoricalInactiveStyleSource(rows, {
    headerIndex: 0,
    issueEndIndex: 2,
    snapshotIndexes: [9, 10]
  }),
  { rowIndex: 1, columnIndex: 9 }
);

console.log("snapshot rules: ok");

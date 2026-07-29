import assert from "node:assert/strict";
import {
  assertSheetMutationTarget,
  countIssueRows,
  findDashboardDropdownSampleCell,
  findSnapshotDropdownSource,
  findPreviousSnapshotIndex,
  normalizeIssueTypeForStyle,
  normalizeSnapshotName,
  normalizeWorkMode,
  planNewChecklistSnapshotColumns,
  planRequestedSnapshotColumn,
  shouldUseTemplateForInsertedRow,
  validateTemplateCopyConfig,
  WORK_MODE_EXISTING,
  WORK_MODE_NEW
} from "./sync-mode.mjs";

assert.equal(normalizeWorkMode("new"), WORK_MODE_NEW);
assert.equal(normalizeWorkMode(" EXISTING "), WORK_MODE_EXISTING);
assert.throws(() => normalizeWorkMode(""), /작업 유형/);

assert.equal(normalizeSnapshotName(" snapshot-11 "), "SNAPSHOT-11");
assert.throws(() => normalizeSnapshotName("SNAPSHOT-"), /SNAPSHOT-숫자/);
assert.throws(() => normalizeSnapshotName("SNAPSHOT-A"), /SNAPSHOT-숫자/);
assert.equal(
  shouldUseTemplateForInsertedRow(WORK_MODE_NEW, 25),
  true
);
assert.equal(
  shouldUseTemplateForInsertedRow(WORK_MODE_EXISTING, null),
  true
);
assert.equal(
  shouldUseTemplateForInsertedRow(WORK_MODE_EXISTING, 25),
  false
);
assert.equal(
  findDashboardDropdownSampleCell(
    [
      ["Dashboard", "", "", "드롭다운 샘플"],
      ["", "", "", ""]
    ],
    (index) => String.fromCharCode(65 + index)
  ),
  "D2"
);
assert.equal(
  findDashboardDropdownSampleCell(
    [
      ["드롭다운 샘플", "", "", " 드롭다운  샘플 "],
      ["", "", "", ""]
    ],
    (index) => String.fromCharCode(65 + index)
  ),
  "D2"
);
assert.throws(
  () =>
    findDashboardDropdownSampleCell(
      [["Dashboard", "테스트 URL"]],
      (index) => String.fromCharCode(65 + index)
    ),
  /드롭다운 샘플/
);

assert.deepEqual(
  planNewChecklistSnapshotColumns([
    "번호",
    "유형",
    "JIRA",
    "고객사",
    "제목",
    "상태",
    "중요도",
    "담당자",
    "테스트자",
    "SNAPSHOT-1",
    "SNAPSHOT-3",
    "SNAPSHOT-",
    "참고사항여부(Y/N)"
  ], 12),
  {
    keepSourceIndex: 9,
    keepIndex: 9,
    deleteIndexes: [11, 10]
  }
);
assert.deepEqual(
  planNewChecklistSnapshotColumns(
    ["번호", "유형", "JIRA", "", "", "", "", "", "테스트자", "", "", "참고사항여부(Y/N)"],
    11
  ),
  {
    keepSourceIndex: 9,
    keepIndex: 9,
    deleteIndexes: [10]
  }
);
assert.deepEqual(
  planNewChecklistSnapshotColumns(
    ["번호", "유형", "JIRA", "", "", "", "", "", "테스트자", "참고사항여부(Y/N)"],
    9
  ),
  {
    keepSourceIndex: -1,
    keepIndex: -1,
    deleteIndexes: []
  }
);
assert.equal(normalizeIssueTypeForStyle("Bug"), "버그");
assert.equal(normalizeIssueTypeForStyle("Improvement"), "개선");
assert.equal(normalizeIssueTypeForStyle("Sub-task"), "부작업");
assert.equal(normalizeIssueTypeForStyle("새 기능"), "새기능");
assert.doesNotThrow(() =>
  assertSheetMutationTarget(
    { spreadsheetId: "sheet-1", gid: "100", sheetName: "대상 탭" },
    { spreadsheetId: "sheet-1", gid: "100" },
    "대상 탭"
  )
);
assert.throws(
  () =>
    assertSheetMutationTarget(
      { spreadsheetId: "sheet-1", gid: "100", sheetName: "대상 탭" },
      { spreadsheetId: "sheet-1", gid: "200" },
      "다른 탭"
    ),
  /대상 시트 보호/
);
const validTemplateCopyConfig = {
  spreadsheetId: "sheet-1",
  templateSheetName: "기본 양식",
  snapshotDropdownSourceCell: "동적 계산",
  targetSheetName: "대상 탭",
  targetRowNumber: 24,
  targetLayout: { headerIndex: 22 },
  issueType: "버그"
};
assert.equal(
  validateTemplateCopyConfig(validTemplateCopyConfig),
  validTemplateCopyConfig
);
assert.throws(
  () =>
    validateTemplateCopyConfig({
      ...validTemplateCopyConfig,
      snapshotDropdownSourceCell: ""
    }),
  /snapshotDropdownSourceCell/
);
assert.throws(
  () =>
    validateTemplateCopyConfig({
      ...validTemplateCopyConfig,
      targetRowNumber: "대상 탭"
    }),
  /대상 행 번호/
);

assert.deepEqual(
  planRequestedSnapshotColumn(
    ["번호", "유형", "JIRA", "고객사", "제목", "상태", "중요도", "담당자", "테스트자", "SNAPSHOT-3", ""],
    10,
    "SNAPSHOT-3"
  ),
  { action: "use", targetIndex: 9 }
);
assert.deepEqual(
  planRequestedSnapshotColumn(
    ["번호", "유형", "JIRA", "고객사", "제목", "상태", "중요도", "담당자", "테스트자", "SNAPSHOT-", ""],
    10,
    "SNAPSHOT-6"
  ),
  { action: "rename", targetIndex: 9 }
);
assert.deepEqual(
  planRequestedSnapshotColumn(
    ["번호", "유형", "JIRA", "고객사", "제목", "상태", "중요도", "담당자", "테스트자", "", ""],
    10,
    "SNAPSHOT-3"
  ),
  { action: "rename", targetIndex: 9 }
);
assert.deepEqual(
  planRequestedSnapshotColumn(
    ["번호", "유형", "JIRA", "고객사", "제목", "상태", "중요도", "담당자", "테스트자", "SNAPSHOT-3", ""],
    10,
    "SNAPSHOT-6"
  ),
  { action: "insert", targetIndex: 10 }
);
assert.equal(
  findPreviousSnapshotIndex(
    ["번호", "", "", "", "", "", "", "", "", "SNAPSHOT-3", "SNAPSHOT-6", "SNAPSHOT-11"],
    11
  ),
  10
);
assert.equal(
  countIssueRows(
    [
      ["번호", "유형", "JIRA"],
      ["1", "버그", "MS-100"],
      ["", "", ""],
      ["", "참고사항", ""]
    ],
    { headerIndex: 0, issueEndIndex: 3 },
    (value) => (/^MS-\d+$/.test(String(value ?? "")) ? String(value) : "")
  ),
  1
);
assert.deepEqual(
  findSnapshotDropdownSource(
    [
      [],
      ["", "", "", "", "", "", "", "", "", "", "", "테스트완료"],
      ["", "", "", "", "", "", "", "", "", "", "PASS", ""]
    ],
    [9, 10, 11],
    [1, 2],
    (value) => ["PASS", "테스트완료"].includes(String(value ?? ""))
  ),
  { rowIndex: 1, columnIndex: 11 }
);

console.log("sync mode tests passed");

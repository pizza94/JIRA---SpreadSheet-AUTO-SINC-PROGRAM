export const WORK_MODE_NEW = "new";
export const WORK_MODE_EXISTING = "existing";
export const WORK_MODES = new Set([WORK_MODE_NEW, WORK_MODE_EXISTING]);

export function normalizeWorkMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!WORK_MODES.has(normalized)) {
    throw new Error(
      "작업 유형을 선택하세요: 신규 체크리스트 또는 기존 체크리스트 추가·업데이트"
    );
  }
  return normalized;
}

export function normalizeSnapshotName(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^SNAPSHOT-\d+$/.test(normalized)) {
    throw new Error(
      "등록할 SNAPSHOT은 SNAPSHOT-숫자 형식으로 입력하세요. 예: SNAPSHOT-3"
    );
  }
  return normalized;
}

export function countIssueRows(rows, layout, jiraKeyFromCell) {
  return rows
    .slice(layout.headerIndex + 1, layout.issueEndIndex)
    .filter((row) => jiraKeyFromCell(row?.[2]) !== "").length;
}

export function shouldUseTemplateForInsertedRow(workMode, lastIssueIndex) {
  return workMode === WORK_MODE_NEW || lastIssueIndex == null;
}

export function findDashboardDropdownSampleCell(rows, columnName) {
  const matches = [];
  for (let rowIndex = 0; rowIndex < (rows ?? []).length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      const normalized = String(row[columnIndex] ?? "")
        .replace(/\s+/g, "")
        .toLowerCase();
      if (normalized === "드롭다운샘플") {
        matches.push({ rowIndex, columnIndex });
      }
    }
  }
  if (matches.length === 0) {
    throw new Error(
      "대상 시트 Dashboard에서 '드롭다운 샘플' 영역을 찾지 못했습니다."
    );
  }
  const source = matches.sort(
    (left, right) =>
      right.columnIndex - left.columnIndex ||
      left.rowIndex - right.rowIndex
  )[0];
  return `${columnName(source.columnIndex)}${source.rowIndex + 2}`;
}

export function planNewChecklistSnapshotColumns(header, referenceIndex) {
  const firstWorkColumnIndex = 9;
  const snapshotIndexes = (header ?? [])
    .map((value, index) => ({
      value: String(value ?? "").trim().toUpperCase(),
      index
    }))
    .filter(({ value }) => /^SNAPSHOT(?:-|$)/.test(value))
    .map(({ index }) => index);
  const keepSourceIndex =
    snapshotIndexes.find(
      (index) =>
        index >= firstWorkColumnIndex && index < referenceIndex
    ) ??
    (referenceIndex > firstWorkColumnIndex
      ? firstWorkColumnIndex
      : -1);
  const deleteIndexes = [];
  for (
    let index = referenceIndex - 1;
    index >= firstWorkColumnIndex;
    index -= 1
  ) {
    if (index !== keepSourceIndex) {
      deleteIndexes.push(index);
    }
  }
  return {
    keepSourceIndex,
    keepIndex: keepSourceIndex >= 0 ? firstWorkColumnIndex : -1,
    deleteIndexes
  };
}

export function normalizeIssueTypeForStyle(value) {
  const normalized = String(value ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
  const aliases = new Map([
    ["bug", "버그"],
    ["버그", "버그"],
    ["improvement", "개선"],
    ["개선", "개선"],
    ["subtask", "부작업"],
    ["하위작업", "부작업"],
    ["부작업", "부작업"],
    ["newfeature", "새기능"],
    ["새기능", "새기능"]
  ]);
  return aliases.get(normalized) ?? normalized;
}

export function assertSheetMutationTarget(expected, current, activeSheetName) {
  if (
    !expected ||
    expected.spreadsheetId !== current?.spreadsheetId ||
    String(expected.gid) !== String(current?.gid) ||
    String(expected.sheetName ?? "").trim() !==
      String(activeSheetName ?? "").trim()
  ) {
    throw new Error(
      `대상 시트 보호 검증에 실패하여 변경 작업을 중단합니다. ` +
        `허용=${expected?.sheetName ?? "(미설정)"}(gid=${expected?.gid ?? "-"}), ` +
        `현재=${activeSheetName || "(확인 불가)"}(gid=${current?.gid ?? "-"})`
    );
  }
}

export function validateTemplateCopyConfig(config) {
  const required = [
    "spreadsheetId",
    "templateSheetName",
    "snapshotDropdownSourceCell",
    "targetSheetName",
    "targetRowNumber",
    "targetLayout",
    "issueType"
  ];
  const missing = required.filter((key) => {
    const value = config?.[key];
    return (
      value == null ||
      (typeof value === "string" && value.trim() === "")
    );
  });
  if (missing.length > 0) {
    throw new Error(
      `행 양식 복사 설정이 올바르지 않습니다: ${missing.join(", ")}`
    );
  }
  if (!Number.isInteger(config.targetRowNumber) || config.targetRowNumber < 1) {
    throw new Error("행 양식 복사 대상 행 번호가 올바르지 않습니다.");
  }
  if (
    typeof config.targetLayout !== "object" ||
    !Number.isInteger(config.targetLayout.headerIndex)
  ) {
    throw new Error("행 양식 복사 대상 레이아웃이 올바르지 않습니다.");
  }
  return config;
}

export function planRequestedSnapshotColumn(header, referenceIndex, requestedName) {
  const normalizedHeader = (header ?? []).map((value) =>
    String(value ?? "").trim().toUpperCase()
  );
  const exactMatches = normalizedHeader
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value === requestedName)
    .map(({ index }) => index);
  if (exactMatches.length > 1) {
    throw new Error(
      `${requestedName} 헤더가 ${exactMatches.length}개 있습니다. 중복 헤더를 정리한 뒤 다시 실행하세요.`
    );
  }
  if (exactMatches.length === 1) {
    return {
      action: "use",
      targetIndex: exactMatches[0]
    };
  }

  const placeholderMatches = normalizedHeader
    .map((value, index) => ({ value, index }))
    .filter(({ value }) => value === "SNAPSHOT-")
    .map(({ index }) => index);
  if (placeholderMatches.length > 1) {
    throw new Error(
      "SNAPSHOT- 빈 작업 헤더가 여러 개 있습니다. 하나만 남긴 뒤 다시 실행하세요."
    );
  }
  if (placeholderMatches.length === 1) {
    return {
      action: "rename",
      targetIndex: placeholderMatches[0]
    };
  }

  const lastCoreColumnIndex = 8;
  for (
    let index = lastCoreColumnIndex + 1;
    index < referenceIndex;
    index += 1
  ) {
    if ((normalizedHeader[index] ?? "") === "") {
      return {
        action: "rename",
        targetIndex: index
      };
    }
  }

  return {
    action: "insert",
    targetIndex:
      referenceIndex >= 0 ? referenceIndex : normalizedHeader.length
  };
}

export function findPreviousSnapshotIndex(header, targetIndex) {
  let previousIndex = -1;
  for (let index = 0; index < targetIndex; index += 1) {
    if (/^SNAPSHOT-\d+$/i.test(String(header?.[index] ?? "").trim())) {
      previousIndex = index;
    }
  }
  return previousIndex;
}

export function findSnapshotDropdownSource(
  rows,
  snapshotIndexes,
  issueIndexes,
  isKnownValue
) {
  for (const columnIndex of [...snapshotIndexes].reverse()) {
    const rowIndex = issueIndexes.find((candidateRowIndex) =>
      isKnownValue(rows[candidateRowIndex]?.[columnIndex])
    );
    if (rowIndex != null) {
      return { rowIndex, columnIndex };
    }
  }
  return null;
}

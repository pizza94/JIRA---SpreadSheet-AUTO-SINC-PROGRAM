const CARRY_VALUES = new Set([
  "보류",
  "반려",
  "현장확인",
  "테스트제외",
  "테스트중",
  "개발중",
  "테스트완료"
]);

const KNOWN_DROPDOWN_VALUES = new Set([
  "pass",
  "보류",
  "반려",
  "현장확인",
  "테스트제외",
  "테스트중",
  "개발중",
  "테스트완료",
  "재개발",
  "재개발요청",
  "추가이슈"
]);

export const SNAPSHOT_WORK_HEADER = "SNAPSHOT-";

export function normalizeSnapshotValue(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

export function isSnapshotWorkHeader(value) {
  return String(value ?? "").trim().toUpperCase() === SNAPSHOT_WORK_HEADER;
}

export function isKnownSnapshotDropdownValue(value) {
  return KNOWN_DROPDOWN_VALUES.has(normalizeSnapshotValue(value));
}

export function shouldResetCarriedSnapshot(action, previousValue) {
  if (action === "inserted") {
    return true;
  }
  return carriedSnapshotValue(previousValue) === "";
}

export function carriedSnapshotValue(previousValue) {
  const normalized = normalizeSnapshotValue(previousValue);
  if (normalized === "pass") {
    return "테스트완료";
  }
  if (CARRY_VALUES.has(normalized)) {
    return String(previousValue ?? "").trim();
  }
  return "";
}

export function snapshotValueForRun(previousValue, _includedInInput) {
  return carriedSnapshotValue(previousValue);
}

export function copiedSnapshotRepairValue(previousValue, currentValue) {
  const previous = String(previousValue ?? "");
  const current = String(currentValue ?? "");
  const expected = snapshotValueForRun(previous, false);
  return current === previous && current !== expected ? expected : null;
}

export function snapshotCarryAction(
  previousValue,
  currentValue,
  includedInInput
) {
  const value = snapshotValueForRun(previousValue, includedInInput).replace(
    /\r?\n/g,
    " "
  );
  if (String(currentValue ?? "") === value) {
    return { type: "none", value };
  }
  return value === ""
    ? { type: "clear", value }
    : { type: "set", value };
}

export function referenceValueForRun(currentValue, inserted) {
  return !inserted && String(currentValue ?? "").trim().toUpperCase() === "Y"
    ? "Y"
    : "N";
}

export function isSnapshotWorkColumnReady(layout, expectedIndex) {
  return (
    layout.hasBlankSnapshotWorkColumn === true &&
    layout.snapshotWorkIndex === expectedIndex &&
    layout.snapshotIndexes.at(-1) === expectedIndex - 1 &&
    layout.referenceIndex === expectedIndex + 1
  );
}

export function findBlankSnapshotWorkIndex(
  header,
  snapshotIndexes,
  referenceIndex
) {
  const lastSnapshotIndex = snapshotIndexes.at(-1);
  if (
    lastSnapshotIndex == null ||
    referenceIndex <= lastSnapshotIndex + 1
  ) {
    return -1;
  }
  const candidateIndex = lastSnapshotIndex + 1;
  const candidateHeader = String(header[candidateIndex] ?? "").trim();
  return candidateHeader === "" || isSnapshotWorkHeader(candidateHeader)
    ? candidateIndex
    : -1;
}

export function findHistoricalInactiveStyleSource(rows, layout) {
  if (layout.snapshotIndexes.length < 2) {
    return null;
  }

  for (
    let rowIndex = layout.headerIndex + 1;
    rowIndex < layout.issueEndIndex;
    rowIndex += 1
  ) {
    const row = rows[rowIndex] ?? [];
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(String(row[2] ?? "").trim())) {
      continue;
    }
    for (
      let snapshotPosition = 0;
      snapshotPosition < layout.snapshotIndexes.length - 1;
      snapshotPosition += 1
    ) {
      const snapshotIndex = layout.snapshotIndexes[snapshotPosition];
      const laterHasValue = layout.snapshotIndexes
        .slice(snapshotPosition + 1)
        .some((index) => String(row[index] ?? "").trim() !== "");
      if (
        String(row[snapshotIndex] ?? "").trim() === "" &&
        laterHasValue
      ) {
        return { rowIndex, columnIndex: snapshotIndex };
      }
    }
  }
  return null;
}

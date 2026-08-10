const FIELD_LABELS = {
  key: "Jira",
  title: "제목",
  status: "상태",
  priority: "중요도",
  assignee: "담당자",
  snapshot: "SNAPSHOT",
  reference: "참고사항여부"
};

export function normalizeVerificationValue(value) {
  return String(value ?? "").trim();
}

export function jiraHyperlinkFormula(url, issueKey) {
  const escapeFormulaText = (value) =>
    String(value ?? "").replaceAll('"', '""');
  return (
    `=HYPERLINK("${escapeFormulaText(url)}",` +
    `"${escapeFormulaText(issueKey)}")`
  );
}

export function issueRowMismatches(actual, expected) {
  return Object.keys(expected).flatMap((field) => {
    const actualValue = normalizeVerificationValue(actual[field]);
    const expectedValue = normalizeVerificationValue(expected[field]);
    const normalizedActual =
      field === "key" || field === "reference"
        ? actualValue.toUpperCase()
        : actualValue;
    const normalizedExpected =
      field === "key" || field === "reference"
        ? expectedValue.toUpperCase()
        : expectedValue;

    return normalizedActual === normalizedExpected
      ? []
      : [
          {
            field,
            label: FIELD_LABELS[field] ?? field,
            expected: expectedValue,
            actual: actualValue
          }
        ];
  });
}

export function formatIssueRowMismatches(mismatches) {
  return mismatches
    .map(
      ({ label, expected, actual }) =>
        `${label}(예상="${expected}", 실제="${actual}")`
    )
    .join(", ");
}

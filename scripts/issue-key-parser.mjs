const issueKeyPattern =
  /(?:^|[\s,\[])((?:MS|QS|IRD|MDM|MDMS|MSUI|QSUI|MDMT)-\d+)(?=$|[\s,\]\)])/gi;

// Jira 검색결과를 통째로 붙여넣을 때 제목 안의 REQ_MS_032-05,
// IMP-MS-091 같은 보조 식별자를 이슈 번호로 오인하지 않는다.
export function extractIssueKeys(value) {
  return [
    ...new Set(
      [...String(value ?? "").matchAll(issueKeyPattern)].map((match) =>
        match[1].toUpperCase()
      )
    )
  ];
}

export function buildSyncSummary({
  status = "성공",
  completedAt,
  sheetName,
  sheetUrl,
  snapshot,
  schedule,
  performance,
  results = [],
  resultPath
}) {
  const inserted = results.filter((item) => item.action === "inserted").length;
  const updated = results.filter((item) => item.action === "updated").length;
  const lines = [
    "Jira → Google Sheets 작업 요약",
    "================================",
    `결과: ${status}`,
    `완료 시각: ${formatDateTime(completedAt)}`,
    `대상 시트: ${sheetName || "-"}`,
    `시트 링크: ${sheetUrl || "-"}`,
    `처리 결과: 총 ${results.length}건 (추가 ${inserted}건, 업데이트 ${updated}건)`,
    snapshot
      ? `SNAPSHOT: 이전 열 ${formatColumn(snapshot.previousColumn)} / ` +
        `작업 열 ${formatColumn(snapshot.workColumn)}`
      : "SNAPSHOT: -",
    `테스트 일정: ${formatSchedule(schedule)}`,
    performance
      ? `처리 시간: ${formatDuration(performance.totalDurationMs)}`
      : "처리 시간: -",
    "",
    "[이슈별 결과]"
  ];

  if (performance?.existingWriteDurationMs > 0) {
    lines.push(
      `기존 이슈 일괄 입력: ${formatDuration(performance.existingWriteDurationMs)}`
    );
  }
  if (performance?.existingVerificationDurationMs > 0) {
    lines.push(
      `기존 이슈 일괄 검증: ${formatDuration(performance.existingVerificationDurationMs)}`
    );
  }
  if (performance?.insertedProcessingMs > 0) {
    lines.push(
      `신규 이슈 순차 처리: ${formatDuration(performance.insertedProcessingMs)}`
    );
  }
  if (performance?.sheetReadCount != null) {
    lines.push(
      `Google Sheets CSV 조회: ${performance.sheetReadCount}회 / ` +
        `${formatDuration(performance.sheetReadDurationMs)}`
    );
  }

  if (results.length === 0) {
    lines.push("- 처리된 이슈가 없습니다.");
  } else {
    for (const result of results) {
      lines.push(
        `- ${result.key}: ${result.action === "inserted" ? "추가" : "업데이트"}, ` +
          `${result.rowNumber ?? "-"}행, 상태=${result.status || "-"}`
      );
    }
  }

  lines.push(
    "",
    `결과 파일: ${resultPath || "-"}`,
    ""
  );
  return lines.join("\r\n");
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "-");
  }
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatColumn(value) {
  return value == null || value === "" ? "-" : String(value);
}

function formatSchedule(schedule = {}) {
  const valueOf = (item) =>
    typeof item === "object" && item !== null
      ? item.input || item.value || ""
      : item || "";
  const values = [
    valueOf(schedule.deadline) && `배포 ${valueOf(schedule.deadline)}`,
    valueOf(schedule.testStartDate) &&
      `시작 ${valueOf(schedule.testStartDate)}`,
    valueOf(schedule.testEndDate) && `종료 ${valueOf(schedule.testEndDate)}`
  ].filter(Boolean);
  return values.length ? values.join(" / ") : "변경 없음";
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    return "-";
  }
  return milliseconds >= 1_000
    ? `${(milliseconds / 1_000).toFixed(1)}초`
    : `${milliseconds}ms`;
}

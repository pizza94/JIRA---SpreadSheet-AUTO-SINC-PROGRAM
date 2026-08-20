export function extractUrlCandidate(value) {
  const text = String(value ?? "").trim();
  const markdownUrl = text.match(/\((https?:\/\/[^)]+)\)/i)?.[1];
  if (markdownUrl) {
    return markdownUrl;
  }
  return text.match(/https?:\/\/[^\s\])]+/i)?.[0] ?? text;
}

export function parseGoogleSheetLink(value) {
  const candidate = extractUrlCandidate(value);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Google Sheets 링크를 입력하세요. 예: https://docs.google.com/spreadsheets/d/.../edit?gid=123#gid=123"
    );
  }

  const spreadsheetId =
    parsed.pathname.match(/^\/spreadsheets\/d\/([^/]+)/)?.[1] ?? "";
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "docs.google.com" ||
    !spreadsheetId
  ) {
    throw new Error("올바른 Google Sheets 링크를 입력하세요.");
  }

  const hashParameters = new URLSearchParams(
    parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash
  );
  const gid = parsed.searchParams.get("gid") ?? hashParameters.get("gid") ?? "";
  if (!/^\d+$/.test(gid)) {
    throw new Error(
      "Google Sheets 링크에 시트 탭 gid가 없습니다. 작업할 탭을 연 상태의 주소를 복사하세요."
    );
  }

  return {
    parsed,
    spreadsheetId,
    gid,
    canonicalUrl:
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` +
      `?gid=${gid}#gid=${gid}`
  };
}

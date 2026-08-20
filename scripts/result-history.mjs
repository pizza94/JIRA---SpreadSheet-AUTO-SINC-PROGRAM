import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HISTORY_SEPARATOR = "-".repeat(80);

export function dailyResultFileName(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`작업결과 날짜가 올바르지 않습니다: ${value}`);
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";
  return `Jira-Sheets-작업결과-${part("year")}-${part("month")}-${part("day")}.txt`;
}

export async function prependDailyResult(
  outputDirectory,
  content,
  occurredAt = new Date()
) {
  await mkdir(outputDirectory, { recursive: true });
  const target = join(outputDirectory, dailyResultFileName(occurredAt));
  let previous = "";
  try {
    previous = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const currentBlock = normalizeLineEndings(content).trim();
  const previousBlock = normalizeLineEndings(previous).trim();
  const nextContent = previousBlock
    ? `${currentBlock}\r\n\r\n${HISTORY_SEPARATOR}\r\n\r\n${previousBlock}\r\n`
    : `${currentBlock}\r\n`;
  await writeFile(target, nextContent, "utf8");
  return target;
}

function normalizeLineEndings(value) {
  return String(value ?? "").replace(/\r?\n/g, "\r\n");
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dailyResultFileName,
  prependDailyResult
} from "./result-history.mjs";

const testDirectory = await mkdtemp(join(tmpdir(), "jira-result-history-"));

assert.equal(
  dailyResultFileName("2026-07-20T15:30:00.000Z"),
  "Jira-Sheets-작업결과-2026-07-21.txt"
);

const firstPath = await prependDailyResult(
  testDirectory,
  "실행: 첫 번째\r\n결과: 성공",
  "2026-07-21T00:00:00.000Z"
);
const secondPath = await prependDailyResult(
  testDirectory,
  "실행: 두 번째\r\n결과: 실패",
  "2026-07-21T01:00:00.000Z"
);
const nextDayPath = await prependDailyResult(
  testDirectory,
  "실행: 다음 날짜\r\n결과: 성공",
  "2026-07-22T00:00:00.000Z"
);

assert.equal(firstPath, secondPath);
assert.notEqual(secondPath, nextDayPath);

const dailyContent = await readFile(secondPath, "utf8");
assert.ok(dailyContent.indexOf("실행: 두 번째") < dailyContent.indexOf("실행: 첫 번째"));
assert.match(dailyContent, /-{80}/);

const files = (await readdir(testDirectory)).sort();
assert.deepEqual(files, [
  "Jira-Sheets-작업결과-2026-07-21.txt",
  "Jira-Sheets-작업결과-2026-07-22.txt"
]);

console.log("result history tests passed");

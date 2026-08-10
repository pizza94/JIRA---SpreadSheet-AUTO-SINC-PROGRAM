import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const spreadsheetId = "1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94";
const gid = "108125438";
const issueKey = process.argv[2] ?? "MS-4395";
const targetCell = process.argv[3] ?? "C31";
const jiraUrl = `http://192.168.0.119:8079/browse/${issueKey}`;
const formula = `=HYPERLINK("${jiraUrl}","${issueKey}")`;
const sheetUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
const exportUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
const screenshotPath = `output/${issueKey}-hyperlink.png`;

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();
  await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const nameBox = page.locator("#t-name-box");
  await nameBox.waitFor({ state: "visible", timeout: 20_000 });

  await page.evaluate(
    (clipboardText) => navigator.clipboard.writeText(clipboardText),
    formula
  );
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+V");

  const deadline = Date.now() + 30_000;
  let verified = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const response = await context.request.get(exportUrl, { timeout: 30_000 });
    const csv = await response.text();
    verified = response.ok() && csv.includes(issueKey);
    if (verified) {
      break;
    }
  }

  if (!verified) {
    throw new Error(`${issueKey} 하이퍼링크 셀의 표시값 저장을 확인하지 못했습니다.`);
  }

  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.waitForTimeout(750);
  await mkdir("output", { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: false });

  console.log(
    JSON.stringify(
      { issueKey, targetCell, jiraUrl, formula, screenshotPath },
      null,
      2
    )
  );
} finally {
  await browser.close();
}

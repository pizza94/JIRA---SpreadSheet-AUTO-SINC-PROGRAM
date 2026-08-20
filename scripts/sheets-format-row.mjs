import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const spreadsheetId = "1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94";
const gid = process.env.SHEET_GID ?? "108125438";
const sheetUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
const exportUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
const issueKey = process.argv[2] ?? "MS-4395";
const screenshotPath = `output/${issueKey}-sheet.png`;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field.replace(/\r$/, ""));
  rows.push(row);
  return rows;
}

async function readRows(request) {
  const response = await request.get(exportUrl, { timeout: 30_000 });
  if (!response.ok()) {
    throw new Error(`CSV 확인 실패: HTTP ${response.status()}`);
  }
  return parseCsv(await response.text());
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();
  const rows = await readRows(context.request);
  const headerIndex = rows.findIndex(
    (row) => row[0] === "번호" && row[2] === "JIRA"
  );
  const targetIndex = rows.findIndex((row) => row[2] === issueKey);

  if (headerIndex < 0 || targetIndex <= headerIndex) {
    throw new Error(`${issueKey} 또는 표 헤더를 찾지 못했습니다.`);
  }

  let sourceIndex = targetIndex - 1;
  while (
    sourceIndex > headerIndex &&
    !/^[A-Z]+-\d+$/.test(rows[sourceIndex][2] ?? "")
  ) {
    sourceIndex -= 1;
  }
  if (sourceIndex <= headerIndex) {
    throw new Error("복사할 기존 이슈 행을 찾지 못했습니다.");
  }

  const targetRowNumber = targetIndex + 1;
  const sourceRowNumber = sourceIndex + 1;
  const ordinal = rows
    .slice(headerIndex + 1, targetIndex + 1)
    .filter((row) => /^[A-Z]+-\d+$/.test(row[2] ?? "")).length;
  const current = rows[targetIndex];
  const values = [
    String(ordinal),
    current[1] ?? "",
    current[2] ?? "",
    current[3] ?? "",
    current[4] ?? "",
    current[5] ?? "",
    current[6] ?? "",
    current[7] ?? "",
    "",
    "",
    ""
  ];

  await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const nameBox = page.locator("#t-name-box");
  await nameBox.waitFor({ state: "visible", timeout: 20_000 });

  await nameBox.fill(`A${sourceRowNumber}:K${sourceRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(400);

  await nameBox.fill(`A${targetRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(1_000);

  await nameBox.fill(`A${targetRowNumber}:K${targetRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);

  const tabSeparatedValues = values.join("\t");
  await navigatorClipboardWrite(page, tabSeparatedValues);
  await nameBox.fill(`A${targetRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+V");

  const deadline = Date.now() + 30_000;
  let verifiedRow;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const updatedRows = await readRows(context.request);
    verifiedRow = updatedRows[targetIndex] ?? [];
    if (
      verifiedRow[0] === String(ordinal) &&
      verifiedRow[2] === issueKey &&
      verifiedRow[8] === "" &&
      verifiedRow[9] === "" &&
      verifiedRow[10] === ""
    ) {
      break;
    }
  }

  if (
    !verifiedRow ||
    verifiedRow[0] !== String(ordinal) ||
    verifiedRow[2] !== issueKey
  ) {
    throw new Error("번호 또는 Jira 값의 저장 검증에 실패했습니다.");
  }

  await nameBox.fill(`A${targetRowNumber}:K${targetRowNumber}`);
  await nameBox.press("Enter");
  await page.waitForTimeout(500);
  await mkdir("output", { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: false });

  console.log(
    JSON.stringify(
      {
        sourceRowNumber,
        targetRowNumber,
        ordinal,
        issueKey,
        screenshotPath
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}

async function navigatorClipboardWrite(page, text) {
  await page.evaluate(
    (clipboardText) => navigator.clipboard.writeText(clipboardText),
    text
  );
}

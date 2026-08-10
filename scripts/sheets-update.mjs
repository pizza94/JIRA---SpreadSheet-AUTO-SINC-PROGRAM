import { chromium } from "playwright";

const spreadsheetId = "1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94";
const gid = "94813446";
const sheetUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
const exportUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
const expectedIssueKey = "MS-12847";
const newStatus = "보류";

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

async function readTargetRow(request) {
  const response = await request.get(exportUrl, { timeout: 30_000 });
  if (!response.ok()) {
    throw new Error(`CSV 확인 실패: HTTP ${response.status()}`);
  }

  const rows = parseCsv(await response.text());
  const matches = rows
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .filter(({ row }) => row[2] === expectedIssueKey);

  if (matches.length !== 1) {
    throw new Error(
      `${expectedIssueKey} 행을 하나만 찾아야 하지만 ${matches.length}개를 찾았습니다.`
    );
  }

  const { row, rowNumber } = matches[0];
  return {
    rowNumber,
    issueKey: row[2] ?? "",
    title: row[4] ?? "",
    status: row[5] ?? "",
    priority: row[6] ?? "",
    assignee: row[7] ?? ""
  };
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const before = await readTargetRow(context.request);
  const targetCell = `F${before.rowNumber}`;

  if (before.status !== newStatus) {
    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const nameBox = page.locator("#t-name-box");
    await nameBox.waitFor({ state: "visible", timeout: 20_000 });
    await nameBox.fill(targetCell);
    await nameBox.press("Enter");
    await page.waitForTimeout(500);
    await page.keyboard.type(newStatus);
    await page.keyboard.press("Enter");

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const current = await readTargetRow(context.request);
      if (current.status === newStatus) {
        break;
      }
    }
  }

  const after = await readTargetRow(context.request);
  if (after.status !== newStatus) {
    throw new Error(
      `Google Sheets 편집이 저장되지 않았습니다. 현재 상태 값: ${after.status}`
    );
  }

  if (
    after.rowNumber !== before.rowNumber ||
    after.issueKey !== before.issueKey ||
    after.title !== before.title ||
    after.priority !== before.priority ||
    after.assignee !== before.assignee
  ) {
    throw new Error("검증 실패: 상태 외의 핵심 셀 값이 변경되었습니다.");
  }

  console.log(JSON.stringify({ targetCell, before, after }, null, 2));
} finally {
  await browser.close();
}

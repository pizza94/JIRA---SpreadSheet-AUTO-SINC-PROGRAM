import { chromium } from "playwright";

const spreadsheetId = "1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94";
const gid = "94813446";
const issueKey = process.argv[2] ?? "MS-4395";
const sheetUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
const exportUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;

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
  const targetIndex = rows.findIndex((row) => row[2] === issueKey);

  if (targetIndex < 0) {
    console.log(JSON.stringify({ action: "already_absent", issueKey }, null, 2));
  } else {
    const targetRowNumber = targetIndex + 1;
    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const nameBox = page.locator("#t-name-box");
    await nameBox.waitFor({ state: "visible", timeout: 20_000 });
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      Array(11).fill("").join("\t")
    );
    await nameBox.fill(`A${targetRowNumber}`);
    await nameBox.press("Enter");
    await page.keyboard.press("Control+V");

    const deadline = Date.now() + 30_000;
    let removed = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const currentRows = await readRows(context.request);
      removed = !currentRows.some((row) => row[2] === issueKey);
      if (removed) {
        break;
      }
    }

    if (!removed) {
      throw new Error(`복사본에서 ${issueKey} 제거 검증에 실패했습니다.`);
    }

    console.log(
      JSON.stringify(
        { action: "cleared_copy_row", targetRowNumber, issueKey },
        null,
        2
      )
    );
  }
} finally {
  await browser.close();
}

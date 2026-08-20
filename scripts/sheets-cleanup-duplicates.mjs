import { chromium } from "playwright";

const spreadsheetId = "1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94";
const gid = "108125438";
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

function containsIssueKey(row) {
  return row.some((cell) => String(cell ?? "").includes(issueKey));
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();
  const rows = await readRows(context.request);
  const occurrences = rows
    .map((row, index) => ({ row, index, rowNumber: index + 1 }))
    .filter(({ row }) => containsIssueKey(row));

  if (occurrences.length <= 1) {
    console.log(
      JSON.stringify({ action: "no_duplicates", issueKey, occurrences }, null, 2)
    );
  } else {
    const keep = [...occurrences].sort((left, right) => {
      const score = (item) =>
        (String(item.row[2] ?? "").includes(issueKey) ? 4 : 0) +
        (item.row[1] ? 2 : 0) +
        (item.row[4] ? 2 : 0) +
        (item.row[0] ? 1 : 0);
      return score(right) - score(left);
    })[0];
    const remove = occurrences.filter(
      ({ rowNumber }) => rowNumber !== keep.rowNumber
    );

    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const nameBox = page.locator("#t-name-box");
    await nameBox.waitFor({ state: "visible", timeout: 20_000 });

    for (const item of remove) {
      await page.evaluate(
        (text) => navigator.clipboard.writeText(text),
        Array(11).fill("").join("\t")
      );
      await nameBox.fill(`A${item.rowNumber}`);
      await nameBox.press("Enter");
      await page.keyboard.press("Control+V");
      await page.waitForTimeout(750);
    }

    const deadline = Date.now() + 30_000;
    let finalOccurrences = [];
    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const currentRows = await readRows(context.request);
      finalOccurrences = currentRows
        .map((row, index) => ({ row, rowNumber: index + 1 }))
        .filter(({ row }) => containsIssueKey(row));
      if (finalOccurrences.length === 1) {
        break;
      }
    }

    if (
      finalOccurrences.length !== 1 ||
      !String(finalOccurrences[0].row[2] ?? "").includes(issueKey)
    ) {
      throw new Error(`${issueKey} 중복 정리 검증에 실패했습니다.`);
    }

    console.log(
      JSON.stringify(
        {
          action: "duplicates_cleared",
          issueKey,
          keptRowNumber: finalOccurrences[0].rowNumber,
          clearedRowNumbers: remove.map((item) => item.rowNumber)
        },
        null,
        2
      )
    );
  }
} finally {
  await browser.close();
}

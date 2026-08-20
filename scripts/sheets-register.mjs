import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const spreadsheetId = "1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94";
const gid = process.env.SHEET_GID ?? "108125438";
const sheetUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${gid}`;
const exportUrl =
  `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
const issueKey = process.argv[2] ?? "MS-4395";
const googleAuthFile = resolve("playwright/.auth/google.json");
const issue = JSON.parse(
  await readFile(new URL(`../output/${issueKey}.json`, import.meta.url), "utf8")
);

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

function inferCustomer(title) {
  return title.match(/^\[([^\]]+)\]/)?.[1]?.trim() ?? "";
}

function locateTarget(rows) {
  const headerIndex = rows.findIndex(
    (row) => row[0] === "번호" && row[2] === "JIRA"
  );
  if (headerIndex < 0) {
    throw new Error("번호/JIRA 헤더 행을 찾지 못했습니다.");
  }

  const duplicates = rows
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .filter(({ row }) => row[2] === issueKey);
  if (duplicates.length > 0) {
    return { duplicate: duplicates[0], targetRowNumber: null };
  }

  let lastIssueIndex = headerIndex;
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    if (/^[A-Z]+-\d+$/.test(rows[index][2] ?? "")) {
      lastIssueIndex = index;
    }
  }

  return { duplicate: null, targetRowNumber: lastIssueIndex + 2 };
}

const expected = {
  type: issue.issueType,
  key: issue.key,
  customer: inferCustomer(issue.title),
  title: issue.title,
  status: issue.status,
  priority: issue.priority,
  assignee: issue.assignee
};

const browser = await chromium.launch({ headless: true });

try {
  let storageState;
  try {
    await access(googleAuthFile);
    storageState = googleAuthFile;
  } catch {
    storageState = undefined;
  }

  const context = await browser.newContext({
    storageState,
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();
  const beforeRows = await readRows(context.request);
  const target = locateTarget(beforeRows);

  if (target.duplicate) {
    console.log(
      JSON.stringify(
        {
          action: "skipped_duplicate",
          rowNumber: target.duplicate.rowNumber,
          issueKey
        },
        null,
        2
      )
    );
    process.exitCode = 0;
  } else {
    await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const nameBox = page.locator("#t-name-box");
    await nameBox.waitFor({ state: "visible", timeout: 20_000 });

    const values = [
      expected.type,
      expected.key,
      expected.customer,
      expected.title,
      expected.status,
      expected.priority,
      expected.assignee
    ];

    await nameBox.fill(`B${target.targetRowNumber}`);
    await nameBox.press("Enter");
    await page.waitForTimeout(500);
    const tabSeparatedValues = values.map((value) => value ?? "").join("\t");
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      tabSeparatedValues
    );
    await page.keyboard.press("Control+V");

    const deadline = Date.now() + 30_000;
    let registered = null;

    while (Date.now() < deadline) {
      await page.waitForTimeout(2_000);
      const currentRows = await readRows(context.request);
      const matchIndex = currentRows.findIndex((row) => row[2] === issueKey);
      if (matchIndex >= 0) {
        registered = {
          rowNumber: matchIndex + 1,
          row: currentRows[matchIndex]
        };
        break;
      }
    }

    if (!registered) {
      throw new Error(
        "Google Sheets에 행이 저장되지 않았습니다. 공개 링크가 보기 전용일 수 있습니다."
      );
    }

    const actual = {
      type: registered.row[1] ?? "",
      key: registered.row[2] ?? "",
      customer: registered.row[3] ?? "",
      title: registered.row[4] ?? "",
      status: registered.row[5] ?? "",
      priority: registered.row[6] ?? "",
      assignee: registered.row[7] ?? ""
    };

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `입력 검증 실패: ${JSON.stringify({ expected, actual }, null, 2)}`
      );
    }

    console.log(
      JSON.stringify(
        {
          action: "registered",
          rowNumber: registered.rowNumber,
          values: actual
        },
        null,
        2
      )
    );
  }
} finally {
  await browser.close();
}

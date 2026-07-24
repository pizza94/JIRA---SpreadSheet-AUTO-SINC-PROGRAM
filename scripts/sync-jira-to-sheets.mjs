import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const jiraBaseUrl =
  process.env.JIRA_BASE_URL ?? "http://jira.example.local:8079";
const dataRoot = resolve(process.env.AUTOMATION_DATA_DIR ?? ".");
const outputDir = resolve(dataRoot, "output");
const jiraAuthFile = resolve(dataRoot, "playwright/.auth/jira.json");
const googleAuthFile = resolve(dataRoot, "playwright/.auth/google.json");
const args = parseArgs(process.argv.slice(2));

if (!args.issueKeys.length || !args.sheetUrl || !args.sheetName) {
  throw new Error(
    "사용법: npm run sync -- --issues MS-100,MS-101 " +
      '--sheet-url "Google Sheets URL" --sheet-name "시트 탭 이름"'
  );
}

await requireFile(
  jiraAuthFile,
  "Jira 로그인 세션이 없습니다. 먼저 npm run jira:login 을 실행하세요."
);

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {})
});

try {
  const issues = await fetchJiraIssues(browser, args.issueKeys);
  const sheetResult = await syncIssuesToSheet(browser, issues, args);
  const reportPath = resolve(
    outputDir,
    `sync-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        jiraBaseUrl,
        sheetName: args.sheetName,
        sheetUrl: sheetResult.resolvedSheetUrl,
        schedule: sheetResult.schedule,
        results: sheetResult.results
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        sheetName: args.sheetName,
        resolvedSheetUrl: sheetResult.resolvedSheetUrl,
        schedule: sheetResult.schedule,
        results: sheetResult.results,
        screenshotPath: sheetResult.screenshotPath,
        reportPath
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}

function parseArgs(argv) {
  const parsed = {
    issueKeys: [],
    sheetUrl: "",
    sheetName: "",
    deadline: "",
    testStartDate: "",
    testEndDate: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--issues") {
      parsed.issueKeys = (argv[++index] ?? "")
        .split(/[\s,]+/)
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean);
    } else if (argument === "--sheet-url") {
      parsed.sheetUrl = argv[++index] ?? "";
    } else if (argument === "--sheet-name") {
      parsed.sheetName = argv[++index] ?? "";
    } else if (argument === "--deadline") {
      parsed.deadline = argv[++index] ?? "";
    } else if (argument === "--test-start-date") {
      parsed.testStartDate = argv[++index] ?? "";
    } else if (argument === "--test-end-date") {
      parsed.testEndDate = argv[++index] ?? "";
    } else if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(argument)) {
      parsed.issueKeys.push(argument.toUpperCase());
    }
  }

  parsed.issueKeys = [...new Set(parsed.issueKeys)];
  for (const issueKey of parsed.issueKeys) {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) {
      throw new Error(`잘못된 Jira 번호 형식입니다: ${issueKey}`);
    }
  }
  return parsed;
}

async function requireFile(path, message) {
  try {
    await access(path);
  } catch {
    throw new Error(message);
  }
}

async function optionalFile(path) {
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

async function fetchJiraIssues(browserInstance, issueKeys) {
  const context = await browserInstance.newContext({
    storageState: jiraAuthFile
  });
  const fields = [
    "summary",
    "status",
    "priority",
    "assignee",
    "description",
    "issuetype",
    "project",
    "reporter",
    "created",
    "updated",
    "labels",
    "components",
    "fixVersions",
    "resolution",
    "duedate",
    "parent"
  ].join(",");
  const issues = [];

  try {
    for (const issueKey of issueKeys) {
      const apiUrl =
        `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}` +
        `?fields=${encodeURIComponent(fields)}`;
      const response = await context.request.get(apiUrl, {
        headers: { Accept: "application/json" },
        timeout: 20_000
      });

      if (response.status() === 401) {
        throw new Error(
          "Jira 로그인 세션이 만료됐습니다. npm run jira:login 후 다시 실행하세요."
        );
      }
      if (response.status() === 403) {
        throw new Error(`${issueKey} 조회 권한이 없습니다.`);
      }
      if (!response.ok()) {
        throw new Error(
          `${issueKey} Jira 조회 실패: HTTP ${response.status()} ${await response.text()}`
        );
      }

      const source = await response.json();
      const issue = normalizeJiraIssue(source);
      issues.push(issue);
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        resolve(outputDir, `${issue.key}.json`),
        `${JSON.stringify(issue, null, 2)}\n`,
        "utf8"
      );
    }
  } finally {
    await context.close();
  }

  return issues;
}

function normalizeJiraIssue(issue) {
  return {
    key: issue.key,
    url: `${jiraBaseUrl}/browse/${issue.key}`,
    title: issue.fields.summary ?? "",
    status: issue.fields.status?.name ?? "",
    priority: issue.fields.priority?.name ?? "",
    assignee: issue.fields.assignee?.displayName ?? "미지정",
    issueType: issue.fields.issuetype?.name ?? "",
    project: issue.fields.project?.name ?? "",
    reporter: issue.fields.reporter?.displayName ?? "",
    resolution: issue.fields.resolution?.name ?? "",
    dueDate: issue.fields.duedate ?? "",
    created: issue.fields.created ?? "",
    updated: issue.fields.updated ?? "",
    labels: issue.fields.labels ?? [],
    components: (issue.fields.components ?? []).map((item) => item.name),
    fixVersions: (issue.fields.fixVersions ?? []).map((item) => item.name),
    parentKey: issue.fields.parent?.key ?? "",
    parentTitle: issue.fields.parent?.fields?.summary ?? "",
    description: issue.fields.description ?? ""
  };
}

async function syncIssuesToSheet(browserInstance, issues, config) {
  const storageState = await optionalFile(googleAuthFile);
  const context = await browserInstance.newContext({
    storageState,
    permissions: ["clipboard-read", "clipboard-write"]
  });
  const page = await context.newPage();

  try {
    const resolved = await resolveSheet(page, config.sheetUrl, config.sheetName);
    const exportUrl =
      `https://docs.google.com/spreadsheets/d/${resolved.spreadsheetId}` +
      `/export?format=csv&gid=${resolved.gid}`;
    const nameBox = page.locator("#t-name-box");
    await nameBox.waitFor({ state: "visible", timeout: 20_000 });
    const results = [];
    const initialRows = await readSheetRows(context.request, exportUrl);
    const initialLayout = inspectLayout(initialRows);
    const schedule = await updateScheduleFields(
      page,
      nameBox,
      context.request,
      exportUrl,
      initialRows,
      initialLayout,
      config
    );
    let sheetColumnCount = initialLayout.columnCount;

    for (const issue of issues) {
      let rows = await readSheetRows(context.request, exportUrl);
      const layout = inspectLayout(rows);
      sheetColumnCount = layout.columnCount;
      let matches = findIssueMatches(rows, issue.key, layout);

      if (matches.length > 1) {
        const retryDeadline = Date.now() + 10_000;
        while (Date.now() < retryDeadline && matches.length > 1) {
          await page.waitForTimeout(2_000);
          rows = await readSheetRows(context.request, exportUrl);
          matches = findIssueMatches(rows, issue.key, layout);
        }
      }

      if (matches.length > 1) {
        throw new Error(
          `${issue.key}가 시트에 ${matches.length}개 있어 자동 동기화를 중단합니다.`
        );
      }

      let targetIndex;
      let action;
      let preparedNumber = "";
      if (matches.length === 1) {
        targetIndex = matches[0].index;
        action = "updated";
      } else {
        let preparedBlankIndex = findPreparedBlankRowIndex(rows, layout);
        const issueIndexes = rows
          .map((row, index) => ({ row, index }))
          .filter(
            ({ row, index }) =>
              index > layout.headerIndex &&
              index < layout.issueEndIndex &&
              jiraKeyFromCell(row[2]) !== ""
          )
          .map(({ index }) => index);
        if (preparedBlankIndex == null && issueIndexes.length === 0) {
          const firstIssueIndex = layout.headerIndex + 1;
          if (
            firstIssueIndex < layout.issueEndIndex &&
            !rowHasContent(rows[firstIssueIndex])
          ) {
            preparedBlankIndex = firstIssueIndex;
          }
        }
        const lastIssueIndex = issueIndexes.at(-1);
        if (preparedBlankIndex != null) {
          targetIndex = preparedBlankIndex;
          preparedNumber = String(rows[targetIndex]?.[0] ?? "").trim();
        } else {
          const matchingTypeIndex = findMatchingTypeRowIndex(
            rows,
            layout,
            issue.issueType
          );
          const formatSourceIndex = matchingTypeIndex ?? lastIssueIndex;
          targetIndex = (lastIssueIndex ?? layout.headerIndex) + 1;
          rows = await insertSheetRowBefore(
            page,
            nameBox,
            context.request,
            exportUrl,
            rows,
            targetIndex
          );

          if (lastIssueIndex == null) {
            await copyTemplateRowFromSheet(
              page,
              nameBox,
              context.request,
              resolved.spreadsheetId,
              "스프레드시트양식",
              config.sheetName,
              targetIndex + 1,
              layout,
              issue.issueType
            );
          } else {
            await copyRowFormattingAndValidation(
              page,
              nameBox,
              formatSourceIndex + 1,
              targetIndex + 1,
              layout.columnCount
            );
          }
        }
        action = "inserted";
      }

      const typeStyleSourceCell = findTypeStyleSourceCell(
        rows,
        layout,
        issue.issueType,
        targetIndex
      );
      if (typeStyleSourceCell) {
        await copyCell(
          page,
          nameBox,
          typeStyleSourceCell,
          `B${targetIndex + 1}`
        );
      }

      rows = await readSheetRows(context.request, exportUrl);
      const ordinal = rows
        .slice(layout.headerIndex + 1, targetIndex + 1)
        .filter((row) => jiraKeyFromCell(row[2]) !== "").length +
        (action === "inserted" ? 1 : 0);
      const rowNumber = targetIndex + 1;
      const customer =
        action === "updated" && (rows[targetIndex]?.[3] ?? "") !== ""
          ? rows[targetIndex][3]
          : inferCustomer(issue, config.sheetName, rows, layout);
      const values = [
        preparedNumber || String(ordinal),
        issue.issueType,
        issue.key,
        customer,
        issue.title,
        issue.status,
        issue.priority,
        issue.assignee
      ];

      await pasteTsv(page, nameBox, `A${rowNumber}`, values.join("\t"));
      await pasteTsv(
        page,
        nameBox,
        `C${rowNumber}`,
        `=HYPERLINK("${issue.url}","${issue.key}")`
      );
      const verified = await waitForIssueRow(
        context.request,
        exportUrl,
        issue,
        rowNumber
      );
      results.push({
        action,
        rowNumber,
        number: verified[0],
        key: issue.key,
        title: verified[4],
        status: verified[5],
        priority: verified[6],
        assignee: verified[7]
      });
    }

    const rowNumbers = results.map((item) => item.rowNumber);
    const firstRow = Math.min(...rowNumbers);
    const lastRow = Math.max(...rowNumbers);
    await nameBox.fill(
      `A${firstRow}:${columnName(sheetColumnCount - 1)}${lastRow}`
    );
    await nameBox.press("Enter");
    await page.waitForTimeout(750);
    await mkdir(outputDir, { recursive: true });
    const screenshotPath = resolve(
      outputDir,
      `sync-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });

    return {
      resolvedSheetUrl: resolved.url,
      schedule,
      results,
      screenshotPath
    };
  } finally {
    await context.close();
  }
}

async function resolveSheet(page, providedUrl, sheetName) {
  await page.goto(providedUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });
  await page.waitForTimeout(3_000);

  return selectSheetByName(page, sheetName);
}

async function selectSheetByName(page, sheetName) {
  const tabs = page.locator(".docs-sheet-tab");
  const count = await tabs.count();
  let targetTab = null;
  const whitespaceInsensitiveMatches = [];
  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index);
    const actualName = (await tab.innerText()).trim();
    if (actualName === sheetName.trim()) {
      targetTab = tab;
      break;
    }
    if (normalizeSheetName(actualName) === normalizeSheetName(sheetName)) {
      whitespaceInsensitiveMatches.push(tab);
    }
  }
  if (!targetTab && whitespaceInsensitiveMatches.length === 1) {
    targetTab = whitespaceInsensitiveMatches[0];
  }
  if (!targetTab && whitespaceInsensitiveMatches.length > 1) {
    throw new Error(
      `공백을 제외하면 같은 이름의 시트 탭이 여러 개입니다: ${sheetName}`
    );
  }
  if (!targetTab) {
    throw new Error(`Google Sheets에서 대상 탭을 찾지 못했습니다: ${sheetName}`);
  }

  await targetTab.click();
  await page.waitForTimeout(1_500);
  const url = page.url();
  const match = url.match(
    /\/spreadsheets\/d\/([^/]+)\/.*(?:[?#&]gid=)(\d+)/
  );
  if (!match) {
    throw new Error(`스프레드시트 ID 또는 gid를 확인하지 못했습니다: ${url}`);
  }
  return {
    spreadsheetId: match[1],
    gid: match[2],
    url
  };
}

function normalizeSheetName(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function inspectLayout(rows) {
  const headerIndex = rows.findIndex(
    (row) =>
      row[0] === "번호" &&
      row[1] === "유형" &&
      row[2] === "JIRA" &&
      row[3] === "고객사" &&
      row[4] === "제목" &&
      row[5] === "상태" &&
      row[6] === "중요도" &&
      row[7] === "담당자"
  );
  if (headerIndex < 0) {
    throw new Error(
      "지원하는 시트 헤더(번호/유형/JIRA/고객사/제목/상태/중요도/담당자)를 찾지 못했습니다."
    );
  }
  const header = rows[headerIndex] ?? [];
  const snapshotIndexes = header
    .map((value, index) => ({ value: String(value ?? ""), index }))
    .filter(({ value }) => /^SNAPSHOT/i.test(value))
    .map(({ index }) => index);
  let referenceIndex = -1;
  for (let rowIndex = 0; rowIndex <= headerIndex; rowIndex += 1) {
    const foundIndex = (rows[rowIndex] ?? []).findIndex((value) =>
      String(value ?? "").includes("참고사항여부")
    );
    if (foundIndex >= 0) {
      referenceIndex = foundIndex;
      break;
    }
  }
  const lastHeaderIndex = header.reduce(
    (last, value, index) => (String(value ?? "") !== "" ? index : last),
    8
  );
  const columnCount =
    Math.max(
      8,
      lastHeaderIndex,
      referenceIndex,
      ...snapshotIndexes
    ) + 1;
  const issueEndIndex = rows.findIndex(
    (row, index) =>
      index > headerIndex &&
      (row ?? []).some(
        (value) => String(value ?? "").trim() === "참고사항"
      )
  );
  return {
    headerIndex,
    issueEndIndex: issueEndIndex >= 0 ? issueEndIndex : rows.length,
    snapshotIndexes,
    referenceIndex,
    columnCount
  };
}

function normalizeType(value) {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

function findMatchingTypeRowIndex(
  rows,
  layout,
  issueType,
  excludedIndex = -1
) {
  const expected = normalizeType(issueType);
  if (!expected) {
    return null;
  }
  const matching = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row, index }) =>
        index > layout.headerIndex &&
        index < layout.issueEndIndex &&
        index !== excludedIndex &&
        jiraKeyFromCell(row[2]) !== "" &&
        normalizeType(row[1]) === expected
    )
    .map(({ index }) => index);
  return matching.at(-1) ?? null;
}

function findTypeStyleSourceCell(rows, layout, issueType, excludedIndex = -1) {
  const matchingIssueIndex = findMatchingTypeRowIndex(
    rows,
    layout,
    issueType,
    excludedIndex
  );
  if (matchingIssueIndex != null) {
    return `B${matchingIssueIndex + 1}`;
  }

  const expected = normalizeType(issueType);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex === excludedIndex) {
      continue;
    }
    const columnIndex = (rows[rowIndex] ?? []).findIndex(
      (value) => normalizeType(value) === expected
    );
    if (columnIndex >= 0) {
      return `${columnName(columnIndex)}${rowIndex + 1}`;
    }
  }
  return null;
}

function findPreparedBlankRowIndex(rows, layout) {
  for (
    let index = layout.headerIndex + 1;
    index < layout.issueEndIndex;
    index += 1
  ) {
    const row = rows[index] ?? [];
    const hasPreparedNumber = /^\d+$/.test(String(row[0] ?? "").trim());
    const issueFieldsAreBlank = row
      .slice(1, 8)
      .every((value) => String(value ?? "").trim() === "");
    if (hasPreparedNumber && issueFieldsAreBlank) {
      return index;
    }
  }
  return null;
}

async function insertSheetRowBefore(
  page,
  nameBox,
  request,
  exportUrl,
  rows,
  targetIndex
) {
  const anchorIndex = rows.findIndex(
    (row, index) => index >= targetIndex && rowHasContent(row)
  );
  const anchorFingerprint =
    anchorIndex >= 0 ? rowFingerprint(rows[anchorIndex]) : "";
  const originalLength = rows.length;
  const rowNumber = targetIndex + 1;

  await nameBox.fill(`${rowNumber}:${rowNumber}`);
  await nameBox.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+Alt+Equal");
  await page.waitForTimeout(1_000);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const refreshedRows = await readSheetRows(request, exportUrl);
    const anchorMoved =
      anchorIndex >= 0 &&
      rowFingerprint(refreshedRows[anchorIndex + 1]) === anchorFingerprint;
    const trailingRowAdded =
      anchorIndex < 0 && refreshedRows.length > originalLength;
    if (anchorMoved || trailingRowAdded) {
      return refreshedRows;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`${rowNumber}행을 삽입하지 못했습니다.`);
}

function rowHasContent(row) {
  return (row ?? []).some((value) => String(value ?? "").trim() !== "");
}

function rowFingerprint(row) {
  return JSON.stringify((row ?? []).map((value) => String(value ?? "").trim()));
}

async function updateScheduleFields(
  page,
  nameBox,
  request,
  exportUrl,
  rows,
  layout,
  config
) {
  const requested = [
    {
      key: "deadline",
      value: config.deadline,
      label: "테스트 배포일정(데드라인)",
      target: (cell) => ({ row: cell.row + 1, column: cell.column })
    },
    {
      key: "testStartDate",
      value: config.testStartDate,
      label: "테스트시작일",
      target: (cell) => ({
        row: cell.row,
        column: layout.snapshotIndexes.at(-1) ?? cell.column + 1
      })
    },
    {
      key: "testEndDate",
      value: config.testEndDate,
      label: "테스트종료일",
      target: (cell) => ({
        row: cell.row,
        column: layout.snapshotIndexes.at(-1) ?? cell.column + 1
      })
    }
  ].filter((item) => item.value);

  const updated = {};
  for (const item of requested) {
    const labelCell = findSheetCell(rows, item.label);
    if (!labelCell) {
      throw new Error(`시트에서 '${item.label}' 항목을 찾지 못했습니다.`);
    }
    const target = item.target(labelCell);
    const targetCell = `${columnName(target.column)}${target.row + 1}`;
    await pasteTsv(page, nameBox, targetCell, item.value);
    updated[item.key] = { cell: targetCell, value: item.value };
  }

  if (requested.length > 0) {
    const verifiedRows = await waitForScheduleValues(
      request,
      exportUrl,
      updated
    );
    for (const [key, details] of Object.entries(updated)) {
      const coordinates = parseCellAddress(details.cell);
      details.value = verifiedRows[coordinates.row]?.[coordinates.column] ?? "";
      details.input = config[key];
    }
  }
  return updated;
}

function findSheetCell(rows, expectedLabel) {
  const expected = String(expectedLabel).replace(/\s+/g, "");
  for (let row = 0; row < rows.length; row += 1) {
    for (let column = 0; column < (rows[row] ?? []).length; column += 1) {
      if (String(rows[row][column] ?? "").replace(/\s+/g, "") === expected) {
        return { row, column };
      }
    }
  }
  return null;
}

function parseCellAddress(value) {
  const match = String(value).match(/^([A-Z]+)(\d+)$/);
  if (!match) {
    throw new Error(`셀 주소를 해석하지 못했습니다: ${value}`);
  }
  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  return { row: Number(match[2]) - 1, column: column - 1 };
}

function comparableDate(value) {
  return String(value ?? "").match(/\d+/g)?.map(Number).join(".") ?? "";
}

async function waitForScheduleValues(request, exportUrl, updated) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    const rows = await readSheetRows(request, exportUrl);
    const complete = Object.values(updated).every((details) => {
      const coordinates = parseCellAddress(details.cell);
      return (
        comparableDate(rows[coordinates.row]?.[coordinates.column]) ===
        comparableDate(details.value)
      );
    });
    if (complete) {
      return rows;
    }
  }
  throw new Error("테스트 일정의 Google Sheets 저장 검증에 실패했습니다.");
}

async function copyCell(page, nameBox, sourceCell, targetCell) {
  await nameBox.fill(sourceCell);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(300);
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(500);
}

async function copyRowFormattingAndValidation(
  page,
  nameBox,
  sourceRowNumber,
  targetRowNumber,
  columnCount
) {
  const lastColumn = columnName(columnCount - 1);
  await nameBox.fill(`A${sourceRowNumber}:${lastColumn}${sourceRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(400);
  await nameBox.fill(`A${targetRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(750);
  await pasteTsv(
    page,
    nameBox,
    `A${targetRowNumber}`,
    Array(columnCount).fill("").join("\t")
  );
}

async function copyTemplateRowFromSheet(
  page,
  nameBox,
  request,
  spreadsheetId,
  templateSheetName,
  targetSheetName,
  targetRowNumber,
  targetLayout,
  issueType
) {
  const template = await selectSheetByName(page, templateSheetName);
  if (template.spreadsheetId !== spreadsheetId) {
    throw new Error("양식 시트가 대상 스프레드시트와 일치하지 않습니다.");
  }
  const templateExportUrl =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}` +
    `/export?format=csv&gid=${template.gid}`;
  const templateRows = await readSheetRows(request, templateExportUrl);
  const templateLayout = inspectLayout(templateRows);
  const templateIssueIndexes = templateRows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row, index }) =>
        index > templateLayout.headerIndex &&
        index < templateLayout.issueEndIndex &&
        jiraKeyFromCell(row[2]) !== ""
    )
    .map(({ index }) => index);
  const matchingTemplateIndex = findMatchingTypeRowIndex(
    templateRows,
    templateLayout,
    issueType
  );
  const templateRowNumber =
    (matchingTemplateIndex ?? templateIssueIndexes[0] ?? templateLayout.headerIndex + 1) +
    1;
  const baseColumnCount = Math.min(
    9,
    targetLayout.columnCount,
    templateLayout.columnCount
  );

  await nameBox.fill(
    `A${templateRowNumber}:${columnName(baseColumnCount - 1)}${templateRowNumber}`
  );
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(400);

  await selectSheetByName(page, targetSheetName);
  await nameBox.fill(`A${targetRowNumber}`);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(750);

  if (
    targetLayout.snapshotIndexes.length > 0 &&
    templateLayout.snapshotIndexes.length > 0
  ) {
    await selectSheetByName(page, templateSheetName);
    const sourceSnapshotColumn = columnName(templateLayout.snapshotIndexes[0]);
    await nameBox.fill(
      `${sourceSnapshotColumn}${templateRowNumber}`
    );
    await nameBox.press("Enter");
    await page.keyboard.press("Control+C");
    await page.waitForTimeout(300);
    await selectSheetByName(page, targetSheetName);
    for (const targetIndex of targetLayout.snapshotIndexes) {
      await nameBox.fill(`${columnName(targetIndex)}${targetRowNumber}`);
      await nameBox.press("Enter");
      await page.keyboard.press("Control+V");
      await page.waitForTimeout(250);
    }
  }

  if (
    targetLayout.referenceIndex >= 0 &&
    templateLayout.referenceIndex >= 0
  ) {
    await selectSheetByName(page, templateSheetName);
    await nameBox.fill(
      `${columnName(templateLayout.referenceIndex)}${templateRowNumber}`
    );
    await nameBox.press("Enter");
    await page.keyboard.press("Control+C");
    await page.waitForTimeout(300);
    await selectSheetByName(page, targetSheetName);
    await nameBox.fill(
      `${columnName(targetLayout.referenceIndex)}${targetRowNumber}`
    );
    await nameBox.press("Enter");
    await page.keyboard.press("Control+V");
    await page.waitForTimeout(300);
  }

  await pasteTsv(
    page,
    nameBox,
    `A${targetRowNumber}`,
    Array(targetLayout.columnCount).fill("").join("\t")
  );
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

async function pasteTsv(page, nameBox, targetCell, text) {
  await page.evaluate(
    (clipboardText) => navigator.clipboard.writeText(clipboardText),
    text
  );
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(750);
}

async function waitForIssueRow(request, exportUrl, issue, rowNumber) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    const rows = await readSheetRows(request, exportUrl);
    const row = rows[rowNumber - 1] ?? [];
    if (
      jiraKeyFromCell(row[2]) === issue.key &&
      row[4] === issue.title &&
      row[5] === issue.status &&
      row[6] === issue.priority &&
      row[7] === issue.assignee
    ) {
      return row;
    }
  }
  throw new Error(`${issue.key}의 Google Sheets 저장 검증에 실패했습니다.`);
}

function jiraKeyFromCell(value) {
  const text = String(value ?? "");
  const direct = text.match(/^[A-Z][A-Z0-9_]*-\d+$/);
  if (direct) {
    return direct[0];
  }
  return text.match(/[A-Z][A-Z0-9_]*-\d+/)?.[0] ?? "";
}

function findIssueMatches(rows, issueKey, layout) {
  return rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row, index }) =>
        index > layout.headerIndex &&
        index < layout.issueEndIndex &&
        jiraKeyFromCell(row[2]) === issueKey
    );
}

function inferCustomer(issue, sheetName, rows, layout) {
  const titleCandidates = extractBracketValues(issue.title);
  const parentCandidates = extractBracketValues(issue.parentTitle);
  const sheetCandidate = sheetName.match(/\(([^)]+)\)/)?.[1]?.trim() ?? "";
  const secondaryCandidates = [
    ...(issue.labels ?? []),
    ...(issue.components ?? [])
  ];
  const candidates = [
    ...titleCandidates.filter(looksLikeCustomerName),
    ...parentCandidates.filter(looksLikeCustomerName),
    ...secondaryCandidates.filter(looksLikeCustomerName),
    sheetCandidate,
    ...titleCandidates,
    ...parentCandidates,
    ...secondaryCandidates,
    issue.project
  ].filter(isCustomerCandidate);
  const existingCustomers = rows
    .slice(layout.headerIndex + 1, layout.issueEndIndex)
    .map((row) => String(row[3] ?? "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const canonical = existingCustomers.find(
      (customer) =>
        normalizeCustomerName(customer) === normalizeCustomerName(candidate)
    );
    if (canonical) {
      return canonical;
    }
  }
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCustomerName(candidate);
    if (normalizedCandidate.length < 2) {
      continue;
    }
    const canonical = existingCustomers.find((customer) => {
      const normalizedCustomer = normalizeCustomerName(customer);
      return (
        normalizedCustomer.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedCustomer)
      );
    });
    if (canonical) {
      return canonical;
    }
  }
  return candidates[0] ?? "";
}

function extractBracketValues(value) {
  return [...String(value ?? "").matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function isCustomerCandidate(value) {
  const text = String(value ?? "").trim();
  const normalized = normalizeCustomerName(text);
  if (!text || /^\d+(?:\.\d+)*$/.test(text) || /^[A-Z]+-\d+$/i.test(text)) {
    return false;
  }
  return ![
    "qa",
    "dev",
    "개선",
    "버그",
    "부작업",
    "새기능",
    "기능",
    "테스트",
    "데이터베이스",
    "database"
  ].some((generic) => normalized === generic || normalized.startsWith(generic)) &&
    !/^(itms|metastream|dq|dqc)$/i.test(normalized);
}

function looksLikeCustomerName(value) {
  const text = String(value ?? "").trim();
  return /[가-힣]/.test(text) &&
    /(은행|증권|금융|지주|생명|라이프|보험|카드|캐피탈|저축|공사|공단|협회|대학교|병원|그룹|청|원)$/.test(
      text
    );
}

function normalizeCustomerName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()[\]{}.,·_\-]/g, "");
}

async function readSheetRows(request, exportUrl) {
  const separator = exportUrl.includes("?") ? "&" : "?";
  const freshUrl =
    `${exportUrl}${separator}_=${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await request.get(freshUrl, {
    timeout: 30_000,
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!response.ok()) {
    throw new Error(`Google Sheets CSV 조회 실패: HTTP ${response.status()}`);
  }
  return parseCsv(await response.text());
}

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

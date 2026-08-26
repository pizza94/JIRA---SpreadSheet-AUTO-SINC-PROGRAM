import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { parseGoogleSheetLink } from "./google-sheet-url.mjs";
import { extractIssueKeys } from "./issue-key-parser.mjs";
import {
  dailyResultFileName,
  prependDailyResult
} from "./result-history.mjs";
import {
  formatIssueRowMismatches,
  issueRowMismatches,
  jiraHyperlinkFormula,
  normalizeVerificationValue
} from "./sheet-verification.mjs";
import { buildSyncSummary } from "./sync-summary.mjs";
import {
  assertSheetMutationTarget,
  countIssueRows,
  findDashboardDropdownSampleCell,
  findNewChecklistTemplateSheet,
  findTemplateTypeStyleSource,
  findPreviousSnapshotIndex,
  normalizeIssueTypeForStyle,
  normalizeSnapshotName,
  normalizeWorkMode,
  planNewChecklistSnapshotColumns,
  planRequestedSnapshotColumn,
  shouldUseTemplateForInsertedRow,
  validateTemplateCopyConfig,
  WORK_MODE_NEW
} from "./sync-mode.mjs";
import {
  carriedSnapshotValue,
  copiedSnapshotRepairValue,
  findBlankSnapshotWorkIndex,
  findHistoricalInactiveStyleSource,
  isKnownSnapshotDropdownValue,
  isSnapshotWorkHeader,
  referenceValueForRun,
  snapshotCarryAction,
  snapshotValueForRun,
  shouldUseJiraStatusForSnapshot,
  shouldResetCarriedSnapshot
} from "./snapshot-rules.mjs";

const jiraBaseUrl = process.env.JIRA_BASE_URL ?? "http://192.168.0.119:8079";
const dataRoot = resolve(process.env.AUTOMATION_DATA_DIR ?? ".");
const outputDir = resolve(
  process.env.AUTOMATION_OUTPUT_DIR ?? resolve(dataRoot, "output")
);
const jiraAuthFile = resolve(dataRoot, "playwright/.auth/jira.json");
const googleAuthFile = resolve(dataRoot, "playwright/.auth/google.json");
const args = parseArgs(process.argv.slice(2));
const sheetMutationTargets = new WeakMap();
const jiraFetchConcurrency = 4;
const defaultTemplateSheetName = "스프레드시트양식";
const processStartedAt = Date.now();
let sheetReadCount = 0;
let sheetReadDurationMs = 0;

if (
  !args.issueKeys.length ||
  !args.sheetUrl ||
  !args.workMode ||
  !args.snapshotName
) {
  throw new Error(
    "사용법: npm run sync -- --issues MS-100,MS-101 " +
      '--sheet-url "Google Sheets URL (gid 포함)" ' +
      '--work-mode new|existing --snapshot-name SNAPSHOT-3'
  );
}
args.workMode = normalizeWorkMode(args.workMode);
args.snapshotName = normalizeSnapshotName(args.snapshotName);

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
  const completedAt = new Date();
  const resultPath = resolve(
    outputDir,
    dailyResultFileName(completedAt)
  );
  const report = {
    status: "성공",
    completedAt: completedAt.toISOString(),
    jiraBaseUrl,
    sheetName: sheetResult.sheetName,
    sheetUrl: sheetResult.resolvedSheetUrl,
    snapshot: sheetResult.snapshot,
    schedule: sheetResult.schedule,
    performance: sheetResult.performance,
    results: sheetResult.results
  };

  await mkdir(outputDir, { recursive: true });
  await prependDailyResult(
    outputDir,
    buildSyncSummary({
      ...report,
      resultPath
    }),
    completedAt
  );

  console.log(
    JSON.stringify(
      {
        sheetName: sheetResult.sheetName,
        resolvedSheetUrl: sheetResult.resolvedSheetUrl,
        snapshot: sheetResult.snapshot,
        schedule: sheetResult.schedule,
        performance: sheetResult.performance,
        results: sheetResult.results,
        resultPath,
        outputDirectory: outputDir
      }
    )
  );
} finally {
  await browser.close();
}

function parseArgs(argv) {
  const parsed = {
    issueKeys: [],
    sheetUrl: "",
    workMode: "",
    snapshotName: "",
    deadline: "",
    testStartDate: "",
    testEndDate: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--issues") {
      parsed.issueKeys = extractIssueKeys(argv[++index] ?? "");
    } else if (argument === "--sheet-url") {
      parsed.sheetUrl = argv[++index] ?? "";
    } else if (argument === "--work-mode") {
      parsed.workMode = argv[++index] ?? "";
    } else if (argument === "--snapshot-name") {
      parsed.snapshotName = argv[++index] ?? "";
    } else if (argument === "--deadline") {
      parsed.deadline = argv[++index] ?? "";
    } else if (argument === "--test-start-date") {
      parsed.testStartDate = argv[++index] ?? "";
    } else if (argument === "--test-end-date") {
      parsed.testEndDate = argv[++index] ?? "";
    } else if (/^(?:MS|QS|IRD|MDM|MDMS|MSUI|QSUI|MDMT)-\d+$/i.test(argument)) {
      parsed.issueKeys.push(argument.toUpperCase());
    }
  }

  parsed.issueKeys = [...new Set(parsed.issueKeys)];
  for (const issueKey of parsed.issueKeys) {
    if (!/^(?:MS|QS|IRD|MDM|MDMS|MSUI|QSUI|MDMT)-\d+$/.test(issueKey)) {
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
    const startedAt = Date.now();
    const results = Array(issueKeys.length);
    let nextIndex = 0;
    let fatalError = null;

    async function worker() {
      while (!fatalError) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= issueKeys.length) {
          return;
        }
        const issueKey = issueKeys[index];
        try {
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
          results[index] = issue;
        } catch (error) {
          fatalError = error;
        }
      }
    }

    const workerCount = Math.min(jiraFetchConcurrency, issueKeys.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );
    if (fatalError) {
      throw fatalError;
    }
    issues.push(...results);
    console.log(
      `[성능] Jira ${issues.length}건 병렬 조회 완료: ` +
        `${Date.now() - startedAt}ms (동시 ${workerCount}건)`
    );
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
    const resolved = await resolveSheet(page, config.sheetUrl);
    sheetMutationTargets.set(page, {
      spreadsheetId: resolved.spreadsheetId,
      gid: resolved.gid,
      sheetName: resolved.sheetName
    });
    const templateSheet =
      config.workMode === WORK_MODE_NEW
        ? await resolveNewChecklistTemplateSheet(page, resolved.sheetName)
        : null;
    if (
      config.workMode === WORK_MODE_NEW &&
      normalizeSheetName(templateSheet.sheetName) ===
        normalizeSheetName(resolved.sheetName)
    ) {
      throw new Error(
        `${resolved.sheetName} 탭은 신규 행 양식 기준 탭이므로 초기화할 수 없습니다.`
      );
    }
    const exportUrl =
      `https://docs.google.com/spreadsheets/d/${resolved.spreadsheetId}` +
      `/export?format=csv&gid=${resolved.gid}`;
    const nameBox = page.locator("#t-name-box");
    await nameBox.waitFor({ state: "visible", timeout: 20_000 });
    const resultsByKey = new Map();
    let initialRows = await readSheetRows(context.request, exportUrl);
    let initialLayout = inspectLayout(initialRows);
    findDashboardDropdownSampleCell(initialRows, columnName);
    if (config.workMode === WORK_MODE_NEW) {
      initialRows = await initializeNewChecklistIssueArea(
        page,
        nameBox,
        context.request,
        exportUrl,
        initialRows,
        initialLayout
      );
      initialLayout = inspectLayout(initialRows);
      const preparedSnapshot = await prepareNewChecklistSnapshotColumns(
        page,
        nameBox,
        context.request,
        exportUrl,
        initialRows,
        initialLayout,
        config.snapshotName
      );
      initialRows = preparedSnapshot.rows;
      initialLayout = preparedSnapshot.layout;
    } else if (countIssueRows(initialRows, initialLayout, jiraKeyFromCell) === 0) {
      throw new Error(
        "시트에 기존 Jira 이슈가 없습니다. 작업 유형을 '신규 체크리스트에 최초 등록'으로 선택하세요."
      );
    }
    const snapshotState = await ensureSnapshotWorkColumn(
      page,
      nameBox,
      context.request,
      exportUrl,
      initialRows,
      initialLayout,
      new Map(issues.map((issue) => [issue.key, issue.status])),
      config.snapshotName,
      config.workMode
    );
    initialRows = snapshotState.rows;
    initialLayout = withSnapshotWorkIndex(
      snapshotState.layout,
      snapshotState.snapshotWorkIndex
    );
    const snapshotDropdownSourceCell =
      findDashboardDropdownSampleCell(initialRows, columnName);
    const schedule = await updateScheduleFields(
      page,
      nameBox,
      context.request,
      exportUrl,
      initialRows,
      initialLayout,
      config.workMode === WORK_MODE_NEW
        ? {
            ...config,
            deadline: config.deadline || "-",
            resetSchedule: true
          }
        : config
    );
    let currentRows = initialRows;
    // 기존 행은 입력과 CSV 검증을 일괄 처리한다. 신규 행만 즉시 검증해야 행 삽입과
    // 서식 처리의 위치가 안전하게 유지된다.
    const pendingExistingUpdates = [];
    const pendingExistingVerifications = [];
    let insertedProcessingMs = 0;
    let existingVerificationDurationMs = 0;

    for (const issue of issues) {
      const issueProcessingStartedAt = Date.now();
      let rows = currentRows;
      const layout = withSnapshotWorkIndex(
        inspectLayout(rows),
        snapshotState.snapshotWorkIndex
      );
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
        const lastIssueIndex = issueIndexes.at(-1);
        if (preparedBlankIndex != null) {
          targetIndex = preparedBlankIndex;
          preparedNumber = String(rows[targetIndex]?.[0] ?? "").trim();
          if (
            shouldUseTemplateForInsertedRow(
              config.workMode,
              lastIssueIndex
            )
          ) {
            if (
              config.workMode === WORK_MODE_NEW &&
              lastIssueIndex != null
            ) {
              await copyPreparedNewChecklistRow(
                page,
                nameBox,
                lastIssueIndex + 1,
                targetIndex + 1,
                layout.columnCount
              );
            } else {
              await copyTemplateRowFromSheet(
                page,
                nameBox,
                context.request,
                {
                  spreadsheetId: resolved.spreadsheetId,
                  templateSheetName: templateSheet.sheetName,
                  snapshotDropdownSourceCell:
                    snapshotDropdownSourceCell,
                  targetSheetName: resolved.sheetName,
                  targetRowNumber: targetIndex + 1,
                  targetLayout: layout,
                  issueType: issue.issueType
                }
              );
            }
          } else if (!preparedNumber) {
            const matchingTypeIndex = findMatchingTypeRowIndex(
              rows,
              layout,
              issue.issueType
            );
            await copyRowFormattingAndValidation(
              page,
              nameBox,
              (matchingTypeIndex ?? lastIssueIndex) + 1,
              targetIndex + 1,
              layout.columnCount
            );
          }
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

          if (
            shouldUseTemplateForInsertedRow(
              config.workMode,
              lastIssueIndex
            )
          ) {
            if (
              config.workMode === WORK_MODE_NEW &&
              lastIssueIndex != null
            ) {
              await copyPreparedNewChecklistRow(
                page,
                nameBox,
                lastIssueIndex + 1,
                targetIndex + 1,
                layout.columnCount
              );
            } else {
              await copyTemplateRowFromSheet(
                page,
                nameBox,
                context.request,
                {
                  spreadsheetId: resolved.spreadsheetId,
                  templateSheetName: templateSheet.sheetName,
                  snapshotDropdownSourceCell:
                    snapshotDropdownSourceCell,
                  targetSheetName: resolved.sheetName,
                  targetRowNumber: targetIndex + 1,
                  targetLayout: layout,
                  issueType: issue.issueType
                }
              );
            }
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
        targetIndex,
        config.workMode !== WORK_MODE_NEW
      );
      if (typeStyleSourceCell) {
        await copyCell(
          page,
          nameBox,
          typeStyleSourceCell,
          `B${targetIndex + 1}`
        );
      } else if (config.workMode === WORK_MODE_NEW) {
        await copyTypeStyleFromTemplateSheet(
          page,
          nameBox,
          context.request,
          {
            spreadsheetId: resolved.spreadsheetId,
            templateSheetName: templateSheet.sheetName,
            targetSheetName: resolved.sheetName,
            targetRowNumber: targetIndex + 1,
            issueType: issue.issueType
          }
        );
      }

      const ordinal = rows
        .slice(layout.headerIndex + 1, targetIndex + 1)
        .filter((row) => jiraKeyFromCell(row[2]) !== "").length +
        (action === "inserted" ? 1 : 0);
      const rowNumber = targetIndex + 1;
      const customer =
        action === "updated" && (rows[targetIndex]?.[3] ?? "") !== ""
          ? rows[targetIndex][3]
          : inferCustomer(issue, resolved.sheetName, rows, layout);
      const values = [
        preparedNumber || String(ordinal),
        issue.issueType,
        issue.key,
        customer,
        normalizeVerificationValue(issue.title),
        issue.status,
        issue.priority,
        issue.assignee
      ];

      if (action === "updated") {
        // 기존 행의 Jira 셀은 이미 사용자가 확인한 하이퍼링크를 보존한다.
        // 이슈 번호가 일치하는 경우 JIRA 열(C)을 다시 입력하거나 수식으로 덮어쓰지 않는다.
        pendingExistingUpdates.push({
          rowNumber,
          basicValues: values.slice(0, 2),
          detailValues: values.slice(3)
        });
      } else {
        await pasteTsv(page, nameBox, `A${rowNumber}`, values.join("\t"));
      }
      const currentReferenceValue =
        layout.referenceIndex >= 0
          ? String(rows[targetIndex]?.[layout.referenceIndex] ?? "")
              .trim()
              .toUpperCase()
          : "";
      const expectedReferenceValue = referenceValueForRun(
        currentReferenceValue,
        action === "inserted"
      );
      if (
        layout.referenceIndex >= 0 &&
        (action === "inserted" ||
          !["Y", "N"].includes(currentReferenceValue))
      ) {
        await pasteTsv(
          page,
          nameBox,
          `${columnName(layout.referenceIndex)}${rowNumber}`,
          expectedReferenceValue
        );
      }
      const previousSnapshotValue =
        snapshotState.previousSnapshotIndex >= 0
          ? rows[targetIndex]?.[snapshotState.previousSnapshotIndex] ?? ""
          : "";
      const currentSnapshotValue =
        snapshotState.snapshotWorkIndex >= 0
          ? rows[targetIndex]?.[snapshotState.snapshotWorkIndex] ?? ""
          : "";
      const usesJiraStatusForSnapshot = shouldUseJiraStatusForSnapshot(
        previousSnapshotValue,
        action === "updated"
      );
      const requestedSnapshotValue = snapshotValueForRun(
        previousSnapshotValue,
        usesJiraStatusForSnapshot,
        issue.status
      );
      const resetSnapshot =
        action === "inserted" ||
        (usesJiraStatusForSnapshot
          ? requestedSnapshotValue === ""
          : snapshotState.previousSnapshotIndex >= 0 &&
            shouldResetCarriedSnapshot(action, previousSnapshotValue));
      const targetSnapshotCell =
        snapshotState.snapshotWorkIndex >= 0
          ? `${columnName(snapshotState.snapshotWorkIndex)}${rowNumber}`
          : null;
      const templatePreparedSnapshot =
        config.workMode === WORK_MODE_NEW && action === "inserted";
      const resetBeforeInactiveStyle =
        Boolean(targetSnapshotCell && resetSnapshot) &&
        action === "inserted" &&
        snapshotState.dropdownSourceCell == null &&
        !templatePreparedSnapshot;
      if (resetBeforeInactiveStyle) {
        await copyBlankDropdownSample(
          page,
          nameBox,
          snapshotDropdownSourceCell,
          targetSnapshotCell
        );
      }
      if (action === "inserted" && layout.snapshotIndexes.length > 0) {
        await applyInactiveSnapshotCells(
          page,
          nameBox,
          rows,
          layout,
          rowNumber,
          snapshotState.historicalStyleSource,
          snapshotState.snapshotWorkIndex
        );
      }
      if (
        targetSnapshotCell &&
        resetSnapshot &&
        !resetBeforeInactiveStyle &&
        !templatePreparedSnapshot
      ) {
        await copyBlankDropdownSample(
          page,
          nameBox,
          snapshotDropdownSourceCell,
          targetSnapshotCell
        );
      }
      if (
        targetSnapshotCell &&
        usesJiraStatusForSnapshot &&
        requestedSnapshotValue !== "" &&
        String(currentSnapshotValue).trim() !== requestedSnapshotValue
      ) {
        await selectDropdownValue(
          page,
          nameBox,
          targetSnapshotCell,
          requestedSnapshotValue
        );
        console.log(
          `[SNAPSHOT Jira 상태 반영] ${issue.key}: ${issue.status} → ` +
            `${requestedSnapshotValue} (${targetSnapshotCell})`
        );
      }
      if (action === "inserted") {
        await enterCellFormula(
          page,
          nameBox,
          `C${rowNumber}`,
          jiraHyperlinkFormula(issue.url, issue.key),
          issue.key
        );
      }
      const verification = {
        issue,
        action,
        rowNumber,
        snapshotExpectation:
          snapshotState.snapshotWorkIndex >= 0
            ? {
                columnIndex: snapshotState.snapshotWorkIndex,
                value: usesJiraStatusForSnapshot
                  ? requestedSnapshotValue
                  : resetSnapshot
                    ? ""
                    : String(
                        snapshotState.initialized
                          ? carriedSnapshotValue(previousSnapshotValue)
                          : currentSnapshotValue
                      )
              }
            : null,
        referenceExpectation:
          layout.referenceIndex >= 0
            ? {
                columnIndex: layout.referenceIndex,
                value: expectedReferenceValue
              }
            : null,
        snapshotReset: resetSnapshot
      };
      if (action === "updated") {
        pendingExistingVerifications.push(verification);
      } else {
        const verified = await waitForIssueRow(
          context.request,
          exportUrl,
          issue,
          rowNumber,
          verification.snapshotExpectation,
          verification.referenceExpectation
        );
        currentRows = verified.rows;
        resultsByKey.set(
          issue.key,
          resultFromVerifiedRow(verification, verified.row)
        );
        insertedProcessingMs += Date.now() - issueProcessingStartedAt;
      }
    }

    const existingUpdateStartedAt = Date.now();
    if (pendingExistingUpdates.length > 0) {
      await pasteExistingIssueUpdates(
        page,
        nameBox,
        pendingExistingUpdates
      );
    }
    const existingWriteDurationMs = Date.now() - existingUpdateStartedAt;
    if (pendingExistingVerifications.length > 0) {
      console.log(
        `[성능] 기존 이슈 ${pendingExistingVerifications.length}건을 ` +
          `연속 행 범위 단위로 입력했습니다: ${existingWriteDurationMs}ms`
      );
      const existingVerificationStartedAt = Date.now();
      console.log(
        `[성능] 기존 이슈 ${pendingExistingVerifications.length}건 저장 결과를 일괄 검증합니다.`
      );
      const verifiedRows = await waitForIssueRows(
        context.request,
        exportUrl,
        pendingExistingVerifications
      );
      for (const verification of pendingExistingVerifications) {
        resultsByKey.set(
          verification.issue.key,
          resultFromVerifiedRow(
            verification,
            verifiedRows[verification.rowNumber - 1] ?? []
          )
        );
      }
      console.log(
        `[성능] 기존 이슈 일괄 저장 검증 완료: ` +
          `${Date.now() - existingVerificationStartedAt}ms`
      );
      existingVerificationDurationMs =
        Date.now() - existingVerificationStartedAt;
    }

    if (insertedProcessingMs > 0) {
      console.log(`[성능] 신규 이슈 순차 처리: ${insertedProcessingMs}ms`);
    }
    const results = issues
      .map((issue) => resultsByKey.get(issue.key))
      .filter(Boolean);

    const performance = {
      totalDurationMs: Date.now() - processStartedAt,
      sheetReadCount,
      sheetReadDurationMs,
      existingWriteDurationMs,
      existingVerificationDurationMs,
      insertedProcessingMs
    };
    console.log(
      `[성능] Google Sheets CSV 조회 ${sheetReadCount}회, ` +
        `누적 ${sheetReadDurationMs}ms`
    );
    return {
      sheetName: resolved.sheetName,
      resolvedSheetUrl: resolved.url,
      snapshot: {
        insertedColumn: snapshotState.inserted,
        initializedValues: snapshotState.initialized,
        previousColumn:
          snapshotState.previousSnapshotIndex >= 0
            ? columnName(snapshotState.previousSnapshotIndex)
            : "",
        workColumn:
          snapshotState.snapshotWorkIndex >= 0
            ? columnName(snapshotState.snapshotWorkIndex)
            : "",
        header: config.snapshotName
      },
      schedule,
      performance,
      results
    };
  } finally {
    await context.close();
  }
}

async function resolveSheet(page, providedUrl) {
  const requested = parseGoogleSheetLink(providedUrl);
  await page.goto(requested.canonicalUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000
  });

  const tabs = page.locator(".docs-sheet-tab");
  await tabs.first().waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(500);

  const current = parseGoogleSheetLink(page.url());
  if (
    current.spreadsheetId !== requested.spreadsheetId ||
    current.gid !== requested.gid
  ) {
    throw new Error(
      `Google Sheets 링크의 대상 탭을 열지 못했습니다. ` +
        `요청 gid=${requested.gid}, 현재 gid=${current.gid}`
    );
  }

  let activeTab = page.locator(
    ".docs-sheet-tab.docs-sheet-active-tab"
  ).first();
  if ((await activeTab.count()) === 0) {
    activeTab = page.locator(
      '.docs-sheet-tab[aria-selected="true"]'
    ).first();
  }
  if ((await activeTab.count()) === 0) {
    throw new Error(
      `Google Sheets에서 gid=${requested.gid}인 활성 탭을 확인하지 못했습니다.`
    );
  }
  const sheetName = (await activeTab.innerText()).trim();
  if (!sheetName) {
    throw new Error(
      `Google Sheets에서 gid=${requested.gid}인 탭 이름을 확인하지 못했습니다.`
    );
  }

  console.log(`[대상 시트 자동 감지] ${sheetName} (gid=${requested.gid})`);
  return {
    spreadsheetId: requested.spreadsheetId,
    gid: requested.gid,
    sheetName,
    url: requested.canonicalUrl
  };
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
  await page.waitForTimeout(650);
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

async function resolveNewChecklistTemplateSheet(page, targetSheetName) {
  const tabs = page.locator(".docs-sheet-tab");
  const count = await tabs.count();
  const sheetNames = [];
  for (let index = 0; index < count; index += 1) {
    const sheetName = (await tabs.nth(index).innerText()).trim();
    if (sheetName) {
      sheetNames.push(sheetName);
    }
  }
  const template = findNewChecklistTemplateSheet(
    sheetNames,
    targetSheetName,
    defaultTemplateSheetName
  );
  if (template == null) {
    throw new Error(
      `신규 체크리스트 기준 탭을 찾지 못했습니다. ` +
        `'${defaultTemplateSheetName}' 탭이 없고, 대상 탭 외에 제품 버전 형식의 시트도 없습니다.`
    );
  }
  console.log(
    template.source === "standard-template"
      ? `[신규 양식 기준] ${template.sheetName} 탭 사용`
      : `[신규 양식 기준 대체] ${defaultTemplateSheetName} 탭 없음 → ` +
          `${template.sheetName} 탭 사용`
  );
  return template;
}

async function assertTargetSheetMutation(page, operation) {
  const expected = sheetMutationTargets.get(page);
  let current = null;
  try {
    current = parseGoogleSheetLink(page.url());
  } catch {
    current = null;
  }
  let activeTab = page.locator(
    ".docs-sheet-tab.docs-sheet-active-tab"
  ).first();
  if ((await activeTab.count()) === 0) {
    activeTab = page.locator(
      '.docs-sheet-tab[aria-selected="true"]'
    ).first();
  }
  const activeSheetName =
    (await activeTab.count()) > 0
      ? (await activeTab.innerText()).trim()
      : "";
  try {
    assertSheetMutationTarget(expected, current, activeSheetName);
  } catch (error) {
    throw new Error(`${operation}: ${error.message}`);
  }
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
  const snapshotWorkHeaderIndex = header.findIndex((value) =>
    isSnapshotWorkHeader(value)
  );
  const snapshotIndexes = header
    .map((value, index) => ({ value: String(value ?? ""), index }))
    .filter(
      ({ value, index }) =>
        /^SNAPSHOT/i.test(value) && index !== snapshotWorkHeaderIndex
    )
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
  const blankSnapshotWorkIndex = findBlankSnapshotWorkIndex(
    header,
    snapshotIndexes,
    referenceIndex
  );
  return {
    headerIndex,
    issueEndIndex: issueEndIndex >= 0 ? issueEndIndex : rows.length,
    snapshotIndexes,
    snapshotWorkIndex:
      blankSnapshotWorkIndex >= 0
        ? blankSnapshotWorkIndex
        : snapshotIndexes.at(-1) ?? -1,
    hasBlankSnapshotWorkColumn: blankSnapshotWorkIndex >= 0,
    referenceIndex,
    columnCount
  };
}

function withSnapshotWorkIndex(layout, snapshotWorkIndex) {
  return {
    ...layout,
    snapshotWorkIndex
  };
}

function normalizeType(value) {
  return normalizeIssueTypeForStyle(value);
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

function findTypeStyleSourceCell(
  rows,
  layout,
  issueType,
  excludedIndex = -1,
  allowNeutralFallback = true
) {
  const matchingIssueIndex = findMatchingTypeRowIndex(
    rows,
    layout,
    issueType,
    excludedIndex
  );
  if (matchingIssueIndex != null) {
    return `B${matchingIssueIndex + 1}`;
  }
  if (!allowNeutralFallback) {
    return null;
  }

  const neutralIssueIndex = rows.findIndex(
    (row, index) =>
      index > layout.headerIndex &&
      index < layout.issueEndIndex &&
      index !== excludedIndex &&
      jiraKeyFromCell(row[2]) !== ""
  );
  return neutralIssueIndex >= 0 ? `B${neutralIssueIndex + 1}` : null;
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
    const entireIssueRowIsBlank = row
      .slice(0, layout.columnCount)
      .every((value) => String(value ?? "").trim() === "");
    const blankRowsFromHere = rows
      .slice(index, layout.issueEndIndex)
      .filter((candidateRow) =>
        (candidateRow ?? [])
          .slice(0, layout.columnCount)
          .every((value) => String(value ?? "").trim() === "")
      ).length;
    if (
      (hasPreparedNumber && issueFieldsAreBlank) ||
      (entireIssueRowIsBlank && blankRowsFromHere > 4)
    ) {
      return index;
    }
  }
  return null;
}

async function initializeNewChecklistIssueArea(
  page,
  nameBox,
  request,
  exportUrl,
  rows,
  layout
) {
  const firstIssueRowNumber = layout.headerIndex + 2;
  const lastIssueRowNumber = layout.issueEndIndex;
  if (lastIssueRowNumber < firstIssueRowNumber) {
    return rows;
  }
  const lastColumn = columnName(layout.columnCount - 1);
  const targetRange =
    `A${firstIssueRowNumber}:${lastColumn}${lastIssueRowNumber}`;
  await clearRange(page, nameBox, targetRange);
  console.log(`[신규 체크리스트 초기화] 이슈 영역 값 삭제: ${targetRange}`);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const refreshedRows = await readSheetRows(request, exportUrl);
    const refreshedLayout = inspectLayout(refreshedRows);
    if (countIssueRows(refreshedRows, refreshedLayout, jiraKeyFromCell) === 0) {
      return refreshedRows;
    }
    await page.waitForTimeout(1_500);
  }
  throw new Error("신규 체크리스트의 기존 이슈 값을 초기화하지 못했습니다.");
}

async function prepareNewChecklistSnapshotColumns(
  page,
  nameBox,
  request,
  exportUrl,
  rows,
  layout,
  requestedSnapshotName
) {
  const header = rows[layout.headerIndex] ?? [];
  const plan = planNewChecklistSnapshotColumns(
    header,
    layout.referenceIndex
  );
  let currentRows = rows;
  let currentLayout = layout;

  for (const columnIndex of plan.deleteIndexes) {
    if (
      currentLayout.referenceIndex < 0 ||
      columnIndex >= currentLayout.referenceIndex
    ) {
      throw new Error(
        `신규 체크리스트의 SNAPSHOT 열 위치를 확인하지 못했습니다: ` +
          `${columnName(columnIndex)}열`
      );
    }
    const column = columnName(columnIndex);
    const expectedReferenceIndex = currentLayout.referenceIndex - 1;
    await nameBox.fill(`${column}:${column}`);
    await nameBox.press("Enter");
    await page.waitForTimeout(300);
    await assertTargetSheetMutation(page, `SNAPSHOT ${column}열 삭제`);
    await page.keyboard.press("Control+Alt+Minus");
    currentRows = await waitForDeletedSnapshotColumn(
      request,
      exportUrl,
      expectedReferenceIndex
    );
    currentLayout = inspectLayout(currentRows);
    console.log(`[신규 SNAPSHOT 열 정리] ${column}열 삭제`);
  }

  if (plan.keepIndex >= 0) {
    if (currentLayout.referenceIndex !== plan.keepIndex + 1) {
      throw new Error(
        `신규 체크리스트의 SNAPSHOT 열을 하나로 정리하지 못했습니다. ` +
          `SNAPSHOT=${columnName(plan.keepIndex)}열, ` +
          `참고사항=${columnName(currentLayout.referenceIndex)}열`
      );
    }
    const targetCell =
      `${columnName(plan.keepIndex)}${currentLayout.headerIndex + 1}`;
    const currentHeader = String(
      currentRows[currentLayout.headerIndex]?.[plan.keepIndex] ?? ""
    )
      .trim()
      .toUpperCase();
    if (currentHeader !== requestedSnapshotName) {
      await enterCellText(
        page,
        nameBox,
        targetCell,
        requestedSnapshotName
      );
      currentRows = await waitForRequestedSnapshotHeader(
        request,
        exportUrl,
        plan.keepIndex,
        requestedSnapshotName
      );
      currentLayout = inspectLayout(currentRows);
    }
    console.log(
      `[신규 SNAPSHOT 열 유지] ${columnName(plan.keepIndex)}열 = ` +
        requestedSnapshotName
    );
  }

  return {
    rows: currentRows,
    layout: currentLayout
  };
}

async function waitForDeletedSnapshotColumn(
  request,
  exportUrl,
  expectedReferenceIndex
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await readSheetRows(request, exportUrl);
    const layout = inspectLayout(rows);
    if (layout.referenceIndex === expectedReferenceIndex) {
      return rows;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  throw new Error(
    `신규 체크리스트의 기존 SNAPSHOT/빈 열을 삭제하지 못했습니다. ` +
      `예상 참고사항 열=${columnName(expectedReferenceIndex)}`
  );
}

async function ensureSnapshotWorkColumn(
  page,
  nameBox,
  request,
  exportUrl,
  rows,
  layout,
  inputIssueStatuses,
  requestedSnapshotName,
  workMode
) {
  let header = rows[layout.headerIndex] ?? [];
  const plan = planRequestedSnapshotColumn(
    header,
    layout.referenceIndex,
    requestedSnapshotName
  );
  let inserted = false;
  let snapshotWorkIndex = plan.targetIndex;

  if (plan.action === "insert") {
    if (layout.referenceIndex < 0) {
      throw new Error(
        "SNAPSHOT 열을 추가할 기준인 참고사항여부 열을 찾지 못했습니다."
      );
    }
    const targetColumn = columnName(snapshotWorkIndex);
    await nameBox.fill(`${targetColumn}:${targetColumn}`);
    await nameBox.press("Enter");
    await page.waitForTimeout(300);
    await assertTargetSheetMutation(page, `SNAPSHOT ${targetColumn}열 추가`);
    await page.keyboard.press("Control+Alt+Equal");
    await page.waitForTimeout(1_000);
    inserted = true;

    rows = await waitForInsertedColumnAt(
      request,
      exportUrl,
      snapshotWorkIndex,
      layout.referenceIndex + 1
    );
    layout = inspectLayout(rows);
    console.log(
      `[SNAPSHOT 열 생성] ${columnName(snapshotWorkIndex)}열, ` +
        `참고사항여부=${columnName(layout.referenceIndex)}열`
    );
  }

  const currentHeader = String(
    rows[layout.headerIndex]?.[snapshotWorkIndex] ?? ""
  )
    .trim()
    .toUpperCase();
  if (currentHeader !== requestedSnapshotName) {
    await enterCellText(
      page,
      nameBox,
      `${columnName(snapshotWorkIndex)}${layout.headerIndex + 1}`,
      requestedSnapshotName
    );
    rows = await waitForRequestedSnapshotHeader(
      request,
      exportUrl,
      snapshotWorkIndex,
      requestedSnapshotName
    );
    layout = inspectLayout(rows);
    console.log(
      `[SNAPSHOT 헤더 설정] ${columnName(snapshotWorkIndex)}열 = ${requestedSnapshotName}`
    );
  }

  header = rows[layout.headerIndex] ?? [];
  const previousSnapshotIndex = findPreviousSnapshotIndex(
    header,
    snapshotWorkIndex
  );
  layout = withSnapshotWorkIndex(layout, snapshotWorkIndex);
  const issueCount = countIssueRows(rows, layout, jiraKeyFromCell);
  const existingWorkColumnHasValues = rows
    .slice(layout.headerIndex + 1, layout.issueEndIndex)
    .some((row) => String(row[snapshotWorkIndex] ?? "").trim() !== "");
  const initialized =
    workMode !== WORK_MODE_NEW &&
    previousSnapshotIndex >= 0 &&
    issueCount > 0 &&
    !existingWorkColumnHasValues;
  const historicalStyleSource = findHistoricalInactiveStyleSource(rows, layout);

  if (initialized) {
    await copySnapshotColumn(
      page,
      nameBox,
      previousSnapshotIndex,
      snapshotWorkIndex,
      layout.headerIndex + 2,
      layout.issueEndIndex
    );
    await writeCarriedSnapshotValues(
      page,
      nameBox,
      rows,
      layout,
      previousSnapshotIndex,
      snapshotWorkIndex,
      inputIssueStatuses
    );
    rows = await waitForSnapshotCarryValues(
      request,
      exportUrl,
      rows,
      layout,
      previousSnapshotIndex,
      snapshotWorkIndex,
      inputIssueStatuses,
      page,
      nameBox,
      requestedSnapshotName
    );
    layout = inspectLayout(rows);
    layout = withSnapshotWorkIndex(layout, snapshotWorkIndex);
  } else if (
    workMode !== WORK_MODE_NEW &&
    previousSnapshotIndex >= 0 &&
    existingWorkColumnHasValues
  ) {
    const repairedMutations = await repairCopiedSnapshotValues(
      page,
      nameBox,
      rows,
      layout,
      previousSnapshotIndex,
      snapshotWorkIndex
    );
    if (repairedMutations.length > 0) {
      rows = await waitForSnapshotMutationValues(
        request,
        exportUrl,
        snapshotWorkIndex,
        repairedMutations
      );
      layout = inspectLayout(rows);
      layout = withSnapshotWorkIndex(layout, snapshotWorkIndex);
    }
  }

  const dropdownSourceIndex =
    previousSnapshotIndex >= 0 ? previousSnapshotIndex : snapshotWorkIndex;
  const preferredDropdownSourceRowIndex = rows.findIndex(
    (row, index) =>
      index > layout.headerIndex &&
      index < layout.issueEndIndex &&
      jiraKeyFromCell(row[2]) !== "" &&
      isKnownSnapshotDropdownValue(row[dropdownSourceIndex])
  );
  const fallbackDropdownSourceRowIndex = rows.findIndex(
    (row, index) =>
      index > layout.headerIndex &&
      index < layout.issueEndIndex &&
      jiraKeyFromCell(row[2]) !== ""
  );
  const dropdownSourceRowIndex =
    preferredDropdownSourceRowIndex >= 0
      ? preferredDropdownSourceRowIndex
      : fallbackDropdownSourceRowIndex;
  const dropdownSourceCell =
    dropdownSourceRowIndex >= 0
      ? `${columnName(dropdownSourceIndex)}${dropdownSourceRowIndex + 1}`
      : null;

  return {
    rows,
    layout,
    previousSnapshotIndex,
    snapshotWorkIndex,
    dropdownSourceCell,
    inserted,
    initialized,
    historicalStyleSource
  };
}

async function repairCopiedSnapshotValues(
  page,
  nameBox,
  sourceRows,
  layout,
  previousSnapshotIndex,
  snapshotWorkIndex
) {
  const mutations = [];
  for (
    let rowIndex = layout.headerIndex + 1;
    rowIndex < layout.issueEndIndex;
    rowIndex += 1
  ) {
    const row = sourceRows[rowIndex] ?? [];
    const jiraKey = jiraKeyFromCell(row[2]);
    if (!jiraKey) {
      continue;
    }
    const previousValue = String(row[previousSnapshotIndex] ?? "");
    const currentValue = String(row[snapshotWorkIndex] ?? "");
    const expectedValue = copiedSnapshotRepairValue(
      previousValue,
      currentValue
    );
    if (expectedValue == null) {
      continue;
    }
    mutations.push({
      rowIndex,
      jiraKey,
      previousValue,
      value: expectedValue,
      sourceCell: `${columnName(previousSnapshotIndex)}${rowIndex + 1}`,
      targetCell: `${columnName(snapshotWorkIndex)}${rowIndex + 1}`
    });
  }

  for (const mutation of mutations) {
    if (mutation.value === "") {
      await resetSnapshotDropdownValue(
        page,
        nameBox,
        mutation.sourceCell,
        mutation.targetCell
      );
    } else {
      await pasteTsv(page, nameBox, mutation.targetCell, mutation.value);
    }
    console.log(
      `[SNAPSHOT 복사값 보정] ${mutation.jiraKey}: ` +
        `${mutation.previousValue} -> ${mutation.value} (${mutation.targetCell})`
    );
  }
  return mutations;
}

async function waitForSnapshotMutationValues(
  request,
  exportUrl,
  snapshotWorkIndex,
  mutations
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await readSheetRows(request, exportUrl);
    const complete = mutations.every(
      ({ rowIndex, value }) =>
        String(rows[rowIndex]?.[snapshotWorkIndex] ?? "") === value
    );
    if (complete) {
      return rows;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  const first = mutations[0];
  throw new Error(
    `기존 SNAPSHOT 복사값을 보정하지 못했습니다: ` +
      `${first?.jiraKey ?? "-"}, 예상값=${first?.value ?? ""}`
  );
}

async function writeCarriedSnapshotValues(
  page,
  nameBox,
  sourceRows,
  layout,
  previousSnapshotIndex,
  snapshotWorkIndex,
  inputIssueStatuses
) {
  const issueRows = sourceRows.slice(
    layout.headerIndex + 1,
    layout.issueEndIndex
  );
  if (issueRows.length === 0) {
    return;
  }
  const targetColumn = columnName(snapshotWorkIndex);
  const mutations = [];
  for (let offset = 0; offset < issueRows.length; offset += 1) {
    const row = issueRows[offset] ?? [];
    const previousValue = row[previousSnapshotIndex];
    const rowNumber = layout.headerIndex + 2 + offset;
    const jiraKey = jiraKeyFromCell(row[2]);
    const action = snapshotCarryAction(
      previousValue,
      previousValue,
      inputIssueStatuses.has(jiraKey),
      inputIssueStatuses.get(jiraKey) ?? ""
    );
    if (action.type === "none") {
      continue;
    }
    mutations.push({
      ...action,
      offset,
      rowNumber,
      sourceCell: `${columnName(previousSnapshotIndex)}${rowNumber}`,
      targetCell: `${targetColumn}${rowNumber}`,
      jiraKey,
      previousValue: String(previousValue ?? "")
    });
  }

  for (let index = 0; index < mutations.length; ) {
    const first = mutations[index];
    const group = [first];
    index += 1;
    while (
      index < mutations.length &&
      mutations[index].type === first.type &&
      mutations[index].offset === group.at(-1).offset + 1
    ) {
      group.push(mutations[index]);
      index += 1;
    }

    if (first.type === "clear") {
      for (const item of group) {
        await resetSnapshotDropdownValue(
          page,
          nameBox,
          item.sourceCell,
          item.targetCell
        );
      }
    } else {
      await pasteTsv(
        page,
        nameBox,
        first.targetCell,
        group.map((item) => item.value).join("\n")
      );
    }
  }

  for (const mutation of mutations) {
    console.log(
      `[SNAPSHOT 승계] ${mutation.jiraKey || mutation.targetCell}: ` +
        `${mutation.previousValue} -> ${mutation.value} (${mutation.targetCell})`
    );
  }
  console.log(
    `[성능] SNAPSHOT ${issueRows.length}개 행 중 ` +
      `${mutations.length}개 변경값을 연속 범위 단위로 일괄 반영`
  );
}

async function waitForInsertedColumnAt(
  request,
  exportUrl,
  expectedColumnIndex,
  expectedReferenceIndex
) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await readSheetRows(request, exportUrl);
    const layout = inspectLayout(rows);
    if (
      layout.referenceIndex === expectedReferenceIndex &&
      expectedColumnIndex < layout.referenceIndex
    ) {
      return rows;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error("새 SNAPSHOT 열을 삽입하지 못했습니다.");
}

async function waitForRequestedSnapshotHeader(
  request,
  exportUrl,
  expectedSnapshotWorkIndex,
  requestedSnapshotName
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await readSheetRows(request, exportUrl);
    const layout = inspectLayout(rows);
    const headerValue =
      rows[layout.headerIndex]?.[expectedSnapshotWorkIndex] ?? "";
    if (
      String(headerValue).trim().toUpperCase() === requestedSnapshotName
    ) {
      return rows;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  throw new Error(
    `새 SNAPSHOT 열 헤더를 설정하지 못했습니다: ` +
      `${columnName(expectedSnapshotWorkIndex)}열, 헤더=${requestedSnapshotName}`
  );
}

async function copySnapshotColumn(
  page,
  nameBox,
  sourceColumnIndex,
  targetColumnIndex,
  firstRowNumber,
  lastRowNumber
) {
  const sourceColumn = columnName(sourceColumnIndex);
  const targetColumn = columnName(targetColumnIndex);
  await nameBox.fill(
    `${sourceColumn}${firstRowNumber}:${sourceColumn}${lastRowNumber}`
  );
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(500);
  await nameBox.fill(`${targetColumn}${firstRowNumber}`);
  await nameBox.press("Enter");
  await assertTargetSheetMutation(
    page,
    `SNAPSHOT ${targetColumn}열 값 붙여넣기`
  );
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(1_500);
  console.log(
    `[SNAPSHOT 이슈 셀 복사] ` +
      `${sourceColumn}${firstRowNumber}:${sourceColumn}${lastRowNumber} → ` +
      `${targetColumn}${firstRowNumber}`
  );
}

async function waitForSnapshotCarryValues(
  request,
  exportUrl,
  sourceRows,
  layout,
  previousSnapshotIndex,
  snapshotWorkIndex,
  inputIssueStatuses,
  page,
  nameBox,
  requestedSnapshotName
) {
  const expected = sourceRows
    .slice(layout.headerIndex + 1, layout.issueEndIndex)
    .map((row, offset) => ({
      rowIndex: layout.headerIndex + 1 + offset,
      jiraKey: jiraKeyFromCell(row[2]),
      targetCell:
        `${columnName(snapshotWorkIndex)}${layout.headerIndex + 2 + offset}`,
      sourceCell:
        `${columnName(previousSnapshotIndex)}${layout.headerIndex + 2 + offset}`,
      value: snapshotValueForRun(
        row[previousSnapshotIndex],
        inputIssueStatuses.has(jiraKeyFromCell(row[2])),
        inputIssueStatuses.get(jiraKeyFromCell(row[2])) ?? ""
      )
    }))
    .filter((item) => item.jiraKey !== "");
  if (expected.length === 0) {
    return readSheetRows(request, exportUrl);
  }

  const deadline = Date.now() + 90_000;
  let retryCount = 0;
  let nextRetryAt = Date.now() + 8_000;
  let lastMismatch = null;
  while (Date.now() < deadline) {
    const rows = await readSheetRows(request, exportUrl);
    const currentLayout = inspectLayout(rows);
    const currentHeader = String(
      rows[currentLayout.headerIndex]?.[snapshotWorkIndex] ?? ""
    )
      .trim()
      .toUpperCase();
    if (currentHeader !== requestedSnapshotName) {
      throw new Error(
        `등록 SNAPSHOT 헤더가 유지되지 않았습니다. ` +
          `작업 열=${columnName(snapshotWorkIndex)}, ` +
          `예상=${requestedSnapshotName}, 실제=${currentHeader || "(빈값)"}`
      );
    }
    const mismatches = expected.filter(
      ({ rowIndex, value }) =>
        String(rows[rowIndex]?.[snapshotWorkIndex] ?? "") !== value
    );
    lastMismatch = mismatches[0] ?? null;
    if (!lastMismatch) {
      console.log(
        `[SNAPSHOT 최종값 검증 완료] ${expected.length}개 이슈`
      );
      return rows;
    }
    if (retryCount < 2 && Date.now() >= nextRetryAt) {
      retryCount += 1;
      console.log(
        `[SNAPSHOT 재시도 ${retryCount}/2] ` +
          mismatches
            .map(
              ({ jiraKey, targetCell, value }) =>
                `${jiraKey || targetCell}=${value}`
            )
            .join(", ")
      );
      for (const mismatch of mismatches) {
        if (mismatch.value === "") {
          await resetSnapshotDropdownValue(
            page,
            nameBox,
            mismatch.sourceCell,
            mismatch.targetCell
          );
        } else {
          await selectDropdownValue(
            page,
            nameBox,
            mismatch.targetCell,
            mismatch.value
          );
        }
      }
      nextRetryAt = Date.now() + 15_000;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(
    `이전 SNAPSHOT 값을 새 열로 복사하지 못했습니다.` +
      (lastMismatch
        ? ` 확인 실패: ${lastMismatch.jiraKey}, ` +
          `셀=${lastMismatch.targetCell}, 예상값=${lastMismatch.value}`
        : "")
  );
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
  await assertTargetSheetMutation(page, `${rowNumber}행 삽입`);
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
        column:
          layout.snapshotWorkIndex >= 0
            ? layout.snapshotWorkIndex
            : cell.column + 1
      })
    },
    {
      key: "testEndDate",
      value: config.testEndDate,
      label: "테스트종료일",
      target: (cell) => ({
        row: cell.row,
        column:
          layout.snapshotWorkIndex >= 0
            ? layout.snapshotWorkIndex
            : cell.column + 1
      })
    }
  ].filter((item) => item.value || config.resetSchedule === true);

  const updated = {};
  for (const item of requested) {
    const labelCell = findSheetCell(rows, item.label);
    if (!labelCell) {
      throw new Error(`시트에서 '${item.label}' 항목을 찾지 못했습니다.`);
    }
    const target = item.target(labelCell);
    const targetCell = `${columnName(target.column)}${target.row + 1}`;
    if (item.value === "") {
      await clearRange(page, nameBox, targetCell);
    } else {
      await pasteTsv(page, nameBox, targetCell, item.value);
    }
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

function comparableScheduleValue(value) {
  const text = String(value ?? "").trim();
  return /\d/.test(text) ? comparableDate(text) : text;
}

async function waitForScheduleValues(request, exportUrl, updated) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
    const rows = await readSheetRows(request, exportUrl);
    const complete = Object.values(updated).every((details) => {
      const coordinates = parseCellAddress(details.cell);
      return (
        comparableScheduleValue(
          rows[coordinates.row]?.[coordinates.column]
        ) === comparableScheduleValue(details.value)
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
  await assertTargetSheetMutation(page, `${targetCell} 셀 복사`);
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(500);
}

async function clearRange(page, nameBox, targetRange) {
  await nameBox.fill(targetRange);
  await nameBox.press("Enter");
  await assertTargetSheetMutation(page, `${targetRange} 값 삭제`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
}

async function clearDropdownValue(page, nameBox, targetRange) {
  // Delete는 셀 값만 제거하므로 복사된 드롭다운(데이터 유효성 검사)은 유지된다.
  await clearRange(page, nameBox, targetRange);
  console.log(`[SNAPSHOT 드롭다운 빈값 설정] ${targetRange}`);
}

async function resetSnapshotDropdownValue(
  page,
  nameBox,
  sourceCell,
  targetCell
) {
  if (!sourceCell) {
    throw new Error(
      `${targetCell}을 빈 드롭다운으로 만들 원본 SNAPSHOT 셀을 찾지 못했습니다.`
    );
  }
  if (sourceCell !== targetCell) {
    await copyCell(page, nameBox, sourceCell, targetCell);
  }
  await clearDropdownValue(page, nameBox, targetCell);
}

async function copyBlankDropdownSample(
  page,
  nameBox,
  sourceCell,
  targetCell
) {
  await copyCell(page, nameBox, sourceCell, targetCell);
  console.log(`[SNAPSHOT 빈 드롭다운 복사] ${sourceCell} → ${targetCell}`);
}

async function setCellFillColor(page, nameBox, targetRange, colorName) {
  await nameBox.fill(targetRange);
  await nameBox.press("Enter");
  await page.waitForTimeout(250);
  await assertTargetSheetMutation(
    page,
    `${targetRange} 배경색 ${colorName} 적용`
  );

  const fillColorButton = page
    .locator(
      '#t-cell-color, [aria-label*="채우기 색상"], [aria-label*="Fill color"]'
    )
    .filter({ visible: true })
    .first();
  await fillColorButton.waitFor({ state: "visible", timeout: 5_000 });
  const menuTrigger = fillColorButton
    .locator(
      '.goog-toolbar-menu-button-dropdown, [aria-haspopup="menu"], [role="button"]'
    )
    .filter({ visible: true })
    .first();
  if (await menuTrigger.isVisible().catch(() => false)) {
    await menuTrigger.click();
  } else {
    await fillColorButton.click();
  }

  const colorOption = page
    .locator(
      [
        `.goog-palette-cell[aria-label*="${colorName}"]`,
        `.docs-material-colorpalette-colorswatch[aria-label*="${colorName}"]`,
        `[role="gridcell"][aria-label*="${colorName}"]`,
        `.goog-palette-cell[title*="${colorName}"]`,
        '.goog-palette-cell[aria-label*="Dark gray 3"]',
        '.docs-material-colorpalette-colorswatch[aria-label*="Dark gray 3"]',
        '[role="gridcell"][aria-label*="Dark gray 3"]',
        '.goog-palette-cell [style*="rgb(102, 102, 102)"]',
        '.goog-palette-cell [style*="#666666"]'
      ].join(", ")
    )
    .filter({ visible: true })
    .first();
  try {
    await colorOption.waitFor({ state: "visible", timeout: 5_000 });
    await colorOption.click();
    await page.waitForTimeout(500);
  } catch (error) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `${targetRange}의 배경색을 ${colorName}으로 설정하지 못했습니다: ` +
        error.message
    );
  }
}

async function applyInactiveSnapshotCells(
  page,
  nameBox,
  rows,
  layout,
  targetRowNumber,
  historicalStyleSource,
  activeSnapshotIndex
) {
  const firstIssueIndex = rows.findIndex(
    (row, index) =>
      index > layout.headerIndex &&
      index < layout.issueEndIndex &&
      jiraKeyFromCell(row[2]) !== ""
  );
  const sourceCell = historicalStyleSource
    ? `${columnName(historicalStyleSource.columnIndex)}${historicalStyleSource.rowIndex + 1}`
    : firstIssueIndex >= 0
      ? `A${firstIssueIndex + 1}`
      : `A${targetRowNumber}`;

  const inactiveSnapshotIndexes = layout.snapshotIndexes.filter(
    (snapshotIndex) => snapshotIndex !== activeSnapshotIndex
  );
  for (const snapshotIndex of inactiveSnapshotIndexes) {
    const targetCell = `${columnName(snapshotIndex)}${targetRowNumber}`;
    await copyCell(page, nameBox, sourceCell, targetCell);
    await clearRange(page, nameBox, targetCell);
    await setCellFillColor(page, nameBox, targetCell, "진한 회색 3");
    console.log(`[이전 SNAPSHOT 없음] ${targetCell} = 진한 회색 3`);
  }
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
  await assertTargetSheetMutation(page, `${targetRowNumber}행 양식 복사`);
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(750);
  await clearRange(
    page,
    nameBox,
    `A${targetRowNumber}:${lastColumn}${targetRowNumber}`
  );
}

async function copyPreparedNewChecklistRow(
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
  await page.waitForTimeout(300);
  await nameBox.fill(`A${targetRowNumber}`);
  await nameBox.press("Enter");
  await assertTargetSheetMutation(
    page,
    `${targetRowNumber}행 신규 체크리스트 양식 복사`
  );
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(650);
  await clearRange(
    page,
    nameBox,
    `A${targetRowNumber}:I${targetRowNumber}`
  );
  console.log(
    `[신규 행 빠른 복사] ${sourceRowNumber}행 → ${targetRowNumber}행`
  );
}

async function copyTypeStyleFromTemplateSheet(
  page,
  nameBox,
  request,
  {
    spreadsheetId,
    templateSheetName,
    targetSheetName,
    targetRowNumber,
    issueType
  }
) {
  const template = await selectSheetByName(page, templateSheetName);
  if (template.spreadsheetId !== spreadsheetId) {
    throw new Error("유형 색상 기준 시트가 대상 스프레드시트와 일치하지 않습니다.");
  }
  const templateExportUrl =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}` +
    `/export?format=csv&gid=${template.gid}`;
  const templateRows = await readSheetRows(request, templateExportUrl);
  const templateLayout = inspectLayout(templateRows);
  const source = findTemplateTypeStyleSource(
    templateRows,
    templateLayout,
    issueType
  );
  if (source == null) {
    await selectSheetByName(page, targetSheetName);
    throw new Error(
      `기준 시트 ${templateSheetName}에서 ` +
        `${issueType || "(유형 없음)"} 유형의 색상 양식을 찾지 못했습니다.`
    );
  }

  const sourceCell = `${columnName(source.columnIndex)}${source.rowIndex + 1}`;
  await nameBox.fill(sourceCell);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(300);
  await selectSheetByName(page, targetSheetName);
  await nameBox.fill(`B${targetRowNumber}`);
  await nameBox.press("Enter");
  await assertTargetSheetMutation(
    page,
    `B${targetRowNumber} 유형 색상 적용`
  );
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(300);
  console.log(
    `[신규 유형 색상 적용] ${issueType}: ` +
      `${templateSheetName}!${sourceCell} → B${targetRowNumber} (${source.source})`
  );
}

async function copyTemplateRowFromSheet(
  page,
  nameBox,
  request,
  config
) {
  const {
    spreadsheetId,
    templateSheetName,
    snapshotDropdownSourceCell,
    targetSheetName,
    targetRowNumber,
    targetLayout,
    issueType
  } = validateTemplateCopyConfig(config);
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
  await assertTargetSheetMutation(
    page,
    `${targetRowNumber}행 기준 양식 복사`
  );
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(750);

  await clearRange(
    page,
    nameBox,
    `A${targetRowNumber}:` +
      `${columnName(targetLayout.columnCount - 1)}${targetRowNumber}`
  );

  await nameBox.fill(snapshotDropdownSourceCell);
  await nameBox.press("Enter");
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(300);

  if (targetLayout.snapshotIndexes.length > 0) {
    const targetSnapshotIndexes = [
      ...new Set(
        [
          ...targetLayout.snapshotIndexes,
          targetLayout.snapshotWorkIndex
        ].filter((index) => index >= 0)
      )
    ];
    for (const targetIndex of targetSnapshotIndexes) {
      await nameBox.fill(`${columnName(targetIndex)}${targetRowNumber}`);
      await nameBox.press("Enter");
      await assertTargetSheetMutation(
        page,
        `${columnName(targetIndex)}${targetRowNumber} SNAPSHOT 드롭다운 복사`
      );
      await page.keyboard.press("Control+V");
      await page.waitForTimeout(250);
    }
  }

  if (targetLayout.referenceIndex >= 0) {
    await nameBox.fill(
      `${columnName(targetLayout.referenceIndex)}${targetRowNumber}`
    );
    await nameBox.press("Enter");
    await assertTargetSheetMutation(
      page,
      `${columnName(targetLayout.referenceIndex)}${targetRowNumber} ` +
        `참고사항 드롭다운 복사`
    );
    await page.keyboard.press("Control+V");
    await page.waitForTimeout(300);
  }

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
  await assertTargetSheetMutation(page, `${targetCell} 값 입력`);
  await page.keyboard.press("Control+V");
  await page.waitForTimeout(750);
}

async function pasteExistingIssueUpdates(page, nameBox, updates) {
  const sorted = [...updates].sort(
    (left, right) => left.rowNumber - right.rowNumber
  );
  const groups = [];
  for (const update of sorted) {
    const previous = groups.at(-1);
    if (
      previous &&
      update.rowNumber === previous.items.at(-1).rowNumber + 1
    ) {
      previous.items.push(update);
    } else {
      groups.push({ items: [update] });
    }
  }

  for (const { items } of groups) {
    const firstRowNumber = items[0].rowNumber;
    await pasteTsv(
      page,
      nameBox,
      `A${firstRowNumber}`,
      items.map((item) => item.basicValues.join("\t")).join("\n")
    );
    await pasteTsv(
      page,
      nameBox,
      `D${firstRowNumber}`,
      items.map((item) => item.detailValues.join("\t")).join("\n")
    );
  }
  console.log(
    `[성능] 기존 이슈 ${updates.length}건 기본 정보 입력: ` +
      `${groups.length}개 연속 행 범위, ${groups.length * 2}회 붙여넣기`
  );
}

async function enterCellText(page, nameBox, targetCell, text) {
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.waitForTimeout(250);
  await assertTargetSheetMutation(page, `${targetCell} 텍스트 입력`);
  await page.keyboard.press("F2");
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_000);
}

async function enterCellFormula(
  page,
  nameBox,
  targetCell,
  formula,
  issueKey
) {
  await page.keyboard.press("Escape");
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.waitForTimeout(100);
  await assertTargetSheetMutation(page, `${targetCell} Jira 하이퍼링크 수식 입력`);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(50);
  await page.keyboard.type(formula);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.waitForTimeout(100);

  const formulaBar = page.locator("#t-formula-bar-input");
  const actualFormula = String(await formulaBar.textContent()).trim();
  if (actualFormula !== formula) {
    throw new Error(
      `${issueKey}의 Jira 하이퍼링크 수식 설정에 실패했습니다: ` +
        `${targetCell}, 예상="${formula}", 실제="${actualFormula}"`
    );
  }
  console.log(`[Jira 하이퍼링크 수식 설정] ${targetCell} = ${issueKey}`);
}

async function selectDropdownValue(page, nameBox, targetCell, value) {
  await nameBox.fill(targetCell);
  await nameBox.press("Enter");
  await page.waitForTimeout(250);
  await assertTargetSheetMutation(
    page,
    `${targetCell} 드롭다운 값 ${value} 선택`
  );
  await page.keyboard.press("Enter");
  try {
    await page.keyboard.insertText(value);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_000);
    console.log(`[SNAPSHOT 드롭다운 키보드 선택] ${targetCell} = ${value}`);
  } catch (error) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error(
      `SNAPSHOT 드롭다운에서 값을 선택하지 못했습니다: ` +
        `${targetCell}, 선택값=${value}, 원인=${error.message}`
    );
  }
}

async function waitForIssueRow(
  request,
  exportUrl,
  issue,
  rowNumber,
  snapshotExpectation = null,
  referenceExpectation = null
) {
  const deadline = Date.now() + 30_000;
  let lastMismatches = [];
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const rows = await readSheetRows(request, exportUrl);
    const row = rows[rowNumber - 1] ?? [];
    const actual = {
      key: jiraKeyFromCell(row[2]),
      title: row[4],
      status: row[5],
      priority: row[6],
      assignee: row[7],
      ...(snapshotExpectation
        ? { snapshot: row[snapshotExpectation.columnIndex] }
        : {}),
      ...(referenceExpectation
        ? { reference: row[referenceExpectation.columnIndex] }
        : {})
    };
    const expected = {
      key: issue.key,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      assignee: issue.assignee,
      ...(snapshotExpectation
        ? { snapshot: snapshotExpectation.value }
        : {}),
      ...(referenceExpectation
        ? { reference: referenceExpectation.value }
        : {})
    };
    lastMismatches = issueRowMismatches(actual, expected);
    if (lastMismatches.length === 0) {
      return { row, rows };
    }
  }
  throw new Error(
    `${issue.key}의 Google Sheets 저장 검증에 실패했습니다: ` +
      formatIssueRowMismatches(lastMismatches)
  );
}

function resultFromVerifiedRow(verification, row) {
  return {
    action: verification.action,
    rowNumber: verification.rowNumber,
    number: row[0],
    key: verification.issue.key,
    title: row[4],
    status: row[5],
    priority: row[6],
    assignee: row[7],
    snapshotReset: verification.snapshotReset
  };
}

async function waitForIssueRows(request, exportUrl, verifications) {
  const deadline = Date.now() + 30_000;
  let lastMismatches = [];
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const rows = await readSheetRows(request, exportUrl);
    lastMismatches = verifications.flatMap((verification) => {
      const row = rows[verification.rowNumber - 1] ?? [];
      const actual = {
        key: jiraKeyFromCell(row[2]),
        title: row[4],
        status: row[5],
        priority: row[6],
        assignee: row[7],
        ...(verification.snapshotExpectation
          ? { snapshot: row[verification.snapshotExpectation.columnIndex] }
          : {}),
        ...(verification.referenceExpectation
          ? { reference: row[verification.referenceExpectation.columnIndex] }
          : {})
      };
      const expected = {
        key: verification.issue.key,
        title: verification.issue.title,
        status: verification.issue.status,
        priority: verification.issue.priority,
        assignee: verification.issue.assignee,
        ...(verification.snapshotExpectation
          ? { snapshot: verification.snapshotExpectation.value }
          : {}),
        ...(verification.referenceExpectation
          ? { reference: verification.referenceExpectation.value }
          : {})
      };
      const mismatches = issueRowMismatches(actual, expected);
      return mismatches.length === 0
        ? []
        : [`${verification.issue.key}: ${formatIssueRowMismatches(mismatches)}`];
    });
    if (lastMismatches.length === 0) {
      return rows;
    }
  }
  throw new Error(
    `기존 Jira 이슈 일괄 저장 검증에 실패했습니다: ${lastMismatches.join(" | ")}`
  );
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
  const startedAt = Date.now();
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
  const rows = parseCsv(await response.text());
  sheetReadCount += 1;
  sheetReadDurationMs += Date.now() - startedAt;
  return rows;
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

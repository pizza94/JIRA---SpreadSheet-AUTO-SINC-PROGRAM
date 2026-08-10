import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron } from "playwright";

const packagedExecutable = process.argv[2]
  ? resolve(process.argv[2])
  : null;
const screenshotPath = resolve(
  packagedExecutable ? "output/app-packaged-preview.png" : "output/app-preview.png"
);
await mkdir(resolve("output"), { recursive: true });
const testDataPath = resolve("output/electron-test-data");
const testResultPath = resolve(testDataPath, "results");
const testAuthPath = resolve(testDataPath, "playwright/.auth");
await rm(testDataPath, { recursive: true, force: true });
await mkdir(testAuthPath, { recursive: true });
await writeFile(resolve(testAuthPath, "jira.json"), "{}\n", "utf8");
await writeFile(resolve(testAuthPath, "google.json"), "{}\n", "utf8");

const electronApp = await electron.launch(
  packagedExecutable
    ? {
        executablePath: packagedExecutable,
        env: {
          ...process.env,
          AUTOMATION_DATA_DIR: testDataPath,
          AUTOMATION_DEFAULT_OUTPUT_DIR: testResultPath,
          JIRA_BASE_URL: "http://127.0.0.1:1"
        }
      }
    : {
        args: ["."],
        cwd: process.cwd(),
        env: {
          ...process.env,
          AUTOMATION_DATA_DIR: testDataPath,
          AUTOMATION_DEFAULT_OUTPUT_DIR: testResultPath,
          JIRA_BASE_URL: "http://127.0.0.1:1"
        }
      }
);

let appClosed = false;
try {
  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.locator("#issueKeys").waitFor({ state: "visible" });

  const checks = {
    title: await window.title(),
    heading: await window.locator("h1").innerText(),
    jiraAddressInputs: await window.locator("#jiraBaseUrl").count(),
    sheetNameInputs: await window.locator("#sheetName").count(),
    issueKeysPlaceholder: await window.locator("#issueKeys").getAttribute("placeholder"),
    workModeOptions: await window.locator('input[name="workMode"]').count(),
    snapshotPlaceholder: await window
      .locator("#snapshotName")
      .getAttribute("placeholder"),
    sheetPlaceholder: await window.locator("#sheetUrl").getAttribute("placeholder"),
    outputDirectory: await window.locator("#outputDirectory").inputValue(),
    chooseOutputButton: await window.locator("#chooseOutputButton").innerText(),
    deadlinePlaceholder: await window.locator("#deadline").getAttribute("placeholder"),
    copyButtons: await window.locator(".copy-default").count(),
    sheetWarning: await window.locator(".field-warning").innerText(),
    preloadApi: await window.evaluate(
      () =>
        typeof window.jiraSheetsApp?.startSync === "function" &&
        typeof window.jiraSheetsApp?.chooseOutputDirectory === "function" &&
        typeof window.jiraSheetsApp?.openOutput === "function"
    ),
    syncButton: (await window.locator("#syncButton").textContent())?.trim(),
    cancelButton: (await window.locator("#cancelButton").textContent())?.trim(),
    activityControls: await window
      .locator(".activity-panel .activity-actions")
      .count(),
    loginButton: await window.locator("#loginButton").innerText(),
    loginRequiredMarks: await window
      .locator(".login-required .required-mark")
      .count(),
    sheetRequiredMarks: await window
      .locator('label:has(#sheetUrl) .required-mark')
      .count()
  };

  if (
    checks.title !== "Jira Sheets Sync" ||
    checks.heading !== "Jira Sheets Sync" ||
    !checks.preloadApi ||
    checks.jiraAddressInputs !== 0 ||
    checks.sheetNameInputs !== 0 ||
    checks.workModeOptions !== 2 ||
    checks.snapshotPlaceholder !== "예: SNAPSHOT-3" ||
    !checks.issueKeysPlaceholder?.includes("[MS-12469] - MyPage") ||
    !checks.sheetPlaceholder?.includes("gid=123") ||
    checks.outputDirectory !== testResultPath ||
    checks.chooseOutputButton !== "폴더 선택" ||
    checks.deadlinePlaceholder !== "예: 2026.07.23" ||
    checks.copyButtons !== 1 ||
    checks.syncButton !== "작업 시작" ||
    checks.cancelButton !== "작업 중지" ||
    checks.activityControls !== 1 ||
    checks.loginRequiredMarks !== 1 ||
    checks.sheetRequiredMarks !== 1 ||
    !checks.sheetWarning.includes("링크의 gid로 탭을 자동 선택")
  ) {
    throw new Error(`Electron UI 검증 실패: ${JSON.stringify(checks)}`);
  }

  const validationMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        issueKeys:
          '버그\n[MS-12818] - [KB증권] 용어 신규 팝업 항목 누락\n' +
          '개선\n[MS-12807] - 결재현황 개선\n[MS-12811] - 변경분 하이라이트\n' +
          '부작업\n[MS-12469] - MyPage 버튼 추가\n[MS-12470] - 재신청 버튼 추가\n' +
          '[MS-12473] - "변경요약" 팝업 추가',
        sheetUrl: "",
        workMode: "existing",
        snapshotName: "SNAPSHOT-3",
        deadline: "",
        testStartDate: "",
        testEndDate: ""
      });
      return "";
    } catch (error) {
      return error.message;
    }
  });
  if (!validationMessage.includes("Google Sheets 링크를 입력하세요")) {
    throw new Error(`URL 오류 안내 검증 실패: ${validationMessage}`);
  }

  const missingWorkModeMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        issueKeys: "MS-4395",
        workMode: "",
        snapshotName: "SNAPSHOT-3",
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446#gid=94813446"
      });
      return "";
    } catch (error) {
      return error.message;
    }
  });
  if (!missingWorkModeMessage.includes("작업 유형")) {
    throw new Error(`작업 유형 필수 검증 실패: ${missingWorkModeMessage}`);
  }

  const missingSnapshotMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        issueKeys: "MS-4395",
        workMode: "new",
        snapshotName: "",
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446#gid=94813446"
      });
      return "";
    } catch (error) {
      return error.message;
    }
  });
  if (!missingSnapshotMessage.includes("SNAPSHOT-숫자")) {
    throw new Error(`SNAPSHOT 필수 검증 실패: ${missingSnapshotMessage}`);
  }

  const missingGidMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        issueKeys: "MS-4395",
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit",
        workMode: "existing",
        snapshotName: "SNAPSHOT-3",
        deadline: "",
        testStartDate: "",
        testEndDate: ""
      });
      return "";
    } catch (error) {
      return error.message;
    }
  });
  if (!missingGidMessage.includes("gid가 없습니다")) {
    throw new Error(`gid 오류 안내 검증 실패: ${missingGidMessage}`);
  }

  const dateValidationMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        issueKeys: "MS-4395",
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446#gid=94813446",
        workMode: "existing",
        snapshotName: "SNAPSHOT-3",
        deadline: "2026.02.30",
        testStartDate: "",
        testEndDate: ""
      });
      return "";
    } catch (error) {
      return error.message;
    }
  });
  if (!dateValidationMessage.includes("올바른 날짜")) {
    throw new Error(`날짜 오류 안내 검증 실패: ${dateValidationMessage}`);
  }

  const failureEvent = await window.evaluate(
    () =>
      new Promise((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(
          () => rejectPromise(new Error("실패 로그 이벤트 대기 시간 초과")),
          20_000
        );
        const unsubscribe = window.jiraSheetsApp.onJobEvent((event) => {
          if (event.type === "finished" && event.job === "jira-login") {
            clearTimeout(timeout);
            unsubscribe();
            resolvePromise(event);
          }
        });
        window.jiraSheetsApp
          .loginJira()
          .catch((error) => {
            clearTimeout(timeout);
            unsubscribe();
            rejectPromise(error);
          });
      })
  );
  if (
    failureEvent.ok ||
    !failureEvent.resultPath ||
    !resolve(failureEvent.resultPath).startsWith(testResultPath) ||
    /^Node\.js v/i.test(failureEvent.message)
  ) {
    throw new Error(`실패 로그 이벤트 검증 실패: ${JSON.stringify(failureEvent)}`);
  }
  await access(failureEvent.resultPath);
  const failureResultText = await readFile(failureEvent.resultPath, "utf8");
  if (
    !failureResultText.includes("결과: 실패") ||
    failureResultText.includes("Call log:")
  ) {
    throw new Error(`실패 결과 요약 검증 실패: ${failureResultText}`);
  }
  const resultFiles = await readdir(testResultPath);
  resultFiles.sort((left, right) => Number(right.endsWith(".txt")) - Number(left.endsWith(".txt")));
  if (
    resultFiles.length < 2 ||
    !/^Jira-Sheets-작업결과-\d{4}-\d{2}-\d{2}\.txt$/.test(resultFiles[0])
  ) {
    throw new Error(`날짜별 결과 파일 검증 실패: ${resultFiles.join(", ")}`);
  }
  const visibleFailureLog = {
    open: await window.locator("#logSection").evaluate((element) => element.open),
    text: await window.locator("#logOutput").innerText()
  };
  if (
    !visibleFailureLog.open ||
    !visibleFailureLog.text.includes("[실패 원인]") ||
    !visibleFailureLog.text.includes("[실패 결과 파일]")
  ) {
    throw new Error(
      `실패 로그 화면 검증 실패: ${JSON.stringify(visibleFailureLog)}`
    );
  }

  await window.locator('.copy-default[data-target="sheetUrl"]').click();
  const defaultInputValues = {
    sheetUrl: await window.locator("#sheetUrl").inputValue()
  };
  if (
    defaultInputValues.sheetUrl !==
      "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446#gid=94813446"
  ) {
    throw new Error(
      `기본값 자동 입력 검증 실패: ${JSON.stringify(defaultInputValues)}`
    );
  }

  await window.evaluate(
    (outputDirectory) =>
      window.jiraSheetsApp.saveSettings({
        issueKeys: "MS-4395",
        workMode: "new",
        snapshotName: "SNAPSHOT-3",
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446#gid=94813446",
        deadline: "2026.07.23",
        testStartDate: "2026.07.23",
        testEndDate: "2026.07.23",
        outputDirectory
      }),
    testResultPath
  );
  await window.screenshot({ path: screenshotPath, fullPage: true });
  console.log(
    JSON.stringify(
      {
        packagedExecutable,
        checks,
        validationMessage,
        missingGidMessage,
        screenshotPath
      },
      null,
      2
    )
  );
  await electronApp.close();
  appClosed = true;
  const persistedSettings = JSON.parse(
    await readFile(resolve(testDataPath, "settings.json"), "utf8")
  );
  if (
    persistedSettings.outputDirectory !== testResultPath ||
    persistedSettings.issueKeys ||
    persistedSettings.sheetUrl
  ) {
    throw new Error("종료 후 결과 폴더 저장 설정 검증 실패");
  }
  const privateFiles = [
    resolve(testAuthPath, "jira.json"),
    resolve(testAuthPath, "google.json")
  ];
  const remainingPrivateFiles = [];
  for (const file of privateFiles) {
    try {
      await access(file);
      remainingPrivateFiles.push(file);
    } catch {
      // Expected after normal app exit.
    }
  }
  if (remainingPrivateFiles.length > 0) {
    throw new Error(
      `종료 후 개인정보 파일 삭제 실패: ${remainingPrivateFiles.join(", ")}`
    );
  }
} finally {
  if (!appClosed) {
    await electronApp.close();
  }
}

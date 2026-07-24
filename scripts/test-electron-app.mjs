import { access, mkdir, rm, writeFile } from "node:fs/promises";
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
const testAuthPath = resolve(testDataPath, "playwright/.auth");
await rm(testDataPath, { recursive: true, force: true });
await mkdir(testAuthPath, { recursive: true });
await writeFile(resolve(testAuthPath, "jira.json"), "{}\n", "utf8");
await writeFile(resolve(testAuthPath, "google.json"), "{}\n", "utf8");

const electronApp = await electron.launch(
  packagedExecutable
    ? {
        executablePath: packagedExecutable,
        env: { ...process.env, AUTOMATION_DATA_DIR: testDataPath }
      }
    : {
        args: ["."],
        cwd: process.cwd(),
        env: { ...process.env, AUTOMATION_DATA_DIR: testDataPath }
      }
);

let appClosed = false;
try {
  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.locator("#jiraBaseUrl").waitFor({ state: "visible" });

  const checks = {
    title: await window.title(),
    heading: await window.locator("h1").innerText(),
    jiraBaseUrl: await window.locator("#jiraBaseUrl").inputValue(),
    jiraPlaceholder: await window.locator("#jiraBaseUrl").getAttribute("placeholder"),
    sheetPlaceholder: await window.locator("#sheetUrl").getAttribute("placeholder"),
    deadlinePlaceholder: await window.locator("#deadline").getAttribute("placeholder"),
    copyButtons: await window.locator(".copy-default").count(),
    sheetWarning: await window.locator(".field-warning").innerText(),
    preloadApi: await window.evaluate(
      () => typeof window.jiraSheetsApp?.startSync === "function"
    ),
    syncButton: await window.locator("#syncButton").innerText(),
    loginButton: await window.locator("#loginButton").innerText()
  };

  if (
    checks.title !== "Jira Sheets Sync" ||
    checks.heading !== "Jira Sheets Sync" ||
    !checks.preloadApi ||
    !checks.jiraPlaceholder?.startsWith("예:") ||
    !checks.sheetPlaceholder?.startsWith("예:") ||
    checks.deadlinePlaceholder !== "예: 2026.07.23" ||
    checks.copyButtons !== 2 ||
    !checks.sheetWarning.includes("버전에 맞는 Google Sheets 주소")
  ) {
    throw new Error(`Electron UI 검증 실패: ${JSON.stringify(checks)}`);
  }

  const validationMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        jiraBaseUrl: "http://jira.example.local:8079",
        issueKeys:
          '버그\n[MS-12818] - [KB증권] 용어 신규 팝업 항목 누락\n' +
          '개선\n[MS-12807] - 결재현황 개선\n[MS-12811] - 변경분 하이라이트\n' +
          '부작업\n[MS-12469] - MyPage 버튼 추가\n[MS-12470] - 재신청 버튼 추가\n' +
          '[MS-12473] - "변경요약" 팝업 추가',
        sheetUrl: "",
        sheetName: "4.2.2.59 (LS증권)",
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

  const dateValidationMessage = await window.evaluate(async () => {
    try {
      await window.jiraSheetsApp.startSync({
        jiraBaseUrl: "http://jira.example.local:8079",
        issueKeys: "MS-4395",
        sheetUrl:
          "https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit",
        sheetName: "4.2.2.59 (LS증권)",
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
          .loginJira({ jiraBaseUrl: "http://127.0.0.1:1" })
          .catch((error) => {
            clearTimeout(timeout);
            unsubscribe();
            rejectPromise(error);
          });
      })
  );
  if (
    failureEvent.ok ||
    !failureEvent.logPath ||
    /^Node\.js v/i.test(failureEvent.message)
  ) {
    throw new Error(`실패 로그 이벤트 검증 실패: ${JSON.stringify(failureEvent)}`);
  }
  await access(failureEvent.logPath);
  const visibleFailureLog = {
    open: await window.locator("#logSection").evaluate((element) => element.open),
    text: await window.locator("#logOutput").innerText()
  };
  if (
    !visibleFailureLog.open ||
    !visibleFailureLog.text.includes("[실패 원인]") ||
    !visibleFailureLog.text.includes("[실패 로그 파일]")
  ) {
    throw new Error(
      `실패 로그 화면 검증 실패: ${JSON.stringify(visibleFailureLog)}`
    );
  }

  await window.locator('.copy-default[data-target="jiraBaseUrl"]').click();
  await window.locator('.copy-default[data-target="sheetUrl"]').click();
  const defaultInputValues = {
    jiraBaseUrl: await window.locator("#jiraBaseUrl").inputValue(),
    sheetUrl: await window.locator("#sheetUrl").inputValue()
  };
  if (
    defaultInputValues.jiraBaseUrl !== "http://jira.example.local:8079/" ||
    defaultInputValues.sheetUrl !==
      "https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit"
  ) {
    throw new Error(
      `기본값 자동 입력 검증 실패: ${JSON.stringify(defaultInputValues)}`
    );
  }

  await window.evaluate(() =>
    window.jiraSheetsApp.saveSettings({
      jiraBaseUrl: "http://jira.example.local:8079",
      issueKeys: "MS-4395",
      sheetUrl:
        "https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit",
      sheetName: "4.2.2.59(LS증권)",
      deadline: "2026.07.23",
      testStartDate: "2026.07.23",
      testEndDate: "2026.07.23"
    })
  );
  await window.screenshot({ path: screenshotPath, fullPage: true });
  console.log(
    JSON.stringify(
      {
        packagedExecutable,
        checks,
        validationMessage,
        screenshotPath
      },
      null,
      2
    )
  );
  await electronApp.close();
  appClosed = true;
  const privateFiles = [
    resolve(testDataPath, "settings.json"),
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

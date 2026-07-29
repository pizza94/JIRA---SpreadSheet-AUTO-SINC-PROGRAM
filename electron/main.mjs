import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell
} from "electron";
import { parseGoogleSheetLink } from "../scripts/google-sheet-url.mjs";
import { prependDailyResult } from "../scripts/result-history.mjs";
import {
  normalizeSnapshotName,
  normalizeWorkMode
} from "../scripts/sync-mode.mjs";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const jiraBaseUrl =
  process.env.JIRA_BASE_URL ?? "http://jira.example.local:8079";
const settingsVersion = 8;

let mainWindow;
let activeJob = null;
let quitCleanupComplete = false;

app.enableSandbox();

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createMainWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  activeJob?.child.kill();
  if (!quitCleanupComplete) {
    event.preventDefault();
    void clearPrivateState().finally(() => {
      quitCleanupComplete = true;
      app.quit();
    });
  }
});

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f4f7fb",
    show: false,
    title: "Jira Sheets Sync",
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url);
      }
    }
  });

  await mainWindow.loadFile(path.join(currentDirectory, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

function registerIpcHandlers() {
  ipcMain.handle("settings:load", async () => {
    const settings = await loadSettings();
    return {
      settings,
      jiraSessionReady: await fileExists(jiraAuthPath()),
      running: Boolean(activeJob),
      outputPath: settings.outputDirectory
    };
  });

  ipcMain.handle("settings:save", async (_event, input) => {
    const settings = normalizeSettings(input);
    await saveSettings(settings);
    return settings;
  });

  ipcMain.handle("jira:login", async () => {
    assertIdle();
    const settings = await loadSettings();
    return startJob("jira-login", "jira-login.mjs", [], settings);
  });

  ipcMain.handle("sync:start", async (_event, input) => {
    assertIdle();
    const settings = normalizeSettings(input);
    const issueKeys = parseIssueKeys(settings.issueKeys);
    validateSheetSettings(settings);
    settings.workMode = normalizeWorkMode(settings.workMode);
    settings.snapshotName = normalizeSnapshotName(settings.snapshotName);
    settings.outputDirectory = validateOutputDirectory(
      settings.outputDirectory
    );
    await mkdir(settings.outputDirectory, { recursive: true });
    settings.deadline = validateOptionalDate(
      settings.deadline,
      "테스트 배포일정(데드라인)"
    );
    settings.testStartDate = validateOptionalDate(
      settings.testStartDate,
      "테스트 시작일"
    );
    settings.testEndDate = validateOptionalDate(
      settings.testEndDate,
      "테스트 종료일"
    );
    await saveSettings(settings);
    const scheduleArgs = [];
    if (settings.deadline) {
      scheduleArgs.push("--deadline", settings.deadline);
    }
    if (settings.testStartDate) {
      scheduleArgs.push("--test-start-date", settings.testStartDate);
    }
    if (settings.testEndDate) {
      scheduleArgs.push("--test-end-date", settings.testEndDate);
    }
    return startJob(
      "sync",
      "sync-jira-to-sheets.mjs",
      [
        "--issues",
        issueKeys.join(","),
        "--sheet-url",
        settings.sheetUrl,
        "--work-mode",
        settings.workMode,
        "--snapshot-name",
        settings.snapshotName,
        ...scheduleArgs
      ],
      settings
    );
  });

  ipcMain.handle("job:cancel", async () => {
    if (!activeJob) {
      return { canceled: false };
    }
    activeJob.child.kill();
    return { canceled: true };
  });

  ipcMain.handle("output:choose", async (_event, currentPath) => {
    const fallback = defaultOutputDirectory();
    const requested = String(currentPath ?? "").trim();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "결과 저장 폴더 선택",
      defaultPath: path.isAbsolute(requested) ? requested : fallback,
      properties: ["openDirectory", "createDirectory"]
    });
    return {
      canceled: result.canceled,
      path: result.filePaths[0] ?? ""
    };
  });

  ipcMain.handle("output:open", async (_event, requestedPath) => {
    const target = validateOutputDirectory(requestedPath);
    await mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    return { ok: error === "", error };
  });

  ipcMain.handle("sheet:open", async (_event, url) => {
    const parsed = validateGoogleSheetsUrl(url);
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });

  ipcMain.handle("clipboard:copy", (_event, value) => {
    const text = String(value ?? "").slice(0, 5_000);
    clipboard.writeText(text);
    return { ok: true };
  });
}

function startJob(type, scriptName, args, settings) {
  const scriptPath = resolveScriptPath(scriptName);
  const jobOutputDirectory = validateOutputDirectory(
    settings.outputDirectory
  );
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: dataPath(),
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AUTOMATION_DATA_DIR: dataPath(),
      AUTOMATION_OUTPUT_DIR: jobOutputDirectory,
      JIRA_BASE_URL: jiraBaseUrl,
      PLAYWRIGHT_CHANNEL: "chrome",
      FORCE_COLOR: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeJob = { type, child, outputDirectory: jobOutputDirectory };
  const stdout = [];
  const stderr = [];

  emitJobEvent({ type: "started", job: type });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout.push(chunk);
    emitJobEvent({ type: "log", level: "info", text: chunk });
  });
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    emitJobEvent({ type: "log", level: "error", text: chunk });
  });
  child.on("error", async (error) => {
    const failureResultPath = await writeFailureResult(
      type,
      "",
      error.stack || error.message,
      jobOutputDirectory,
      settings
    ).catch(() => "");
    emitJobEvent({
      type: "finished",
      job: type,
      ok: false,
      message: error.message,
      resultPath: failureResultPath
    });
    activeJob = null;
  });
  child.on("close", async (code) => {
    if (activeJob?.child === child) {
      activeJob = null;
    }
    const output = stdout.join("").trim();
    const errorOutput = stderr.join("").trim();
    let result = null;
    if (code === 0 && type === "sync") {
      try {
        result = parseLastJsonLine(output);
      } catch {
        result = null;
      }
    }
    const failureResultPath =
      code === 0
        ? ""
        : await writeFailureResult(
            type,
            output,
            errorOutput,
            jobOutputDirectory,
            settings
          ).catch(() => "");
    emitJobEvent({
      type: "finished",
      job: type,
      ok: code === 0,
      code,
      result,
      resultPath: failureResultPath,
      message:
        code === 0
          ? type === "jira-login"
            ? "Jira 로그인이 완료되었습니다."
            : "동기화가 완료되었습니다."
          : summarizeError(errorOutput || output)
    });
  });

  return { accepted: true, job: type };
}

async function writeFailureResult(
  type,
  output,
  errorOutput,
  outputDirectory = defaultOutputDirectory(),
  settings = {}
) {
  const targetDirectory = validateOutputDirectory(outputDirectory);
  await mkdir(targetDirectory, { recursive: true });
  const reason = summarizeError(errorOutput || output);
  const issueKeys = [
    ...new Set(
      String(settings.issueKeys ?? "")
        .toUpperCase()
        .match(/[A-Z][A-Z0-9_]*-\d+/g) ?? []
    )
  ];
  const progressLines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^\[(?:성능|대상 시트|SNAPSHOT)/.test(line) &&
        !line.includes("Call log:")
    );
  const content = [
    "Jira → Google Sheets 작업 결과",
    "================================",
    "결과: 실패",
    `작업: ${type}`,
    `실패 시각: ${formatKoreanDateTime(new Date())}`,
    `실패 원인: ${reason}`,
    `Jira 목록: ${issueKeys.join(", ") || "-"}`,
    `작업 유형: ${String(settings.workMode ?? "").trim() || "-"}`,
    `등록 SNAPSHOT: ${String(settings.snapshotName ?? "").trim() || "-"}`,
    `시트 링크: ${String(settings.sheetUrl ?? "").trim() || "-"}`,
    "",
    "[진행 내용]",
    ...(progressLines.length ? [...new Set(progressLines)] : ["- 기록 없음"]),
    ""
  ].join("\r\n");
  return prependDailyResult(targetDirectory, content, new Date());
}

function formatKoreanDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(value);
}

function emitJobEvent(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("job:event", payload);
  }
}

function resolveScriptPath(scriptName) {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      scriptName
    );
  }
  return path.join(app.getAppPath(), "scripts", scriptName);
}

function normalizeSettings(input = {}) {
  return {
    settingsVersion,
    issueKeys: String(input.issueKeys ?? "").slice(0, 10_000),
    workMode: String(input.workMode ?? "").trim().toLowerCase().slice(0, 20),
    snapshotName: String(input.snapshotName ?? "")
      .trim()
      .toUpperCase()
      .slice(0, 40),
    sheetUrl: String(input.sheetUrl ?? "").slice(0, 2_000),
    outputDirectory: String(
      input.outputDirectory ?? defaultOutputDirectory()
    )
      .trim()
      .slice(0, 2_000),
    deadline: String(input.deadline ?? "").trim().slice(0, 10),
    testStartDate: String(input.testStartDate ?? "").trim().slice(0, 10),
    testEndDate: String(input.testEndDate ?? "").trim().slice(0, 10)
  };
}

function validateOutputDirectory(value) {
  const raw = String(value ?? "").trim().replace(/^"(.*)"$/, "$1");
  const target = raw || defaultOutputDirectory();
  if (!path.isAbsolute(target)) {
    throw new Error("결과 저장 경로는 드라이브 문자를 포함한 전체 경로로 입력하세요.");
  }
  return path.normalize(target);
}

function validateOptionalDate(value, label) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const match = text.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!match) {
    throw new Error(`${label}은 YYYY.MM.DD 형식으로 입력하세요. 예: 2026.07.23`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label}에 올바른 날짜를 입력하세요. 예: 2026.07.23`);
  }
  return text;
}

function validateSheetSettings(settings) {
  settings.sheetUrl = validateGoogleSheetsUrl(settings.sheetUrl).toString();
}

function validateGoogleSheetsUrl(value) {
  return new URL(parseGoogleSheetLink(value).canonicalUrl);
}

function parseIssueKeys(value) {
  const keys = [
    ...new Set(
      String(value)
        .toUpperCase()
        .match(/[A-Z][A-Z0-9_]*-\d+/g) ?? []
    )
  ];
  if (!keys.length) {
    throw new Error("입력 내용에서 Jira 번호를 찾지 못했습니다. 예: MS-12818");
  }
  return keys;
}

function summarizeError(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningfulLines = lines.filter(
    (line) =>
      !/^Node\.js v\d+/i.test(line) &&
      !/^at\s+/i.test(line) &&
      !/^[{}\[\],]+$/.test(line) &&
      !/^(name|stack|message):/i.test(line)
  );
  const errorLine = meaningfulLines.find((line) =>
    /(error:|net::err|econn|timeout|timed out|실패|오류|권한|만료)/i.test(line)
  );
  return (errorLine ?? meaningfulLines.at(-1) ?? "작업에 실패했습니다.").replace(
    /^Error:\s*/,
    ""
  );
}

function parseLastJsonLine(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // 실행 로그 중 마지막 JSON 결과를 찾을 때까지 계속 확인합니다.
    }
  }
  return null;
}

async function loadSettings() {
  try {
    const content = await readFile(settingsPath(), "utf8");
    const stored = JSON.parse(content);
    const migrated = {
      ...stored,
      settingsVersion,
      outputDirectory:
        stored.outputDirectory || defaultOutputDirectory()
    };
    const settings = normalizeSettings({
      ...createDefaultSettings(),
      ...migrated
    });
    if (stored.settingsVersion !== settingsVersion) {
      await saveSettings(settings);
    }
    return settings;
  } catch {
    return createDefaultSettings();
  }
}

async function saveSettings(settings) {
  await mkdir(dataPath(), { recursive: true });
  await writeFile(
    settingsPath(),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8"
  );
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function dataPath() {
  return process.env.AUTOMATION_DATA_DIR
    ? path.resolve(process.env.AUTOMATION_DATA_DIR)
    : app.getPath("userData");
}

function defaultOutputDirectory() {
  return process.env.AUTOMATION_DEFAULT_OUTPUT_DIR
    ? path.resolve(process.env.AUTOMATION_DEFAULT_OUTPUT_DIR)
    : app.getPath("desktop");
}

function createDefaultSettings() {
  return {
    settingsVersion,
    issueKeys: "",
    workMode: "",
    snapshotName: "",
    sheetUrl: "",
    outputDirectory: defaultOutputDirectory(),
    deadline: "",
    testStartDate: "",
    testEndDate: ""
  };
}

function jiraAuthPath() {
  return path.join(dataPath(), "playwright", ".auth", "jira.json");
}

function googleAuthPath() {
  return path.join(dataPath(), "playwright", ".auth", "google.json");
}

function settingsPath() {
  return path.join(dataPath(), "settings.json");
}

async function clearPrivateState() {
  await Promise.allSettled([
    rm(settingsPath(), { force: true }),
    rm(jiraAuthPath(), { force: true }),
    rm(googleAuthPath(), { force: true })
  ]);
}

function assertIdle() {
  if (activeJob) {
    throw new Error("다른 작업이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도하세요.");
  }
}

function isSafeExternalUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

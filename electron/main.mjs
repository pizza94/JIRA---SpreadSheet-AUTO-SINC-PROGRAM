import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  shell
} from "electron";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSettings = {
  settingsVersion: 4,
  jiraBaseUrl: "",
  issueKeys: "",
  sheetUrl: "",
  sheetName: "",
  deadline: "",
  testStartDate: "",
  testEndDate: ""
};

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
      outputPath: outputPath()
    };
  });

  ipcMain.handle("settings:save", async (_event, input) => {
    const settings = normalizeSettings(input);
    await saveSettings(settings);
    return settings;
  });

  ipcMain.handle("jira:login", async (_event, input) => {
    assertIdle();
    const settings = normalizeSettings({
      ...(await loadSettings()),
      jiraBaseUrl: input?.jiraBaseUrl
    });
    settings.jiraBaseUrl = validateJiraBaseUrl(settings.jiraBaseUrl);
    await saveSettings(settings);
    return startJob("jira-login", "jira-login.mjs", [], settings);
  });

  ipcMain.handle("sync:start", async (_event, input) => {
    assertIdle();
    const settings = normalizeSettings(input);
    const issueKeys = parseIssueKeys(settings.issueKeys);
    settings.jiraBaseUrl = validateJiraBaseUrl(settings.jiraBaseUrl);
    validateSheetSettings(settings);
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
        "--sheet-name",
        settings.sheetName,
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

  ipcMain.handle("output:open", async () => {
    await mkdir(outputPath(), { recursive: true });
    const error = await shell.openPath(outputPath());
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
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: dataPath(),
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AUTOMATION_DATA_DIR: dataPath(),
      JIRA_BASE_URL: settings.jiraBaseUrl,
      PLAYWRIGHT_CHANNEL: "chrome",
      FORCE_COLOR: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  activeJob = { type, child };
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
    const failureLogPath = await writeFailureLog(
      type,
      "",
      error.stack || error.message
    ).catch(() => "");
    emitJobEvent({
      type: "finished",
      job: type,
      ok: false,
      message: error.message,
      logPath: failureLogPath
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
        result = JSON.parse(output);
      } catch {
        result = null;
      }
    }
    const failureLogPath =
      code === 0
        ? ""
        : await writeFailureLog(type, output, errorOutput).catch(() => "");
    emitJobEvent({
      type: "finished",
      job: type,
      ok: code === 0,
      code,
      result,
      logPath: failureLogPath,
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

async function writeFailureLog(type, output, errorOutput) {
  await mkdir(outputPath(), { recursive: true });
  const target = path.join(
    outputPath(),
    `failure-${type}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
  );
  const content = [
    `작업: ${type}`,
    `실패 시각: ${new Date().toISOString()}`,
    "",
    "[오류 출력]",
    errorOutput || "(없음)",
    "",
    "[일반 출력]",
    output || "(없음)",
    ""
  ].join("\n");
  await writeFile(target, content, "utf8");
  return target;
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
    settingsVersion: 4,
    jiraBaseUrl: String(input.jiraBaseUrl ?? "").trim().slice(0, 2_000),
    issueKeys: String(input.issueKeys ?? "").slice(0, 10_000),
    sheetUrl: String(input.sheetUrl ?? "").slice(0, 2_000),
    sheetName: String(input.sheetName ?? "").trim().slice(0, 200),
    deadline: String(input.deadline ?? "").trim().slice(0, 10),
    testStartDate: String(input.testStartDate ?? "").trim().slice(0, 10),
    testEndDate: String(input.testEndDate ?? "").trim().slice(0, 10)
  };
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
  if (!settings.sheetName) {
    throw new Error("대상 시트 탭 이름을 입력하세요.");
  }
}

function validateGoogleSheetsUrl(value) {
  const candidate = extractUrlCandidate(value);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(
      "Google Sheets 링크를 입력하세요. 예: https://docs.google.com/spreadsheets/d/..."
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "docs.google.com" ||
    !parsed.pathname.startsWith("/spreadsheets/d/")
  ) {
    throw new Error("올바른 Google Sheets 링크를 입력하세요.");
  }
  return parsed;
}

function validateJiraBaseUrl(value) {
  return normalizeUrl(
    extractUrlCandidate(value),
    ["http:", "https:"],
    "Jira 서버 주소"
  ).replace(/\/+$/, "");
}

function normalizeUrl(value, protocols, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 형식이 올바르지 않습니다.`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${label}는 ${protocols.join(" 또는 ")} 주소여야 합니다.`);
  }
  return parsed.toString();
}

function extractUrlCandidate(value) {
  const text = String(value ?? "").trim();
  const markdownUrl = text.match(/\((https?:\/\/[^)]+)\)/i)?.[1];
  if (markdownUrl) {
    return markdownUrl;
  }
  return text.match(/https?:\/\/[^\s\])]+/i)?.[0] ?? text;
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

async function loadSettings() {
  try {
    const content = await readFile(settingsPath(), "utf8");
    const stored = JSON.parse(content);
    const migrated =
      stored.settingsVersion === 4
        ? stored
        : {
            ...stored,
            settingsVersion: 4,
            jiraBaseUrl: "",
            sheetUrl: ""
          };
    const settings = normalizeSettings({
      ...defaultSettings,
      ...migrated
    });
    if (stored.settingsVersion !== 4) {
      await saveSettings(settings);
    }
    return settings;
  } catch {
    return defaultSettings;
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

function outputPath() {
  return path.join(dataPath(), "output");
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

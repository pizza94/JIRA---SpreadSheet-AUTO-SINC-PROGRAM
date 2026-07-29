const elements = {
  issueKeys: document.querySelector("#issueKeys"),
  workModes: [...document.querySelectorAll('input[name="workMode"]')],
  snapshotName: document.querySelector("#snapshotName"),
  sheetUrl: document.querySelector("#sheetUrl"),
  outputDirectory: document.querySelector("#outputDirectory"),
  deadline: document.querySelector("#deadline"),
  testStartDate: document.querySelector("#testStartDate"),
  testEndDate: document.querySelector("#testEndDate"),
  loginButton: document.querySelector("#loginButton"),
  syncButton: document.querySelector("#syncButton"),
  cancelButton: document.querySelector("#cancelButton"),
  openOutputButton: document.querySelector("#openOutputButton"),
  chooseOutputButton: document.querySelector("#chooseOutputButton"),
  openSheetButton: document.querySelector("#openSheetButton"),
  sessionBadge: document.querySelector("#sessionBadge"),
  runBadge: document.querySelector("#runBadge"),
  activityTitle: document.querySelector("#activityTitle"),
  progressTrack: document.querySelector("#progressTrack"),
  summaryCard: document.querySelector("#summaryCard"),
  resultBody: document.querySelector("#resultBody"),
  resultCount: document.querySelector("#resultCount"),
  logSection: document.querySelector("#logSection"),
  logOutput: document.querySelector("#logOutput"),
  toast: document.querySelector("#toast")
};

let running = false;
let toastTimer;

initialize();

async function initialize() {
  window.jiraSheetsApp.onJobEvent(handleJobEvent);
  try {
    const state = await window.jiraSheetsApp.loadState();
    applySettings(state.settings);
    setSessionState(state.jiraSessionReady);
    setRunningState(state.running);
  } catch (error) {
    showError(error);
  }
}

elements.loginButton.addEventListener("click", async () => {
  try {
    await window.jiraSheetsApp.loginJira();
  } catch (error) {
    showError(error);
  }
});

elements.syncButton.addEventListener("click", async () => {
  clearResults();
  elements.logOutput.textContent = "";
  try {
    await window.jiraSheetsApp.startSync(collectSettings());
  } catch (error) {
    showError(error);
  }
});

elements.cancelButton.addEventListener("click", async () => {
  await window.jiraSheetsApp.cancelJob();
});

elements.openOutputButton.addEventListener("click", async () => {
  try {
    const result = await window.jiraSheetsApp.openOutput(
      elements.outputDirectory.value.trim()
    );
    if (!result.ok) {
      showToast(result.error || "결과 폴더를 열지 못했습니다.");
    }
  } catch (error) {
    showError(error);
  }
});

elements.chooseOutputButton.addEventListener("click", async () => {
  try {
    const result = await window.jiraSheetsApp.chooseOutputDirectory(
      elements.outputDirectory.value.trim()
    );
    if (!result.canceled && result.path) {
      elements.outputDirectory.value = result.path;
      await window.jiraSheetsApp.saveSettings(collectSettings());
    }
  } catch (error) {
    showError(error);
  }
});

elements.openSheetButton.addEventListener("click", async () => {
  try {
    await window.jiraSheetsApp.openSheet(elements.sheetUrl.value.trim());
  } catch (error) {
    showError(error);
  }
});

for (const button of document.querySelectorAll(".copy-default")) {
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    const value = button.dataset.copy || "";
    const target = elements[button.dataset.target];
    if (target) {
      target.value = value;
      target.focus();
    }
    await window.jiraSheetsApp.copyText(value);
    await window.jiraSheetsApp.saveSettings(collectSettings());
    showToast("기본값을 복사하고 입력했습니다.");
  });
}

for (const input of [
  elements.issueKeys,
  ...elements.workModes,
  elements.snapshotName,
  elements.sheetUrl,
  elements.outputDirectory,
  elements.deadline,
  elements.testStartDate,
  elements.testEndDate
]) {
  input.addEventListener("change", () => {
    void window.jiraSheetsApp.saveSettings(collectSettings()).catch(() => {});
  });
}

function handleJobEvent(event) {
  if (event.type === "started") {
    setRunningState(true);
    elements.runBadge.className = "badge badge-warning";
    elements.runBadge.textContent = "RUNNING";
    elements.activityTitle.textContent =
      event.job === "jira-login" ? "Jira 로그인 대기 중" : "Jira·시트 동기화 중";
    setSummary(
      "running",
      event.job === "jira-login" ? "브라우저에서 로그인하세요" : "데이터를 처리하고 있습니다",
      event.job === "jira-login"
        ? "열린 Google Chrome에서 Jira 로그인을 완료하면 자동으로 세션이 저장됩니다."
        : "Jira 조회, 정확한 탭 선택, 서식 복사와 저장 검증을 순서대로 진행합니다."
    );
    appendLog(`[시작] ${event.job}\n`);
    return;
  }

  if (event.type === "log") {
    appendLog(event.text);
    return;
  }

  if (event.type === "finished") {
    setRunningState(false);
    if (event.ok) {
      elements.runBadge.className = "badge badge-success";
      elements.runBadge.textContent = "SUCCESS";
      elements.activityTitle.textContent = "완료";
      setSummary("success", "작업이 완료되었습니다", event.message);
      if (event.job === "jira-login") {
        setSessionState(true);
      }
      if (event.result?.results) {
        renderResults(event.result.results);
        if (event.result.resolvedSheetUrl) {
          elements.sheetUrl.value = event.result.resolvedSheetUrl;
        }
        if (event.result.resultPath) {
          appendLog(`\n[성공 결과 파일] ${event.result.resultPath}\n`);
        }
        resetRequiredRunSettings();
      }
      showToast(event.message);
    } else {
      elements.runBadge.className = "badge badge-danger";
      elements.runBadge.textContent = "FAILED";
      elements.activityTitle.textContent = "확인 필요";
      setSummary("error", "작업을 완료하지 못했습니다", event.message);
      elements.logSection.open = true;
      appendLog(`\n[실패 원인] ${event.message}\n`);
      if (event.resultPath) {
        appendLog(`[실패 결과 파일] ${event.resultPath}\n`);
      }
      showToast(event.message);
    }
  }
}

function collectSettings() {
  return {
    issueKeys: elements.issueKeys.value,
    workMode:
      elements.workModes.find((input) => input.checked)?.value || "",
    snapshotName: elements.snapshotName.value.trim(),
    sheetUrl: elements.sheetUrl.value.trim(),
    outputDirectory: elements.outputDirectory.value.trim(),
    deadline: elements.deadline.value.trim(),
    testStartDate: elements.testStartDate.value.trim(),
    testEndDate: elements.testEndDate.value.trim()
  };
}

function applySettings(settings) {
  elements.issueKeys.value = settings.issueKeys || "";
  for (const input of elements.workModes) {
    input.checked = false;
  }
  elements.snapshotName.value = "";
  elements.sheetUrl.value = settings.sheetUrl || "";
  elements.outputDirectory.value = settings.outputDirectory || "";
  elements.deadline.value = settings.deadline || "";
  elements.testStartDate.value = settings.testStartDate || "";
  elements.testEndDate.value = settings.testEndDate || "";
}

function setSessionState(ready) {
  elements.sessionBadge.className = ready
    ? "badge badge-success"
    : "badge badge-warning";
  elements.sessionBadge.textContent = ready
    ? "Jira 로그인됨"
    : "Jira 로그인 필요";
}

function setRunningState(value) {
  running = value;
  elements.progressTrack.classList.toggle("running", running);
  elements.cancelButton.classList.toggle("hidden", !running);
  elements.syncButton.disabled = running;
  elements.loginButton.disabled = running;
  elements.openSheetButton.disabled = running;
  elements.chooseOutputButton.disabled = running;
  elements.outputDirectory.disabled = running;
  elements.snapshotName.disabled = running;
  for (const input of elements.workModes) {
    input.disabled = running;
  }
}

function resetRequiredRunSettings() {
  for (const input of elements.workModes) {
    input.checked = false;
  }
  elements.snapshotName.value = "";
  void window.jiraSheetsApp.saveSettings(collectSettings()).catch(() => {});
}

function setSummary(kind, title, description) {
  elements.summaryCard.className = `summary-card ${kind === "running" ? "" : kind}`;
  elements.summaryCard.querySelector(".summary-icon").textContent =
    kind === "error" ? "!" : kind === "running" ? "…" : "✓";
  elements.summaryCard.querySelector("strong").textContent = title;
  elements.summaryCard.querySelector("p").textContent = description;
}

function renderResults(results) {
  elements.resultBody.textContent = "";
  for (const result of results) {
    const row = document.createElement("tr");
    row.append(
      createCell(result.key, "result-key"),
      createCell(result.action === "inserted" ? "추가" : "갱신", "action-pill"),
      createCell(String(result.rowNumber)),
      createCell(result.status)
    );
    elements.resultBody.append(row);
  }
  elements.resultCount.textContent = `${results.length}건`;
}

function createCell(text, className) {
  const cell = document.createElement("td");
  const content = className === "action-pill" ? document.createElement("span") : cell;
  if (content !== cell) {
    cell.append(content);
  }
  content.textContent = text;
  if (className) {
    content.className = className;
  }
  return cell;
}

function clearResults() {
  elements.resultBody.innerHTML =
    '<tr class="empty-row"><td colspan="4">처리 결과를 기다리는 중입니다.</td></tr>';
  elements.resultCount.textContent = "0건";
}

function appendLog(text) {
  elements.logOutput.textContent += text;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function showError(error) {
  const message = (error?.message ?? String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
  setSummary("error", "입력 내용을 확인해 주세요", message);
  elements.logSection.open = true;
  appendLog(`\n[실패 원인] ${message}\n`);
  showToast(message);
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3600);
}

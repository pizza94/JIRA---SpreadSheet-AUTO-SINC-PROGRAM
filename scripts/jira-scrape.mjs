import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const jiraBaseUrl = process.env.JIRA_BASE_URL ?? "http://jira.example.local:8079";
const issueKey = process.env.JIRA_ISSUE_KEY ?? process.argv[2] ?? "MS-12847";
const authFile = resolve("playwright/.auth/jira.json");
const outputFile = resolve(`output/${issueKey}.json`);
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
  "duedate"
].join(",");
const apiUrl =
  `${jiraBaseUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}` +
  `?fields=${encodeURIComponent(fields)}`;

await readFile(authFile, "utf8");

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ storageState: authFile });
  const response = await context.request.get(apiUrl, {
    headers: { Accept: "application/json" },
    timeout: 20_000
  });

  if (response.status() === 401 || response.status() === 403) {
    throw new Error("Jira 로그인 세션이 만료되었거나 이슈 조회 권한이 없습니다.");
  }

  if (!response.ok()) {
    throw new Error(`Jira 조회 실패: HTTP ${response.status()} ${await response.text()}`);
  }

  const issue = await response.json();
  const result = {
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
    description: issue.fields.description ?? ""
  };

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(result, null, 2));
  console.log(`\n저장 위치: ${outputFile}`);
} finally {
  await browser.close();
}

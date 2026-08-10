import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const jiraBaseUrl = process.env.JIRA_BASE_URL ?? "http://192.168.0.119:8079";
const dataRoot = resolve(process.env.AUTOMATION_DATA_DIR ?? ".");
const authFile = resolve(dataRoot, "playwright/.auth/jira.json");
const loginUrl = `${jiraBaseUrl}/secure/Dashboard.jspa`;
const authCheckUrl = `${jiraBaseUrl}/rest/api/2/myself`;

await mkdir(dirname(authFile), { recursive: true });

const browser = await chromium.launch({
  headless: false,
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {})
});
const context = await browser.newContext();
const page = await context.newPage();

console.log(`Jira 로그인 창을 엽니다: ${loginUrl}`);
console.log("브라우저에서 직접 로그인하세요. 비밀번호는 스크립트가 읽거나 저장하지 않습니다.");

await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

const deadline = Date.now() + 10 * 60 * 1000;
let authenticated = false;

while (Date.now() < deadline) {
  try {
    const response = await context.request.get(authCheckUrl, {
      headers: { Accept: "application/json" },
      timeout: 10_000
    });

    if (response.ok()) {
      authenticated = true;
      break;
    }
  } catch {
    // 로그인 과정의 페이지 이동 중 발생하는 일시적인 네트워크 오류는 재시도한다.
  }

  await page.waitForTimeout(1_000);
}

if (!authenticated) {
  await browser.close();
  throw new Error("10분 안에 Jira 로그인이 확인되지 않았습니다.");
}

await context.storageState({ path: authFile });
console.log(`로그인 세션을 저장했습니다: ${authFile}`);
await browser.close();

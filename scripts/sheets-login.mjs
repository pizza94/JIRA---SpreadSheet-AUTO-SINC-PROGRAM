import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446";
const authFile = resolve("playwright/.auth/google.json");

await mkdir(dirname(authFile), { recursive: true });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

console.log("Google Sheets 로그인 창을 엽니다.");
console.log("편집 권한이 있는 Google 계정으로 직접 로그인하세요.");
await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

const deadline = Date.now() + 10 * 60 * 1000;
let authenticated = false;

while (Date.now() < deadline) {
  const cookies = await context.cookies();
  authenticated = cookies.some((cookie) =>
    ["SID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"].includes(cookie.name)
  );

  if (authenticated) {
    break;
  }
  await page.waitForTimeout(1_000);
}

if (!authenticated) {
  await browser.close();
  throw new Error("10분 안에 Google 로그인이 확인되지 않았습니다.");
}

await context.storageState({ path: authFile });
console.log(`Google 로그인 세션을 저장했습니다: ${authFile}`);
await browser.close();

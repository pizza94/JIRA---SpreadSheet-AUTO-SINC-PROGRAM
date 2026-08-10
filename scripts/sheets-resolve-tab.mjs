import { chromium } from "playwright";

const startUrl =
  "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446";
const targetSheetName = process.argv[2] ?? "4.2.2.59 (LS증권)";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const tabs = page.locator(".docs-sheet-tab");
  const count = await tabs.count();
  let target = null;

  for (let index = 0; index < count; index += 1) {
    const tab = tabs.nth(index);
    const text = (await tab.innerText()).trim();
    if (text === targetSheetName) {
      target = tab;
      break;
    }
  }

  if (!target) {
    throw new Error(`대상 탭을 찾지 못했습니다: ${targetSheetName}`);
  }

  await target.click();
  await page.waitForTimeout(1_500);
  console.log(JSON.stringify({ targetSheetName, url: page.url() }, null, 2));
} finally {
  await browser.close();
}

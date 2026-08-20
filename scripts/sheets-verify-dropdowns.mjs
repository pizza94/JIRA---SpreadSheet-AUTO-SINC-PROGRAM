import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=108125438";
const screenshotPath = "output/MS-4395-reference-dropdown.png";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const nameBox = page.locator("#t-name-box");
  await nameBox.waitFor({ state: "visible", timeout: 20_000 });
  await nameBox.fill("K31");
  await nameBox.press("Enter");
  await page.waitForTimeout(750);
  await mkdir("output", { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(JSON.stringify({ screenshotPath }, null, 2));
} finally {
  await browser.close();
}

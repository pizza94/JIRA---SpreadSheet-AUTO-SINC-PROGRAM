import { chromium } from "playwright";

const sheetUrl =
  "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const controls = await page.evaluate(() =>
    [...document.querySelectorAll("input, [contenteditable='true'], [role='textbox']")]
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        ariaLabel: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        contentEditable: element.getAttribute("contenteditable"),
        value: "value" in element ? element.value : element.textContent
      }))
      .filter((item) =>
        /name|이름|formula|수식|cell|셀|range|범위/i.test(
          `${item.id} ${item.className} ${item.ariaLabel}`
        )
      )
  );

  console.log(JSON.stringify({ title: await page.title(), controls }, null, 2));
} finally {
  await browser.close();
}

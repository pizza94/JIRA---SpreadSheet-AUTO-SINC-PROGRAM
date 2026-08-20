import { chromium } from "playwright";

const sheetUrl =
  process.argv[2] ??
  "https://docs.google.com/spreadsheets/d/1eb6PYp3mA1uGynBdonZgoKrwYn40ffxI7qn5J6iWl94/edit?gid=94813446";

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(sheetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);

  const result = await page.evaluate(() => {
    const bodyText = document.body?.innerText ?? "";
    const markers = [
      "보기 전용",
      "View only",
      "댓글 작성자",
      "Commenter",
      "편집자",
      "Editor",
      "로그인",
      "Sign in",
      "액세스 권한이 필요합니다",
      "You need access"
    ];

    return {
      url: location.href,
      title: document.title,
      matchedMarkers: markers.filter((marker) => bodyText.includes(marker)),
      bodyPreview: bodyText.slice(0, 2_000)
    };
  });

  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

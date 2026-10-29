/**
 * Browser smoke test.
 *
 * Drives the real UI in Chromium: opens a PDF, checks that pdf.js paints the
 * page, switches to the text tool, double-clicks a run, retypes it, and
 * confirms the change reached the document. Run the backend and frontend
 * first, then:
 *
 *   node scripts/ui-smoke.mjs http://127.0.0.1:3100
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const SAMPLE = process.argv[3];

const passes = [];
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passes.push(name);
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} :: ${detail}`);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));

try {
  console.log(`Target: ${BASE}\n`);

  console.log("[1] Load the app");
  await page.goto(BASE, { waitUntil: "networkidle" });
  check("title bar rendered", await page.getByText("Docsmith").first().isVisible());
  check(
    "start screen shown",
    await page.getByText("Open a document to begin").isVisible(),
  );
  check("offline badge shown", await page.getByText("Offline · local only").isVisible());

  console.log("\n[2] Ribbon");
  const tabs = ["home", "edit", "insert", "organize", "comment", "convert", "protect"];
  for (const tab of tabs) {
    const visible = await page.locator(`[data-ribbon-tab="${tab}"]`).isVisible();
    check(`ribbon tab "${tab}"`, visible);
  }
  await page.locator('[data-ribbon-tab="edit"]').click();
  check("Edit tab shows Add Text", await page.getByText("Add Text").first().isVisible());
  await page.locator('[data-ribbon-tab="protect"]').click();
  check("Protect tab shows Redact tools", await page.getByText("Mark Area").first().isVisible());
  await page.locator('[data-ribbon-tab="home"]').click();

  console.log("\n[3] Open a document");
  await page.setInputFiles("#global-open-input", SAMPLE);
  await page.waitForSelector("canvas", { timeout: 45000 });
  check("canvas mounted", (await page.locator("canvas").count()) > 0);

  // Wait until pdf.js has actually painted something.
  const painted = await page.waitForFunction(
    () => {
      const canvas = document.querySelector("canvas");
      if (!canvas || !canvas.width) return false;
      const context = canvas.getContext("2d");
      const data = context.getImageData(0, 0, canvas.width, Math.min(canvas.height, 400)).data;
      let nonWhite = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) nonWhite += 1;
      }
      return nonWhite > 500;
    },
    { timeout: 45000 },
  ).then(() => true).catch(() => false);
  check("page actually rendered by pdf.js", painted);

  const pageCount = await page.locator("[data-page]").count();
  check("both pages laid out", pageCount >= 2, String(pageCount));

  console.log("\n[4] Thumbnails");
  const thumbs = await page.locator('img[alt^="Page "]').count();
  check("thumbnails listed", thumbs >= 2, String(thumbs));

  console.log("\n[5] Text editing");
  await page.getByTitle("Edit Text").first().click();
  await page.waitForSelector(".para-box", { timeout: 20000 });
  const paragraphCount = await page.locator(".para-box").count();
  check("text overlay built", paragraphCount >= 3, String(paragraphCount));

  // Paragraphs come in reading order, so the title is the first one.
  const title = page.locator('[data-page="0"] .para-box').first();
  await title.click();
  check("paragraph selects", (await page.locator(".para-box.is-selected").count()) > 0);
  // The inspector must reflect the run's real typography read out of the PDF.
  const sizeInput = page.locator('aside input[type="number"]').first();
  const shownSize = await sizeInput.inputValue().catch(() => "");
  check("properties panel shows the font size", shownSize.startsWith("24"), shownSize);
  const shownColor = await page
    .locator('aside input[type="color"]')
    .first()
    .inputValue()
    .catch(() => "");
  check("properties panel shows the colour", /^#[0-9a-f]{6}$/i.test(shownColor), shownColor);

  await title.dblclick();
  await page.waitForSelector(".para-editor", { timeout: 10000 });
  check("double-click opens the paragraph editor", true);

  await page.keyboard.press("Control+A");
  await page.keyboard.type("Browser Edited Title");
  // Enter starts a new paragraph, as in a word processor; Ctrl+Enter applies.
  await page.keyboard.press("Control+Enter");

  await page.waitForFunction(
    () => !document.querySelector(".para-editor"),
    { timeout: 20000 },
  );
  await page.waitForTimeout(2500);

  const docId = await page.evaluate(async () => {
    const response = await fetch("/api/documents");
    const list = await response.json();
    return list[list.length - 1]?.id ?? null;
  });
  const text = await page.evaluate(async (id) => {
    const response = await fetch(`/api/documents/${id}/text/layout/0`);
    const layout = await response.json();
    return layout.text;
  }, docId);

  check("edit reached the document", text.includes("Browser Edited Title"), text.slice(0, 120));
  check("original text removed", !text.includes("Quarterly Report"));
  check("other content untouched", text.includes("Revenue grew"));

  console.log("\n[6] Undo");
  await page.getByTitle("Undo (Ctrl+Z)").click();
  await page.waitForTimeout(2500);
  const afterUndo = await page.evaluate(async (id) => {
    const response = await fetch(`/api/documents/${id}/text/layout/0`);
    return (await response.json()).text;
  }, docId);
  check("undo restored the original", afterUndo.includes("Quarterly Report"), afterUndo.slice(0, 120));

  console.log("\n[7] Search");
  await page.keyboard.press("Control+f");
  const searchBox = page.getByPlaceholder("Find in document");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill("Revenue");
  await page.locator('aside button[type="submit"]', { hasText: "Find" }).click();
  await page.waitForTimeout(2000);
  check("search highlights a hit", (await page.locator(".search-hit").count()) > 0);

  console.log("\n[8] Zoom and view controls");
  const zoomBefore = await page.locator("canvas").first().evaluate((el) => el.style.width);
  await page.getByTitle("Zoom in").click();
  await page.waitForTimeout(1200);
  const zoomAfter = await page.locator("canvas").first().evaluate((el) => el.style.width);
  check("zoom in changes page size", zoomBefore !== zoomAfter, `${zoomBefore} -> ${zoomAfter}`);

  await page.getByTitle("Fit page").click();
  await page.waitForTimeout(1200);
  check("fit page applies", true);

  console.log("\n[9] Redaction panel");
  await page.locator('[data-ribbon-tab="protect"]').click();
  await page.getByTitle("Find & Redact").first().click();
  await page.getByRole("button", { name: "Scan document" }).click();
  await page.waitForTimeout(3500);
  const foundSensitive = await page
    .getByText(/jane\.doe@example\.com/)
    .first()
    .isVisible()
    .catch(() => false);
  check("sensitive data surfaced in the UI", foundSensitive);

  console.log("\n[10] Console health");
  const realErrors = consoleErrors.filter(
    (message) =>
      !/favicon|Download the React DevTools|ResizeObserver loop/i.test(message),
  );
  check(
    "no console errors",
    realErrors.length === 0,
    realErrors.slice(0, 3).join(" | ").slice(0, 300),
  );

  await page.screenshot({ path: "scripts/ui-smoke.png", fullPage: false });
  console.log("\nScreenshot: frontend/scripts/ui-smoke.png");
} catch (error) {
  check("test run completed", false, String(error).slice(0, 400));
} finally {
  await browser.close();
}

console.log("\n" + "=".repeat(62));
console.log(`PASSED ${passes.length}   FAILED ${failures.length}`);
if (failures.length) {
  console.log("-".repeat(62));
  failures.forEach((failure) => console.log("  " + failure));
}
console.log("=".repeat(62));
process.exit(failures.length ? 1 : 0);

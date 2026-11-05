import { expect, test, type Page } from "@playwright/test";
import { injectWallet } from "./wallet";

/**
 * A stage judged on measured parameters, through the real UI: the builder's parameter editor with its band preview,
 * readings recorded against the stage, the ring on the flow node, the gate's bands, and a passport that proves each
 * parameter in zero knowledge without showing the value.
 */
test.describe.configure({ mode: "serial" });

const choose = async (page: Page, trigger: ReturnType<Page["locator"]>, option: string | RegExp) => {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
};

test("build, record and prove a stage with several measured parameters", async ({ page }) => {
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  const wallet = await injectWallet(page);
  await page.goto("/");
  await page.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("heading", { name: "Create your site" })).toBeVisible();
  await page.getByPlaceholder("e.g. Pune Plant 1").fill("Protein Lab");
  await page.getByRole("button", { name: "Create site" }).click();
  await expect(page.getByRole("heading", { name: "Floor & fleet" })).toBeVisible();

  // ---- Only an approved validator releases a quality gate: the admin applies and approves with a signature ----
  await page.getByRole("link", { name: /Team & validators/ }).click();
  await page.getByRole("tab", { name: /Validators/ }).click();
  await page.getByRole("button", { name: "Apply as validator" }).click();
  const ap = page.getByRole("dialog", { name: "Apply as a validator" });
  await ap.getByRole("textbox", { name: "Full name" }).fill("Meera Okafor");
  await ap.getByRole("textbox", { name: "Qualifications" }).fill("QC release, 8 years in biologics");
  await ap.getByRole("button", { name: "Send application" }).click();
  await expect(ap).toBeHidden();
  await page.getByRole("tab", { name: /Applications/ }).click();
  await page.getByRole("button", { name: "Approve and sign" }).click();
  const grant = page.getByRole("dialog", { name: /Approve Meera Okafor/ });
  await grant.getByRole("button", { name: "Sign with wallet" }).click();
  await expect(grant).toBeHidden({ timeout: 15_000 });

  // ---- Builder: a QC release stage judged on two measured parameters ----
  await page.getByRole("link", { name: "Builder" }).click();
  await page.getByRole("button", { name: /\+ Order intake/ }).click();
  await page.getByRole("button", { name: /\+ QC release/ }).click();
  await page.locator(".b-card").nth(1).click();
  const params = page.locator(".crit2");
  await expect(params).toHaveCount(2);
  await expect(params.first()).toContainText("Measured signal");
  await expect(params.first()).toContainText("Final value");
  await expect(params.first().locator(".specband")).toHaveAttribute("aria-label", /Endotoxin ≤ 0.5 EU\/mg.*band at most 0.5 EU\/mg/);
  // a range shows both bounds on the band preview
  await params.nth(1).getByRole("button", { name: "range" }).click();
  await params.nth(1).getByLabel("Upper bound").fill("2");
  await expect(params.nth(1).locator(".specband")).toHaveAttribute("aria-label", /band 0–2 CFU/);
  await params.nth(1).getByRole("button", { name: "single" }).click();
  await page.locator(".builder input.input").first().fill("Protein QC");
  await page.getByRole("button", { name: "Publish pipeline" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published Protein QC v1/)).toBeVisible();

  // ---- One batch runs; the QC stage waits for its parameters ----
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await page.getByRole("button", { name: "Start a run" }).click();
  const start = page.getByRole("dialog", { name: "Start a pipeline run" });
  await choose(page, start.locator(".sel-btn").first(), /Protein QC/);
  await start.getByPlaceholder("e.g. SO-48213").fill("PS-001");
  await start.locator('input[type="number"]').fill("1");
  await start.getByRole("button", { name: "Start run" }).click();
  const node = page.locator(".node-hit", { hasText: "02" });
  await expect(node).toContainText(/Running/, { timeout: 30_000 });
  // two parameters, nothing measured yet: a dashed ring
  await expect(node.locator(".cring .cr-na")).toHaveCount(2);
  await expect(node).toHaveAttribute("aria-label", /0 of 2 parameters in spec/);

  // ---- The operator records the batch with its parameters ----
  await node.click();
  await expect(page.locator(".block .band-list .specband")).toHaveCount(2);
  await page.locator(".block").getByRole("button", { name: "Record units" }).click();
  const rec = page.getByRole("dialog", { name: /Record/ });
  await expect(rec).toContainText("Parameters");
  await expect(rec).toContainText("target ≤ 0.5 EU/mg · signal endotoxin_eu_mg");
  const nums = rec.locator('input[type="number"]');
  await nums.nth(0).fill("1");
  await nums.nth(2).fill("0.3");
  await nums.nth(3).fill("0");
  await rec.getByRole("button", { name: "Record" }).click();
  await expect(node).toContainText("Awaiting approval", { timeout: 20_000 });
  await expect(node.locator(".cring .cr-ok")).toHaveCount(2);
  await expect(node).toHaveAttribute("aria-label", /2 of 2 parameters in spec/);
  await expect(page.locator(".block")).toContainText("0.30 EU/mg");
  await expect(page.locator(".block .band-list .sb-mark.ok")).toHaveCount(2);

  // the drawer shows a card per parameter, each in spec
  await page.locator(".block").getByRole("button", { name: /Full details/ }).click();
  const drawer = page.locator("aside.drawer");
  await expect(drawer.getByRole("heading", { name: "Parameters" })).toBeVisible();
  await expect(drawer.locator(".param-card")).toHaveCount(2);
  await expect(drawer.locator(".param-card.s-ok")).toHaveCount(2);
  await expect(drawer).toContainText("2 of 2 in spec");
  await expect(drawer.locator(".param-card").first()).toContainText("● Pass");
  await page.keyboard.press("Escape");

  // ---- The gate shows the parameters against their bands; a signature releases it ----
  await page.getByRole("link", { name: "Approvals" }).click();
  await expect(page.locator(".metric-row .specband")).toHaveCount(2);
  await page.getByRole("link", { name: "Pipelines", exact: true }).click();
  await node.click();
  await page.locator(".block").getByRole("button", { name: "Approve" }).click();
  const sig = page.getByRole("dialog", { name: /Approve 02/ });
  await expect(sig).toContainText(wallet.address.slice(0, 6));
  await sig.getByRole("button", { name: "Sign with wallet" }).click();
  await expect(sig).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".main .ph-text .eyebrow")).toContainText("completed", { timeout: 20_000 });
  await page.keyboard.press("Escape");

  // ---- The public passport: bands, no values, one proof per parameter, re-checked here ----
  await page.getByRole("button", { name: "Lot passport" }).click();
  const pp = page.getByRole("dialog", { name: /Lot PS-001/ });
  const publicUrl = await pp.getByRole("link", { name: "Open the public page" }).getAttribute("href");
  const anon = await page.context().browser()!.newContext();
  const pub = await anon.newPage();
  await pub.goto(publicUrl!);
  await expect(pub.getByRole("heading", { name: "Lot PS-001" })).toBeVisible();
  const qc = pub.locator("tr", { hasText: "QC release" });
  await expect(qc.locator(".pp-crit .specband")).toHaveCount(2);
  await expect(pub.locator(".pp-crit .sb-mark")).toHaveCount(0); // the band is public, where the value fell is not
  await expect(pub.getByText("0.30")).toHaveCount(0);
  await expect(async () => {
    await pub.reload();
    await expect(pub.getByText(/2 of 2 bounds across 2 criteria met are proven in zero knowledge/)).toBeVisible();
    await expect(pub.getByText("ZK proof pending")).toHaveCount(0);
  }).toPass({ timeout: 90_000 });
  await expect(pub.getByText("ZK proof verified")).toHaveCount(2);
  await pub.getByRole("button", { name: "Verify in this browser", exact: true }).click();
  await expect(pub.getByText("2 of 2 verified in this browser")).toBeVisible({ timeout: 30_000 });
  await anon.close();
});

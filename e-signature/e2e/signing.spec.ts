import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createRequest(request: APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post("/api/mock/v1/signature-requests", {
    data: { external_ref: `quote:${Date.now()}`, ...data },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; token: string; signing_url: string };
}

async function drawSignature(page: Page) {
  const canvas = page.getByTestId("signature-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 20 + i * 20, box.y + box.height / 2 + (i % 2 ? -20 : 20));
  await page.mouse.up();
}

async function eventsFor(request: APIRequestContext, ref: string) {
  const res = await request.get("/api/mock/v1/events");
  const { data } = (await res.json()) as { data: { type: string; data: { external_ref: string } }[] };
  return data.filter((e) => e.data.external_ref === ref).map((e) => e.type);
}

test("signs a document and exposes the signed PDF", async ({ page, request }) => {
  const ref = `quote:sign-${Math.random()}`;
  const { token } = await createRequest(request, { external_ref: ref, signer_name: "Marie Martin" });

  await page.goto(`/sign/${token}`);
  await expect(page.getByRole("heading", { name: "Devis D-2026-0012" })).toBeVisible();
  await expect(page.getByLabel("Nom complet")).toHaveValue("Marie Martin");
  await expect(page.getByTestId("pdf-pages").locator("canvas")).toHaveCount(1); // sample quote = 1 page
  await expect(page.getByText("Impossible d'afficher le document")).toHaveCount(0);

  const submit = page.getByRole("button", { name: "Accepter et signer" });
  await expect(submit).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(submit).toBeDisabled(); // still no signature
  await drawSignature(page);
  await submit.click();

  await expect(page.getByRole("heading", { name: "Document signé" })).toBeVisible();
  const pdf = await request.get(`/sign/${token}/signed`);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  expect(await eventsFor(request, ref)).toEqual([
    "signature_request.signed",
    "signature_request.viewed",
    "signature_request.created",
  ]);
});

test("declines a document with a reason", async ({ page, request }) => {
  const ref = `quote:decline-${Math.random()}`;
  const { token } = await createRequest(request, { external_ref: ref });
  await page.goto(`/sign/${token}`);
  await page.getByRole("button", { name: "Refuser le document" }).click();
  await page.getByLabel("Motif du refus").fill("Prix trop élevé");
  await page.getByRole("button", { name: "Confirmer le refus" }).click();
  await expect(page.getByRole("heading", { name: "Document refusé" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accepter et signer" })).toHaveCount(0);
  expect((await eventsFor(request, ref))[0]).toBe("signature_request.declined");
});

test("rejects unknown and malformed tokens", async ({ page }) => {
  await page.goto(`/sign/${"x".repeat(43)}`);
  await expect(page.getByRole("heading", { name: "Lien invalide" })).toBeVisible();
  await page.goto("/sign/not-a-token");
  await expect(page.getByRole("heading", { name: "Lien invalide" })).toBeVisible();
});

test("shows an expired link without the form", async ({ page, request }) => {
  const { token } = await createRequest(request, { expires_in_days: -1 });
  await page.goto(`/sign/${token}`);
  await expect(page.getByRole("heading", { name: "Lien expiré" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accepter et signer" })).toHaveCount(0);
});

test("serves the document inline with no-referrer", async ({ request }) => {
  const { token } = await createRequest(request);
  const page = await request.get(`/sign/${token}`);
  expect(page.headers()["referrer-policy"]).toBe("no-referrer");
  const doc = await request.get(`/sign/${token}/document`);
  expect(doc.headers()["content-disposition"]).toMatch(/^inline/);
});

test("backend refuses a second signature (409)", async ({ request }) => {
  const { token } = await createRequest(request);
  const meta = await (await request.get(`/api/mock/v1/public/signature-requests/${token}`)).json();
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const body = { signer_name: "Jean Dupont", signature_png: png, consent: true, document_sha256: meta.document.sha256 };
  const url = `/api/mock/v1/public/signature-requests/${token}/sign`;
  expect((await request.post(url, { data: body })).status()).toBe(200);
  expect((await request.post(url, { data: body })).status()).toBe(409);
});

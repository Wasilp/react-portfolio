import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

async function createRequest(request: APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post("/api/mock/v1/signature-requests", {
    data: { external_ref: `quote:${Date.now()}`, ...data },
  });
  expect(res.status()).toBe(201);
  const json = (await res.json()) as { id: string; token: string; signing_url: string };
  expect(json.token).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  return json;
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

test("rejects malformed and tampered links", async ({ page, request }) => {
  await page.goto("/sign/not-a-token");
  await expect(page.getByRole("heading", { name: "Lien invalide" })).toBeVisible();

  // Flip one character of the ciphertext: the GCM tag no longer matches.
  const { token } = await createRequest(request);
  const [v, iv, ct, tag] = token.split(".");
  const flipped = (ct[5] === "A" ? "B" : "A");
  const tampered = [v, iv, ct.slice(0, 5) + flipped + ct.slice(6), tag].join(".");
  await page.goto(`/sign/${tampered}`);
  await expect(page.getByRole("heading", { name: "Lien invalide" })).toBeVisible();
  expect((await request.get(`/sign/${tampered}/document`)).status()).toBe(404);
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
  expect(await page.text()).not.toContain("/api/mock/v1/documents"); // storage URL stays server-side
  const doc = await request.get(`/sign/${token}/document`);
  expect(doc.headers()["content-disposition"]).toMatch(/^inline/);
});

test("backend requires the matching link and refuses a second signature", async ({ request }) => {
  const { id, token } = await createRequest(request);
  const other = await createRequest(request);
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const view = await request.post(`/api/mock/v1/signature-requests/${id}/view`, { headers: { "X-Signature-Link": token } });
  expect(view.status()).toBe(200);
  const doc = await request.get(`/sign/${token}/document`);
  const { createHash } = await import("node:crypto");
  const body = {
    signer_name: "Jean Dupont",
    signature_png: png,
    consent: true,
    document_sha256: createHash("sha256").update(await doc.body()).digest("hex"),
  };
  const url = `/api/mock/v1/signature-requests/${id}/sign`;
  expect((await request.post(url, { data: body })).status()).toBe(403); // no link
  expect((await request.post(url, { data: body, headers: { "X-Signature-Link": other.token } })).status()).toBe(403); // link of another request
  expect((await request.post(url, { data: body, headers: { "X-Signature-Link": token } })).status()).toBe(200);
  expect((await request.post(url, { data: body, headers: { "X-Signature-Link": token } })).status()).toBe(409);
});

import { notFound, redirect } from "next/navigation";
import { mockEnabled } from "@/lib/mock/http";
import { createRequest, events } from "@/lib/mock/store";

/** Dev-only console (MOCK_API=true): issue a signing link and watch the mocked webhooks. */

async function create(form: FormData) {
  "use server";
  if (!mockEnabled()) notFound();
  const file = form.get("document");
  const pdf = file instanceof File && file.size > 0 && file.type === "application/pdf" ? new Uint8Array(await file.arrayBuffer()) : null;
  const { token } = await createRequest({
    title: String(form.get("title") || "Devis D-2026-0012"),
    message: String(form.get("message") || "") || null,
    issuer_name: String(form.get("issuer_name") || "SolarPro SRL"),
    signer_name: String(form.get("signer_name") || "Jean Dupont"),
    signer_email: String(form.get("signer_email") || "jean.dupont@example.com"),
    external_ref: "quote:42",
    expires_in_days: Number(form.get("expires_in_days") || 14),
    pdf,
    filename: pdf && file instanceof File ? file.name : null,
  });
  redirect(`/dev?token=${token}`);
}

export default async function DevPage({ searchParams }: PageProps<"/dev">) {
  if (!mockEnabled()) notFound();
  const { token } = await searchParams;
  const field = "w-full rounded-md border border-border px-3 py-2";

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8">
      <h1 className="text-2xl font-semibold">Console de dev — mock</h1>

      {typeof token === "string" && (
        <p className="rounded-md border border-border p-4">
          Lien de signature :{" "}
          <a data-testid="signing-link" href={`/sign/${token}`} className="break-all underline">
            /sign/{token}
          </a>
        </p>
      )}

      <form action={create} className="space-y-3">
        <input name="title" placeholder="Titre (Devis D-2026-0012)" className={field} />
        <input name="issuer_name" placeholder="Émetteur (SolarPro SRL)" className={field} />
        <input name="signer_name" placeholder="Signataire (Jean Dupont)" className={field} />
        <input name="signer_email" type="email" placeholder="E-mail (jean.dupont@example.com)" className={field} />
        <textarea name="message" placeholder="Message (facultatif)" className={field} />
        <label className="block text-sm">
          Validité (jours, -1 pour un lien déjà expiré)
          <input name="expires_in_days" type="number" defaultValue={14} className={field} />
        </label>
        <label className="block text-sm">
          PDF (facultatif, sinon un devis d&apos;exemple est généré)
          <input name="document" type="file" accept="application/pdf" className="block" />
        </label>
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-primary-foreground">
          Créer une demande de signature
        </button>
      </form>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Webhooks émis (mock)</h2>
        <ul className="space-y-1 font-mono text-xs" data-testid="events">
          {events().map((e) => (
            <li key={e.id}>
              {e.created_at} {e.type} {e.data.external_ref} [{e.delivery}]
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

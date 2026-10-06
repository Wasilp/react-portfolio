import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeLink, type LinkPayload } from "@/lib/link-token";
import { SignatureApiError, view } from "@/lib/signature-api/client";
import { isActionable, type SignatureRequest } from "@/lib/signature-api/types";
import { PdfViewer } from "./pdf-viewer";
import { SigningForm } from "./signing-form";

export const metadata: Metadata = {
  title: "Signer un document",
  robots: { index: false, follow: false },
};

const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("fr-BE", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Brussels" }) : "";

export default async function SignPage({ params }: PageProps<"/sign/[token]">) {
  const { token } = await params;

  // 1. Decrypt and authenticate the link. Any tampering → invalid; past `exp` → expired.
  const link = decodeLink(token);
  if (!link.ok && link.reason === "invalid") notFound();
  if (!link.ok) return <Final title="Lien expiré" body="Ce lien de signature a expiré. Contactez l'expéditeur pour en recevoir un nouveau." />;
  const payload = link.payload;

  // 2. Live state from the backend (also records the view).
  let request: SignatureRequest;
  try {
    request = await view(payload.rid, token);
  } catch (e) {
    if (e instanceof SignatureApiError && (e.status === 404 || e.status === 403)) notFound();
    if (e instanceof SignatureApiError && e.status === 410) return <Final title="Lien expiré" body="Ce lien de signature a expiré. Contactez l'expéditeur pour en recevoir un nouveau." />;
    throw e;
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm text-muted">{payload.issuer.name} vous invite à signer</p>
        <h1 className="text-2xl font-semibold">{payload.title}</h1>
        {payload.message && <p className="whitespace-pre-line">{payload.message}</p>}
      </header>

      <section className="space-y-2">
        <PdfViewer src={`/sign/${token}/document`} title={`Document : ${payload.document.filename}`} />
        <a href={`/sign/${token}/document`} target="_blank" rel="noreferrer" className="text-sm underline">
          Ouvrir le document dans un nouvel onglet
        </a>
      </section>

      <section aria-live="polite">
        <StatusBlock token={token} payload={payload} request={request} />
      </section>
    </main>
  );
}

function StatusBlock({ token, payload, request }: { token: string; payload: LinkPayload; request: SignatureRequest }) {
  if (isActionable(request.status)) {
    return (
      <>
        <p className="mb-4 text-sm text-muted">Lien valable jusqu&apos;au {fmt(new Date(payload.exp * 1000).toISOString())}.</p>
        <SigningForm token={token} signerName={payload.signer.name} />
      </>
    );
  }
  switch (request.status) {
    case "signed":
      return (
        <div className="space-y-2 rounded-md border border-border p-4">
          <h2 className="text-lg font-semibold">Document signé</h2>
          <p>Signé le {fmt(request.signed_at)}. Une copie vous est envoyée par e-mail.</p>
          <a href={`/sign/${token}/signed`} className="inline-block rounded-md bg-primary px-4 py-2 text-primary-foreground">
            Télécharger le document signé
          </a>
        </div>
      );
    case "declined":
      return <Notice title="Document refusé" body={`Vous avez refusé ce document le ${fmt(request.declined_at)}. L'expéditeur en a été informé.`} />;
    case "expired":
      return <Notice title="Lien expiré" body="Ce lien de signature a expiré. Contactez l'expéditeur pour en recevoir un nouveau." />;
    case "canceled":
      return <Notice title="Demande annulée" body="L'expéditeur a annulé cette demande de signature." />;
  }
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-1 rounded-md border border-border p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function Final({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-16">
      <Notice title={title} body={body} />
    </main>
  );
}

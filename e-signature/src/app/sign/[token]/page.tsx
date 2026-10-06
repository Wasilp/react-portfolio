import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSignatureRequest, SignatureApiError } from "@/lib/signature-api/client";
import { isActionable, type SignatureRequest } from "@/lib/signature-api/types";
import { isWellFormedToken } from "@/lib/token";
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
  if (!isWellFormedToken(token)) notFound();

  let request: SignatureRequest;
  try {
    request = await getSignatureRequest(token);
  } catch (e) {
    if (e instanceof SignatureApiError && e.status === 404) notFound();
    if (e instanceof SignatureApiError && e.status === 410) return <Final title="Lien expiré" body="Ce lien de signature a expiré. Contactez l'expéditeur pour en recevoir un nouveau." />;
    throw e;
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <p className="text-sm text-muted">{request.issuer.name} vous invite à signer</p>
        <h1 className="text-2xl font-semibold">{request.title}</h1>
        {request.message && <p className="whitespace-pre-line">{request.message}</p>}
      </header>

      <section className="space-y-2">
        <PdfViewer src={`/sign/${token}/document`} title={`Document : ${request.document.filename}`} />
        <a href={`/sign/${token}/document`} target="_blank" rel="noreferrer" className="text-sm underline">
          Ouvrir le document dans un nouvel onglet
        </a>
      </section>

      <section aria-live="polite">
        <StatusBlock token={token} request={request} />
      </section>
    </main>
  );
}

function StatusBlock({ token, request }: { token: string; request: SignatureRequest }) {
  if (isActionable(request.status)) {
    return (
      <>
        <p className="mb-4 text-sm text-muted">Lien valable jusqu&apos;au {fmt(request.expires_at)}.</p>
        <SigningForm token={token} signerName={request.signer.name} documentSha256={request.document.sha256} />
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

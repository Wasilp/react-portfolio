"use client";

import { useActionState, useCallback, useRef, useState } from "react";
import { declineAction, signAction, type ActionState } from "./actions";
import { SignatureCanvas, type SignaturePadHandle } from "./signature-pad";

const initial: ActionState = { error: null };

export function SigningForm({ token, signerName }: { token: string; signerName: string }) {
  const [signState, signFormAction, signing] = useActionState(signAction.bind(null, token), initial);
  const [declineState, declineFormAction, declining] = useActionState(declineAction.bind(null, token), initial);
  const padRef = useRef<SignaturePadHandle>(null);
  // Controlled on purpose: React resets uncontrolled fields after a form action, which would
  // drop the signature if the backend returns an error and the signer retries.
  const [png, setPng] = useState("");
  const empty = png === "";
  const [consent, setConsent] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const onPadChange = useCallback((isEmpty: boolean) => {
    setPng(isEmpty ? "" : (padRef.current?.toPng() ?? ""));
  }, []);
  const busy = signing || declining;

  return (
    <div className="space-y-6">
      <form
        action={signFormAction}
        className="space-y-4"
      >
        <input type="hidden" name="signature_png" value={png} />

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1 size-4"
          />
          <span>J&apos;ai lu le document ci-dessus et je l&apos;accepte. Je reconnais que ma signature électronique a la même valeur qu&apos;une signature manuscrite.</span>
        </label>

        <div className="space-y-1">
          <label htmlFor="signer_name" className="block text-sm font-medium">Nom complet</label>
          <input
            id="signer_name"
            name="signer_name"
            defaultValue={signerName}
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            className="w-full rounded-md border border-border px-3 py-2"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Signature</span>
            <button type="button" onClick={() => padRef.current?.clear()} className="text-sm text-muted underline">
              Effacer
            </button>
          </div>
          <SignatureCanvas ref={padRef} onChange={onPadChange} />
          <p className="text-xs text-muted">Dessinez votre signature avec la souris ou le doigt.</p>
        </div>

        {signState.error && <p role="alert" className="text-sm text-danger">{signState.error}</p>}

        <button
          type="submit"
          disabled={busy || empty || !consent}
          className="w-full rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground disabled:opacity-40"
        >
          {signing ? "Signature en cours…" : "Accepter et signer"}
        </button>
      </form>

      <div className="border-t border-border pt-4">
        {!showDecline ? (
          <button type="button" onClick={() => setShowDecline(true)} className="text-sm text-danger underline">
            Refuser le document
          </button>
        ) : (
          <form action={declineFormAction} className="space-y-3">
            <label htmlFor="reason" className="block text-sm font-medium">Motif du refus (facultatif)</label>
            <textarea id="reason" name="reason" maxLength={1000} rows={3} className="w-full rounded-md border border-border px-3 py-2" />
            {declineState.error && <p role="alert" className="text-sm text-danger">{declineState.error}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={busy} className="rounded-md border border-danger px-4 py-2 text-sm text-danger disabled:opacity-40">
                {declining ? "Envoi…" : "Confirmer le refus"}
              </button>
              <button type="button" onClick={() => setShowDecline(false)} className="px-4 py-2 text-sm text-muted">
                Annuler
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

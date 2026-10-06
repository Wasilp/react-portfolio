"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders every page of the PDF with pdf.js. An <iframe> is not enough: Chrome on Android
 * does not display PDFs inline, and most signers are on a phone.
 */
export function PdfViewer({ src, title }: { src: string; title: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current!;

    (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const doc = await pdfjs.getDocument({ url: src }).promise;
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      container.replaceChildren();
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (container.clientWidth / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = "100%";
        canvas.setAttribute("aria-label", `Page ${n} sur ${doc.numPages}`);
        canvas.className = "border-b border-border last:border-b-0";
        container.append(canvas);
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      }
      if (!cancelled) setState("ready");
    })().catch((e) => {
      console.error("PDF render failed", e);
      if (!cancelled) setState("error");
    });

    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div role="document" aria-label={title} aria-busy={state === "loading"} className="max-h-[70vh] overflow-y-auto rounded-md border border-border bg-white">
      {state === "loading" && <p className="p-4 text-sm text-muted">Chargement du document…</p>}
      {state === "error" && <p className="p-4 text-sm text-danger">Impossible d&apos;afficher le document ici. Utilisez le lien ci-dessous pour l&apos;ouvrir.</p>}
      <div ref={containerRef} data-testid="pdf-pages" />
    </div>
  );
}

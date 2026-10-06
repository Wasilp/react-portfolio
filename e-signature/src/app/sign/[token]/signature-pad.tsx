"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import SignaturePad from "signature_pad";

export type SignaturePadHandle = { isEmpty: () => boolean; toPng: () => string; clear: () => void };

/** Canvas wrapper: crisp on high-DPI screens, works with mouse, pen and finger. */
export function SignatureCanvas({ ref, onChange }: { ref: Ref<SignaturePadHandle>; onChange: (empty: boolean) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const pad = new SignaturePad(canvas, { penColor: "#111827", minWidth: 0.8, maxWidth: 2.5 });
    padRef.current = pad;
    const notify = () => onChange(pad.isEmpty());
    pad.addEventListener("endStroke", notify);

    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const data = pad.toData();
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d")!.scale(ratio, ratio);
      pad.clear();
      pad.fromData(data); // keep the drawing when the phone rotates
    };
    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      pad.removeEventListener("endStroke", notify);
      pad.off();
    };
  }, [onChange]);

  useImperativeHandle(ref, () => ({
    isEmpty: () => padRef.current?.isEmpty() ?? true,
    toPng: () => padRef.current?.toDataURL("image/png") ?? "",
    clear: () => {
      padRef.current?.clear();
      onChange(true);
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      data-testid="signature-canvas"
      aria-label="Zone de signature : dessinez votre signature"
      className="h-44 w-full touch-none rounded-md border border-border bg-white"
    />
  );
}

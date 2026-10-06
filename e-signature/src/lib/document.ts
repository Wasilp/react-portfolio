import "server-only";

import { createHash } from "node:crypto";
import { isAllowedDocumentUrl, type LinkPayload } from "./link-token";

const MAX_BYTES = 20 * 1024 * 1024;

export class DocumentError extends Error {}

/**
 * Downloads the document named in the link and checks it is exactly the one the backend signed
 * off on (SHA-256 from the link). A swapped or modified file is never shown to the signer.
 */
export async function fetchDocument(doc: LinkPayload["document"]): Promise<Uint8Array> {
  if (!isAllowedDocumentUrl(doc.url)) throw new DocumentError("Document origin not allowed");
  const res = await fetch(doc.url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new DocumentError(`Document fetch failed: ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw new DocumentError("Document too large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new DocumentError("Document too large");
  if (createHash("sha256").update(bytes).digest("hex") !== doc.sha256) {
    throw new DocumentError("Document hash mismatch");
  }
  return bytes;
}

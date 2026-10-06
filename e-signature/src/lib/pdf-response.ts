/** Re-serve a backend PDF response with safe headers. */
export function passthroughPdf(res: Response, disposition: "inline" | "attachment") {
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "document.pdf";
  return new Response(res.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import "server-only";

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/** Mock-only PDF helpers: a sample quote, and the signed copy with its proof page. */

const A4: [number, number] = [595.28, 841.89];
const grey = rgb(0.4, 0.4, 0.4);

// Standard PDF fonts are WinAnsi-encoded: no narrow no-break spaces, so format by hand.
const eur = (n: number) =>
  n.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €";

export async function renderSamplePdf(title: string, signerName: string, issuerName: string) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage(A4);
  let y = 780;
  const text = (s: string, x: number, size = 10, f: PDFFont = font, color = rgb(0, 0, 0)) =>
    page.drawText(s, { x, y, size, font: f, color });

  text(issuerName, 50, 14, bold);
  y -= 30;
  text(title, 50, 18, bold);
  y -= 20;
  text(`Client : ${signerName}`, 50, 10, font, grey);
  y -= 14;
  text(`Date : ${new Date().toLocaleDateString("fr-BE")}`, 50, 10, font, grey);
  y -= 40;

  const lines: [string, number, number][] = [
    ["Panneau photovoltaïque 430 Wc", 12, 185],
    ["Kit de fixation toiture tuiles", 12, 42],
    ["Onduleur hybride 6 kW", 1, 1450],
    ["Câblage, protections AC/DC (forfait)", 1, 350],
    ["Pose et mise en service (forfait)", 1, 1200],
  ];
  text("Désignation", 50, 10, bold);
  text("Qté", 360, 10, bold);
  text("P.U. HTVA", 410, 10, bold);
  text("Total HTVA", 490, 10, bold);
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: grey });
  y -= 16;
  let total = 0;
  for (const [label, qty, unit] of lines) {
    total += qty * unit;
    text(label, 50);
    text(String(qty), 360);
    text(eur(unit), 410);
    text(eur(qty * unit), 490);
    y -= 18;
  }
  y -= 10;
  const vat = total * 0.21;
  for (const [label, value, f] of [
    ["Total HTVA", total, font],
    ["TVA 21 %", vat, font],
    ["Total TVAC", total + vat, bold],
  ] as const) {
    text(label, 410, 10, f);
    text(eur(value), 490, 10, f);
    y -= 16;
  }
  y -= 30;
  text("Devis valable 30 jours. Document d'exemple généré par le mock.", 50, 9, font, grey);
  return pdf.save();
}

export async function renderSignedPdf(input: {
  original: Uint8Array;
  originalSha256: string;
  requestId: string;
  title: string;
  signerName: string;
  signerEmail: string;
  signaturePng: string;
  audit: { at: string; type: string; ip: string; user_agent: string }[];
}) {
  const pdf = await PDFDocument.load(input.original);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const png = await pdf.embedPng(Buffer.from(input.signaturePng.split(",")[1], "base64"));
  const signedAt = input.audit.findLast((a) => a.type === "signed")?.at ?? "";

  // Stamp the signature on the last page of the original.
  const last = pdf.getPage(pdf.getPageCount() - 1);
  const stamp = png.scaleToFit(160, 60);
  last.drawText(`Signé par ${input.signerName} le ${signedAt}`, { x: 50, y: 70, size: 8, font, color: grey });
  last.drawImage(png, { x: 50, y: 80, width: stamp.width, height: stamp.height });

  // Proof page (audit trail).
  const page = pdf.addPage(A4);
  let y = 780;
  const line = (p: PDFPage, s: string, size = 10, f: PDFFont = font) => {
    p.drawText(s.slice(0, 110), { x: 50, y, size, font: f });
    y -= size + 8;
  };
  line(page, "Certificat de signature électronique", 16, bold);
  y -= 6;
  line(page, `Document : ${input.title}`);
  line(page, `Identifiant de la demande : ${input.requestId}`);
  line(page, `Empreinte SHA-256 du document original :`);
  line(page, input.originalSha256, 9);
  line(page, `Signataire : ${input.signerName} <${input.signerEmail}>`);
  line(page, `Signé le (UTC) : ${signedAt}`);
  const sig = png.scaleToFit(220, 90);
  page.drawImage(png, { x: 50, y: y - sig.height, width: sig.width, height: sig.height });
  y -= sig.height + 24;
  line(page, "Journal des événements", 12, bold);
  for (const a of input.audit) {
    line(page, `${a.at}  ${a.type}${a.ip ? `  IP ${a.ip}` : ""}`, 9);
    if (a.user_agent) line(page, `    ${a.user_agent}`, 8);
  }
  return pdf.save();
}

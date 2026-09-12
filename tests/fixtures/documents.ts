// Minimal real, multi-page PDF with a valid xref table; extraction is never mocked.
export function textPdf(pages: string[][]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, lines] of pages.entries()) {
    const stream = `BT /F1 12 Tf 50 760 Td 16 TL ${lines.map((line, j) => `${j ? "T* " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}
export const inductionPages = [
  [
    "Mathematical induction: proving a statement for every natural number.",
    "First verify the base case, typically n equals one.",
    "The base case starts a chain of implications, like falling dominoes.",
  ],
  [
    "The inductive hypothesis assumes that the proposition holds for an arbitrary k.",
    "Use that assumption to demonstrate the proposition for k plus one.",
    "Together with the base case, this proves the statement for all natural numbers.",
  ],
];

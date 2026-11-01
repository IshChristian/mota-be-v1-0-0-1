const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const path = require("node:path");
const text = (value) =>
  value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
function flattenReport(summary, records) {
  const sheets = [
    {
      name: "Report information",
      rows: [
        { field: "Generated", value: String(summary.generatedAt) },
        { field: "From", value: String(summary.period.from) },
        { field: "Through", value: String(summary.period.to) },
        { field: "Timezone", value: summary.period.timezone },
        ...summary.coverage.map((value) => ({ field: "Coverage", value })),
        { field: "Detail rows exported", value: records.rows.length },
        { field: "Matching detail records", value: records.total },
        { field: "Export cap", value: 2000 },
      ],
    },
  ];
  for (const [section, report] of Object.entries(summary.sections)) {
    sheets.push({
      name: `${section} summary`,
      rows: [
        ...Object.entries(report.cards || {}).map(([metric, value]) => ({
          metric,
          value,
        })),
        { metric: "Definition", value: report.note },
      ],
    });
    for (const [key, value] of Object.entries(report))
      if (Array.isArray(value))
        sheets.push({ name: `${section} ${key}`, rows: value });
    if (report.funnel)
      sheets.push({
        name: `${section} verification`,
        rows: Object.entries(report.funnel)
          .filter(([key]) => key !== "_id")
          .map(([metric, value]) => ({ metric, value })),
      });
  }
  if (records.rows.length)
    sheets.push({ name: "Filtered detail records", rows: records.rows });
  return sheets;
}
async function spreadsheet(sheets) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MOTA";
  workbook.created = new Date();
  for (const [index, sheet] of sheets.entries()) {
    const ws = workbook.addWorksheet(
      `${index + 1} ${sheet.name}`.slice(0, 31),
      { views: [{ state: "frozen", ySplit: 1 }] },
    );
    const keys = [...new Set(sheet.rows.flatMap((row) => Object.keys(row)))];
    if (!keys.length) keys.push("No records");
    ws.columns = keys.map((key) => ({
      header: key,
      key,
      width: Math.min(60, Math.max(18, key.length + 4)),
    }));
    for (const row of sheet.rows)
      ws.addRow(
        Object.fromEntries(
          keys.map((key) => [
            key,
            typeof row[key] === "number"
              ? row[key]
              : /At$|timestamp/.test(key) &&
                  typeof row[key] === "string" &&
                  /^\d{4}-\d{2}-\d{2}T/.test(row[key]) &&
                  Number.isFinite(+new Date(row[key]))
                ? new Date(row[key])
                : text(row[key]),
          ]),
        ),
      );
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFD71920" },
    };
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd hh:mm";
      });
      row.alignment = { vertical: "top", wrapText: true };
      row.height = 36;
    });
    if (sheet.rows.length)
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: sheet.rows.length + 1, column: keys.length },
      };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function pdf(sheets) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 42, bufferPages: true }),
      chunks = [];
    doc.registerFont(
      "MotaRegular",
      path.join(__dirname, "../assets/fonts/Reporting-Regular.woff"),
    );
    doc.registerFont(
      "MotaBold",
      path.join(__dirname, "../assets/fonts/Reporting-Bold.woff"),
    );
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    let first = true;
    for (const sheet of sheets) {
      if (!first) doc.addPage();
      first = false;
      doc
        .fillColor("#d71920")
        .font("MotaBold")
        .fontSize(20)
        .text(`MOTA - ${sheet.name}`);
      doc.moveDown();
      const chartRows = sheet.rows
        .filter((row) => typeof row.count === "number")
        .slice(0, 8);
      if (chartRows.length) {
        const max = Math.max(1, ...chartRows.map((row) => row.count));
        for (const row of chartRows) {
          const y = doc.y;
          doc
            .fillColor("#333333")
            .font("MotaRegular")
            .fontSize(9)
            .text(text(row._id).slice(0, 40), 42, y, { width: 180 });
          doc
            .fillColor("#d71920")
            .rect(225, y, (230 * row.count) / max, 9)
            .fill();
          doc
            .fillColor("#111111")
            .text(String(row.count), 465, y, { width: 60 });
          doc.y = y + 19;
        }
        doc.x = 42;
        doc.moveDown();
      }
      if (!sheet.rows.length)
        doc
          .fillColor("#333333")
          .font("MotaRegular")
          .fontSize(10)
          .text("No records in this period.");
      for (const row of sheet.rows) {
        for (const [key, value] of Object.entries(row)) {
          const content = `${key}: ${text(value)}`;
          const pieces = content.match(/[\s\S]{1,3000}/g) || [""];
          for (const piece of pieces) {
            if (doc.y > 730) doc.addPage();
            doc
              .fillColor("#111111")
              .font("MotaRegular")
              .fontSize(10)
              .text(piece, 42, doc.y, { width: 510, lineGap: 3 });
          }
        }
        doc.moveDown(0.6);
        if (doc.y > 730) doc.addPage();
      }
    }
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .fillColor("#666666")
        .fontSize(8)
        .text(
          `MOTA confidential report | Page ${i + 1} of ${range.count}`,
          42,
          800,
          { lineBreak: false },
        );
    }
    doc.end();
  });
}
module.exports = { flattenReport, spreadsheet, pdf };

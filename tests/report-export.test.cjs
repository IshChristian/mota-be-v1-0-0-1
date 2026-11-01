const test = require("node:test"),
  assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const exportReport = require("../services/reportExport");
const sheets = [
  {
    name: "Financial summary",
    rows: [
      { metric: "Amount", value: 5000 },
      { metric: "Formula text", value: '=HYPERLINK("https://example.test")' },
    ],
  },
  {
    name: "Records",
    rows: [
      { count: 9, _id: "completed", createdAt: "2026-10-05T10:00:00.000Z" },
      { count: 2, _id: "cancelled", createdAt: "2026-10-04T10:00:00.000Z" },
    ],
  },
];
test("XLSX preserves numeric money, typed dates and treats formula-looking text as plain text", async () => {
  const buf = await exportReport.spreadsheet(sheets);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf);
  assert.equal(workbook.worksheets.length, 2);
  assert.equal(workbook.worksheets[0].getCell("B2").value, 5000);
  assert.equal(typeof workbook.worksheets[0].getCell("B3").value, "string");
  assert.ok(workbook.worksheets[1].getCell("C2").value instanceof Date);
  assert.equal(workbook.worksheets[1].views[0].ySplit, 1);
});
test("PDF exports multiple report sections and handles long metadata", async () => {
  const buf = await exportReport.pdf([
    ...sheets,
    {
      name: "Audit",
      rows: [{ metadata: "Example safe audit data ".repeat(800) }],
    },
  ]);
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buf.length > 2000);
});
test("exports describe the row cap and matching totals", () => {
  const result = exportReport.flattenReport(
    {
      generatedAt: new Date(),
      period: { from: new Date(), to: new Date(), timezone: "Africa/Kigali" },
      coverage: ["Missing history unavailable"],
      sections: {
        users: {
          cards: { Accounts: 5 },
          funnel: { registered: 5 },
          note: "Current state",
        },
      },
    },
    { rows: [{ _id: "a" }], total: 2500 },
  );
  assert.ok(
    result[0].rows.some(
      (row) => row.field === "Matching detail records" && row.value === 2500,
    ),
  );
  assert.ok(
    result[0].rows.some(
      (row) => row.field === "Export cap" && row.value === 2000,
    ),
  );
});

// PDF and Excel renderings of a report section: summary cards, breakdown and up to 2,000 detail rows.
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const flat = (v) => (v == null ? "" : v instanceof Date ? v : typeof v === "object" ? JSON.stringify(v) : v);
const columns = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r)))];

async function xlsx(section, summary, detail) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "MOTA";
    const report = summary.sections[section] || {};
    const s1 = wb.addWorksheet("Summary");
    s1.addRow([`MOTA ${section} report`, `${summary.period.from} – ${summary.period.to} (${summary.period.timezone})`]);
    s1.addRow([report.note || ""]);
    s1.addRow([]);
    s1.addRow(["Metric", "Value"]).font = { bold: true };
    for (const [k, v] of Object.entries(report.cards || {})) s1.addRow([k, typeof v === "number" ? v : flat(v)]);
    if (report.breakdown?.length) {
        s1.addRow([]);
        s1.addRow(["Category", "Count", "Amount (RWF)"]).font = { bold: true };
        for (const r of report.breakdown) s1.addRow([String(r._id), r.count, r.amount ?? ""]);
    }
    s1.columns.forEach((c) => { c.width = 34; });
    const s2 = wb.addWorksheet("Records");
    const cols = columns(detail.rows);
    s2.addRow([`${detail.rows.length} of ${detail.total} matching records (export limit 2,000)`]);
    s2.addRow(cols).font = { bold: true };
    for (const r of detail.rows) s2.addRow(cols.map((c) => flat(r[c])));
    s2.columns.forEach((c) => { c.width = 22; });
    return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdf(section, summary, detail) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: "A4" });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
        const report = summary.sections[section] || {};
        doc.fontSize(18).text(`MOTA ${section} report`);
        doc.fontSize(10).fillColor("#555").text(`${summary.period.from} – ${summary.period.to} (${summary.period.timezone}) · generated ${new Date(summary.generatedAt).toISOString()}`);
        doc.moveDown().fillColor("#000").fontSize(10).text(report.note || "");
        doc.moveDown().fontSize(13).text("Summary");
        doc.fontSize(10);
        for (const [k, v] of Object.entries(report.cards || {})) doc.text(`${k}: ${typeof v === "number" ? v.toLocaleString() : flat(v)}`);
        if (report.breakdown?.length) {
            doc.moveDown().fontSize(13).text("By category");
            doc.fontSize(10);
            for (const r of report.breakdown.slice(0, 40)) doc.text(`${r._id}: ${r.count}${r.amount != null ? ` · ${Number(r.amount).toLocaleString()} RWF` : ""}`);
        }
        doc.moveDown().fontSize(13).text(`Records (${detail.rows.length} of ${detail.total}; limit 2,000)`);
        doc.fontSize(8);
        for (const r of detail.rows) {
            doc.text(Object.entries(r).map(([k, v]) => `${k}: ${v instanceof Date ? v.toISOString() : flat(v)}`).join(" · "), { width: 515 });
        }
        doc.end();
    });
}

module.exports = { xlsx, pdf };

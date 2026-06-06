/**
 * pdf-generator.js
 *
 * Renders schedule and materials PDFs using pdfkit.
 * Called after Claude generates the structured JSON for each document.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// ── Brand colours / fonts ────────────────────────────────────────────────────
const BRAND = {
  primary: '#1a1a2e',   // dark navy
  accent:  '#e94560',   // red
  light:   '#f5f5f5',
  mid:     '#888888',
  black:   '#111111',
};

function makeDoc() {
  return new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
}

function header(doc, clientName, jobTitle, docType) {
  // Top bar
  doc.rect(50, 50, doc.page.width - 100, 3).fill(BRAND.accent);

  doc.moveDown(0.5);
  doc.fontSize(20).fillColor(BRAND.primary).font('Helvetica-Bold')
    .text('CRUZ SERVICES', { align: 'left' });
  doc.fontSize(10).fillColor(BRAND.mid).font('Helvetica')
    .text('General Contractor  ·  Stuart, FL', { align: 'left' });

  doc.moveDown(0.3);
  doc.fontSize(16).fillColor(BRAND.accent).font('Helvetica-Bold')
    .text(docType.toUpperCase(), { align: 'right' });
  doc.fontSize(11).fillColor(BRAND.black).font('Helvetica')
    .text(clientName, { align: 'right' });
  doc.fontSize(10).fillColor(BRAND.mid).font('Helvetica')
    .text(jobTitle, { align: 'right' });
  doc.fontSize(9).fillColor(BRAND.mid)
    .text(`Generated: ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}`, { align: 'right' });

  doc.moveDown(0.5);
  doc.rect(50, doc.y, doc.page.width - 100, 1).fill('#dddddd');
  doc.moveDown(1);
}

function footer(doc) {
  const bottom = doc.page.height - 40;
  doc.fontSize(8).fillColor(BRAND.mid).font('Helvetica')
    .text('AI-generated estimate — review with project manager before distributing to client.',
      50, bottom, { width: doc.page.width - 100, align: 'center' });
}

// ── Schedule PDF ──────────────────────────────────────────────────────────────

function generateSchedulePDF(schedule, clientName, jobTitle, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = makeDoc();
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    header(doc, clientName, jobTitle, 'Project Schedule');

    // Summary box
    doc.roundedRect(50, doc.y, doc.page.width - 100, 44, 4)
       .fill(BRAND.light);
    const boxTop = doc.y - 44 + 10;
    doc.fontSize(10).fillColor(BRAND.mid).font('Helvetica').text('Estimated Duration', 65, boxTop);
    doc.fontSize(16).fillColor(BRAND.primary).font('Helvetica-Bold')
       .text(`${schedule.estimated_duration_weeks} weeks`, 65, boxTop + 14);

    if (schedule.assumptions?.length) {
      doc.moveDown(2.2);
      doc.fontSize(9).fillColor(BRAND.mid).font('Helvetica-Oblique')
         .text('Assumptions: ' + schedule.assumptions.join('  ·  '), { width: doc.page.width - 100 });
    }

    doc.moveDown(1.2);

    // Week rows
    for (const week of (schedule.weeks || [])) {
      if (doc.y > doc.page.height - 150) { doc.addPage(); footer(doc); }

      // Week header row
      doc.rect(50, doc.y, doc.page.width - 100, 22).fill(BRAND.primary);
      doc.fontSize(11).fillColor('white').font('Helvetica-Bold')
         .text(`${week.week}  —  ${week.phase || ''}`, 60, doc.y - 18, { width: doc.page.width - 120 });
      doc.moveDown(0.3);

      // Trades badge
      if (week.trades?.length) {
        doc.fontSize(8).fillColor(BRAND.accent).font('Helvetica-Bold')
           .text('TRADES: ' + week.trades.join(', '), 60, doc.y, { width: doc.page.width - 120 });
        doc.moveDown(0.4);
      }

      // Task list
      for (const task of (week.tasks || [])) {
        if (doc.y > doc.page.height - 80) { doc.addPage(); footer(doc); }
        doc.fontSize(10).fillColor(BRAND.black).font('Helvetica')
           .text(`  •  ${task}`, 60, doc.y, { width: doc.page.width - 120 });
        doc.moveDown(0.35);
      }
      doc.moveDown(0.5);
    }

    // Milestones
    if (schedule.milestones?.length) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.moveDown(0.5);
      doc.rect(50, doc.y, doc.page.width - 100, 1).fill(BRAND.accent);
      doc.moveDown(0.8);
      doc.fontSize(12).fillColor(BRAND.primary).font('Helvetica-Bold').text('KEY MILESTONES');
      doc.moveDown(0.5);
      for (const m of schedule.milestones) {
        doc.fontSize(10).fillColor(BRAND.black).font('Helvetica')
           .text(`  ✓  ${m.name}`, 60, doc.y, { continued: true, width: 300 })
           .fillColor(BRAND.accent).font('Helvetica-Bold')
           .text(`  ${m.week}`, { align: 'left' });
        doc.moveDown(0.4);
      }
    }

    footer(doc);
    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

// ── Materials PDF ─────────────────────────────────────────────────────────────

function generateMaterialsPDF(materials, clientName, jobTitle, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = makeDoc();
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    header(doc, clientName, jobTitle, 'Materials List');

    const categories = materials.categories || [];
    const totalItems = categories.reduce((n, c) => n + (c.items?.length || 0), 0);

    // Summary line
    doc.fontSize(10).fillColor(BRAND.mid).font('Helvetica')
       .text(`${categories.length} categories  ·  ${totalItems} line items`, { align: 'left' });
    doc.moveDown(1);

    for (const cat of categories) {
      if (doc.y > doc.page.height - 130) { doc.addPage(); footer(doc); }

      // Category header
      doc.rect(50, doc.y, doc.page.width - 100, 22).fill(BRAND.primary);
      doc.fontSize(11).fillColor('white').font('Helvetica-Bold')
         .text(cat.name.toUpperCase(), 60, doc.y - 18, { width: doc.page.width - 120 });
      doc.moveDown(0.4);

      // Column headers
      const COL = { item: 60, qty: 340, notes: 410 };
      doc.fontSize(8).fillColor(BRAND.mid).font('Helvetica-Bold')
         .text('ITEM', COL.item, doc.y)
         .text('QTY / UNIT', COL.qty, doc.y - 10)
         .text('NOTES', COL.notes, doc.y - 10);
      doc.moveDown(0.5);
      doc.rect(50, doc.y, doc.page.width - 100, 0.5).fill('#cccccc');
      doc.moveDown(0.4);

      // Items
      let rowAlt = false;
      for (const item of (cat.items || [])) {
        if (doc.y > doc.page.height - 60) { doc.addPage(); footer(doc); }

        const rowH = 18;
        if (rowAlt) doc.rect(50, doc.y, doc.page.width - 100, rowH).fill('#fafafa');
        rowAlt = !rowAlt;

        const yRow = doc.y + 4;
        doc.fontSize(9.5).fillColor(BRAND.black).font('Helvetica')
           .text(item.item || '', COL.item, yRow, { width: 265 });
        doc.fontSize(9).fillColor(BRAND.mid).font('Helvetica')
           .text(`${item.quantity || '—'} ${item.unit || ''}`.trim(), COL.qty, yRow, { width: 65 });
        doc.fontSize(8.5).fillColor(BRAND.mid).font('Helvetica-Oblique')
           .text(item.notes || '', COL.notes, yRow, { width: doc.page.width - COL.notes - 50 });

        doc.moveDown(0.65);
      }
      doc.moveDown(0.7);
    }

    footer(doc);
    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { generateSchedulePDF, generateMaterialsPDF };

import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- PDFKit's CommonJS entry exports the constructor directly.
import PDFDocument = require('pdfkit');

export interface BillingPdfLineInput {
  lineNumber: number;
  eventType: string;
  description: string;
  quantity: number;
  netAmountMinor: number;
  taxAmountMinor: number;
  grossAmountMinor: number;
  currency: string;
}

export interface BillingInvoicePdfInput {
  documentType: 'INVOICE' | 'CREDIT_NOTE';
  documentNumber: string;
  sourceDocumentNumber?: string | null;
  clientCode: string;
  warehouseCode: string;
  currency: string;
  subtotalMinor: number;
  taxTotalMinor: number;
  totalAmountMinor: number;
  periodStart?: Date | string | null;
  periodEnd?: Date | string | null;
  status: string;
  lines: BillingPdfLineInput[];
}

// Geist Regular from the v1.9.2 release. The license is bundled with the font.
const fontPath = join(__dirname, '../../assets/fonts/Geist-Regular.ttf');
const left = 46;
const bottom = 62;
const itemFontSize = 10;
const muted = '#465564';
const ink = '#14202b';

export async function buildBillingPdfBase64(input: BillingInvoicePdfInput): Promise<string> {
  const title = input.documentType.replace('_', ' ');
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 43, left, right: left, bottom },
    autoFirstPage: false,
    bufferPages: true,
    font: fontPath,
    info: { Title: `${title} ${input.documentNumber}` },
  });

  doc.on('pageAdded', () => {
    doc.fillColor(ink).fontSize(20).text(title);
    doc.fontSize(12).text(input.documentNumber);
    doc.moveDown(0.8);
  });
  doc.addPage();
  doc.fillColor(muted).fontSize(10);
  doc.text(`Status: ${input.status}`);
  doc.text(`Client: ${input.clientCode}`);
  doc.text(`Warehouse: ${input.warehouseCode}`);
  doc.text(`Currency: ${input.currency}`);
  if (input.sourceDocumentNumber) doc.text(`Source invoice: ${input.sourceDocumentNumber}`);
  if (input.periodStart && input.periodEnd) {
    doc.text(`Period: ${toIsoDate(input.periodStart)} - ${toIsoDate(input.periodEnd)}`);
  }
  doc.moveDown();
  drawTotals(doc, input);
  doc.moveDown();

  for (const line of input.lines) {
    const details = `${line.lineNumber}.  ${line.eventType}  |  Qty ${line.quantity}  |  Net ${formatMinor(line.netAmountMinor, line.currency)}  |  Tax ${formatMinor(line.taxAmountMinor, line.currency)}  |  Total ${formatMinor(line.grossAmountMinor, line.currency)}`;
    const description = line.description.normalize('NFC');
    const textOptions = { width: doc.page.width - left * 2 };
    doc.fontSize(itemFontSize);
    const itemHeight = doc.heightOfString(details, textOptions) + doc.heightOfString(description, textOptions) + 12;
    if (doc.y + itemHeight > doc.page.height - bottom) doc.addPage();

    doc.strokeColor('#dce2e7').lineWidth(0.5);
    doc.moveTo(left, doc.y).lineTo(doc.page.width - left, doc.y).stroke();
    doc.y += 5;
    doc.fillColor(ink).fontSize(itemFontSize).text(details, textOptions);
    doc.fillColor(muted).text(description, textOptions);
    doc.y += 7;
  }

  const pages = doc.bufferedPageRange();
  for (let page = pages.start; page < pages.start + pages.count; page++) {
    doc.switchToPage(page);
    doc.fillColor(muted).fontSize(9);
    const footer = `Page ${page - pages.start + 1} of ${pages.count}`;
    const x = doc.page.width - left - doc.widthOfString(footer);
    doc.text(footer, x, doc.page.height - 37, { lineBreak: false });
  }

  const contents = buffer(doc);
  doc.end();
  return (await contents).toString('base64');
}

function drawTotals(doc: PDFKit.PDFDocument, input: BillingInvoicePdfInput): void {
  const values = [
    ['Subtotal', input.subtotalMinor],
    ['Tax', input.taxTotalMinor],
    ['Total', input.totalAmountMinor],
  ] as const;
  const gap = 12;
  const width = (doc.page.width - left * 2 - 2 * gap) / values.length;
  const top = doc.y;

  for (const [column, [label, amount]] of values.entries()) {
    const x = left + column * (width + gap);
    doc.rect(x, top, width, 48).fill('#f1f4f6');
    doc.fillColor(muted).fontSize(9).text(label, x + 10, top + 7, { width: width - 20 });
    doc.fillColor(ink).fontSize(13).text(formatMinor(amount, input.currency), x + 10, top + 21, { width: width - 20 });
  }
  doc.x = left;
  doc.y = top + 48;
}

function toIsoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function formatMinor(value: number, currency: string): string {
  return `${(Math.trunc(value) / 100).toFixed(2)} ${currency}`;
}

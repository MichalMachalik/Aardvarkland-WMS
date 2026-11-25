import { renderZpl, validateZplDocument } from '../labels/zpl-renderer.helpers';
import type { LabelLayout } from '../labels/zpl-renderer.helpers';

export interface ShipmentLabelDocument {
  format: 'ZPL' | 'PDF';
  content: string;
}

const layout: LabelLayout = {
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  fields: [
    { type: 'text', x: 6, y: 8, width: 88, height: 8, value: 'Aardvarkland WMS', fontSize: 5 },
    { type: 'text', x: 6, y: 22, width: 88, height: 6, binding: 'reference', fontSize: 3 },
    { type: 'qr', x: 6, y: 38, width: 44, height: 44, binding: 'tracking', moduleSize: 5 },
    { type: 'text', x: 6, y: 96, width: 88, height: 6, binding: 'trackingText', fontSize: 3 },
  ],
};

export function renderShipmentLabel(reference: string, tracking: string): string {
  return renderZpl(layout, { reference: reference.slice(0, 48), tracking, trackingText: tracking.slice(0, 48) }).zpl;
}

export function readStoredLabelDocument(format: string, payload: unknown): ShipmentLabelDocument | null {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['labelData']
    : null;
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (format === 'ZPL') {
    const zpl = value.startsWith('^XA') ? value : Buffer.from(value, 'base64').toString('utf8').trim();
    if (!validateZplDocument(zpl).length) return { format, content: zpl };
  }
  if (format === 'PDF' && Buffer.from(value, 'base64').subarray(0, 5).toString('ascii') === '%PDF-') {
    return { format, content: value };
  }
  return null;
}

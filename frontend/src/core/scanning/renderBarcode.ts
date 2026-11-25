import { code128, datamatrix, drawingSVG, gs1_128, qrcode } from 'bwip-js/generic';
import { svgPreviewDataUri } from './svgPreview';

const encoders = { qr: qrcode, code128, 'gs1-128': gs1_128, datamatrix };
export type BarcodeType = keyof typeof encoders;

export function renderBarcode(type: BarcodeType, text: string, scale: number): string {
  const svg = encoders[type]({
    bcid: type === 'qr' ? 'qrcode' : type,
    text,
    scale,
    includetext: type === 'code128' || type === 'gs1-128',
    textxalign: 'center',
    paddingwidth: 6,
    paddingheight: 6,
  }, drawingSVG());

  return svgPreviewDataUri(svg);
}

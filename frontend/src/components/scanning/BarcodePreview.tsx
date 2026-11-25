import type { BarcodeType } from '../../core/scanning/renderBarcode';
import { useBarcodePreview } from '../../core/scanning/useBarcodePreview';

interface BarcodePreviewProps {
  type: BarcodeType;
  value: string;
  label: string;
  emptyText: string;
  errorText: string;
}

export function BarcodePreview({ type, value, label, emptyText, errorText }: BarcodePreviewProps) {
  const preview = useBarcodePreview(type, value);

  return (
    <article className="barcode-preview" aria-busy={preview.status === 'loading'}>
      <span>{label}</span>
      {preview.status === 'ready' && (
        <div className="barcode-preview__canvas">
          <img src={preview.src} alt={label} />
        </div>
      )}
      {preview.status === 'idle' && <p>{emptyText}</p>}
      {preview.status === 'error' && <p role="status">{errorText}</p>}
    </article>
  );
}

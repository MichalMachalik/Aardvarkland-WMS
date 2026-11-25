import { useEffect, useMemo, useState } from 'react';
import type { BarcodeType } from './renderBarcode';

type Preview = { status: 'idle' | 'loading' | 'error' } | { status: 'ready'; src: string };

export function useBarcodePreview(type: BarcodeType, value: string, scale = 2): Preview {
  const text = value.trim();
  const request = useMemo(() => ({ type, text, scale }), [type, text, scale]);
  const [result, setResult] = useState<{ request: typeof request; src: string | null } | null>(null);

  useEffect(() => {
    if (!request.text) return;
    let active = true;

    void import('./renderBarcode')
      .then(({ renderBarcode }) => {
        if (!active) return;
        const src = renderBarcode(request.type, request.text, request.scale);
        setResult({ request, src });
      })
      .catch(() => {
        if (active) setResult({ request, src: null });
      });

    return () => { active = false; };
  }, [request]);

  if (!text) return { status: 'idle' };
  if (result?.request !== request) return { status: 'loading' };
  return result.src ? { status: 'ready', src: result.src } : { status: 'error' };
}

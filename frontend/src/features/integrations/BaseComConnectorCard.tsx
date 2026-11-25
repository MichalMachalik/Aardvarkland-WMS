import { useState } from 'react';

import { ActionStatus } from '../../components/ops/ActionStatus';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ApiError } from '../../core/api/http';
import { useApiMutation } from '../../core/api/useApiMutation';
import { useApiResource } from '../../core/api/useApiResource';
import { getBaseComConnectorStatus, importBaseComOrder, syncBaseComDispatch } from '../../core/api/wms';
import { pickLanguage } from '../../core/i18n/i18n';
import { useWorkspace } from '../../core/workspace/workspace';

interface ConnectorStatus {
  configured: boolean;
  dispatchSyncConfigured: boolean;
}

type ResultMessage = 'imported' | 'existing' | 'synced' | 'alreadySynced';

const unconfigured: ConnectorStatus = { configured: false, dispatchSyncConfigured: false };

export function BaseComConnectorCard() {
  const { warehouseId, language } = useWorkspace();
  const text = pickLanguage(language, copy);
  const resource = useApiResource({
    fallback: unconfigured,
    loader: () => getBaseComConnectorStatus<ConnectorStatus>(warehouseId),
    map: (payload) => payload as ConnectorStatus,
    dependencies: [warehouseId],
  });
  const mutation = useApiMutation();
  const [value, setValue] = useState('');
  const [result, setResult] = useState<{ message: ResultMessage; orderNumber: string }>();
  const orderId = Number(value);
  const busy = mutation.status === 'running';
  const configured = resource.status === 'live' && resource.data.configured;
  const ready = configured && /^\d+$/.test(value) && orderId > 0 && Number.isSafeInteger(orderId) && !busy;
  const syncReady = ready && resource.data.dispatchSyncConfigured;

  const importOrder = async () => {
    if (!ready) return;
    setResult(undefined);
    const response = await mutation.run(text.importOrder, () =>
      importBaseComOrder<{ created: boolean; order: { orderNumber: string } }>(warehouseId, orderId));
    if (response) setResult({ message: response.created ? 'imported' : 'existing', orderNumber: response.order.orderNumber });
  };
  const syncDispatch = async () => {
    if (!syncReady) return;
    setResult(undefined);
    const response = await mutation.run(text.syncDispatch, async () => {
      try {
        return await syncBaseComDispatch<{ updated: boolean; orderNumber: string }>(warehouseId, orderId);
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 422) throw new Error(text.dispatchRejected);
        throw error;
      }
    });
    if (response) setResult({ message: response.updated ? 'synced' : 'alreadySynced', orderNumber: response.orderNumber });
  };
  const badge = resource.status === 'live' ? (
    <Badge tone={configured ? 'good' : 'neutral'}>{configured ? text.ready : text.notConfigured}</Badge>
  ) : undefined;

  return (
    <Card title="Base.com" className="span-12" action={badge}>
      {resource.status === 'error' && <p className="inline-banner inline-banner--warning" role="alert">{text.loadError}</p>}
      {resource.status === 'live' && !configured && <p className="form-hint">{text.setup}</p>}
      {configured && (
        <form className="stacked-form base-com-order-form" onSubmit={(event) => { event.preventDefault(); void importOrder(); }}>
          <label>
            {text.orderId}
            <input
              value={value}
              inputMode="numeric"
              pattern="[0-9]+"
              maxLength={16}
              autoComplete="off"
              required
              readOnly={busy}
              onChange={(event) => { setValue(event.target.value.trim()); setResult(undefined); mutation.reset(); }}
            />
          </label>
          <div className="form-actions">
            <Button type="submit" tone="primary" disabled={!ready}>{text.importOrder}</Button>
            <Button type="button" disabled={!syncReady} onClick={() => { void syncDispatch(); }}>{text.syncDispatch}</Button>
          </div>
          <p className="form-hint">{resource.data.dispatchSyncConfigured ? text.shippedOnly : text.configureStatus}</p>
          {result && <p className="inline-banner" role="status">{text[result.message]} · <strong>{result.orderNumber}</strong></p>}
          {mutation.status === 'running' && <div role="status"><ActionStatus mutation={mutation} /></div>}
          {mutation.status === 'error' && <div role="alert"><ActionStatus mutation={mutation} /></div>}
        </form>
      )}
    </Card>
  );
}

const copy = {
  cs: {
    ready: 'Připraveno', notConfigured: 'Vyžaduje nastavení', loadError: 'Stav konektoru se nepodařilo načíst.',
    setup: 'API token Base.com se nastavuje na serveru WMS.', orderId: 'ID objednávky v Base.com',
    importOrder: 'Importovat objednávku', syncDispatch: 'Odeslat stav expedice',
    shippedOnly: 'Stav lze odeslat po dokončení expedice ve WMS.',
    dispatchRejected: 'Zkontrolujte, že je objednávka odeslaná ve WMS a potvrzená v Base.com.',
    configureStatus: 'Pro odesílání expedice nastavte na serveru ID cílového stavu v Base.com.',
    imported: 'Objednávka importována do WMS', existing: 'Objednávka už je ve WMS',
    synced: 'Stav expedice odeslán do Base.com', alreadySynced: 'Base.com už má stav expedice',
  },
  en: {
    ready: 'Ready', notConfigured: 'Setup required', loadError: 'Could not load the connector status.',
    setup: 'Configure the Base.com API token on the WMS server.', orderId: 'Base.com order ID',
    importOrder: 'Import order', syncDispatch: 'Send dispatch status',
    shippedOnly: 'Send the status after dispatch is complete in WMS.',
    dispatchRejected: 'Check that the order has shipped in WMS and is confirmed in Base.com.',
    configureStatus: 'Set the Base.com target status ID on the server to enable dispatch updates.',
    imported: 'Order imported into WMS', existing: 'Order already in WMS',
    synced: 'Dispatch status sent to Base.com', alreadySynced: 'Base.com already has the dispatch status',
  },
  ua: {
    ready: 'Готово', notConfigured: 'Потрібне налаштування', loadError: 'Не вдалося завантажити стан підключення.',
    setup: 'Налаштуйте токен API Base.com на сервері WMS.', orderId: 'Ідентифікатор замовлення в Base.com',
    importOrder: 'Імпортувати замовлення', syncDispatch: 'Надіслати статус відправлення',
    shippedOnly: 'Надсилайте статус після завершення відправлення в WMS.',
    dispatchRejected: 'Перевірте, чи замовлення відправлено у WMS і підтверджено в Base.com.',
    configureStatus: 'Для надсилання налаштуйте ідентифікатор цільового статусу Base.com на сервері.',
    imported: 'Замовлення імпортовано до WMS', existing: 'Замовлення вже є у WMS',
    synced: 'Статус відправлення надіслано до Base.com', alreadySynced: 'Base.com уже має статус відправлення',
  },
};

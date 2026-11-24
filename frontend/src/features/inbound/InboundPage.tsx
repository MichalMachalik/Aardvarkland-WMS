import { pickLanguage } from '../../core/i18n/i18n';
import { FormEvent, useRef, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Column, DataTable } from '../../components/ui/DataTable';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { StatusPill } from '../../components/ui/StatusPill';
import { DataSourceBanner } from '../../components/ops/DataSourceBanner';
import { ActionStatus } from '../../components/ops/ActionStatus';
import { useWorkspace } from '../../core/workspace/workspace';
import { useApiMutation } from '../../core/api/useApiMutation';
import { useApiResource } from '../../core/api/useApiResource';
import { createWmsIdempotencyKey, listInboundShipments, receiveInboundShipment } from '../../core/api/wms';
import { mapInboundShipments } from '../../core/api/view-models';
import type { Shipment } from '../../core/types/wms';

const emptyShipments: Shipment[] = [];

export function InboundPage() {
  const { warehouseId } = useWorkspace();
  return <InboundWorkspace key={warehouseId} />;
}

function InboundWorkspace() {
  const { warehouseId, language, can } = useWorkspace();
  const text = pickLanguage(language, { cs: inboundCzech, en: inboundEnglish, ua: inboundUkrainian });
  const resource = useApiResource({ fallback: emptyShipments, productionFallback: emptyShipments, loader: () => listInboundShipments<unknown[]>(warehouseId), map: mapInboundShipments, dependencies: [warehouseId] });
  const mutation = useApiMutation();
  const [latestReceipt, setLatestReceipt] = useState<{ source: Shipment[]; shipment: Shipment }>();
  const sourceRows = latestReceipt?.source === resource.data
    ? resource.data.map((shipment) => shipment.id === latestReceipt.shipment.id ? latestReceipt.shipment : shipment)
    : resource.data;
  const [filter, setFilter] = useState('active');
  const [selectedId, setSelectedId] = useState('');
  const [lineId, setLineId] = useState('');
  const [quantity, setQuantity] = useState('');
  const retryKey = useRef<string | undefined>(undefined);
  const rows = filter === 'all' ? sourceRows : sourceRows.filter((shipment) => shipment.active);
  const selected = rows.find((row) => row.id === selectedId);
  const outstanding = selected?.active ? selected.lines.filter((line) => line.remaining > 0) : [];
  const selectedLine = outstanding.find((line) => line.id === lineId) ?? (outstanding.length === 1 ? outstanding[0] : undefined);
  const amount = Number(quantity);
  const canReceive = ['inbound.manage', 'inventory.move', 'task.manage'].every(can);
  const running = mutation.status === 'running';
  const canSubmit = canReceive && resource.status === 'live' && !running && Boolean(selectedLine)
    && /^\d+$/.test(quantity.trim()) && amount > 0 && amount <= (selectedLine?.remaining ?? 0);

  function clearQuantity() {
    retryKey.current = undefined;
    setQuantity('');
  }

  const columns: Column<Shipment>[] = [
    { key: 'select', label: '', render: (row) => (
      <input type="radio" name="inbound" aria-label={row.number} data-e2e-row="inbound" data-e2e-value={row.number}
        checked={selected?.id === row.id} disabled={running} onChange={() => { setSelectedId(row.id); setLineId(''); clearQuantity(); }} />
    ) },
    { key: 'id', label: 'ASN', render: (row) => <strong>{row.number}</strong> },
    { key: 'supplier', label: text.supplier, render: (row) => row.supplier },
    { key: 'dock', label: text.dock, render: (row) => row.dock ? <Badge>{row.dock}</Badge> : '—' },
    { key: 'eta', label: 'ETA', render: (row) => row.eta },
    { key: 'lines', label: text.lines, align: 'right', render: (row) => row.lines.length },
    { key: 'progress', label: text.progress, render: (row) => <ProgressBar value={row.progress} /> },
    { key: 'status', label: text.status, render: (row) => <StatusPill value={row.status} /> },
  ];
  async function receive(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || !selected || !selectedLine) return;
    const idempotencyKey = retryKey.current ?? createWmsIdempotencyKey('inbound-receipt');
    retryKey.current = idempotencyKey;
    const result = await mutation.run(text.receiveLine, () => receiveInboundShipment<{ shipment: unknown }>(warehouseId, selected.id, {
      lineReference: selectedLine.id,
      quantity: amount,
      qualityStatus: 'PASSED',
      locationReference: selected.dock ?? undefined,
      idempotencyKey,
      metadata: { source: 'storage-ui' },
    }));
    if (result) {
      const [shipment] = mapInboundShipments([result.shipment]);
      if (shipment) setLatestReceipt({ source: resource.data, shipment });
      clearQuantity();
      resource.refresh();
    }
  }

  function changeFilter(value: string) {
    setFilter(value);
    setSelectedId('');
    setLineId('');
    clearQuantity();
  }

  return (
    <div className="page-grid">
      <div className="span-12"><DataSourceBanner label={text.banner} resource={resource} /></div>
      <Card title={text.title} className="span-8" action={
        <div className="segmented">
          <button type="button" aria-pressed={filter === 'active'} className={filter === 'active' ? 'is-active' : ''} disabled={running} onClick={() => changeFilter('active')}>{text.active}</button>
          <button type="button" aria-pressed={filter === 'all'} className={filter === 'all' ? 'is-active' : ''} disabled={running} onClick={() => changeFilter('all')}>{text.all}</button>
        </div>
      }>
        <DataTable rows={rows} columns={columns} getRowKey={(row) => row.id} emptyTitle={text.emptyTitle} emptyText={text.emptyText} />
      </Card>
      {canReceive && <Card title={text.controlTitle} className="span-4">
        {selected && <p className="muted-copy">{text.selectedAsn} <strong>{selected.number}</strong></p>}
        {outstanding.length > 0 ? (
          <form className="action-panel" aria-label={text.controlTitle} onSubmit={receive}>
            <label>{text.line}
              <select data-testid="inbound-line-reference" value={selectedLine?.id ?? ''} disabled={running} required
                onChange={(event) => { setLineId(event.target.value); clearQuantity(); }}>
                <option value="" disabled>{text.chooseLine}</option>
                {outstanding.map((line) => <option key={line.id} value={line.id}>{line.number} · {line.sku}</option>)}
              </select>
            </label>
            {selectedLine && <p className="muted-copy" aria-live="polite">{text.remaining} <strong>{selectedLine.remaining}</strong></p>}
            <label>{text.quantity}
              <input data-testid="inbound-quantity" type="number" min={1} max={selectedLine?.remaining}
                step={1} inputMode="numeric" required value={quantity} disabled={!selectedLine || running}
                onChange={(event) => { retryKey.current = undefined; setQuantity(event.target.value); }} />
            </label>
            <Button tone="primary" type="submit" data-e2e-action="inbound-receive" disabled={!canSubmit}>{text.receiveLine}</Button>
          </form>
        ) : <p className="muted-copy">{selected ? text.nothingToReceive : text.chooseShipment}</p>}
        <ActionStatus mutation={mutation} />
      </Card>}
    </div>
  );
}

const inboundCzech = {
  banner: 'API příjmu',
  title: 'Příjem',
  supplier: 'Dodavatel',
  dock: 'Rampa',
  lines: 'Řádků',
  progress: 'Průběh',
  status: 'Stav',
  emptyTitle: 'Žádné příjmy',
  emptyText: 'Server zatím nevrátil žádné příjmy zboží.',
  active: 'Aktivní',
  all: 'Vše',
  controlTitle: 'Přijmout řádek',
  selectedAsn: 'Vybrané ASN',
  line: 'Řádek',
  chooseLine: 'Vyberte řádek',
  chooseShipment: 'Vyberte příjem v tabulce.',
  remaining: 'Zbývá přijmout',
  nothingToReceive: 'V tomto příjmu už není co přijmout.',
  quantity: 'Množství',
  receiveLine: 'Přijmout řádek',
};

const inboundEnglish = {
  banner: 'Receiving API',
  title: 'Receiving',
  supplier: 'Supplier',
  dock: 'Dock',
  lines: 'Lines',
  progress: 'Progress',
  status: 'Status',
  emptyTitle: 'No receiving',
  emptyText: 'The server has not returned any receiving shipments yet.',
  active: 'Active',
  all: 'All',
  controlTitle: 'Receive line',
  selectedAsn: 'Selected ASN',
  line: 'Line',
  chooseLine: 'Choose a line',
  chooseShipment: 'Select a shipment in the table.',
  remaining: 'Remaining to receive',
  nothingToReceive: 'No items remain to be received on this shipment.',
  quantity: 'Quantity',
  receiveLine: 'Receive line',
};

const inboundUkrainian = {
  banner: 'API приймання',
  title: 'Приймання',
  supplier: 'Постач.',
  dock: 'Рампа',
  lines: 'Рядків',
  progress: 'Прогрес',
  status: 'Стан',
  emptyTitle: 'Немає приймань',
  emptyText: 'Сервер поки не повернув жодного приймання товару.',
  active: 'Активні',
  all: 'Усі',
  controlTitle: 'Прийняти рядок',
  selectedAsn: 'Вибране ASN',
  line: 'Рядок',
  chooseLine: 'Виберіть рядок',
  chooseShipment: 'Виберіть відправлення в таблиці.',
  remaining: 'Залишилося прийняти',
  nothingToReceive: 'У цьому відправленні більше немає товарів для приймання.',
  quantity: 'Кількість',
  receiveLine: 'Прийняти рядок',
};

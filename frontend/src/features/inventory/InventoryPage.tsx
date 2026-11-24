import { pickLanguage } from '../../core/i18n/i18n';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Column, DataTable } from '../../components/ui/DataTable';
import { StatusPill } from '../../components/ui/StatusPill';
import { DataSourceBanner } from '../../components/ops/DataSourceBanner';
import { ActionStatus } from '../../components/ops/ActionStatus';
import { useWorkspace } from '../../core/workspace/workspace';
import { useApiMutation } from '../../core/api/useApiMutation';
import { useApiResource } from '../../core/api/useApiResource';
import { adjustInventoryStock, createWmsIdempotencyKey, listStockQuants, moveInventoryStock, receiveInventoryStock } from '../../core/api/wms';
import { mapStockQuants } from '../../core/api/view-models';
import type { StockQuant } from '../../core/types/wms';
import { numberFormat } from '../../core/utils/format';

const emptyStockQuants: StockQuant[] = [];

export function InventoryPage() {
  const { warehouseId, warehouse, language, can } = useWorkspace();
  const text = pickLanguage(language, { cs: czech, en: english, ua: ukrainian });
  const resource = useApiResource({ fallback: emptyStockQuants, productionFallback: emptyStockQuants, loader: () => listStockQuants<unknown[]>(warehouseId), map: mapStockQuants, dependencies: [warehouseId] });
  const mutation = useApiMutation();
  const sourceRows = resource.data;
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(sourceRows[0]?.id ?? '');
  const [quantity, setQuantity] = useState('1');
  const [targetLocation, setTargetLocation] = useState('');
  const canMove = can('inventory.move');
  const canAdjust = can('inventory.adjust');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sourceRows;
    return sourceRows.filter((quant) => `${quant.sku} ${quant.product} ${quant.location} ${quant.lot} ${quant.client}`.toLowerCase().includes(q));
  }, [query, sourceRows]);
  const activeRow = sourceRows.find((row) => row.id === selectedId) ?? sourceRows[0];
  const selected = rows.find((row) => row.id === activeRow?.id);

  const columns: Column<StockQuant>[] = [
    { key: 'select', label: '', render: (row) => <input className="radio-input" type="radio" name="quant" aria-label={[row.sku, row.location, row.lot].filter(Boolean).join(' · ')} data-e2e-row="quant" data-e2e-value={`${row.id} ${row.sku}`} checked={selected?.id === row.id} onChange={() => setSelectedId(row.id)} /> },
    { key: 'sku', label: 'SKU', render: (row) => <div><strong>{row.sku}</strong><small>{row.product}</small></div> },
    { key: 'location', label: text.columns.location, render: (row) => <Badge>{row.location}</Badge> },
    { key: 'lot', label: text.columns.lot, render: (row) => row.lot || '-' },
    { key: 'available', label: text.columns.available, align: 'right', render: (row) => numberFormat(row.available) },
    { key: 'reserved', label: text.columns.reserved, align: 'right', render: (row) => numberFormat(row.reserved) },
    { key: 'status', label: text.columns.status, render: (row) => <StatusPill value={row.status} /> },
    { key: 'client', label: text.columns.owner, render: (row) => row.client || '-' },
  ];

  const totalAvailable = sourceRows.reduce((sum, quant) => sum + quant.available, 0);
  const reserved = sourceRows.reduce((sum, quant) => sum + quant.reserved, 0);
  const blocked = sourceRows.filter((row) => row.status === 'Blocked' || row.status === 'Quarantine').length;
  const parsedQuantity = Number(quantity);
  const validQuantity = Number.isSafeInteger(parsedQuantity) && parsedQuantity >= 1 && parsedQuantity <= 2147483647;
  const normalizedTargetLocation = targetLocation.trim();
  const targetIsCurrentLocation = Boolean(selected && normalizedTargetLocation && normalizedTargetLocation.toLowerCase() === selected.location.toLowerCase());
  const tooManyToMove = Boolean(selected && validQuantity && parsedQuantity > selected.available);
  const moveHint = targetIsCurrentLocation ? text.sameLocationHint : normalizedTargetLocation && tooManyToMove ? text.overAvailableHint : '';
  const canSubmit = Boolean(selected && validQuantity && mutation.status !== 'running');

  const afterMutation = async (label: string, action: () => Promise<unknown>) => {
    const result = await mutation.run(label, action);
    if (result) resource.refresh();
  };

  const receive = () => {
    if (!selected || !canMove || !canSubmit) return;
    void afterMutation(text.actions.receive, () => receiveInventoryStock(warehouseId, {
      skuReference: selected.sku,
      locationReference: selected.location,
      quantity: parsedQuantity,
      status: 'AVAILABLE',
      reference: createWmsIdempotencyKey('storage-ui-receive-ref'),
      idempotencyKey: createWmsIdempotencyKey('storage-receive'),
      metadata: { source: 'storage-ui' },
    }));
  };

  const move = () => {
    if (!selected || !canMove || !canSubmit || !normalizedTargetLocation || moveHint) return;
    void afterMutation(text.actions.move, () => moveInventoryStock(warehouseId, {
      quantReference: selected.id,
      toLocationReference: normalizedTargetLocation,
      quantity: parsedQuantity,
      status: 'AVAILABLE',
      reason: text.reasons.move,
      idempotencyKey: createWmsIdempotencyKey('storage-move'),
      metadata: { source: 'storage-ui' },
    }));
  };

  const adjust = () => {
    if (!selected || !canAdjust || !canSubmit) return;
    void afterMutation(text.actions.adjust, () => adjustInventoryStock(warehouseId, {
      quantReference: selected.id,
      quantityDelta: parsedQuantity,
      reasonCode: 'MANUAL_CORRECTION',
      reason: text.reasons.adjust,
      reference: createWmsIdempotencyKey('storage-adjust-ref'),
      idempotencyKey: createWmsIdempotencyKey('storage-adjust'),
      metadata: { source: 'storage-ui' },
    }));
  };

  return (
    <div className="page-grid page-grid--tight inventory-minimal-page">
      <section className="wms-page-intro span-12">
        <div>
          <h1>{text.title}</h1>
          <span>{warehouse.label}</span>
        </div>
        <div className="wms-page-intro__actions">
          {blocked > 0 && <Badge tone="warning">{text.blocked} {numberFormat(blocked)}</Badge>}
        </div>
      </section>

      {resource.status === 'error' && <div className="span-12"><DataSourceBanner label={text.banner} resource={resource} /></div>}

      <Card
        title={text.tableTitle}
        className="span-8"
        action={<input className="search-input" type="search" data-testid="inventory-search" aria-label={text.searchPlaceholder} placeholder={text.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />}
      >
        <dl className="inventory-summary">
          <div><dt>{text.columns.available}</dt><dd>{numberFormat(totalAvailable)}</dd></div>
          <div><dt>{text.columns.reserved}</dt><dd>{numberFormat(reserved)}</dd></div>
        </dl>
        <DataTable rows={rows} columns={columns} getRowKey={(row) => row.id}
          emptyTitle={query.trim() ? text.noResults : text.emptyTitle}
          emptyText={query.trim() ? text.changeSearch : text.emptyText} />
      </Card>

      <Card title={text.detailTitle} className="span-4 detail-card">
        <div className="stock-detail">
          <div className="stock-detail__header">
            <div>
              {selected ? <><strong>{selected.sku}</strong><small>{selected.product} · {selected.location}</small></> : <span>{text.noSelection}</span>}
            </div>
            {selected && <StatusPill value={selected.status} />}
          </div>

          {selected && (canMove || canAdjust) && <form className="action-panel" aria-label={text.detailTitle} onSubmit={(event) => event.preventDefault()}>
            <label>{text.fields.quantity}<input data-testid="inventory-quantity" type="number" min="1" max="2147483647" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
            {canMove && <label>{text.fields.targetLocation}<input data-testid="inventory-target-location" value={targetLocation} onChange={(event) => setTargetLocation(event.target.value)} placeholder={text.fields.targetPlaceholder} aria-describedby={moveHint ? 'inventory-move-hint' : undefined} /></label>}
            {moveHint && <p id="inventory-move-hint" className="form-hint">{moveHint}</p>}
            <div className="button-row">
              {canMove && <Button type="button" tone="primary" data-e2e-action="inventory-move" disabled={!canSubmit || !normalizedTargetLocation || Boolean(moveHint)} onClick={move}>{text.buttons.move}</Button>}
              {canMove && <Button type="button" tone="secondary" data-e2e-action="inventory-receive" disabled={!canSubmit} onClick={receive}>{text.buttons.receive}</Button>}
              {canAdjust && <Button type="button" tone="secondary" data-e2e-action="inventory-adjust" disabled={!canSubmit} onClick={adjust}>{text.buttons.adjust}</Button>}
            </div>
            <ActionStatus mutation={mutation} />
          </form>}
        </div>
      </Card>

    </div>
  );
}

const czech = {
  title: 'Zásoby',
  blocked: 'Blokované položky',
  banner: 'API zásob',
  tableTitle: 'Položky',
  searchPlaceholder: 'Hledat SKU, lokaci nebo šarži...',
  detailTitle: 'Vybraná položka',
  noSelection: 'Není vybraná žádná zásoba',
  emptyTitle: 'Žádné zásoby',
  emptyText: 'Server zatím nevrátil žádné zásoby.',
  noResults: 'Žádné výsledky',
  changeSearch: 'Zkuste jiné SKU, lokaci nebo šarži.',
  columns: { location: 'Lokace', lot: 'Šarže', available: 'Dostupné', reserved: 'Rezervované', status: 'Stav', owner: 'Vlastník' },
  fields: { quantity: 'Množství', targetLocation: 'Cílová lokace', targetPlaceholder: 'Např. A-01-01' },
  sameLocationHint: 'Zadejte jinou cílovou lokaci.',
  overAvailableHint: 'Zadejte množství, které je v této lokaci dostupné.',
  buttons: { receive: 'Přijmout zásobu', move: 'Přesunout', adjust: 'Upravit +ks' },
  actions: { receive: 'Přijmout zásobu', move: 'Přesunout zásobu', adjust: 'Upravit zásobu' },
  reasons: { move: 'Přesun zásoby z jednoduchého UI', adjust: 'Ruční korekce z jednoduchého UI' },
};

const english = {
  title: 'Inventory',
  blocked: 'Blocked items',
  banner: 'Inventory API',
  tableTitle: 'Items',
  searchPlaceholder: 'Search SKU, location, or lot...',
  detailTitle: 'Selected item',
  noSelection: 'No stock is selected',
  emptyTitle: 'No inventory',
  emptyText: 'The server has not returned any inventory yet.',
  noResults: 'No results',
  changeSearch: 'Try a different SKU, location, or lot.',
  columns: { location: 'Location', lot: 'Lot', available: 'Available', reserved: 'Reserved', status: 'Status', owner: 'Owner' },
  fields: { quantity: 'Quantity', targetLocation: 'Target location', targetPlaceholder: 'For example A-01-01' },
  sameLocationHint: 'Enter a different target location.',
  overAvailableHint: 'Enter a quantity available at this location.',
  buttons: { receive: 'Receive stock', move: 'Move', adjust: 'Adjust +pcs' },
  actions: { receive: 'Receive stock', move: 'Move stock', adjust: 'Adjust stock' },
  reasons: { move: 'Stock movement from the simple UI', adjust: 'Manual correction from the simple UI' },
};

const ukrainian = {
  title: 'Запаси',
  blocked: 'Заблоковані позиції',
  banner: 'API запасів',
  tableTitle: 'Позиції',
  searchPlaceholder: 'Шукати SKU, локацію або партію...',
  detailTitle: 'Вибрана позиція',
  noSelection: 'Не вибрано жодного запасу',
  emptyTitle: 'Немає запасів',
  emptyText: 'Сервер поки не повернув жодних запасів.',
  noResults: 'Немає результатів',
  changeSearch: 'Спробуйте інший SKU, локацію або партію.',
  columns: { location: 'Локація', lot: 'Партія', available: 'Доступно', reserved: 'Резерв', status: 'Стан', owner: 'Власник' },
  fields: { quantity: 'Кількість', targetLocation: 'Цільова локація', targetPlaceholder: 'Напр. A-01-01' },
  sameLocationHint: 'Введіть іншу цільову локацію.',
  overAvailableHint: 'Введіть кількість, доступну в цій локації.',
  buttons: { receive: 'Прийняти запас', move: 'Перемістити', adjust: 'Корекція +шт' },
  actions: { receive: 'Прийняти запас', move: 'Перемістити запас', adjust: 'Коригувати запас' },
  reasons: { move: 'Переміщення запасу з простого UI', adjust: 'Ручна корекція з простого UI' },
};

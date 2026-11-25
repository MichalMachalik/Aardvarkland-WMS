import { pickLanguage } from '../../core/i18n/i18n';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Column, DataTable } from '../../components/ui/DataTable';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { StatusPill } from '../../components/ui/StatusPill';
import { DataSourceBanner } from '../../components/ops/DataSourceBanner';
import { ActionStatus } from '../../components/ops/ActionStatus';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useWorkspace, type Language } from '../../core/workspace/workspace';
import { useApiMutation } from '../../core/api/useApiMutation';
import { useApiResource } from '../../core/api/useApiResource';
import { allocateOutboundOrder, listOutboundOrders, releasePicking } from '../../core/api/wms';
import { mapOutboundOrders } from '../../core/api/view-models';
import type { Order } from '../../core/types/wms';

const emptyOrders: Order[] = [];
const allocationStatuses = new Set<Order['status']>(['Draft', 'New', 'Allocated', 'Exception']);

function priorityLabel(priority: Order['priority'], language: Language): string {
  if (language === 'fr' || language === 'de' || language === 'es') {
    return pickLanguage(language, {
      cs: priorityLabel(priority, 'cs'),
      en: priorityLabel(priority, 'en'),
      ua: priorityLabel(priority, 'ua'),
    });
  }
  if (language === 'en') return priority;
  if (language === 'ua') {
    if (priority === 'Rush') return 'Терміново';
    if (priority === 'High') return 'Високий';
    if (priority === 'Low') return 'Низький';
    return 'Норма';
  }
  if (priority === 'Rush') return 'Urgentní';
  if (priority === 'High') return 'Vysoká';
  if (priority === 'Low') return 'Nízká';
  return 'Normální';
}

export function OutboundPage() {
  const { warehouseId } = useWorkspace();
  return <OutboundWorkspace key={warehouseId} />;
}

function OutboundWorkspace() {
  const { warehouseId, language, can } = useWorkspace();
  const text = pickLanguage(language, { cs: czech, en: english, ua: ukrainian });
  const resource = useApiResource({ fallback: emptyOrders, productionFallback: emptyOrders, loader: () => listOutboundOrders<unknown[]>(warehouseId), map: mapOutboundOrders, dependencies: [warehouseId] });
  const mutation = useApiMutation();
  const sourceRows = resource.data;
  const [filter, setFilter] = useState('active');
  const [selectedId, setSelectedId] = useState('');
  const [refreshingFrom, setRefreshingFrom] = useState<Order[]>();
  const rows = useMemo(() => {
    if (filter === 'all') return sourceRows;
    if (filter === 'shipped') return sourceRows.filter((order) => order.status === 'Shipped');
    return sourceRows.filter((order) => !['Shipped', 'Cancelled'].includes(order.status));
  }, [filter, sourceRows]);
  const selected = rows.find(order => order.id === selectedId);
  const mayAllocate = can('outbound.manage');
  const mayRelease = mayAllocate || can('fulfillment.manage');
  const ready = resource.status === 'live' && mutation.status !== 'running' && refreshingFrom !== sourceRows;
  const canAllocate = ready && selected && mayAllocate && allocationStatuses.has(selected.status);
  const canRelease = ready && selected?.status === 'Allocated' && mayRelease;
  const columns: Column<Order>[] = [
    { key: 'select', label: '', render: (row) => <input type="radio" name="order" aria-label={row.orderNumber}
      data-e2e-row="order" data-e2e-value={row.orderNumber} checked={selected?.id === row.id}
      disabled={mutation.status === 'running'} onChange={() => { setSelectedId(row.id); mutation.reset(); }} /> },
    { key: 'id', label: text.columns.order, render: (row) => <strong>{row.orderNumber}</strong> },
    { key: 'channel', label: text.columns.channel, render: (row) => row.channel || '-' },
    { key: 'priority', label: text.columns.priority, render: (row) => <Badge tone={row.priority === 'Rush' ? 'critical' : row.priority === 'High' ? 'warning' : 'neutral'}>{priorityLabel(row.priority, language)}</Badge> },
    { key: 'status', label: text.columns.status, render: (row) => <StatusPill value={row.status} /> },
    { key: 'lines', label: text.columns.lines, align: 'right', render: (row) => row.lines },
    { key: 'wave', label: text.columns.wave, render: (row) => row.wave || '-' },
    { key: 'cutoff', label: text.columns.deadline, render: (row) => row.cutoff || '-' },
  ];
  const allocated = sourceRows.filter((order) => ['Allocated', 'Picking', 'Picked', 'Packing', 'Packed'].includes(order.status)).length;
  const progress = sourceRows.length ? Math.round((sourceRows.filter((order) => order.status === 'Shipped').length / sourceRows.length) * 100) : 0;
  function refreshAfterWrite() {
    setRefreshingFrom(sourceRows);
    resource.refresh();
  }

  async function allocate() {
    if (!selected || !canAllocate) return;
    const result = await mutation.run(text.allocateAction, () => allocateOutboundOrder(warehouseId, selected.id, {
      allocationStrategy: 'FEFO', metadata: { source: 'storage-ui' },
    }));
    if (result) refreshAfterWrite();
  }

  async function release() {
    if (!selected || !canRelease) return;
    await mutation.run(text.releaseAction, () => releasePicking(warehouseId, selected.id, {
      metadata: { source: 'storage-ui' },
    }));
    refreshAfterWrite();
  }

  return (
    <div className="page-grid">
      <div className="span-12"><DataSourceBanner label={text.banner} resource={resource} /></div>
      <Card
        title={text.tableTitle}
        className="span-8"
        action={<SegmentedControl value={filter} onChange={setFilter} options={[{ value: 'active', label: text.filters.active }, { value: 'all', label: text.filters.all }, { value: 'shipped', label: text.filters.shipped }]} />}
      >
        <DataTable rows={rows} columns={columns} getRowKey={(row) => row.id} emptyTitle={text.emptyTitle} emptyText={text.emptyText} />
      </Card>
      <Card title={text.allocationTitle} className="span-4">
        <div className="metric-stack">
          <article><span>{text.selectedOrder}</span><strong>{selected?.orderNumber ?? '—'}</strong></article>
          <article><span>{text.allocated}</span><strong>{allocated}</strong></article>
          <article><span>{text.shippingProgress}</span><strong>{progress}%</strong><ProgressBar value={progress} /></article>
        </div>
        <div className="action-panel">
          {mayAllocate && <Button tone="primary" data-e2e-action="outbound-allocate-selected" disabled={!canAllocate} onClick={() => { void allocate(); }}>{text.allocateButton}</Button>}
          {mayRelease && <Button tone="secondary" data-e2e-action="outbound-release-picking" disabled={!canRelease} onClick={() => { void release(); }}>{text.releaseButton}</Button>}
          <Button tone="secondary" data-e2e-action="outbound-open-packing" onClick={() => { window.location.hash = '/packing'; }}>{text.openPacking}</Button>
          <ActionStatus mutation={mutation} />
        </div>
      </Card>
    </div>
  );
}

const czech = {
  banner: 'API expedice',
  tableTitle: 'Objednávky',
  allocationTitle: 'Alokace',
  selectedOrder: 'Vybraná objednávka',
  allocated: 'Alokováno / pickuje se',
  shippingProgress: 'Průběh odeslání',
  allocateButton: 'Alokovat vybranou',
  allocateAction: 'Alokovat objednávku',
  releaseButton: 'Uvolnit picking',
  releaseAction: 'Uvolnit picking',
  openPacking: 'Otevřít balení',
  emptyTitle: 'Žádné objednávky',
  emptyText: 'Server zatím nevrátil žádné objednávky.',
  filters: { active: 'Aktivní', all: 'Vše', shipped: 'Odeslané' },
  columns: { order: 'Objednávka', channel: 'Kanál', priority: 'Priorita', status: 'Stav', lines: 'Řádků', wave: 'Vlna', deadline: 'Termín' },
};

const english = {
  banner: 'Shipping API',
  tableTitle: 'Orders',
  allocationTitle: 'Allocation',
  selectedOrder: 'Selected order',
  allocated: 'Allocated / picking',
  shippingProgress: 'Shipping progress',
  allocateButton: 'Allocate selected',
  allocateAction: 'Allocate order',
  releaseButton: 'Release picking',
  releaseAction: 'Release picking',
  openPacking: 'Open packing',
  emptyTitle: 'No orders',
  emptyText: 'The server has not returned any orders yet.',
  filters: { active: 'Active', all: 'All', shipped: 'Shipped' },
  columns: { order: 'Order', channel: 'Channel', priority: 'Priority', status: 'Status', lines: 'Lines', wave: 'Wave', deadline: 'Deadline' },
};

const ukrainian = {
  banner: 'API експедиції',
  tableTitle: 'Замовлення',
  allocationTitle: 'Алокація',
  selectedOrder: 'Вибране замовлення',
  allocated: 'Алоковано / відбір',
  shippingProgress: 'Прогрес відправки',
  allocateButton: 'Алокувати вибране',
  allocateAction: 'Алокувати замовлення',
  releaseButton: 'Відкрити відбір',
  releaseAction: 'Відкрити відбір',
  openPacking: 'Відкрити пакування',
  emptyTitle: 'Немає замовлень',
  emptyText: 'Сервер поки не повернув жодних замовлень.',
  filters: { active: 'Активні', all: 'Усі', shipped: 'Відправлені' },
  columns: { order: 'Замовлення', channel: 'Канал', priority: 'Пріоритет', status: 'Стан', lines: 'Рядків', wave: 'Хвиля', deadline: 'Термін' },
};

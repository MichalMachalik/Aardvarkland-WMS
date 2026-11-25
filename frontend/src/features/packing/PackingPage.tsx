import { FormEvent, useRef, useState } from 'react';
import { ActionStatus } from '../../components/ops/ActionStatus';
import { DataSourceBanner } from '../../components/ops/DataSourceBanner';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ProgressBar } from '../../components/ui/ProgressBar';
import { StatusPill } from '../../components/ui/StatusPill';
import { useApiMutation } from '../../core/api/useApiMutation';
import { useApiResource } from '../../core/api/useApiResource';
import {
  addShipmentPackage, createShipment, createWmsIdempotencyKey, generateShipmentLabel, getShipmentLabelDocument,
  listOutboundOrders, listPackingStations, listPrinters, listShipmentPackages, listShipments, printShipmentLabel,
  resolveScan, shipShipment, stageShipment,
} from '../../core/api/wms';
import { pickLanguage } from '../../core/i18n/i18n';
import { useWorkspace } from '../../core/workspace/workspace';

interface PackingLine {
  id: string;
  lineNumber: string;
  sku: string;
  pickedQuantity: number;
}

interface PackingOrder {
  id: string;
  orderNumber: string;
  lines: PackingLine[];
}

interface Shipment {
  id: string;
  shipmentNumber: string;
  status: string;
  labelRequired: boolean;
}

interface PackageContent {
  outboundOrderLineId: string | null;
  sku: string;
  quantity: number;
}

interface PackedPackage {
  id: string;
  packageCode: string;
  shipmentId: string;
  labelReady: boolean;
  label: ShipmentLabel | null;
  status: string;
  trackingNumber: string | null;
  contents: PackageContent[];
}

interface ShipmentLabel {
  id: string;
  reference: string;
  format: string;
  status: string;
  printStatus: string | null;
}

interface PrinterChoice {
  code: string;
  name: string;
}

interface PackingDetails {
  shipments: Shipment[];
  packages: PackedPackage[];
  station?: { id: string };
}

type PackingText = typeof english;
const emptyOrders: PackingOrder[] = [];
const emptyDetails: PackingDetails = { shipments: [], packages: [] };
const emptyPrinters: PrinterChoice[] = [];
const shipmentStatuses: Record<string, string> = {
  DRAFT: 'Draft', PACKING: 'Packing', STAGED: 'Ready',
  LOADING: 'In progress', SHIPPED: 'Shipped', EXCEPTION: 'Exception',
};
const pendingPrintStatuses = new Set(['QUEUED', 'CLAIMED', 'PRINTING']);

function saveLabelDocument(documentData: { reference: string; format: 'ZPL' | 'PDF'; content: string }) {
  const pdf = documentData.format === 'PDF';
  const content = pdf ? Uint8Array.from(atob(documentData.content), character => character.charCodeAt(0)) : documentData.content;
  const url = URL.createObjectURL(new Blob([content], { type: pdf ? 'application/pdf' : 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = documentData.reference.replace(/[^a-z0-9.-]/gi, '-') + (pdf ? '.pdf' : '.zpl');
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PackingPage() {
  const { warehouseId } = useWorkspace();
  return <PackingWorkspace key={warehouseId} />;
}

function PackingWorkspace() {
  const { warehouseId, language } = useWorkspace();
  const text = pickLanguage(language, { cs: czech, en: english, ua: ukrainian });
  const [orderId, setOrderId] = useState('');
  const [shippedOrder, setShippedOrder] = useState('');
  const orders = useApiResource({
    fallback: emptyOrders,
    loader: async () => {
      const groups = await Promise.all(['PICKED', 'PACKING', 'PACKED'].map(status =>
        listOutboundOrders<PackingOrder[]>(warehouseId, { status }),
      ));
      return groups.flat().filter(order => order.lines?.some(line => line.pickedQuantity > 0));
    },
    map: payload => payload as PackingOrder[],
    dependencies: [warehouseId],
    refreshIntervalMs: 15000,
  });
  const selectedOrder = orders.data.find(order => order.id === orderId);

  function shipped() {
    setShippedOrder(selectedOrder?.orderNumber ?? '');
    setOrderId(current => current === selectedOrder?.id ? '' : current);
    orders.refresh();
  }

  return (
    <div className="page-grid">
      <div className="span-12"><DataSourceBanner label={text.banner} resource={orders} /></div>
      <Card title={text.title} className="span-12">
        <label>{text.order}
          <select value={selectedOrder?.id ?? ''} onChange={event => {
            setOrderId(event.target.value);
            setShippedOrder('');
          }}>
            <option value="">{text.chooseOrder}</option>
            {orders.data.map(order => <option key={order.id} value={order.id}>{order.orderNumber}</option>)}
          </select>
        </label>
        {shippedOrder && <p role="status">{text.shipped} · {shippedOrder}</p>}
      </Card>
      {selectedOrder && <PackingWork key={selectedOrder.id} order={selectedOrder} text={text} onShipped={shipped} />}
    </div>
  );
}

function packedQuantities(packages: PackedPackage[]) {
  const quantities = new Map<string, number>();
  for (const pack of packages) {
    for (const line of pack.contents) {
      if (line.outboundOrderLineId) {
        quantities.set(line.outboundOrderLineId, (quantities.get(line.outboundOrderLineId) ?? 0) + line.quantity);
      }
    }
  }
  return quantities;
}

function PackingWork({ order, text, onShipped }: { order: PackingOrder; text: PackingText; onShipped: () => void }) {
  const { warehouseId, can } = useWorkspace();
  const mutation = useApiMutation();
  const [shipmentId, setShipmentId] = useState('');
  const [scan, setScan] = useState('');
  const [scanError, setScanError] = useState('');
  const [scans, setScans] = useState<Record<string, number>>({});
  const [weight, setWeight] = useState('');
  const [printerCode, setPrinterCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [refreshingFrom, setRefreshingFrom] = useState<PackingDetails>();
  const scanInFlight = useRef(false);
  const packageCode = useRef('');
  const printKeys = useRef(new Map<string, string>());
  const scanInput = useRef<HTMLInputElement>(null);
  const details = useApiResource({
    fallback: emptyDetails,
    loader: async () => {
      const [allShipments, stations] = await Promise.all([
        listShipments<Shipment[]>(warehouseId, { outboundOrderReference: order.id }),
        listPackingStations<Array<{ id: string; status: string }>>(warehouseId),
      ]);
      const shipments = allShipments.filter(shipment => shipment.status !== 'CANCELLED');
      const packages = (await Promise.all(shipments.map(shipment =>
        listShipmentPackages<PackedPackage[]>(warehouseId, shipment.id, { take: 200 }),
      ))).flat().filter(pack => pack.status !== 'CANCELLED');
      return { shipments, packages, station: stations.find(station => station.status === 'ACTIVE') };
    },
    map: payload => payload as PackingDetails,
    dependencies: [warehouseId, order.id],
    refreshIntervalMs: 15000,
  });

  const { shipments, packages, station } = details.data;
  const shipment = shipments.find(item => item.id === shipmentId) ?? (shipments.length === 1 ? shipments[0] : undefined);
  const currentPackages = packages.filter(pack => pack.shipmentId === shipment?.id);
  const canDownload = can('label.read');
  const canPrint = can('label.print');
  const showPrinters = canPrint && canDownload && currentPackages.some(pack => pack.label?.format === 'ZPL');
  const printers = useApiResource({
    fallback: emptyPrinters,
    enabled: showPrinters,
    loader: () => listPrinters<PrinterChoice[]>(warehouseId),
    map: payload => payload as PrinterChoice[],
    dependencies: [warehouseId],
  });
  const selectedPrinter = printers.data.find(printer => printer.code === printerCode);
  const packedByLine = packedQuantities(packages);
  const shipmentPackedByLine = packedQuantities(currentPackages);
  const lines = order.lines.filter(line => line.pickedQuantity > 0).map(line => {
    const packed = packedByLine.get(line.id) ?? 0;
    const scanned = scans[line.id] ?? 0;
    return { ...line, packed, scanned, remaining: Math.max(0, line.pickedQuantity - packed) };
  });
  const pickedTotal = lines.reduce((sum, line) => sum + line.pickedQuantity, 0);
  const packedTotal = lines.reduce((sum, line) => sum + Math.min(line.pickedQuantity, line.packed), 0);
  const ready = can('shipment.manage') && details.status === 'live'
    && refreshingFrom !== details.data && mutation.status !== 'running';
  const canWrite = ready && !scanning;
  const openShipment = shipment ? ['DRAFT', 'PACKING'].includes(shipment.status) : shipments.length === 0;
  const hasUnpackedItems = lines.some(line => line.remaining > 0);
  const scanEnabled = ready && openShipment && lines.some(line => line.scanned < line.remaining);
  const canScan = scanEnabled && !scanning;
  const weightGrams = Number(weight);
  const validWeight = !weight || (/^\d+$/.test(weight.trim()) && weightGrams > 0 && weightGrams <= 2_147_483_647);
  const readyToPackage = canWrite && openShipment && validWeight && lines.some(line => line.scanned > 0)
    && lines.every(line => line.scanned <= line.remaining);
  const needsLabels = Boolean(shipment?.labelRequired && currentPackages.some(pack => !pack.labelReady));
  const packedHere = lines.length > 0 && lines.every(line => (shipmentPackedByLine.get(line.id) ?? 0) >= line.pickedQuantity);
  const canShip = canWrite && shipment && ['DRAFT', 'PACKING', 'STAGED', 'LOADING'].includes(shipment.status)
    && currentPackages.length > 0 && packedHere && !needsLabels;

  function resetScans() {
    setScans({});
    setScan('');
    setScanError('');
    packageCode.current = '';
  }

  function refresh() {
    setRefreshingFrom(details.data);
    details.refresh();
  }

  async function submitScan(event: FormEvent) {
    event.preventDefault();
    const value = scan.trim();
    if (!canScan || !value || scanInFlight.current) return;
    scanInFlight.current = true;
    setScanning(true);
    setScanError('');
    try {
      let sku = value.toUpperCase();
      if (!lines.some(line => line.sku.toUpperCase() === sku)) {
        const { resolved } = await resolveScan<{ resolved: { objectType: string | null; code: string | null } }>(warehouseId, {
          scannedValue: value,
        });
        sku = resolved.objectType === 'SKU' ? resolved.code?.toUpperCase() ?? '' : '';
      }
      const matched = lines.filter(line => line.sku.toUpperCase() === sku);
      const next = matched.find(line => line.scanned < line.remaining);
      if (!next) setScanError(matched.length ? text.scanFull : text.wrongSku);
      else {
        setScans(current => ({ ...current, [next.id]: (current[next.id] ?? 0) + 1 }));
        packageCode.current = '';
      }
      setScan('');
    } catch {
      setScanError(text.scanUnavailable);
    } finally {
      scanInFlight.current = false;
      setScanning(false);
      scanInput.current?.focus();
    }
  }

  async function ensureShipment() {
    if (shipment) return shipment;
    const shipmentNumber = 'PACK-' + order.id.toUpperCase();
    try {
      return await createShipment<Shipment>(warehouseId, {
        shipmentNumber,
        outboundOrderReference: order.id,
        packingStationReference: station?.id,
      });
    } catch (error) {
      const current = await listShipments<Shipment[]>(warehouseId, { outboundOrderReference: order.id });
      const saved = current.find(item => item.shipmentNumber === shipmentNumber);
      if (saved) return saved;
      throw error;
    }
  }

  async function savePackage(event: FormEvent) {
    event.preventDefault();
    if (!readyToPackage) return;
    const code = packageCode.current || createWmsIdempotencyKey('BOX').toUpperCase();
    packageCode.current = code;
    const saved = await mutation.run(text.createPackage, async () => {
      const target = await ensureShipment();
      setShipmentId(target.id);
      try {
        return await addShipmentPackage<PackedPackage>(warehouseId, target.id, {
          packageCode: code,
          weightGrams: weight ? weightGrams : undefined,
          contents: lines.filter(line => line.scanned > 0).map(line => ({
            outboundOrderLineReference: line.id,
            sku: line.sku,
            quantity: line.scanned,
          })),
        });
      } catch (error) {
        const current = await listShipmentPackages<PackedPackage[]>(warehouseId, target.id);
        const savedPackage = current.find(pack => pack.packageCode === code);
        if (savedPackage) return savedPackage;
        throw error;
      }
    });
    if (saved) {
      resetScans();
      setWeight('');
    }
    refresh();
  }

  async function createLabel(pack: PackedPackage) {
    if (!canWrite || !shipment || pack.shipmentId !== shipment.id || pack.labelReady) return;
    await mutation.run(text.generateLabel, () => generateShipmentLabel(warehouseId, shipment.id, {
      packageReference: pack.id,
      labelFormat: 'ZPL',
    }));
    refresh();
  }

  async function downloadLabel(label: ShipmentLabel) {
    if (!shipment || !canDownload) return;
    await mutation.run(text.downloadLabel, async () => {
      const result = await getShipmentLabelDocument<{ reference: string; format: 'ZPL' | 'PDF'; content: string }>(warehouseId, shipment.id, label.id);
      saveLabelDocument(result);
      return result;
    });
  }

  async function queueLabel(label: ShipmentLabel) {
    if (!shipment || !canPrint || !selectedPrinter || !canWrite || printers.status !== 'live'
      || pendingPrintStatuses.has(label.printStatus ?? '')) return;
    const intent = label.id + ':' + selectedPrinter.code;
    const key = printKeys.current.get(intent) ?? createWmsIdempotencyKey('shipment-label-print');
    printKeys.current.set(intent, key);
    const job = await mutation.run(text.printLabel, () => printShipmentLabel(warehouseId, shipment.id, label.id, {
      printerCode: selectedPrinter.code,
      idempotencyKey: key,
    }));
    if (job) printKeys.current.delete(intent);
    refresh();
  }

  async function ship() {
    if (!canShip || !shipment) return;
    const result = await mutation.run(text.send, async () => {
      if (['DRAFT', 'PACKING'].includes(shipment.status)) await stageShipment(warehouseId, shipment.id);
      return shipShipment(warehouseId, shipment.id);
    });
    if (result) onShipped();
    else refresh();
  }

  return (
    <>
      <Card title={text.items} className="span-7">
        <DataSourceBanner label={text.banner} resource={details} />
        <ProgressBar value={pickedTotal ? Math.round(packedTotal / pickedTotal * 100) : 0} />
        <div className="packing-lines">
          {lines.map(line => (
            <article key={line.id}>
              <div><strong>{line.sku}</strong><p>{text.line} {line.lineNumber}</p></div>
              <span>{text.scanned} {line.scanned}</span>
              <strong>{line.packed}/{line.pickedQuantity}</strong>
            </article>
          ))}
        </div>
        {openShipment && hasUnpackedItems && <form className="action-panel" onSubmit={submitScan}>
          <label>{text.scan}
            <input ref={scanInput} data-testid="packing-scan-input" value={scan}
              onChange={event => setScan(event.target.value)} disabled={!scanEnabled} readOnly={scanning} autoComplete="off" />
          </label>
          <Button type="submit" disabled={!canScan || !scan.trim()}>{text.confirmScan}</Button>
          {scanError && <p role="alert">{scanError}</p>}
        </form>}
      </Card>
      <Card title={text.shipment} className="span-5">
        {shipments.length > 1 ? (
          <label>{text.shipment}
            <select value={shipment?.id ?? ''} disabled={!canWrite} onChange={event => {
              setShipmentId(event.target.value);
              resetScans();
              setWeight('');
            }}>
              <option value="">{text.chooseShipment}</option>
              {shipments.map(item => <option key={item.id} value={item.id}>{item.shipmentNumber}</option>)}
            </select>
          </label>
        ) : shipment && <p><strong>{shipment.shipmentNumber}</strong> <StatusPill value={shipmentStatuses[shipment.status] ?? shipment.status} /></p>}
        {openShipment && hasUnpackedItems && can('shipment.manage') && (
          <form className="action-panel" onSubmit={savePackage}>
            <label>{text.weight}
              <input type="number" min="1" max="2147483647" step="1" inputMode="numeric" value={weight}
                disabled={!canWrite} onChange={event => { setWeight(event.target.value); packageCode.current = ''; }} />
            </label>
            <Button tone="primary" type="submit" disabled={!readyToPackage}>{text.createPackage}</Button>
            <Button type="button" disabled={!canWrite || !Object.values(scans).some(Boolean)} onClick={resetScans}>{text.clearScans}</Button>
          </form>
        )}
        {showPrinters && (
          <div className="action-panel">
            <DataSourceBanner label={text.printer} resource={printers} />
            <label>{text.printer}
              <select value={selectedPrinter?.code ?? ''} disabled={mutation.status === 'running'} onChange={event => setPrinterCode(event.target.value)}>
                <option value="">{text.choosePrinter}</option>
                {printers.data.map(printer => <option key={printer.code} value={printer.code}>{printer.name} · {printer.code}</option>)}
              </select>
            </label>
          </div>
        )}
        <div className="packing-lines">
          {currentPackages.map(pack => {
            const label = pack.label;
            const pending = pendingPrintStatuses.has(label?.printStatus ?? '');
            return (
            <article key={pack.id}>
              <div><strong>{pack.packageCode}</strong>{pack.labelReady && pack.trackingNumber && <p>{pack.trackingNumber}</p>}</div>
              {label ? (
                <div className="action-panel">
                  <span role="status">{label.status === 'PRINTED' ? text.labelPrinted : text.labelReady}</span>
                  {pending && <p>{text.printQueued}</p>}
                  {label.printStatus === 'FAILED' && <p>{text.printFailed}</p>}
                  {canDownload && ['ZPL', 'PDF'].includes(label.format) && (
                    <Button size="sm" disabled={mutation.status === 'running'} onClick={() => { void downloadLabel(label); }}>{text.downloadLabel}</Button>
                  )}
                  {showPrinters && label.format === 'ZPL' && (
                    <Button size="sm" disabled={!canWrite || printers.status !== 'live' || !selectedPrinter || pending}
                      onClick={() => { void queueLabel(label); }}>{label.status === 'PRINTED' ? text.reprintLabel : text.printLabel}</Button>
                  )}
                </div>
              ) : shipment?.labelRequired && (
                <Button size="sm" disabled={!canWrite} onClick={() => { void createLabel(pack); }}>{text.generateLabel}</Button>
              )}
            </article>
            );
          })}
        </div>
        {shipment && can('shipment.manage') && (
          <div className="action-panel">
            <Button tone="primary" disabled={!canShip} onClick={() => { void ship(); }}>{text.send}</Button>
            {currentPackages.length > 0 && !packedHere && <p className="muted-copy">{text.finishPacking}</p>}
          </div>
        )}
        <ActionStatus mutation={mutation} />
      </Card>
    </>
  );
}

const czech = {
  banner: 'Balení a doprava', title: 'Balení', order: 'Objednávka', chooseOrder: 'Vyberte objednávku k balení',
  items: 'Položky k balení', line: 'Řádek', scanned: 'Naskenováno', scan: 'SKU nebo čárový kód',
  confirmScan: 'Potvrdit sken', scanFull: 'Všechny kusy této položky už jsou započtené.',
  wrongSku: 'Kód nepatří k vybrané objednávce.', scanUnavailable: 'Kód se nepodařilo ověřit.',
  shipment: 'Zásilka', chooseShipment: 'Vyberte zásilku', weight: 'Hmotnost balíku v g (volitelně)',
  createPackage: 'Vytvořit balík', clearScans: 'Zrušit skeny', labelReady: 'Štítek připraven',
  generateLabel: 'Vygenerovat štítek', send: 'Odeslat zásilku', shipped: 'Odesláno',
  printer: 'Tiskárna', choosePrinter: 'Vyberte tiskárnu', downloadLabel: 'Stáhnout štítek',
  printLabel: 'Zařadit štítek k tisku', reprintLabel: 'Vytisknout štítek znovu', labelPrinted: 'Štítek vytištěn',
  printQueued: 'Čeká na potvrzení tisku', printFailed: 'Tisk štítku selhal',
  finishPacking: 'Před odesláním musí být všechny vychystané položky v této zásilce.',
};

const english = {
  banner: 'Packing and shipping', title: 'Packing', order: 'Order', chooseOrder: 'Select an order to pack',
  items: 'Items to pack', line: 'Line', scanned: 'Scanned', scan: 'SKU or barcode',
  confirmScan: 'Confirm scan', scanFull: 'All units of this item have already been counted.',
  wrongSku: 'This code does not belong to the selected order.', scanUnavailable: 'Could not verify the code.',
  shipment: 'Shipment', chooseShipment: 'Select a shipment', weight: 'Package weight in g (optional)',
  createPackage: 'Create package', clearScans: 'Clear scans', labelReady: 'Label ready',
  generateLabel: 'Generate label', send: 'Ship shipment', shipped: 'Shipped',
  printer: 'Printer', choosePrinter: 'Select a printer', downloadLabel: 'Download label',
  printLabel: 'Queue label for printing', reprintLabel: 'Print label again', labelPrinted: 'Label printed',
  printQueued: 'Waiting for print confirmation', printFailed: 'Label printing failed',
  finishPacking: 'All picked items must be in this shipment before dispatch.',
};

const ukrainian = {
  banner: 'Пакування та відправлення', title: 'Пакування', order: 'Замовлення', chooseOrder: 'Виберіть замовлення для пакування',
  items: 'Позиції для пакування', line: 'Рядок', scanned: 'Відскановано', scan: 'SKU або штрихкод',
  confirmScan: 'Підтвердити сканування', scanFull: 'Усі одиниці цієї позиції вже враховано.',
  wrongSku: 'Цей код не належить до вибраного замовлення.', scanUnavailable: 'Не вдалося перевірити код.',
  shipment: 'Відправлення', chooseShipment: 'Виберіть відправлення', weight: 'Вага посилки в г (необов’язково)',
  createPackage: 'Створити посилку', clearScans: 'Очистити сканування', labelReady: 'Етикетка готова',
  generateLabel: 'Згенерувати етикетку', send: 'Відправити', shipped: 'Відправлено',
  printer: 'Принтер', choosePrinter: 'Виберіть принтер', downloadLabel: 'Завантажити етикетку',
  printLabel: 'Поставити етикетку в чергу друку', reprintLabel: 'Надрукувати етикетку знову', labelPrinted: 'Етикетку надруковано',
  printQueued: 'Очікується підтвердження друку', printFailed: 'Не вдалося надрукувати етикетку',
  finishPacking: 'Перед відправленням усі відібрані позиції мають бути в цьому відправленні.',
};

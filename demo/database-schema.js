const svg = document.getElementById('diagram');
const edgesLayer = document.getElementById('edges-layer');
const nodesLayer = document.getElementById('nodes-layer');
const details = document.getElementById('details');
const breadcrumbs = document.getElementById('breadcrumbs');
const tableSearch = document.getElementById('table-search');
const tableOptions = document.getElementById('table-options');
const diagramCount = document.getElementById('diagram-count');
const groupFilter = document.getElementById('group-filter');
const groupFilterControl = document.getElementById('group-filter-control');
const loading = document.getElementById('loading');
const stage = document.getElementById('diagram-stage');
const languageToggle = document.querySelector('[data-language-toggle]');
const themeButton = document.querySelector('[data-theme-toggle]');
const guide = document.getElementById('order-guide');
const diagramView = document.getElementById('diagram-view');
const viewButtons = document.querySelectorAll('[data-schema-view]');
const stepButtons = guide.querySelectorAll('[data-guide-step]');
const guideCards = document.getElementById('guide-cards');
const guideSteps = [
  ['OutboundOrder', 'OutboundOrderLine'],
  ['OutboundOrderLine', 'PackageContent', 'ShipmentPackage'],
  ['ShipmentPackage', 'Shipment'],
];
const guideCopy = {
  en: {
    presentationTitle: 'How an order leaves the warehouse',
    presentationIntro: 'Aardvarkland WMS helps warehouse teams track stock, find items in the right location, and check what went into each parcel.',
    viewChoice: 'Choose a view', guideView: 'Follow an order', diagramView: 'Explore the database',
    guideStages: 'Order stages', guidePicking: '1. Picking', guidePacking: '2. Packing', guideDispatch: '3. Dispatch',
    tryOrder: 'Try sample order', sampleOrderNote: 'DEMO-1042 uses fictional data and simulates scanning and shipping.',
    openGuideTable: (name) => `Explore ${name} in the database diagram`,
    steps: [
      ['Pick the items', 'The order says what needs to leave the warehouse. Each line tells the worker which product to pick and how many units to take.'],
      ['Pack the order', 'The warehouse records what goes into each parcel and which order line it came from.'],
      ['Hand the shipment to the carrier', 'A shipment groups the parcels the warehouse hands over to the carrier.'],
    ],
    cards: {
      OutboundOrder: ['Order', 'Groups the items the customer ordered.'],
      OutboundOrderLine: ['Order line', 'Records one product and the quantity ordered.'],
      PackageContent: ['Parcel contents', 'Records how many units from an order line went into a parcel.'],
      ShipmentPackage: ['Parcel', 'Represents one physical parcel ready to ship.'],
      Shipment: ['Shipment', 'Groups the parcels that ship together.'],
    },
  },
  cs: {
    presentationTitle: 'Jak objednávka opouští sklad',
    presentationIntro: 'Aardvarkland WMS pomáhá skladu evidovat zboží, najít ho na správné pozici a zkontrolovat, co odešlo v každém balíku.',
    viewChoice: 'Výběr zobrazení', guideView: 'Ukázat cestu objednávky', diagramView: 'Prozkoumat databázi',
    guideStages: 'Kroky objednávky', guidePicking: '1. Vychystání', guidePacking: '2. Balení', guideDispatch: '3. Expedice',
    tryOrder: 'Vyzkoušet objednávku', sampleOrderNote: 'DEMO-1042 používá fiktivní data. Skenování a expedice jsou simulované.',
    openGuideTable: (name) => `Zobrazit tabulku ${name} v databázovém diagramu`,
    steps: [
      ['Vychystání zboží', 'Objednávka říká, co má ze skladu odejít. Její položky říkají, který produkt a kolik kusů má pracovník vychystat.'],
      ['Zabalení objednávky', 'U každého balíku víme, co je uvnitř a ke které položce objednávky to patří.'],
      ['Předání dopravci', 'Zásilka sdružuje balíky, které sklad předá dopravci.'],
    ],
    cards: {
      OutboundOrder: ['Objednávka', 'Sdružuje položky, které si zákazník objednal.'],
      OutboundOrderLine: ['Položka objednávky', 'Eviduje jeden produkt a objednaný počet kusů.'],
      PackageContent: ['Obsah balíku', 'Eviduje, kolik kusů z položky objednávky skončilo v balíku.'],
      ShipmentPackage: ['Balík', 'Představuje jeden fyzický balík připravený k odeslání.'],
      Shipment: ['Zásilka', 'Sdružuje balíky, které se odesílají společně.'],
    },
  },
};
const requestedTable = new URLSearchParams(location.search).get('table');
let guideStep = 0;
const translations = {
  en: {
    metaDescription: 'Interactive diagram of tables and relationships in the Aardvarkland WMS database.', pageName: 'Database diagram', backLink: '← Back to WMS preview',
    eyebrow: 'DATA MODEL · POSTGRESQL', title: 'Database diagram', lede: 'Explore the tables and relationships behind the WMS. Select a table to open its connected group in the same diagram.',
    searchPlaceholder: 'Find a table…', diagramAria: 'Interactive database diagram', pathAria: 'Diagram path', overview: 'Overview', zoomOut: 'Zoom out', zoomIn: 'Zoom in', fitDiagram: 'Fit diagram to view', showOverview: 'Show overview',
    diagramSvgAria: 'Connected tables in the WMS database', loading: 'Loading table relationships…', solidLegend: 'Schema-defined relationship', dashedLegend: 'ID-field reference', panHint: 'Click and drag anywhere on the diagram to pan · use buttons to zoom',
    howToRead: 'HOW TO READ THE DIAGRAM', startOverview: 'Start with the overview', readIntro: 'Each box represents a database table. Lines show relationships between tables. Select a box to open its connected group; select another table to continue exploring.',
    readRelationships: 'Solid lines represent relationships defined in the schema. Dashed lines represent references inferred from ID fields that are not declared as database foreign keys.', footerGenerated: 'Generated from the current WMS data model.', footerNote: 'Shows database structure, not live warehouse records.',
    switchToDark: 'Switch to dark mode', switchToLight: 'Switch to light mode', switchToCzech: 'Switch language to Czech', switchToEnglish: 'Switch language to English', overviewCount: (visible, total) => `${visible} overview tables · ${total} total`, relatedCount: (visible, total) => `${visible} connected tables · ${total} total`,
    noRelationships: 'No direct relationships', connected: 'connected tables', columns: 'columns', expanded: 'EXPANDED GROUP', directRelationships: 'Direct relationships', noDirect: 'This table has no direct relationships.',
    solidHelp: 'Solid line: relationship defined in the database schema.', dashedHelp: 'Dashed line: reference inferred from an ID field.', openTable: (name) => `Open relationships for ${name}`,
    groupFilter: 'Group', allGroups: 'All groups', filteredCount: (visible, group, total) => `${visible} tables · ${group} · ${total} total`,
    openRelationship: (label, name) => `Open ${name} via ${label}`,
    groups: {},
  },
  cs: {
    metaDescription: 'Interaktivní diagram tabulek a jejich vazeb v databázi Aardvarkland WMS.', pageName: 'Databázový diagram', backLink: '← Zpět do WMS preview',
    eyebrow: 'DATOVÝ MODEL · POSTGRESQL', title: 'Databázový diagram', lede: 'Prozkoumejte tabulky a jejich vazby ve WMS. Výběrem tabulky otevřete její propojenou skupinu ve stejném diagramu.',
    searchPlaceholder: 'Najít tabulku…', diagramAria: 'Interaktivní diagram databáze', pathAria: 'Cesta diagramem', overview: 'Přehled', zoomOut: 'Oddálit', zoomIn: 'Přiblížit', fitDiagram: 'Přizpůsobit diagram výřezu', showOverview: 'Zobrazit přehled',
    diagramSvgAria: 'Propojené tabulky databáze WMS', loading: 'Načítám vazby mezi tabulkami…', solidLegend: 'Vazba definovaná ve schématu', dashedLegend: 'Odkaz přes pole ID', panHint: 'Tažením myší posunete diagram · přiblížení nastavíte tlačítky',
    howToRead: 'JAK ČÍST DIAGRAM', startOverview: 'Začněte přehledem', readIntro: 'Každý rámeček představuje databázovou tabulku. Čáry znázorňují vazby mezi tabulkami. Výběrem rámečku otevřete propojenou skupinu; výběrem další tabulky můžete pokračovat.',
    readRelationships: 'Plné čáry označují vazby definované ve schématu. Přerušované čáry označují odkazy odvozené z polí ID, které nejsou deklarované jako cizí klíče.', footerGenerated: 'Diagram se generuje z aktuálního datového modelu WMS.', footerNote: 'Zobrazuje strukturu databáze, nikoli aktuální skladové záznamy.',
    switchToDark: 'Přepnout na tmavý režim', switchToLight: 'Přepnout na světlý režim', switchToCzech: 'Přepnout jazyk na češtinu', switchToEnglish: 'Přepnout jazyk na angličtinu', overviewCount: (visible, total) => `${visible} hlavních tabulek · ${total} celkem`, relatedCount: (visible, total) => `${visible} propojených tabulek · ${total} celkem`,
    noRelationships: 'Žádné přímé vazby', connected: 'propojených tabulek', columns: 'sloupců', expanded: 'ROZBALENÁ SKUPINA', directRelationships: 'Přímé vazby', noDirect: 'Tato tabulka nemá žádné přímé vazby.',
    solidHelp: 'Plná čára: vazba definovaná v databázovém schématu.', dashedHelp: 'Přerušovaná čára: odkaz odvozený z pole ID.', openTable: (name) => `Otevřít vazby tabulky ${name}`,
    groupFilter: 'Skupina', allGroups: 'Všechny skupiny', filteredCount: (visible, group, total) => `${visible} tabulek · ${group} · ${total} celkem`,
    openRelationship: (label, name) => `Otevřít tabulku ${name} přes vazbu ${label}`,
    groups: { 'Billing': 'Fakturace', 'People and clients': 'Lidé a klienti', 'Warehouse layout': 'Uspořádání skladu', 'Receiving and quality': 'Příjem a kvalita', 'Fulfillment': 'Vyskladnění a expedice', 'Products and inventory': 'Produkty a zásoby', 'Warehouse operations': 'Skladové operace', 'Integrations and events': 'Integrace a události', 'Security and access': 'Zabezpečení a přístupy', 'Supporting records': 'Podpůrné záznamy' },
  },
};
const overviewSize = { width: 1800, height: 920 };
const diagramScale = 0.68;
const overviewPositions = {
  Warehouse: { x: 800, y: 58 },
  WarehouseLocation: { x: 210, y: 220 },
  InboundShipment: { x: 520, y: 220 },
  OutboundOrder: { x: 850, y: 220 },
  Product: { x: 1340, y: 220 },
  InboundShipmentLine: { x: 450, y: 500 },
  OutboundOrderLine: { x: 650, y: 500 },
  Reservation: { x: 850, y: 500 },
  Shipment: { x: 1050, y: 500 },
  Sku: { x: 1340, y: 500 },
  StockQuant: { x: 220, y: 800 },
  ShipmentPackage: { x: 1050, y: 800 },
  PackageContent: { x: 1290, y: 800 },
  StockMovement: { x: 1570, y: 800 },
};
const overviewLabels = {
  'Warehouse>WarehouseLocation': 'has locations',
  'Warehouse>InboundShipment': 'receives',
  'Warehouse>OutboundOrder': 'processes',
  'Warehouse>StockMovement': 'tracks movements',
  'WarehouseLocation>StockQuant': 'holds stock',
  'InboundShipment>InboundShipmentLine': 'contains lines',
  'OutboundOrder>OutboundOrderLine': 'contains lines',
  'OutboundOrder>Reservation': 'reserves stock',
  'Reservation>StockQuant': 'draws from stock',
  'OutboundOrder>Shipment': 'can create shipment',
  'Shipment>ShipmentPackage': 'contains packages',
  'ShipmentPackage>PackageContent': 'contains items',
  'OutboundOrderLine>PackageContent': 'references order line',
  'Product>Sku': 'has variants',
  'Sku>StockQuant': 'is held in stock',
  'Sku>StockMovement': 'has movements',
};
const overviewLabelsCs = {
  'Warehouse>WarehouseLocation': 'má skladové pozice', 'Warehouse>InboundShipment': 'přijímá', 'Warehouse>OutboundOrder': 'zpracovává', 'Warehouse>StockMovement': 'eviduje pohyby',
  'WarehouseLocation>StockQuant': 'obsahuje zásoby', 'InboundShipment>InboundShipmentLine': 'obsahuje položky', 'OutboundOrder>OutboundOrderLine': 'obsahuje položky',
  'OutboundOrder>Reservation': 'rezervuje zásoby', 'Reservation>StockQuant': 'čerpá ze zásob', 'OutboundOrder>Shipment': 'může vytvořit zásilku',
  'Shipment>ShipmentPackage': 'obsahuje balíky', 'ShipmentPackage>PackageContent': 'obsahuje položky', 'Product>Sku': 'má varianty',
  'OutboundOrderLine>PackageContent': 'odkazuje na položku objednávky',
  'Sku>StockQuant': 'je vedena v zásobách', 'Sku>StockMovement': 'má pohyby',
};
const overviewRoutes = {
  'Warehouse>WarehouseLocation': { d: 'M800 92 V137 H210 V186', x: 505, y: 128 },
  'Warehouse>InboundShipment': { d: 'M800 92 V158 H520 V186', x: 660, y: 149 },
  'Warehouse>OutboundOrder': { d: 'M800 92 V166 H850 V186', x: 828, y: 158 },
  'Warehouse>StockMovement': { d: 'M895 58 H1740 V800 H1665', x: 1645, y: 435 },
  'WarehouseLocation>StockQuant': { d: 'M210 254 V766', x: 137, y: 495 },
  'InboundShipment>InboundShipmentLine': { d: 'M520 254 V466 H450', x: 520, y: 354 },
  'OutboundOrder>OutboundOrderLine': { d: 'M800 254 V352 H650 V466', x: 718, y: 341 },
  'OutboundOrder>Reservation': { d: 'M850 254 V466', x: 923, y: 365 },
  'OutboundOrder>Shipment': { d: 'M900 254 V333 H1050 V466', x: 981, y: 322 },
  'Reservation>StockQuant': { d: 'M850 534 V710 H220 V766', x: 540, y: 700 },
  'Shipment>ShipmentPackage': { d: 'M1050 534 V766', x: 1138, y: 644 },
  'ShipmentPackage>PackageContent': { d: 'M1145 800 H1195', x: 1170, y: 778 },
  'OutboundOrderLine>PackageContent': { d: 'M745 500 H780 V860 H1195 V800', x: 985, y: 860 },
  'Product>Sku': { d: 'M1340 254 V466', x: 1417, y: 357 },
  'Sku>StockQuant': { d: 'M1245 534 V681 H220 V766', x: 704, y: 670 },
  'Sku>StockMovement': { d: 'M1435 534 V646 H1570 V766', x: 1503, y: 636 },
};
const shortLabels = {
  'Warehouse>WarehouseLocation': 'has locations',
  'Warehouse>InboundShipment': 'receives',
  'Warehouse>OutboundOrder': 'processes',
  'Warehouse>StockMovement': 'tracks movements',
  'WarehouseLocation>StockQuant': 'holds stock',
  'InboundShipment>InboundShipmentLine': 'contains lines',
  'OutboundOrder>OutboundOrderLine': 'contains lines',
  'OutboundOrder>Reservation': 'reserves stock',
  'Reservation>StockQuant': 'reserves quantity',
  'OutboundOrder>Shipment': 'hands off for shipping',
  'Shipment>ShipmentPackage': 'contains packages',
  'ShipmentPackage>PackageContent': 'contains items',
  'Product>Sku': 'has variants',
  'Sku>StockQuant': 'is held in stock',
  'Sku>StockMovement': 'has movements',
};
const shortLabelsCs = { ...overviewLabelsCs, 'Reservation>StockQuant': 'rezervuje množství', 'OutboundOrder>Shipment': 'předává k expedici' };
const fieldLabels = {
  warehouseId: 'warehouse', ownerClientId: 'client', clientId: 'client', orderId: 'order', outboundOrderId: 'order',
  inboundShipmentId: 'inbound shipment', shipmentId: 'shipment', packageId: 'package', outboundOrderLineId: 'order line',
  skuId: 'SKU', stockQuantId: 'stock quantity', reservationId: 'reservation', taskId: 'task', warehouseTaskId: 'task',
  assignedUserId: 'assigned user', actorUserId: 'user', userId: 'user', createdByUserId: 'created by user',
  locationId: 'location', currentLocationId: 'current location', dockLocationId: 'dock location',
  fromLocationId: 'source location', toLocationId: 'destination location', parentId: 'parent table',
  handlingUnitId: 'handling unit', parcelId: 'parcel', serialNumberId: 'serial number', lotId: 'lot',
  integrationId: 'integration', roleId: 'role', permissionId: 'permission', rateCardId: 'rate card',
};
const fieldLabelsCs = {
  warehouseId: 'sklad', ownerClientId: 'vlastník / klient', clientId: 'klient', orderId: 'objednávka', outboundOrderId: 'objednávka',
  inboundShipmentId: 'příjemka', shipmentId: 'zásilka', packageId: 'balík', outboundOrderLineId: 'položka objednávky', skuId: 'SKU',
  stockQuantId: 'zásoba', reservationId: 'rezervace', taskId: 'úkol', warehouseTaskId: 'skladový úkol', assignedUserId: 'přiřazený pracovník',
  actorUserId: 'uživatel', userId: 'uživatel', createdByUserId: 'vytvořil uživatel', locationId: 'pozice', currentLocationId: 'aktuální pozice',
  dockLocationId: 'pozice rampy', fromLocationId: 'výchozí pozice', toLocationId: 'cílová pozice', parentId: 'nadřazená tabulka',
  handlingUnitId: 'manipulační jednotka', parcelId: 'balík', serialNumberId: 'sériové číslo', lotId: 'šarže', integrationId: 'integrace',
  roleId: 'role', permissionId: 'oprávnění', rateCardId: 'ceník',
};

let models = [];
let edges = [];
let modelByName = new Map();
let currentModel = null;
let pathStack = [];
let isOverview = true;
let view = { ...overviewSize, x: 0, y: 0, zoom: 1 };
let panStart = null;
let suppressDiagramClick = false;
let language = (() => { try { return localStorage.getItem('wms-schema-language') === 'cs' ? 'cs' : 'en'; } catch { return 'en'; } })();

function t(key, ...args) {
  const value = translations[language][key] ?? guideCopy[language][key] ?? translations.en[key] ?? key;
  return typeof value === 'function' ? value(...args) : value;
}

function applyLanguage() {
  document.documentElement.lang = language;
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((element) => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => { element.title = t(element.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  populateGroupFilter();
  const nextLanguageLabel = language === 'cs' ? t('switchToEnglish') : t('switchToCzech');
  languageToggle.setAttribute('aria-label', nextLanguageLabel);
  languageToggle.setAttribute('aria-pressed', String(language === 'cs'));
  languageToggle.title = nextLanguageLabel;
  updateThemeButton();
  renderGuide();
  renderAll();
}

function renderGuide() {
  const copy = guideCopy[language];
  const [title, description] = copy.steps[guideStep];
  document.getElementById('guide-step-title').textContent = title;
  document.getElementById('guide-step-copy').textContent = description;
  document.getElementById('guide-demo-link').href = `./?walkthrough=order&lang=${language}`;
  stepButtons.forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.guideStep) === guideStep)));
  guideCards.innerHTML = guideSteps[guideStep].map((model) => {
    const [name, summary] = copy.cards[model];
    return `<li><a href="?table=${model}" data-guide-table="${model}" aria-label="${escapeHtml(t('openGuideTable', name))}">
      <strong>${escapeHtml(name)}</strong><code>${model}</code><span>${escapeHtml(summary)}</span>
    </a></li>`;
  }).join('');
}

function showSchemaView(name, table) {
  guide.hidden = name !== 'guide';
  diagramView.hidden = name !== 'diagram';
  viewButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.schemaView === name)));
  if (diagramView.hidden || !models.length) return;
  if (table && modelByName.has(table)) {
    pathStack = [table];
    focusModel(table, false);
  } else renderAll();
}

function updateThemeButton() {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const label = theme === 'dark' ? t('switchToLight') : t('switchToDark');
  themeButton.setAttribute('aria-label', label);
  themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
  themeButton.title = label;
}

function populateGroupFilter() {
  if (!groupFilter) return;
  const current = groupFilter.value || 'all';
  const groups = [...new Set(models.map((model) => model.group))].sort((a, b) => a.localeCompare(b));
  groupFilter.innerHTML = `<option value="all">${t('allGroups')}</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(translations[language].groups[group] || group)}</option>`).join('')}`;
  groupFilter.value = groups.includes(current) || current === 'all' ? current : 'all';
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const edgeKey = (source, target) => `${source}>${target}`;

function labelLines(model) {
  const words = model.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split('_').map((word) => word.toUpperCase());
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current}_${word}` : word;
    if (next.length > 21 && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function buildEdges() {
  const edgeMap = new Map();
  for (const model of models) {
    for (const link of model.links || []) {
      const key = edgeKey(link.target, model.name);
      const existing = edgeMap.get(key) || { source: link.target, target: model.name, fields: [], declared: false };
      if (link.field && !existing.fields.includes(link.field)) existing.fields.push(link.field);
      existing.declared ||= Boolean(link.declared);
      edgeMap.set(key, existing);
    }
  }
  edges = [...edgeMap.values()];
}

function setView(width, height) {
  view.width = width * diagramScale;
  view.height = height * diagramScale;
  view.x = 0;
  view.y = 0;
  view.zoom = 1;
  const canvasWidth = Math.max(stage.clientWidth, 1200);
  const canvasHeight = canvasWidth * height / width;
  svg.style.height = `${canvasHeight}px`;
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  updateViewBox();
}

function centerDiagram(worldX = 800) {
  const rect = svg.getBoundingClientRect();
  if (stage.clientWidth >= rect.width) return;
  const screenX = worldX * diagramScale / view.width * rect.width;
  view.x = (screenX - stage.clientWidth / 2) * view.width / (rect.width * view.zoom);
  updateViewBox();
}

function updateViewBox() {
  const width = view.width / view.zoom;
  const height = view.height / view.zoom;
  const panMarginX = view.zoom >= 1 ? view.width * 0.5 : 0;
  const panMarginY = view.zoom >= 1 ? view.height * 0.5 : 0;
  const minX = -panMarginX;
  const minY = -panMarginY;
  const maxX = Math.max(minX, view.width - width + panMarginX);
  const maxY = Math.max(minY, view.height - height + panMarginY);
  const x = Math.max(minX, Math.min(maxX, view.x));
  const y = Math.max(minY, Math.min(maxY, view.y));
  view.x = x;
  view.y = y;
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
}

function fitCurrentDiagram() {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  view.zoom = Math.max(0.2, Math.min(1, stage.clientWidth / rect.width, stage.clientHeight / rect.height));
  view.x = 0;
  view.y = 0;
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  updateViewBox();
}

function renderNode(model, x, y, options = {}) {
  const width = options.width || 190;
  const height = options.height || 66;
  const lines = labelLines(model);
  const lineHeight = lines.length > 2 ? 11 : 13;
  const firstY = y - ((lines.length - 1) * lineHeight) / 2;
  const title = escapeHtml(model.name);
  const label = lines.map((line, index) => `<tspan x="${x}" y="${firstY + index * lineHeight}" ${line.length > 20 ? 'textLength="164" lengthAdjust="spacingAndGlyphs"' : ''}>${escapeHtml(line)}</tspan>`).join('');
  const secondary = options.count ? `<text class="node-count" x="${x}" y="${y + height / 2 - 8}">${options.count} ${t('connected')}</text>` : '';
  const stateClass = options.muted ? ' is-muted' : options.selected ? ' is-selected' : options.related ? ' is-related' : '';
  return `<g class="table-node${options.root ? ' is-root' : ''}${stateClass}" role="button" tabindex="0" data-model="${title}" aria-label="${escapeHtml(t('openTable', model.name))}"><title>${title} · ${model.fields.length} ${t('columns')} · ${escapeHtml(t('openTable', model.name))}</title><rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="1"/><text class="node-label" x="${x}" y="${firstY}">${label}</text>${secondary}</g>`;
}

function relationshipLabel(edge) {
  const key = edgeKey(edge.source, edge.target);
  const known = language === 'cs' ? (overviewLabelsCs[key] || shortLabelsCs[key]) : (overviewLabels[key] || shortLabels[key]);
  if (known) return known;
  const labels = (edge.fields || []).map((field) => (language === 'cs' ? fieldLabelsCs[field] : fieldLabels[field]) || fieldLabels[field] || field.replace(/Id$/, '')).filter(Boolean);
  const unique = [...new Set(labels)];
  if (!unique.length) return language === 'cs' ? 'související' : 'related';
  return unique.length === 1 ? (labels.length > 1 ? `${unique[0]} ×${labels.length}` : unique[0]) : unique.join(' / ');
}

function renderEdgeLabel(label, destination, x, y, width, height) {
  return `<g class="edge-label-control" role="button" tabindex="0" data-model="${escapeHtml(destination)}" aria-label="${escapeHtml(t('openRelationship', label, destination))}"><rect class="edge-label-bg" x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="4"/><text class="edge-label" x="${x}" y="${y}">${escapeHtml(label)}</text></g>`;
}

function renderEdge(edge, route, sourcePos, targetPos, label) {
  const destination = currentModel ? (edge.source === currentModel.name ? edge.target : edge.source) : edge.target;
  const stateClass = edge.viewState ? ` ${edge.viewState}` : '';
  if (route) {
    const labelWidth = Math.max(72, label.length * 10.5 + 24);
    const ends = route.d.matchAll(/([MVH])\s*(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?/g);
    let first = null;
    let last = null;
    for (const [, command, a, b] of ends) {
      if (command === 'M') last = { x: Number(a), y: Number(b) };
      else if (command === 'H') last = { ...last, x: Number(a) };
      else if (command === 'V') last = { ...last, y: Number(a) };
      if (!first && last) first = { ...last };
    }
    const endA = route.start || first || sourcePos;
    const endB = route.end || last || targetPos;
    return `<g class="edge-group${edge.declared ? '' : ' is-logical'}${stateClass}" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}"><title>${escapeHtml(edge.declared ? t('solidHelp') : t('dashedHelp'))}</title><path class="edge" d="${route.d}"/><circle class="edge-mark" cx="${endA.x}" cy="${endA.y}" r="4"/><circle class="edge-mark" cx="${endB.x}" cy="${endB.y}" r="4"/>${renderEdgeLabel(label, destination, route.x, route.y, labelWidth, 22)}</g>`;
  }
  const sourceAtStart = !currentModel || edge.source === currentModel.name;
  const from = sourceAtStart ? sourcePos : targetPos;
  const to = sourceAtStart ? targetPos : sourcePos;
  const sx = from.x;
  const sy = from.y + (sourceAtStart ? 34 : -34);
  const tx = to.x;
  const ty = to.y + (sourceAtStart ? -34 : 34);
  const row = Math.round((to.y - 280) / 150);
  const lane = 168 + row * 10;
  const d = `M${sx} ${sy} V${lane} H${tx} V${ty}`;
  const labelY = ty - 49;
  const labelWidth = Math.max(68, label.length * 10.5 + 24);
  return `<g class="edge-group${edge.declared ? '' : ' is-logical'}${stateClass}" data-source="${escapeHtml(edge.source)}" data-target="${escapeHtml(edge.target)}"><title>${escapeHtml(edge.declared ? t('solidHelp') : t('dashedHelp'))}</title><path class="edge" d="${d}"/><circle class="edge-mark" cx="${sx}" cy="${sy}" r="3.4"/><circle class="edge-mark" cx="${tx}" cy="${ty}" r="3.4"/>${renderEdgeLabel(label, destination, tx, labelY, labelWidth, 22)}</g>`;
}

function overviewEdgeMarkup(visibleNames) {
  return Object.keys(overviewRoutes).flatMap((key) => {
    const [sourceName, targetName] = key.split('>');
    if (!visibleNames.has(sourceName) || !visibleNames.has(targetName)) return [];
    const edge = edges.find((item) => item.source === sourceName && item.target === targetName);
    if (!edge) return [];
    const route = overviewRoutes[key];
    const source = overviewPositions[sourceName];
    const target = overviewPositions[targetName];
    edge.viewState = '';
    return [renderEdge(edge, route, source, target, relationshipLabel(edge))];
  }).join('');
}

function renderOverview() {
  isOverview = true;
  currentModel = null;
  pathStack = [];
  groupFilterControl.hidden = false;
  if (groupFilter.value !== 'all') return renderGroupOverview();
  setView(overviewSize.width, overviewSize.height);
  const names = new Set(Object.keys(overviewPositions).filter((name) => modelByName.has(name)));
  edgesLayer.innerHTML = overviewEdgeMarkup(names);
  nodesLayer.innerHTML = [...names].map((name) => renderNode(modelByName.get(name), overviewPositions[name].x, overviewPositions[name].y)).join('');
  centerDiagram(800);
  diagramCount.textContent = t('overviewCount', names.size, models.length);
  renderBreadcrumbs();
  details.innerHTML = `<div class="details-empty"><span class="eyebrow">${t('howToRead')}</span><h2>${t('startOverview')}</h2><p>${t('readIntro')}</p><p>${t('readRelationships')}</p></div>`;
}

function groupEdgeRoute(source, target) {
  if (source.x === target.x && source.y === target.y) return selfEdgeRoute(source);
  if (Math.abs(target.y - source.y) < 1) {
    const start = { x: source.x, y: source.y + 33 };
    const end = { x: target.x, y: target.y + 33 };
    const lane = source.y + 48;
    return { d: `M${start.x} ${start.y} V${lane} H${end.x} V${end.y}`, x: (start.x + end.x) / 2, y: lane, start, end };
  }
  const downward = target.y > source.y;
  const start = { x: source.x, y: source.y + (downward ? 33 : -33) };
  const end = { x: target.x, y: target.y + (downward ? -33 : 33) };
  const lane = (start.y + end.y) / 2;
  return { d: `M${start.x} ${start.y} V${lane} H${end.x} V${end.y}`, x: (start.x + end.x) / 2, y: lane, start, end };
}

function selfEdgeRoute(position, halfWidth = 95) {
  const start = { x: position.x + halfWidth, y: position.y };
  const end = { x: position.x, y: position.y - 33 };
  const outerX = position.x + halfWidth + 40;
  const laneY = position.y - 58;
  return { d: `M${start.x} ${start.y} H${outerX} V${laneY} H${position.x} V${end.y}`, x: position.x + halfWidth + 20, y: laneY, start, end };
}

function renderGroupOverview() {
  const group = groupFilter.value;
  const groupModels = models.filter((model) => model.group === group).sort((a, b) => a.name.localeCompare(b.name));
  const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(groupModels.length))));
  const stepX = 350;
  const stepY = 170;
  const rows = Math.ceil(groupModels.length / columns);
  const width = 1800;
  const height = Math.max(920, 180 + rows * stepY);
  setView(width, height);
  const positions = new Map();
  groupModels.forEach((model, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const rowItems = Math.min(columns, groupModels.length - row * columns);
    const rowWidth = rowItems * stepX;
    positions.set(model.name, { x: width / 2 - rowWidth / 2 + stepX / 2 + col * stepX, y: 100 + row * stepY });
  });
  const visibleNames = new Set(groupModels.map((model) => model.name));
  const groupEdges = edges.filter((edge) => visibleNames.has(edge.source) && visibleNames.has(edge.target));
  edgesLayer.innerHTML = groupEdges.map((edge) => {
    edge.viewState = '';
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    return renderEdge(edge, groupEdgeRoute(source, target), source, target, relationshipLabel(edge));
  }).join('');
  nodesLayer.innerHTML = groupModels.map((model) => renderNode(model, positions.get(model.name).x, positions.get(model.name).y)).join('');
  fitCurrentDiagram();
  const groupLabel = translations[language].groups[group] || group;
  diagramCount.textContent = t('filteredCount', groupModels.length, groupLabel, models.length);
  renderBreadcrumbs();
  details.innerHTML = `<div class="details-empty"><span class="eyebrow">${t('howToRead')}</span><h2>${escapeHtml(groupLabel)}</h2><p>${t('readIntro')}</p><p>${t('readRelationships')}</p></div>`;
}

function focusModel(name, append = true) {
  const model = modelByName.get(name);
  if (!model) return;
  if (!isOverview && currentModel?.name === name && append) return;
  if (append) pathStack.push(name);
  isOverview = false;
  currentModel = model;
  groupFilterControl.hidden = true;
  const relatedEdges = edges.filter((edge) => edge.source === name || edge.target === name);
  const neighborNames = [...new Set(relatedEdges.map((edge) => edge.source === name ? edge.target : edge.source))]
    .filter((neighbor) => neighbor !== name)
    .sort((a, b) => a.localeCompare(b));
  const columns = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(Math.max(1, neighborNames.length)))));
  const cardWidth = 190;
  const gap = 26;
  const step = cardWidth + gap;
  const totalWidth = columns * cardWidth + (columns - 1) * gap;
  const rootX = 800;
  const rowCount = Math.ceil(neighborNames.length / columns);
  const height = Math.max(620, 300 + rowCount * 156);
  setView(1600, height);
  const positions = new Map([[name, { x: rootX, y: 80 }]]);
  neighborNames.forEach((neighbor, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const colsInRow = Math.min(columns, neighborNames.length - row * columns);
    const rowWidth = colsInRow * cardWidth + (colsInRow - 1) * gap;
    positions.set(neighbor, { x: 800 - rowWidth / 2 + cardWidth / 2 + col * step, y: 285 + row * 155 });
  });
  edgesLayer.innerHTML = relatedEdges.map((edge) => {
    edge.viewState = '';
    const route = edge.source === edge.target ? selfEdgeRoute(positions.get(name), 105) : null;
    return renderEdge(edge, route, positions.get(edge.source), positions.get(edge.target), relationshipLabel(edge));
  }).join('');
  nodesLayer.innerHTML = renderNode(model, rootX, 80, { root: true, width: 210, count: neighborNames.length }) + neighborNames.map((neighbor) => renderNode(modelByName.get(neighbor), positions.get(neighbor).x, positions.get(neighbor).y)).join('');
  centerDiagram(rootX);
  diagramCount.textContent = neighborNames.length ? t('relatedCount', neighborNames.length, models.length) : t('noRelationships');
  renderBreadcrumbs();
  renderDetails(model, relatedEdges, neighborNames);
}

function renderBreadcrumbs() {
  breadcrumbs.innerHTML = `<button type="button" data-home>${t('overview').toUpperCase()}</button>${pathStack.map((name, index) => `<span class="crumb-separator" aria-hidden="true">›</span>${index === pathStack.length - 1 ? `<span class="crumb-current">${escapeHtml(name.toUpperCase())}</span>` : `<button type="button" data-path-index="${index}">${escapeHtml(name.toUpperCase())}</button>`}`).join('')}`;
}

function renderDetails(model, connectedEdges, neighborNames) {
  const columns = model.fields.map((field) => `<div class="field-row"><span class="field-name">${escapeHtml(field.name)}</span><span class="field-meta">${field.key ? `<b class="key-badge">${field.key}</b>` : ''}<span class="field-type">${escapeHtml(field.type)}${field.optional ? '?' : ''}</span></span></div>`).join('');
  const connections = connectedEdges.map((edge) => {
    const neighbor = edge.source === model.name ? edge.target : edge.source;
    return `<button class="connection" type="button" data-model="${escapeHtml(neighbor)}"><span class="connection-mark" aria-hidden="true">${edge.declared ? '●' : '◌'}</span><span class="connection-name">${escapeHtml(neighbor.toUpperCase())}</span><span class="connection-type">${escapeHtml(edge.fields.join(', '))}</span></button>`;
  }).join('');
  const group = translations[language].groups[model.group] || model.group;
  details.innerHTML = `<header class="detail-header"><p class="eyebrow">${t('expanded')} · ${escapeHtml(group.toUpperCase())}</p><div class="detail-title"><h2>${escapeHtml(model.name.toUpperCase())}</h2></div><p class="table-name">${escapeHtml(model.table)} · ${model.fields.length} ${t('columns')} · ${neighborNames.length} ${t('connected')}</p></header><div class="detail-body"><section><h3 class="detail-section-title">${language === 'cs' ? 'Sloupce' : 'Columns'} <span>${model.fields.length}</span></h3><div class="field-list">${columns}</div></section><section><h3 class="detail-section-title">${t('directRelationships')} <span>${connectedEdges.length}</span></h3><div class="connection-list">${connections || `<p class="no-connections">${t('noDirect')}</p>`}</div></section></div>`;
}

function renderAll() {
  if (diagramView.hidden || !models.length) return;
  if (isOverview) renderOverview();
  else if (currentModel) focusModel(currentModel.name, false);
}

function updateDiagramHighlight(modelName) {
  const visibleNodes = [...nodesLayer.querySelectorAll('.table-node')];
  const visibleEdges = [...edgesLayer.querySelectorAll('.edge-group')];
  const neighborNames = new Set(modelName ? visibleEdges
    .filter((edge) => edge.dataset.source === modelName || edge.dataset.target === modelName)
    .map((edge) => edge.dataset.source === modelName ? edge.dataset.target : edge.dataset.source) : []);
  visibleNodes.forEach((node) => {
    const name = node.dataset.model;
    node.classList.toggle('is-hovered', name === modelName);
    node.classList.toggle('is-related', Boolean(modelName && name !== modelName && neighborNames.has(name)));
    node.classList.toggle('is-muted', Boolean(modelName && name !== modelName && !neighborNames.has(name)));
  });
  visibleEdges.forEach((edge) => {
    const connected = edge.dataset.source === modelName || edge.dataset.target === modelName;
    edge.classList.toggle('is-focused', Boolean(modelName && connected));
    edge.classList.toggle('is-muted', Boolean(modelName && !connected));
  });
}

nodesLayer.addEventListener('pointerover', (event) => {
  if (event.pointerType !== 'mouse') return;
  const node = event.target.closest('.table-node');
  if (node) updateDiagramHighlight(node.dataset.model);
});
nodesLayer.addEventListener('pointerout', (event) => {
  if (event.pointerType !== 'mouse') return;
  const node = event.target.closest('.table-node');
  if (!node) return;
  const nextNode = event.relatedTarget?.closest?.('.table-node');
  if (nextNode && nodesLayer.contains(nextNode)) updateDiagramHighlight(nextNode.dataset.model);
  else updateDiagramHighlight(null);
});

nodesLayer.addEventListener('click', (event) => {
  if (suppressDiagramClick) return;
  const node = event.target.closest('[data-model]');
  if (node) focusModel(node.dataset.model);
});
edgesLayer.addEventListener('click', (event) => {
  if (suppressDiagramClick) return;
  const label = event.target.closest('.edge-label-control');
  if (label) focusModel(label.dataset.model);
});
nodesLayer.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-model]')) {
    event.preventDefault();
    focusModel(event.target.dataset.model);
  }
});
edgesLayer.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.edge-label-control')) {
    event.preventDefault();
    focusModel(event.target.dataset.model);
  }
});
details.addEventListener('click', (event) => {
  const connection = event.target.closest('[data-model]');
  if (connection) focusModel(connection.dataset.model);
});
breadcrumbs.addEventListener('click', (event) => {
  if (event.target.closest('[data-home]')) {
    groupFilter.value = 'all';
    return renderOverview();
  }
  const index = Number(event.target.closest('[data-path-index]')?.dataset.pathIndex);
  if (Number.isInteger(index) && index >= 0) {
    pathStack = pathStack.slice(0, index + 1);
    focusModel(pathStack.at(-1), false);
  }
});
document.querySelectorAll('[data-home]').forEach((button) => button.addEventListener('click', () => {
  groupFilter.value = 'all';
  renderOverview();
}));
groupFilter.addEventListener('change', renderOverview);
viewButtons.forEach((button) => button.addEventListener('click', () => showSchemaView(button.dataset.schemaView)));
stepButtons.forEach((button) => button.addEventListener('click', () => {
  guideStep = Number(button.dataset.guideStep);
  renderGuide();
}));
guideCards.addEventListener('click', (event) => {
  const link = event.target.closest('[data-guide-table]');
  if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !modelByName.has(link.dataset.guideTable)) return;
  event.preventDefault();
  showSchemaView('diagram', link.dataset.guideTable);
  document.getElementById('diagram-heading').focus();
});
languageToggle.addEventListener('click', () => {
  language = language === 'cs' ? 'en' : 'cs';
  try { localStorage.setItem('wms-schema-language', language); } catch {}
  applyLanguage();
});
themeButton.addEventListener('click', () => {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = nextTheme;
  document.querySelector('meta[name="theme-color"]').content = nextTheme === 'dark' ? '#171d1a' : '#f2f8f4';
  try { localStorage.setItem('wms-schema-theme', nextTheme); } catch {}
  updateThemeButton();
});
document.querySelectorAll('[data-zoom]').forEach((button) => button.addEventListener('click', () => {
  const factor = button.dataset.zoom === 'in' ? 1.2 : 1 / 1.2;
  view.zoom = Math.max(0.65, Math.min(2.5, view.zoom * factor));
  updateViewBox();
}));
document.querySelector('[data-fit]').addEventListener('click', fitCurrentDiagram);
tableSearch.addEventListener('change', () => {
  const query = tableSearch.value.trim().toLowerCase();
  const match = models.find((model) => model.name.toLowerCase() === query || model.table.toLowerCase() === query);
  if (match) {
    pathStack = [];
    focusModel(match.name);
  }
});
tableSearch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    tableSearch.dispatchEvent(new Event('change'));
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !diagramView.hidden && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    tableSearch.focus();
  }
  if (event.key === 'Escape' && document.activeElement === tableSearch) tableSearch.blur();
});
stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y, moved: false, startedOnInteractive: Boolean(event.target.closest('.table-node, .edge-label-control')) };
});
document.addEventListener('pointermove', (event) => {
  if (!panStart) return;
  if (!panStart.moved && Math.hypot(event.clientX - panStart.x, event.clientY - panStart.y) < 4) return;
  if (!panStart.moved) {
    panStart.moved = true;
    stage.classList.add('is-panning');
  }
  const rect = svg.getBoundingClientRect();
  view.x = panStart.viewX - (event.clientX - panStart.x) * (view.width / view.zoom / rect.width);
  view.y = panStart.viewY - (event.clientY - panStart.y) * (view.height / view.zoom / rect.height);
  updateViewBox();
});
function finishPan() {
  if (panStart?.moved && panStart.startedOnInteractive) {
    suppressDiagramClick = true;
    setTimeout(() => { suppressDiagramClick = false; }, 0);
  }
  panStart = null;
  stage.classList.remove('is-panning');
}
document.addEventListener('pointerup', finishPan);
document.addEventListener('pointercancel', finishPan);
stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  view.zoom = Math.max(0.65, Math.min(2.5, view.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)));
  updateViewBox();
}, { passive: false });

fetch('database-schema.json').then((response) => {
  if (!response.ok) throw new Error('schema unavailable');
  return response.json();
}).then((schema) => {
  models = schema.models;
  modelByName = new Map(models.map((model) => [model.name, model]));
  populateGroupFilter();
  buildEdges();
  tableOptions.innerHTML = models.map((model) => `<option value="${escapeHtml(model.table)}">${escapeHtml(model.name)}</option>`).join('');
  loading.hidden = true;
  if (!diagramView.hidden) showSchemaView('diagram', requestedTable);
}).catch(() => {
  loading.textContent = language === 'cs' ? 'Nepodařilo se načíst databázové schéma.' : 'Could not load the database schema.';
  diagramCount.textContent = language === 'cs' ? 'Schéma není dostupné' : 'Schema unavailable';
});

showSchemaView(requestedTable ? 'diagram' : 'guide');
applyLanguage();

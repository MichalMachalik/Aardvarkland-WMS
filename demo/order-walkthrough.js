const previewParams = new URLSearchParams(window.location.search);
const isOrderWalkthrough = previewParams.get('walkthrough') === 'order';
const orderViews = ['rf', 'packing', 'outbound'];
const walkthroughOrder = {
  code: 'DEMO-1042',
  parcel: 'DEMO-PARCEL-1042',
  dock: 'DOCK-02',
  carrier: 'Demo Parcel',
};

const orderCopy = {
  en: {
    title: 'Order walkthrough', order: 'Order', preview: 'Full WMS preview',
    notice: 'Fictional order. Scans and shipping are simulated.',
    stages: ['Picking', 'Packing', 'Dispatch'], complete: 'Complete', restart: 'Restart walkthrough',
    scan: 'Simulate scan', useQuantity: 'Use expected quantity', toPacking: 'Continue to packing',
    contents: 'Order contents', pickLocation: 'Pick location', station: 'Packing station', dock: 'Dispatch dock',
    stock: 'Units at pick location', label: 'Sample shipping label',
    packTitle: 'Pack the order', packHelp: 'Check the item count at the packing station. Seal the parcel once it matches the order.',
    expected: 'Expected quantity', quantity: 'Units in parcel', seal: 'Seal parcel',
    invalidQuantity: 'The packed quantity must match the order.',
    packed: 'Parcel sealed. The sample shipping label is ready.', toDispatch: 'Continue to dispatch',
    dispatchTitle: 'Dispatch the parcel', dispatchHelp: 'Scan the label at the dispatch dock and record carrier handoff.',
    labelCode: 'Code on label', parcelCode: 'Parcel code', useLabel: 'Use label code', handoff: 'Confirm handoff',
    invalidParcel: 'This code does not match the parcel label.',
    dispatched: 'Order dispatched', done: 'Carrier handoff recorded for this demo order.',
  },
  cs: {
    title: 'Průchod objednávkou', order: 'Objednávka', preview: 'Celá ukázka WMS',
    notice: 'Fiktivní data. Skenování a expedice jsou simulované.',
    stages: ['Vychystání', 'Balení', 'Expedice'], complete: 'Dokončeno', restart: 'Začít znovu',
    scan: 'Simulovat sken', useQuantity: 'Použít očekávané množství', toPacking: 'Pokračovat k balení',
    contents: 'Obsah objednávky', pickLocation: 'Vychystávací lokace', station: 'Balicí stanoviště', dock: 'Expediční rampa',
    stock: 'Kusů na lokaci', label: 'Ukázkový přepravní štítek',
    packTitle: 'Zabalte objednávku', packHelp: 'Na balicím stanovišti zkontrolujte počet kusů. Pokud souhlasí s objednávkou, uzavřete balík.',
    expected: 'Očekávané množství', quantity: 'Kusů v balíku', seal: 'Uzavřít balík',
    invalidQuantity: 'Počet kusů v balíku musí odpovídat objednávce.',
    packed: 'Balík je uzavřený a ukázkový štítek je připravený.', toDispatch: 'Pokračovat k expedici',
    dispatchTitle: 'Vyexpedujte balík', dispatchHelp: 'Na expediční rampě naskenujte štítek a potvrďte předání dopravci.',
    labelCode: 'Kód na štítku', parcelCode: 'Kód balíku', useLabel: 'Použít kód ze štítku', handoff: 'Potvrdit předání',
    invalidParcel: 'Kód neodpovídá štítku tohoto balíku.',
    dispatched: 'Objednávka vyexpedována', done: 'Předání dopravci bylo zaevidováno v ukázce.',
  },
  ua: {
    title: 'Демонстрація обробки замовлення', order: 'Замовлення', preview: 'Повна демонстрація WMS',
    notice: 'Вигадане замовлення. Сканування й відправлення імітуються.',
    stages: ['Відбір', 'Пакування', 'Відправлення'], complete: 'Завершено', restart: 'Почати спочатку',
    scan: 'Імітувати сканування', useQuantity: 'Підставити очікувану кількість', toPacking: 'Перейти до пакування',
    contents: 'Вміст замовлення', pickLocation: 'Місце відбору', station: 'Ділянка пакування', dock: 'Рампа відправлення',
    stock: 'Одиниць у місці відбору', label: 'Зразок транспортної етикетки',
    packTitle: 'Запакуйте замовлення', packHelp: 'Перевірте кількість на ділянці пакування. Запечатайте посилку, якщо кількість відповідає замовленню.',
    expected: 'Очікувана кількість', quantity: 'Одиниць у посилці', seal: 'Запечатати посилку',
    invalidQuantity: 'Кількість у посилці має відповідати замовленню.',
    packed: 'Посилку запечатано. Зразок транспортної етикетки готовий.', toDispatch: 'Перейти до відправлення',
    dispatchTitle: 'Відправте посилку', dispatchHelp: 'Відскануйте етикетку біля рампи та підтвердьте передачу перевізнику.',
    labelCode: 'Код на етикетці', parcelCode: 'Код посилки', useLabel: 'Підставити код з етикетки', handoff: 'Підтвердити передачу',
    invalidParcel: 'Цей код не відповідає етикетці посилки.',
    dispatched: 'Замовлення відправлено', done: 'Передачу перевізнику зафіксовано в демонстрації.',
  },
};

function orderStage(progress = state.picking) {
  if (progress.step !== pickingSteps.length || progress.pending) return 0;
  if (progress.fulfillment === 'dispatched') return 3;
  return progress.fulfillment === 'packed' ? 2 : 1;
}

function orderViewForProgress(progress) {
  return orderViews[Math.min(orderStage(progress), orderViews.length - 1)];
}

function orderContinue(view, label) {
  return `<button class="primary-button order-continue" type="button" data-order-view="${view}">${escapeHtml(label)}</button>`;
}

function renderOrderDetails(text, stage) {
  const item = inventoryRows.find(({ sku }) => sku === pickTask.sku);
  const available = item.available - (stage > 0 ? pickTask.quantity : 0);
  return `
    <aside class="panel order-details" aria-labelledby="order-contents-heading">
      <h2 id="order-contents-heading">${escapeHtml(text.contents)}</h2>
      <div class="order-line">
        <div><strong>${html(item.product)}</strong><code>${escapeHtml(pickTask.sku)}</code></div>
        <strong>× ${pickTask.quantity}</strong>
      </div>
      <dl class="order-locations">
        <div><dt>${escapeHtml(text.pickLocation)}</dt><dd>${escapeHtml(pickTask.source)}</dd></div>
        <div><dt>${escapeHtml(text.station)}</dt><dd>${escapeHtml(pickTask.target)}</dd></div>
        <div><dt>${escapeHtml(text.dock)}</dt><dd>${escapeHtml(walkthroughOrder.dock)}</dd></div>
        <div><dt>${escapeHtml(text.stock)}</dt><dd>${available}</dd></div>
      </dl>
      ${stage >= 2 ? `
        <div class="order-label">
          <h3>${escapeHtml(text.label)}</h3>
          <strong>${escapeHtml(walkthroughOrder.carrier)} · ${escapeHtml(walkthroughOrder.dock)}</strong>
          <code>${escapeHtml(walkthroughOrder.parcel)}</code>
        </div>` : ''}
    </aside>`;
}

function orderStep(view, text) {
  if (view === 'packing') {
    return {
      stage: 1, next: 'packed', title: text.packTitle, help: text.packHelp,
      expected: text.expected, field: text.quantity, value: String(pickTask.quantity),
      sample: String(pickTask.quantity), sampleLabel: text.useQuantity, submit: text.seal,
      invalid: text.invalidQuantity, inputMode: 'numeric',
    };
  }
  return {
    stage: 2, next: 'dispatched', title: text.dispatchTitle, help: text.dispatchHelp,
    expected: text.labelCode, field: text.parcelCode, value: walkthroughOrder.parcel,
    sample: 'AARD1:PARCEL:' + walkthroughOrder.parcel, sampleLabel: text.useLabel, submit: text.handoff,
    invalid: text.invalidParcel, inputMode: 'text',
  };
}

function renderOrderStep(text, stage) {
  const packing = state.view === 'packing';
  const step = orderStep(state.view, text);
  if (stage > step.stage) {
    return `
      <section class="panel order-stage">
        <h2 class="order-stage-title" id="order-stage-title" tabindex="-1">${escapeHtml(packing ? step.title : text.dispatched)}</h2>
        <p class="order-complete" role="status"><span aria-hidden="true">✓</span> ${escapeHtml(packing ? text.packed : text.done)}</p>
        ${packing ? orderContinue('outbound', text.toDispatch) : ''}
      </section>`;
  }
  return `
    <section class="panel order-stage">
      <h2 class="order-stage-title" id="order-stage-title" tabindex="-1">${escapeHtml(step.title)}</h2>
      <p class="order-instruction">${escapeHtml(step.help)}</p>
      <form id="order-step-form" class="scan-form">
        <p class="rf-expected">${escapeHtml(step.expected)}<strong>${escapeHtml(step.value)}</strong></p>
        <label for="order-step-input">${escapeHtml(step.field)}</label>
        <div class="scan-row">
          <input id="order-step-input" name="code" aria-describedby="order-step-feedback" inputmode="${step.inputMode}" autocomplete="off" spellcheck="false" required>
          <button class="text-button" type="button" data-order-action="sample">${escapeHtml(step.sampleLabel)}</button>
          <button class="primary-button" type="submit">${escapeHtml(step.submit)}</button>
        </div>
        <p class="order-feedback" id="order-step-feedback" role="alert"></p>
      </form>
    </section>`;
}

function renderOrderWalkthrough() {
  const text = orderCopy[state.language];
  const stage = orderStage();
  const previewLink = previewParams.has('mobileFrame') ? './?mobileFrame=1' : './';
  return `
    <header class="order-header">
      <h1>${escapeHtml(text.title)}</h1>
      <p class="order-reference">${escapeHtml(text.order)} <strong>${escapeHtml(walkthroughOrder.code)}</strong></p>
      <p>${escapeHtml(text.notice)}</p>
    </header>
    <ol class="order-stages" role="list" aria-label="${escapeHtml(text.title)}">
      ${orderViews.map((view, index) => {
        const label = escapeHtml(text.stages[index]);
        const complete = index < stage;
        return `<li><button type="button" data-order-view="${view}"${view === state.view ? ' aria-current="step"' : ''}${index > stage ? ' disabled' : ''}${complete ? ` aria-label="${label} · ${escapeHtml(text.complete)}"` : ''}>
          <span class="order-stage-number${complete ? ' is-complete' : ''}" aria-hidden="true">${complete ? '✓' : index + 1}</span> ${label}
        </button></li>`;
      }).join('')}
    </ol>
    <p class="order-feedback" id="order-feedback" role="alert"></p>
    <div class="rf-layout order-layout">
      ${state.view === 'rf' ? renderPickingTask() : renderOrderStep(text, stage)}
      ${renderOrderDetails(text, stage)}
    </div>
    <div class="order-page-actions">
      <a class="text-button" href="${previewLink}">${escapeHtml(text.preview)}</a>
      ${state.picking.step > 0 ? `<button class="text-button" type="button" data-order-action="reset">${escapeHtml(text.restart)}</button>` : ''}
    </div>`;
}

function openOrderView(view) {
  const index = orderViews.indexOf(view);
  if (index < 0 || index > orderStage()) return;
  state.view = view;
  renderView();
  document.getElementById('order-stage-title')?.focus();
}

function handleOrderAction(action) {
  if (action === 'reset') {
    if (savePicking({ step: 0, offline: false, pending: false, fulfillment: null }, 'order-feedback')) {
      openOrderView('rf');
    }
    return;
  }
  const input = document.getElementById('order-step-input');
  if (action !== 'sample' || !input) return;
  input.value = orderStep(state.view, orderCopy[state.language]).sample;
  clearOrderError(input);
  input.form.querySelector('[type="submit"]').focus();
}

function clearOrderError(input) {
  input.removeAttribute('aria-invalid');
  setText('order-step-feedback', '');
}

function confirmOrderStep(form) {
  const step = orderStep(state.view, orderCopy[state.language]);
  if (orderStage() !== step.stage) return;
  const input = form.elements.code;
  const value = input.value.trim().toUpperCase();
  if (value !== step.value && value !== step.sample) {
    input.setAttribute('aria-invalid', 'true');
    setText('order-step-feedback', step.invalid);
    input.focus();
    input.select();
    return;
  }
  if (!savePicking({ fulfillment: step.next }, 'order-step-feedback')) return;
  renderView();
  (document.querySelector('.order-continue') ?? document.getElementById('order-stage-title'))?.focus();
}

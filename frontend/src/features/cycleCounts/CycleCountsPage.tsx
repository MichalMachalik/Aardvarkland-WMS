import { pickLanguage, type BaseTranslations } from '../../core/i18n/i18n';
import { FormEvent, useMemo, useState } from 'react';
import { ActionStatus } from '../../components/ops/ActionStatus';
import { DataSourceBanner } from '../../components/ops/DataSourceBanner';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { PermissionGate } from '../../components/ui/PermissionGate';
import { useApiMutation } from '../../core/api/useApiMutation';
import { useApiResource } from '../../core/api/useApiResource';
import {
  approveCycleCountTask,
  createCycleCountPlan,
  listCycleCountPlans,
  listCycleCountTasks,
  releaseCycleCountPlan,
  submitCycleCountTask,
} from '../../core/api/wms';
import { useWorkspace, type Language } from '../../core/workspace/workspace';
import { asRecord as record, finiteNumber as numberValue, nonBlankText as nullableString, textOr as stringValue } from '../../core/api/response-values';

interface CycleCountPlan {
  id: string;
  code: string;
  status: string;
  scopeType: string;
  scopeReference: string | null;
  releasedAt: string | null;
  approvedAt: string | null;
}

interface CycleCountTask {
  id: string;
  warehouseTaskId: string | null;
  locationId: string;
  skuId: string | null;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  varianceQuantity: number | null;
  status: string;
}

const emptyPlans: CycleCountPlan[] = [];
const emptyTasks: CycleCountTask[] = [];
const emptyTaskList = { warehouseId: '', planId: '', tasks: emptyTasks };
const emptyCountForm = { countedQuantity: '', reason: '' };
const maxCount = 2_147_483_647;
const scopeTypes = ['LOCATION', 'SKU', 'ZONE', 'ALL'];
const planStatuses = ['DRAFT', 'RELEASED', 'COUNTING', 'RECONCILING', 'APPROVED', 'CANCELLED'];

export function CycleCountsPage() {
  const { warehouseId, language } = useWorkspace();
  const text = pickLanguage(language, { cs: czech, en: english, ua: ukrainian });
  const mutation = useApiMutation();
  const plansResource = useApiResource<CycleCountPlan[]>({
    fallback: emptyPlans,
    productionFallback: emptyPlans,
    loader: () => listCycleCountPlans<unknown[]>(warehouseId),
    map: mapPlans,
    dependencies: [warehouseId],
  });
  const [filter, setFilter] = useState({ query: '', status: '' });
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [planForm, setPlanForm] = useState({ code: '', scopeType: 'LOCATION', scopeReference: '', reason: '' });
  const [releaseBlindCount, setReleaseBlindCount] = useState(true);
  const [countForm, setCountForm] = useState(emptyCountForm);

  const rows = useMemo(() => {
    const query = filter.query.trim().toLowerCase();
    return plansResource.data.filter((plan) => {
      const queryMatches = !query || `${plan.code} ${plan.scopeReference ?? ''}`.toLowerCase().includes(query);
      const statusMatches = !filter.status || plan.status === filter.status;
      return queryMatches && statusMatches;
    });
  }, [filter.query, filter.status, plansResource.data]);
  const selectedPlan = rows.find((plan) => plan.id === selectedPlanId);
  const planId = selectedPlan?.id ?? '';
  const tasksResource = useApiResource<typeof emptyTaskList>({
    fallback: emptyTaskList,
    productionFallback: emptyTaskList,
    enabled: Boolean(planId),
    loader: async () => ({
      warehouseId,
      planId,
      tasks: mapTasks(await listCycleCountTasks<unknown[]>(warehouseId, planId)),
    }),
    map: (payload) => payload as typeof emptyTaskList,
    dependencies: [warehouseId, planId],
  });
  const tasks = tasksResource.data.warehouseId === warehouseId && tasksResource.data.planId === planId
    ? tasksResource.data.tasks
    : emptyTasks;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const countedQuantity = Number(countForm.countedQuantity);
  const validCount = /^\d+$/.test(countForm.countedQuantity.trim()) && countedQuantity <= maxCount;
  const canEnterCount = tasksResource.status === 'live' && Boolean(selectedTask && ['OPEN', 'IN_PROGRESS'].includes(selectedTask.status));
  const canSubmitCount = canEnterCount && validCount && mutation.status !== 'running';
  const canApproveCount = tasksResource.status === 'live' && selectedTask?.status === 'SUBMITTED' && mutation.status !== 'running';
  const canReleasePlan = plansResource.status === 'live' && selectedPlan?.status === 'DRAFT' && mutation.status !== 'running';
  const canCreatePlan = mutation.status !== 'running' && (planForm.scopeType === 'ALL' || Boolean(planForm.scopeReference.trim()));
  const openPlans = plansResource.data.filter((plan) => !['APPROVED', 'CANCELLED'].includes(plan.status)).length;
  const submittedTasks = tasks.filter((task) => task.status === 'SUBMITTED').length;
  const varianceTasks = tasks.filter((task) => (task.varianceQuantity ?? 0) !== 0).length;

  function selectPlan(id: string | null) {
    setSelectedPlanId(id);
    setSelectedTaskId(null);
    setCountForm(emptyCountForm);
    setReleaseBlindCount(true);
  }

  const planColumns: Column<CycleCountPlan>[] = [
    { key: 'code', label: text.columns.code, render: (row) => <strong>{row.code}</strong> },
    { key: 'status', label: text.columns.status, render: (row) => <Badge tone={row.status === 'APPROVED' ? 'good' : row.status === 'RECONCILING' ? 'warning' : 'neutral'}>{planStatusLabel(row.status, language)}</Badge> },
    { key: 'scope', label: text.columns.scope, render: (row) => `${scopeLabel(row.scopeType, language)} ${row.scopeReference ?? ''}`.trim() },
    { key: 'released', label: text.columns.released, render: (row) => row.releasedAt ? formatDate(row.releasedAt) : text.notSet },
    { key: 'action', label: text.columns.action, align: 'right', render: (row) => <Button size="sm" type="button" aria-pressed={selectedPlan?.id === row.id} onClick={() => selectPlan(row.id)}>{text.select}</Button> },
  ];
  const taskColumns: Column<CycleCountTask>[] = [
    { key: 'task', label: text.columns.task, render: (row) => <strong>{shortId(row.warehouseTaskId ?? row.id)}</strong> },
    { key: 'location', label: text.columns.location, render: (row) => shortId(row.locationId) },
    { key: 'expected', label: text.columns.expected, align: 'right', render: (row) => row.expectedQuantity ?? text.blind },
    { key: 'counted', label: text.columns.counted, align: 'right', render: (row) => row.countedQuantity ?? text.notSet },
    { key: 'variance', label: text.columns.variance, align: 'right', render: (row) => row.varianceQuantity ?? text.notSet },
    { key: 'status', label: text.columns.status, render: (row) => <Badge tone={row.status === 'APPROVED' ? 'good' : row.status === 'SUBMITTED' || row.status === 'REJECTED' ? 'warning' : 'neutral'}>{taskStatusLabel(row.status, language)}</Badge> },
    { key: 'action', label: text.columns.action, align: 'right', render: (row) => <Button size="sm" type="button" aria-pressed={selectedTask?.id === row.id} onClick={() => { setSelectedTaskId(row.id); setCountForm(emptyCountForm); }}>{text.select}</Button> },
  ];

  async function createPlan(event: FormEvent) {
    event.preventDefault();
    if (!canCreatePlan) return;
    const result = await mutation.run(text.actions.createPlan, () => createCycleCountPlan<CycleCountPlan>(warehouseId, {
      code: planForm.code.trim() || undefined,
      scopeType: planForm.scopeType,
      scopeReference: planForm.scopeType === 'ALL' ? undefined : planForm.scopeReference.trim(),
      metadata: { reason: planForm.reason.trim() || undefined, source: 'cycle-count-ui' },
    }));
    if (result) {
      setPlanForm({ code: '', scopeType: 'LOCATION', scopeReference: '', reason: '' });
      setFilter({ query: '', status: '' });
      selectPlan(result.id);
      plansResource.refresh();
    }
  }

  async function releasePlan() {
    if (!canReleasePlan || !selectedPlan) return;
    const result = await mutation.run(text.actions.releasePlan, () => releaseCycleCountPlan(warehouseId, selectedPlan.id, {
      metadata: { hideExpectedFromRf: releaseBlindCount, source: 'cycle-count-ui' },
    }));
    if (result) {
      plansResource.refresh();
      tasksResource.refresh();
    }
  }

  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (!canSubmitCount || !selectedTask) return;
    const result = await mutation.run(text.actions.submitTask, () => submitCycleCountTask(warehouseId, selectedTask.id, {
      countedQuantity,
      metadata: { source: 'cycle-count-ui' },
    }));
    if (result) {
      tasksResource.refresh();
      plansResource.refresh();
    }
  }

  async function approveTask() {
    if (!canApproveCount || !selectedTask) return;
    const result = await mutation.run(text.actions.approveTask, () => approveCycleCountTask(warehouseId, selectedTask.id, {
      reason: countForm.reason || undefined,
      metadata: { source: 'cycle-count-ui' },
    }));
    if (result) {
      tasksResource.refresh();
      plansResource.refresh();
    }
  }

  return (
    <div className="page-grid">
      <div className="span-12"><DataSourceBanner label={text.title} resource={plansResource} /></div>
      <section className="wms-page-intro span-12">
        <div><p className="eyebrow">{text.eyebrow}</p><h2>{text.title}</h2></div>
        <Button size="sm" type="button" onClick={() => { plansResource.refresh(); tasksResource.refresh(); }}>{text.refresh}</Button>
      </section>

      <Card title={text.health} className="span-12">
        <div className="metric-stack metric-stack--inline">
          <article><span>{text.metrics.openPlans}</span><strong>{openPlans}</strong></article>
          <article><span>{text.metrics.tasks}</span><strong>{tasks.length}</strong></article>
          <article><span>{text.metrics.submitted}</span><strong>{submittedTasks}</strong></article>
          <article><span>{text.metrics.variances}</span><strong>{varianceTasks}</strong></article>
        </div>
      </Card>

      <Card title={text.plans} className="span-7">
        <div className="filter-row">
          <label>{text.fields.search}<input value={filter.query} onChange={(event) => setFilter((value) => ({ ...value, query: event.target.value }))} /></label>
          <label>{text.fields.status}<select value={filter.status} onChange={(event) => setFilter((value) => ({ ...value, status: event.target.value }))}><option value="">{text.all}</option>{planStatuses.map((status) => <option key={status} value={status}>{planStatusLabel(status, language)}</option>)}</select></label>
        </div>
        <DataTable rows={rows} columns={planColumns} getRowKey={(row) => row.id} emptyTitle={text.emptyPlansTitle} emptyText={text.emptyPlansText} />
      </Card>

      <Card title={text.selectedPlan} eyebrow={selectedPlan?.code ?? text.notSet} className="span-5">
        {selectedPlan ? (
          <div className="detail-list">
            <article><span>{text.columns.status}</span><strong>{planStatusLabel(selectedPlan.status, language)}</strong></article>
            <article><span>{text.columns.scope}</span><strong>{scopeLabel(selectedPlan.scopeType, language)} {selectedPlan.scopeReference ?? ''}</strong></article>
            <article><span>{text.columns.approved}</span><strong>{selectedPlan.approvedAt ? formatDate(selectedPlan.approvedAt) : text.notSet}</strong></article>
            <PermissionGate permission="cycle-count.manage">
              {selectedPlan.status === 'DRAFT' && (
                <>
                  <label className="checkbox-row"><input type="checkbox" checked={releaseBlindCount} onChange={(event) => setReleaseBlindCount(event.target.checked)} />{text.fields.blindCount}</label>
                  <Button type="button" onClick={releasePlan} disabled={!canReleasePlan}>{text.release}</Button>
                </>
              )}
            </PermissionGate>
          </div>
        ) : <p className="muted-copy">{text.emptySelection}</p>}
      </Card>

      <Card title={text.tasks} className="span-8">
        <DataSourceBanner label={text.tasks} resource={tasksResource} />
        <DataTable rows={tasks} columns={taskColumns} getRowKey={(row) => row.id} emptyTitle={text.emptyTasksTitle} emptyText={text.emptyTasksText} />
      </Card>

      <PermissionGate permission="cycle-count.manage">
        <Card title={text.countAction} eyebrow={selectedTask ? shortId(selectedTask.id) : text.notSet} className="span-4">
          <form aria-label={text.countAction} className="stacked-form" onSubmit={submitTask}>
            <label>{text.fields.counted}<input type="number" min={0} max={maxCount} step={1} required value={countForm.countedQuantity} onChange={(event) => setCountForm((form) => ({ ...form, countedQuantity: event.target.value }))} inputMode="numeric" disabled={!canEnterCount || mutation.status === 'running'} /></label>
            <label>{text.fields.reason}<textarea value={countForm.reason} onChange={(event) => setCountForm((form) => ({ ...form, reason: event.target.value }))} rows={3} disabled={!canApproveCount} /></label>
            <div className="form-actions">
              <Button tone="primary" type="submit" disabled={!canSubmitCount}>{text.submit}</Button>
              <Button type="button" onClick={approveTask} disabled={!canApproveCount}>{text.approve}</Button>
            </div>
          </form>
          <ActionStatus mutation={mutation} />
        </Card>

        <Card title={text.createPlan} className="span-12">
          <form aria-label={text.createPlan} className="stacked-form" onSubmit={createPlan}>
            <label>{text.fields.code}<input maxLength={80} value={planForm.code} onChange={(event) => setPlanForm((form) => ({ ...form, code: event.target.value }))} /></label>
            <label>{text.fields.scope}<select value={planForm.scopeType} onChange={(event) => setPlanForm((form) => ({ ...form, scopeType: event.target.value }))}>{scopeTypes.map((scope) => <option key={scope} value={scope}>{scopeLabel(scope, language)}</option>)}</select></label>
            <label>{text.fields.scopeReference}<input maxLength={120} required={planForm.scopeType !== 'ALL'} value={planForm.scopeReference} onChange={(event) => setPlanForm((form) => ({ ...form, scopeReference: event.target.value }))} disabled={planForm.scopeType === 'ALL'} /></label>
            <label>{text.fields.reason}<input value={planForm.reason} onChange={(event) => setPlanForm((form) => ({ ...form, reason: event.target.value }))} /></label>
            <Button tone="primary" type="submit" disabled={!canCreatePlan}>{text.save}</Button>
          </form>
        </Card>
      </PermissionGate>
    </div>
  );
}

function mapPlans(payload: unknown): CycleCountPlan[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map((value) => {
    const row = record(value);
    return {
      id: stringValue(row['id'], ''),
      code: stringValue(row['code'], ''),
      status: stringValue(row['status'], 'DRAFT'),
      scopeType: stringValue(row['scopeType'], 'LOCATION'),
      scopeReference: nullableString(row['scopeReference']),
      releasedAt: nullableString(row['releasedAt']),
      approvedAt: nullableString(row['approvedAt']),
    };
  }).filter((plan) => plan.id && plan.code);
}

function mapTasks(payload: unknown): CycleCountTask[] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map((value) => {
    const row = record(value);
    return {
      id: stringValue(row['id'], ''),
      warehouseTaskId: nullableString(row['warehouseTaskId']),
      locationId: stringValue(row['locationId'], ''),
      skuId: nullableString(row['skuId']),
      expectedQuantity: numberValue(row['expectedQuantity']),
      countedQuantity: numberValue(row['countedQuantity']),
      varianceQuantity: numberValue(row['varianceQuantity']),
      status: stringValue(row['status'], 'OPEN'),
    };
  }).filter((task) => task.id);
}

function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}...` : value; }
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function scopeLabel(value: string, language: Language) {
  const labels: Record<string, BaseTranslations<string>> = {
    LOCATION: { cs: 'Lokace', en: 'Location', ua: 'Локація' },
    SKU: { cs: 'SKU', en: 'SKU', ua: 'SKU' },
    ZONE: { cs: 'Zóna', en: 'Zone', ua: 'Зона' },
    ALL: { cs: 'Vše', en: 'All', ua: 'Усе' },
  };
  return labels[value] ? pickLanguage(language, labels[value]) : value;
}

function planStatusLabel(value: string, language: Language) {
  const labels: Record<string, BaseTranslations<string>> = {
    DRAFT: { cs: 'Rozpracováno', en: 'Draft', ua: 'Чернетка' },
    RELEASED: { cs: 'Uvolněno', en: 'Released', ua: 'Випущено' },
    COUNTING: { cs: 'Počítání', en: 'Counting', ua: 'Підрахунок' },
    RECONCILING: { cs: 'Rozdíly', en: 'Reconciling', ua: 'Звірка' },
    APPROVED: { cs: 'Schváleno', en: 'Approved', ua: 'Затверджено' },
    CANCELLED: { cs: 'Zrušeno', en: 'Cancelled', ua: 'Скасовано' },
  };
  return labels[value] ? pickLanguage(language, labels[value]) : value;
}

function taskStatusLabel(value: string, language: Language) {
  const labels: Record<string, BaseTranslations<string>> = {
    OPEN: { cs: 'Otevřeno', en: 'Open', ua: 'Відкрито' },
    IN_PROGRESS: { cs: 'Probíhá', en: 'In progress', ua: 'В роботі' },
    SUBMITTED: { cs: 'Odevzdáno', en: 'Submitted', ua: 'Подано' },
    APPROVED: { cs: 'Schváleno', en: 'Approved', ua: 'Затверджено' },
    REJECTED: { cs: 'Vráceno', en: 'Rejected', ua: 'Відхилено' },
    CANCELLED: { cs: 'Zrušeno', en: 'Cancelled', ua: 'Скасовано' },
  };
  return labels[value] ? pickLanguage(language, labels[value]) : value;
}

const czech = {
  title: 'Inventury',
  eyebrow: 'počty zásob, rozdíly a schválení',
  refresh: 'Obnovit',
  health: 'Stav inventur',
  plans: 'Plány',
  selectedPlan: 'Vybraný plán',
  tasks: 'Úkoly inventury',
  countAction: 'Počet a schválení',
  createPlan: 'Nový plán inventury',
  release: 'Uvolnit do úkolů',
  save: 'Uložit plán',
  submit: 'Odevzdat počet',
  approve: 'Schválit rozdíl',
  select: 'Vybrat',
  all: 'Vše',
  notSet: 'Nevyplněno',
  blind: 'Skryto',
  emptySelection: 'Vyber plán inventury.',
  emptyPlansTitle: 'Žádné plány inventury',
  emptyPlansText: 'Vytvoř plán podle lokace, zóny, SKU nebo celého skladu.',
  emptyTasksTitle: 'Žádné úkoly',
  emptyTasksText: 'Úkoly vzniknou po uvolnění plánu, pokud rozsah obsahuje zásobu.',
  metrics: { openPlans: 'Otevřené plány', tasks: 'Úkoly', submitted: 'Ke schválení', variances: 'Rozdíly' },
  columns: { code: 'Kód', status: 'Stav', scope: 'Rozsah', released: 'Uvolněno', approved: 'Schváleno', action: 'Akce', task: 'Úkol', location: 'Lokace', expected: 'Systém', counted: 'Spočteno', variance: 'Rozdíl' },
  fields: { search: 'Hledat', status: 'Stav', code: 'Kód plánu', scope: 'Rozsah', scopeReference: 'Reference rozsahu', reason: 'Důvod / poznámka', blindCount: 'Skrýt systémové množství v RF', counted: 'Spočtené množství' },
  actions: { createPlan: 'Vytvoření plánu', releasePlan: 'Uvolnění plánu', submitTask: 'Odevzdání počtu', approveTask: 'Schválení rozdílu' },
};

const english = {
  title: 'Cycle counts',
  eyebrow: 'stock counts, variances, and approval',
  refresh: 'Refresh',
  health: 'Cycle count health',
  plans: 'Plans',
  selectedPlan: 'Selected plan',
  tasks: 'Count tasks',
  countAction: 'Count and approval',
  createPlan: 'New count plan',
  release: 'Release to tasks',
  save: 'Save plan',
  submit: 'Submit count',
  approve: 'Approve variance',
  select: 'Select',
  all: 'All',
  notSet: 'Not set',
  blind: 'Hidden',
  emptySelection: 'Select a cycle count plan.',
  emptyPlansTitle: 'No cycle count plans',
  emptyPlansText: 'Create a plan by location, zone, SKU, or the whole warehouse.',
  emptyTasksTitle: 'No tasks',
  emptyTasksText: 'Tasks are created when a released plan matches stock.',
  metrics: { openPlans: 'Open plans', tasks: 'Tasks', submitted: 'To approve', variances: 'Variances' },
  columns: { code: 'Code', status: 'Status', scope: 'Scope', released: 'Released', approved: 'Approved', action: 'Action', task: 'Task', location: 'Location', expected: 'System', counted: 'Counted', variance: 'Variance' },
  fields: { search: 'Search', status: 'Status', code: 'Plan code', scope: 'Scope', scopeReference: 'Scope reference', reason: 'Reason / note', blindCount: 'Hide system quantity in RF', counted: 'Counted quantity' },
  actions: { createPlan: 'Create plan', releasePlan: 'Release plan', submitTask: 'Submit count', approveTask: 'Approve variance' },
};

const ukrainian = {
  title: 'Інвентаризації',
  eyebrow: 'підрахунок запасів, розбіжності та затвердження',
  refresh: 'Оновити',
  health: 'Стан інвентаризацій',
  plans: 'Плани',
  selectedPlan: 'Вибраний план',
  tasks: 'Завдання підрахунку',
  countAction: 'Підрахунок і затвердження',
  createPlan: 'Новий план',
  release: 'Випустити в завдання',
  save: 'Зберегти план',
  submit: 'Подати підрахунок',
  approve: 'Затвердити розбіжність',
  select: 'Вибрати',
  all: 'Усе',
  notSet: 'Не задано',
  blind: 'Приховано',
  emptySelection: 'Виберіть план інвентаризації.',
  emptyPlansTitle: 'Немає планів інвентаризації',
  emptyPlansText: 'Створіть план за локацією, зоною, SKU або всім складом.',
  emptyTasksTitle: 'Немає завдань',
  emptyTasksText: 'Завдання створюються після випуску плану, якщо в межах є запас.',
  metrics: { openPlans: 'Відкриті плани', tasks: 'Завдання', submitted: 'На затвердження', variances: 'Розбіжності' },
  columns: { code: 'Код', status: 'Статус', scope: 'Межі', released: 'Випущено', approved: 'Затверджено', action: 'Дія', task: 'Завдання', location: 'Локація', expected: 'Система', counted: 'Пораховано', variance: 'Різниця' },
  fields: { search: 'Пошук', status: 'Статус', code: 'Код плану', scope: 'Межі', scopeReference: 'Посилання меж', reason: 'Причина / нотатка', blindCount: 'Приховати системну кількість у RF', counted: 'Порахована кількість' },
  actions: { createPlan: 'Створення плану', releasePlan: 'Випуск плану', submitTask: 'Подання підрахунку', approveTask: 'Затвердження розбіжності' },
};

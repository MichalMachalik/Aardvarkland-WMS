const cycleText = {
  cs: ['Inventury','Plány inventury','Vybraný plán','Úkoly inventury','Zadat počet','Vytvořit plán','Kód plánu','Rozsah','Reference rozsahu','Slepé počítání','Uvolnit plán','Zjištěné množství','Důvod','Odeslat počet','Schválit úkol','Očekáváno','Rozdíl','Vybrat','Vyhledat plán','Kód nebo rozsah není platný.','Zadejte nezáporný celý počet.','Zatím nejsou žádné úkoly.'],
  en: ['Cycle counts','Cycle count plans','Selected plan','Cycle count tasks','Record count','Create plan','Plan code','Scope','Scope reference','Blind count','Release plan','Counted quantity','Reason','Submit count','Approve task','Expected','Variance','Select','Search plans','Enter a unique code and a matching scope.','Enter a non-negative whole quantity.','There are no count tasks yet.'],
  ua: ['Інвентаризації','Плани інвентаризації','Вибраний план','Завдання підрахунку','Записати підрахунок','Створити план','Код плану','Область','Посилання області','Сліпий підрахунок','Випустити план','Підрахована кількість','Причина','Надіслати підрахунок','Затвердити завдання','Очікувано','Розбіжність','Вибрати','Пошук планів','Вкажіть унікальний код і наявну область.','Вкажіть ціле невід’ємне число.','Поки немає завдань підрахунку.'],
};
const cycleStore='aardvarkland-wms-demo-cycle-plans';
const cycleCodePattern=/^[A-Z0-9][A-Z0-9_-]{0,35}$/;
const countPlanStatuses=['DRAFT','RELEASED','COUNTING','RECONCILING','APPROVED'];
let demoCyclePlans;
try { demoCyclePlans=JSON.parse(localStorage.getItem(cycleStore)); } catch { /* Use the initial fictional plan. */ }
if(!Array.isArray(demoCyclePlans)||!demoCyclePlans.every(validCyclePlan)) {
  demoCyclePlans=[{code:'COUNT-18',scope:'LOCATION',reference:'A-01-03',status:'DRAFT',blind:false,tasks:[]}];
}
let cyclePlanCode='';
let cycleTaskIndex=0;
let cycleQuery='';
let cycleStatus='';

function validCyclePlan(plan) {
  const validQuantity=value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000;
  return plan&&typeof plan.code==='string'&&cycleCodePattern.test(plan.code)&&
    countPlanStatuses.includes(plan.status)&&typeof plan.reference==='string'&&
    Array.isArray(plan.tasks)&&plan.tasks.every(task=>task&&typeof task.location==='string'&&
      typeof task.sku==='string'&&validQuantity(task.expected)&&
      (task.status==='OPEN'?task.counted===null:['SUBMITTED','APPROVED'].includes(task.status)&&validQuantity(task.counted)));
}

function saveCyclePlans() {
  try { localStorage.setItem(cycleStore,JSON.stringify(demoCyclePlans)); }
  catch { /* The demonstration also works without browser storage. */ }
}

function selectedCyclePlan() { return demoCyclePlans.find(plan=>plan.code===cyclePlanCode)||demoCyclePlans[0]; }

function cycleTargets(scope,reference) {
  const matching=inventoryRows.filter(item=>scope==='ALL'||(scope==='SKU'&&item.sku===reference)||
    (scope==='LOCATION'&&item.location===reference)||(scope==='ZONE'&&item.location.split('-')[0]===reference));
  return matching;
}

function cycleAdjustedStock(item) {
  const adjustment=demoCyclePlans.flatMap(plan=>plan.tasks).filter(task=>task.status==='APPROVED'&&task.sku===item.sku&&task.location===item.location)
    .reduce((sum,task)=>sum+task.counted-task.expected,0);
  return item.available+adjustment;
}

function renderCycleCountWorkspace() {
  const [title,plans,selected,tasks,record,create,code,scope,reference,blind,release,counted,reason,submit,approve,expected,variance,select,search,,,empty]=cycleText[state.language]||cycleText.en;
  const plan=selectedCyclePlan();
  const task=plan?.tasks[cycleTaskIndex];
  const rows=demoCyclePlans.filter(entry=>(!cycleStatus||entry.status===cycleStatus)&&`${entry.code} ${entry.reference}`.toLowerCase().includes(cycleQuery.toLowerCase()));
  const statuses={DRAFT:{cs:'Koncept',en:'Draft',ua:'Чернетка'},RELEASED:{cs:'Uvolněno',en:'Released',ua:'Випущено'},COUNTING:{cs:'Probíhá',en:'Counting',ua:'Підрахунок'},RECONCILING:{cs:'Ke schválení',en:'Reconciling',ua:'До затвердження'},APPROVED:{cs:'Schváleno',en:'Approved',ua:'Затверджено'}};
  const taskRows=plan?.tasks||[];
  const metrics=renderMetrics([
    {label:{cs:'Otevřené plány',en:'Open plans',ua:'Відкриті плани'},value:demoCyclePlans.filter(entry=>entry.status!=='APPROVED').length,detail:''},
    {label:{cs:'Úkoly',en:'Tasks',ua:'Завдання'},value:taskRows.length,detail:''},
    {label:{cs:'Odesláno',en:'Submitted',ua:'Надіслано'},value:taskRows.filter(row=>row.status==='SUBMITTED').length,detail:''},
    {label:{cs:'Rozdíly',en:'Variances',ua:'Розбіжності'},value:taskRows.filter(row=>row.counted!=null&&row.counted!==row.expected).length,detail:''},
  ]);
  return `<header class="view-heading"><h2>${title}</h2></header>${metrics}
    <div class="cycle-grid"><section class="panel"><div class="panel-heading"><h2>${plans}</h2></div>
      <form data-cycle-form="search" class="cycle-search"><label>${search}<input name="query" type="search" value="${escapeHtml(cycleQuery)}"></label><label>${t().fields.status}<select name="status"><option value="">${{cs:'Vše',en:'All',ua:'Усі'}[state.language]||'All'}</option>${countPlanStatuses.map(status=>`<option value="${status}" ${cycleStatus===status?'selected':''}>${html(statuses[status])}</option>`).join('')}</select></label><button class="text-button" type="submit">${search}</button></form>
      <div class="cycle-table"><table><thead><tr><th>${code}</th><th>${scope}</th><th>${t().fields.status}</th><th></th></tr></thead><tbody>
      ${rows.map(entry=>`<tr><td>${escapeHtml(entry.code)}</td><td>${escapeHtml(entry.reference||entry.scope)}</td><td>${html(statuses[entry.status]||entry.status)}</td><td><button type="button" class="text-button" data-cycle-action="select-plan" data-cycle-code="${escapeHtml(entry.code)}" aria-pressed="${entry===plan}">${select}</button></td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><div class="panel-heading"><h2>${selected}</h2></div>${plan?`<strong data-cycle-plan-status>${escapeHtml(plan.code)} · ${html(statuses[plan.status]||plan.status)}</strong>
        <form data-cycle-form="release" class="cycle-stack"><label class="cycle-checkbox"><input type="checkbox" name="blind" ${plan.blind?'checked':''} ${plan.status==='DRAFT'?'':'disabled'}>${blind}</label><button class="text-button" type="submit" ${plan.status==='DRAFT'?'':'disabled'}>${release}</button></form>`:''}</section></div>
    <div class="cycle-grid"><section class="panel"><div class="panel-heading"><h2>${tasks}</h2></div>${taskRows.length?`<div class="cycle-table"><table><thead><tr><th>SKU</th><th>${t().fields.location}</th><th>${expected}</th><th>${counted}</th><th>${variance}</th><th></th></tr></thead><tbody>
      ${taskRows.map((row,index)=>`<tr><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.location)}</td><td>${plan.blind&&row.status==='OPEN'?'–':row.expected}</td><td>${row.counted??'–'}</td><td>${row.counted==null?'–':row.counted-row.expected}</td><td><button type="button" class="text-button" data-cycle-action="select-task" data-cycle-index="${index}" aria-pressed="${index===cycleTaskIndex}">${select}</button></td></tr>`).join('')}</tbody></table></div>`:`<p>${empty}</p>`}</section>
      <section class="panel"><div class="panel-heading"><h2>${record}</h2></div><form data-cycle-form="count" class="cycle-stack"><label>${counted}<input name="counted" inputmode="numeric" required value="${task?.counted??''}" ${task?.status==='OPEN'?'':'disabled'}></label>
        <label>${reason}<textarea name="reason" rows="3" maxlength="160">${escapeHtml(task?.reason||'')}</textarea></label><div class="cycle-actions"><button class="text-button" type="submit" ${task?.status==='OPEN'?'':'disabled'}>${submit}</button><button class="text-button" type="button" data-cycle-action="approve" ${task?.status==='SUBMITTED'?'':'disabled'}>${approve}</button></div></form></section></div>
    <section class="panel"><div class="panel-heading"><h2>${create}</h2></div><form data-cycle-form="create" class="cycle-fields"><label>${code}<input name="code" maxlength="36" required></label><label>${scope}<select name="scope"><option value="LOCATION">${t().fields.location}</option><option value="SKU">SKU</option><option value="ZONE">${{cs:'Zóna',en:'Zone',ua:'Зона'}[state.language]||'Zone'}</option><option value="ALL">${{cs:'Celý sklad',en:'Entire warehouse',ua:'Увесь склад'}[state.language]||'Entire warehouse'}</option></select></label>
      <label>${reference}<input name="reference" list="cycle-references" maxlength="36" required><datalist id="cycle-references">${inventoryRows.map(item=>`<option value="${escapeHtml(item.location)}">`).join('')}</datalist></label><button class="text-button" type="submit">${create}</button></form></section>`;
}

function updateCyclePlanStatus(plan) {
  plan.status=plan.tasks.every(task=>task.status==='APPROVED')?'APPROVED':plan.tasks.some(task=>task.status==='OPEN')?'COUNTING':'RECONCILING';
  saveCyclePlans();
  renderView();
}

document.addEventListener('submit',event=>{
  const form=event.target;
  const action=form.dataset?.cycleForm;
  if(!action)return;
  event.preventDefault();
  const inputs=form.elements;
  const plan=selectedCyclePlan();
  const words=cycleText[state.language]||cycleText.en;
  if(action==='search') { cycleQuery=inputs.query.value.trim();cycleStatus=inputs.status.value;renderView();return; }
  if(action==='create') {
    const code=inputs.code.value.trim().toUpperCase();
    const scope=inputs.scope.value;
    const reference=scope==='ALL'?'':inputs.reference.value.trim().toUpperCase();
    if(!cycleCodePattern.test(code)||demoCyclePlans.some(entry=>entry.code===code)||!cycleTargets(scope,reference).length) {
      inputs.code.setCustomValidity(words[19]);inputs.code.reportValidity();return;
    }
    demoCyclePlans.unshift({code,scope,reference,status:'DRAFT',blind:false,tasks:[]});
    cyclePlanCode=code;cycleQuery='';cycleStatus='';cycleTaskIndex=0;
    saveCyclePlans();renderView();return;
  }
  if(action==='release'&&plan?.status==='DRAFT') {
    plan.blind=inputs.blind.checked;
    plan.tasks=cycleTargets(plan.scope,plan.reference).map(item=>({sku:item.sku,location:item.location,expected:cycleAdjustedStock(item),counted:null,reason:'',status:'OPEN'}));
    if(!plan.tasks.length)return;
    plan.status='RELEASED';cycleTaskIndex=0;
    saveCyclePlans();renderView();return;
  }
  const task=plan?.tasks[cycleTaskIndex];
  if(action==='count'&&task?.status==='OPEN') {
    const value=inputs.counted.value.trim();
    const number=Number(value);
    if(!/^\d+$/.test(value)||!Number.isSafeInteger(number)||number>1_000_000_000) {
      inputs.counted.setCustomValidity(words[20]);inputs.counted.reportValidity();return;
    }
    task.counted=number;task.reason=inputs.reason.value.trim();task.status='SUBMITTED';
    updateCyclePlanStatus(plan);
  }
});

document.addEventListener('input',event=>{
  const form=event.target.form;
  if(form?.dataset.cycleForm==='create')form.elements.code.setCustomValidity('');
  if(form?.dataset.cycleForm==='count'&&event.target.name==='counted')event.target.setCustomValidity('');
});

document.addEventListener('change',event=>{
  const form=event.target.form;
  if(form?.dataset.cycleForm!=='create'||event.target.name!=='scope')return;
  const reference=form.elements.reference;
  reference.required=event.target.value!=='ALL';
  reference.disabled=!reference.required;
  const values=inventoryRows.map(item=>event.target.value==='SKU'?item.sku:event.target.value==='ZONE'?item.location.split('-')[0]:item.location);
  reference.value='';
  form.querySelector('datalist').innerHTML=[...new Set(values)].map(value=>`<option value="${escapeHtml(value)}">`).join('');
});

document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-cycle-action]');
  if(!button||button.disabled)return;
  const action=button.dataset.cycleAction;
  if(action==='select-plan') {cyclePlanCode=button.dataset.cycleCode;cycleTaskIndex=0;renderView();return;}
  if(action==='select-task') {cycleTaskIndex=Number(button.dataset.cycleIndex);renderView();return;}
  const plan=selectedCyclePlan();
  const task=plan?.tasks[cycleTaskIndex];
  if(action==='approve'&&task?.status==='SUBMITTED') {
    task.status='APPROVED';updateCyclePlanStatus(plan);
  }
});

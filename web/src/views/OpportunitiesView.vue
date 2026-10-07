<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useDragAutoScroll } from '../composables/useDragAutoScroll';
import { useWs } from '../composables/useWs';
import { useRoute, useRouter } from 'vue-router';
import { useDialog } from '../composables/useDialog';
import { Plus, Search, Filter, Download, Upload, X, Trash2, MoreVertical, ChevronDown, Check, UserRound, Briefcase, Kanban, StickyNote, UserPlus, Link2, SlidersHorizontal, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-vue-next';
import { api, getToken } from '../api';
import type { Pipeline, Opportunity, OppTotal, OppPage, FilterCondition, FilterOp, Note, User, Task, TaskStatus } from '../types';
import { ListTodo, CalendarClock } from 'lucide-vue-next';
import OppTabs from '../components/OppTabs.vue';
import Dropdown from '../components/Dropdown.vue';
import Spinner from '../components/Spinner.vue';
import LoadingState from '../components/LoadingState.vue';
import OpportunityCard from '../components/OpportunityCard.vue';
import CustomizeCardPanel from '../components/CustomizeCardPanel.vue';
import ViewToggle from '../components/ViewToggle.vue';
import StatusSelect from '../components/StatusSelect.vue';
import BizSelect from '../components/BizSelect.vue';
import AdSourceCard from '../components/AdSourceCard.vue';
import { normalizeCardConfig, type CardConfig } from '../cardConfig';
import { useAuthStore } from '../stores/auth';
import OpportunityFormModal from '../components/opportunities/OpportunityFormModal.vue';
import { SOURCE_OPTS, STATUS_OPTS, dateTime } from '../utils/opportunities';



const pipelines = ref<Pipeline[]>([]);
const users = ref<User[]>([]);
const currentId = ref<string>('');
// Oportunidades CARGADAS (paginadas: las primeras PAGE de cada columna + las que se piden con "cargar más")
const opps = ref<Opportunity[]>([]);
// Totales de TODO lo filtrado por etapa y estado (los contadores no dependen de lo cargado)
const totals = ref<OppTotal[]>([]);
const PAGE = 50;        // por columna en el tablero
const LIST_PAGE = 100;  // en la vista de lista
const MAX_LIMIT = 1000; // tope del servidor por petición
const dragId = ref<string | null>(null);
// Auto-scroll del tablero al arrastrar cerca de los bordes
const boardEl = ref<HTMLElement | null>(null);
const autoScroll = useDragAutoScroll(boardEl);
const { alert, confirm } = useDialog();
const loading = ref(true);
const reloading = ref(false);

// Personalización de tarjetas (persistida en la cuenta del usuario).
const router = useRouter();
const route = useRoute();
const auth = useAuthStore();
const cardConfig = computed<CardConfig>(() => normalizeCardConfig(auth.preferences.cardConfig));
const showCustomize = ref(false);
async function applyCardConfig(c: CardConfig) {
  showCustomize.value = false;
  await auth.savePreferences({ cardConfig: c });
}

// Vista tablero/lista (recordada en la cuenta).
const viewMode = ref<'board' | 'list'>(auth.preferences.oppView === 'list' ? 'list' : 'board');
watch(viewMode, v => { auth.savePreferences({ oppView: v }); loadOpps(); });
const stageById = computed(() => {
  const m: Record<string, { name: string; color: string }> = {};
  (current.value?.stages ?? []).forEach(s => { m[s.id] = { name: s.name, color: s.color }; });
  return m;
});
const statusBadgeCls: Record<string, string> = { open: 'bg-blue-50 text-blue-600', won: 'bg-emerald-50 text-emerald-600', lost: 'bg-red-50 text-red-600' };
const statusLbl: Record<string, string> = { open: 'Abierta', won: 'Ganada', lost: 'Perdida' };

const search = ref('');
const showFilters = ref(false);    // sidebar de filtros
const match = ref<'AND' | 'OR'>('AND');
const conditions = ref<FilterCondition[]>([]);

// ── Quick-filter sidebar state ────────────────────────────────────────────────
const qf = ref({
  statuses:      [] as string[],
  stageIds:      [] as string[],
  owner_id:      '',
  value_min:     '',
  value_max:     '',
  source:        '',
  business_name: '',
  contact:       '',
  tags:          '',
  created_from:  '',
  created_to:    '',
});

const activeQfCount = computed(() => {
  const q = qf.value;
  return [
    q.statuses.length > 0, q.stageIds.length > 0, !!q.owner_id,
    !!q.value_min || !!q.value_max, !!q.source, !!q.business_name,
    !!q.contact, !!q.tags, !!q.created_from || !!q.created_to,
  ].filter(Boolean).length;
});

function toggleQfStatus(v: string) {
  const i = qf.value.statuses.indexOf(v);
  if (i >= 0) qf.value.statuses.splice(i, 1); else qf.value.statuses.push(v);
}
function toggleQfStage(id: string) {
  const i = qf.value.stageIds.indexOf(id);
  if (i >= 0) qf.value.stageIds.splice(i, 1); else qf.value.stageIds.push(id);
}
function applyQf() {
  conditions.value = [];
  qf.value.statuses.forEach(s  => conditions.value.push({ field: 'status',        op: 'is',       value: s }));
  qf.value.stageIds.forEach(id => conditions.value.push({ field: 'stage',         op: 'is',       value: id }));
  if (qf.value.owner_id)      conditions.value.push({ field: 'owner_id',      op: 'is',       value: qf.value.owner_id });
  if (qf.value.value_min)     conditions.value.push({ field: 'value',         op: 'gte',      value: qf.value.value_min });
  if (qf.value.value_max)     conditions.value.push({ field: 'value',         op: 'lte',      value: qf.value.value_max });
  if (qf.value.source)        conditions.value.push({ field: 'source',        op: 'contains', value: qf.value.source });
  if (qf.value.business_name) conditions.value.push({ field: 'business_name', op: 'contains', value: qf.value.business_name });
  if (qf.value.contact)       conditions.value.push({ field: 'contact',       op: 'contains', value: qf.value.contact });
  if (qf.value.tags)          conditions.value.push({ field: 'tags',          op: 'contains', value: qf.value.tags });
  if (qf.value.created_from)  conditions.value.push({ field: 'created_at',    op: 'after',    value: qf.value.created_from });
  if (qf.value.created_to)    conditions.value.push({ field: 'created_at',    op: 'before',   value: qf.value.created_to });
  const hasMulti = qf.value.statuses.length > 1 || qf.value.stageIds.length > 1;
  match.value = hasMulti ? 'OR' : 'AND';
  loadOpps();
  showFilters.value = false;
}
function clearQf() {
  qf.value = {
    statuses: [], stageIds: [], owner_id: '', value_min: '', value_max: '',
    source: '', business_name: '', contact: '', tags: '', created_from: '', created_to: '',
  };
  conditions.value = [];
  match.value = 'AND';
  loadOpps();
}

const current = computed(() => pipelines.value.find(p => p.id === currentId.value) ?? null);
const totalLeads = computed(() => totals.value.reduce((s, t) => s + t.count, 0));
const money = (n: number) => n.toLocaleString('es-VE', { style: 'currency', currency: 'USD' });

// ── Catálogo de campos filtrables ─────────────────────────────────────────────
const FIELDS = [
  { key: 'title', label: 'Título', type: 'text' },
  { key: 'value', label: 'Valor', type: 'number' },
  { key: 'status', label: 'Estado', type: 'enum' },
  { key: 'stage', label: 'Etapa', type: 'stage' },
  { key: 'contact', label: 'Contacto', type: 'text' },
  { key: 'ad', label: 'Anuncio de origen', type: 'text' },
  { key: 'created_at', label: 'Fecha de creación', type: 'date' },
] as const;
const OPS_BY_TYPE: Record<string, FilterOp[]> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  enum: ['is', 'is_not'], stage: ['is', 'is_not'], date: ['after', 'before'],
};
const OP_LABEL: Record<FilterOp, string> = {
  contains: 'contiene', not_contains: 'no contiene', is: 'es', is_not: 'no es',
  is_empty: 'está vacío', is_not_empty: 'no está vacío',
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', after: 'después de', before: 'antes de',
};
const NO_VALUE: FilterOp[] = ['is_empty', 'is_not_empty'];
function fieldType(key: string) { return FIELDS.find(f => f.key === key)?.type ?? 'text'; }

// ── Carga ──────────────────────────────────────────────────────────────────────
async function loadPipelines() {
  pipelines.value = await api.get<Pipeline[]>('/pipelines');
  if ((!currentId.value || !current.value) && pipelines.value[0]) currentId.value = pipelines.value[0].id;
}
// ── Sort ──────────────────────────────────────────────────────────────────────
const SORT_OPTIONS = [
  { key: 'title',             label: 'Nombre de oportunidad' },
  { key: 'status',            label: 'Estado' },
  { key: 'value',             label: 'Valor' },
  { key: 'source',            label: 'Fuente' },
  { key: 'created_at',        label: 'Fecha de creación' },
  { key: 'updated_at',        label: 'Última actualización' },
  { key: 'last_stage_change', label: 'Último cambio de etapa' },
];
// Sort — persistido en localStorage; default: más reciente primero
const OPPS_PREF_KEY = 'crm.opps.sort';
function loadOppSort() {
  try { return JSON.parse(localStorage.getItem(OPPS_PREF_KEY) || '{}'); } catch { return {}; }
}
const _os = loadOppSort();
const sortBy  = ref<string>(_os.sortBy  ?? 'created_at');
const sortDir = ref<'asc' | 'desc'>(_os.sortDir ?? 'desc');
const hasSort = computed(() => sortBy.value !== 'created_at' || sortDir.value !== 'desc');

function saveOppSort() {
  localStorage.setItem(OPPS_PREF_KEY, JSON.stringify({ sortBy: sortBy.value, sortDir: sortDir.value }));
}
function clearSort() {
  sortBy.value = 'created_at'; sortDir.value = 'desc';
  saveOppSort(); loadOpps();
}
function toggleSortDir() {
  sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  saveOppSort(); loadOpps();
}
function selectSort(key: string) {
  if (sortBy.value === key) { toggleSortDir(); return; }
  sortBy.value = key; sortDir.value = 'desc';
  saveOppSort(); loadOpps();
}

// Cuerpo común de /opportunities/query y de la exportación CSV (búsqueda, filtros y orden actuales).
function queryBody() {
  const filters = conditions.value
    .filter(c => c.field && c.op && (NO_VALUE.includes(c.op) || (c.value !== '' && c.value != null)))
    .map(c => ({ field: c.field, op: c.op, value: fieldType(c.field) === 'number' ? Number(c.value) : c.value }));
  return {
    pipelineId: currentId.value, search: search.value || undefined, match: match.value, filters,
    sort_by: sortBy.value || undefined, sort_dir: sortDir.value,
  };
}

// Cada carga completa invalida las respuestas en vuelo anteriores (y los "cargar más" pendientes).
let loadSeq = 0;

// Carga la primera página. Con keep (recarga en tiempo real, tras guardar/borrar) conserva cuántas
// tarjetas había cargadas para no "encoger" la columna que el usuario ya había desplegado.
async function loadOpps(opts: { keep?: boolean } = {}) {
  if (!currentId.value) return;
  const isList = viewMode.value === 'list';
  let limit = isList ? LIST_PAGE : PAGE;
  if (opts.keep) {
    if (isList) limit = Math.max(limit, opps.value.length);
    else for (const id of new Set(opps.value.map(o => o.stage_id))) limit = Math.max(limit, stageOpps(id).length);
  }
  const seq = ++loadSeq;
  reloading.value = true;
  try {
    const page = await api.post<OppPage>('/opportunities/query', {
      ...queryBody(), limit: Math.min(limit, MAX_LIMIT), group: isList ? 'none' : 'stage',
    });
    if (seq !== loadSeq) return;
    opps.value = page.opportunities;
    totals.value = page.totals;
  } finally {
    if (seq === loadSeq) reloading.value = false;
  }
}

// "Cargar más": siguiente página de una columna (stageId) o de la lista (sin stageId).
const loadingMore = ref<Record<string, boolean>>({});
async function loadMore(stageId?: string) {
  const key = stageId ?? '__list';
  if (loadingMore.value[key] || !currentId.value) return;
  const loaded = stageId ? stageOpps(stageId).length : opps.value.length;
  if (loaded >= (stageId ? stageCount(stageId) : totalLeads.value)) return;
  const seq = loadSeq;
  loadingMore.value[key] = true;
  try {
    const page = await api.post<OppPage>('/opportunities/query', {
      ...queryBody(), limit: stageId ? PAGE : LIST_PAGE, offset: loaded,
      ...(stageId ? { stageId, group: 'stage' } : { group: 'none' }),
    });
    if (seq !== loadSeq) return; // hubo una recarga completa mientras tanto
    // Sin duplicados si entraron leads nuevos entre página y página (desplazan el offset)
    const have = new Set(opps.value.map(o => o.id));
    opps.value.push(...page.opportunities.filter(o => !have.has(o.id)));
    totals.value = page.totals;
  } finally {
    loadingMore.value[key] = false;
  }
}
// Scroll infinito: al acercarse al final de una columna (o de la lista) se pide la siguiente página.
function onScrollEnd(e: Event, stageId?: string) {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) loadMore(stageId);
}

onMounted(async () => {
  try {
    users.value = await api.get<User[]>('/users');
    await loadPipelines();
    await loadOpps();
  } finally {
    loading.value = false;
  }
  openFromQuery();
});
// (durante la carga inicial lo hace onMounted: evita pedir dos veces la primera página)
watch(currentId, () => { if (!loading.value) loadOpps(); });

// Abrir una oportunidad por URL (/opportunities?open=<id>, p. ej. desde una cita del calendario):
// cambia al pipeline de la oportunidad y abre su modal.
async function openFromQuery() {
  const id = route.query.open;
  if (typeof id !== 'string' || !id) return;
  router.replace({ query: { ...route.query, open: undefined } });
  try {
    const o = await api.get<Opportunity>(`/opportunities/${id}`);
    if (o.pipeline_id !== currentId.value) currentId.value = o.pipeline_id;
    await openEdit(o);
  } catch { /* oportunidad inexistente o de otra cuenta */ }
}
watch(() => route.query.open, v => { if (v && !loading.value) openFromQuery(); });

// Tiempo real: los leads que crean los bots/webhooks aparecen sin recargar la página
const { on: onWs } = useWs();
let wsReloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload() {
  clearTimeout(wsReloadTimer);
  wsReloadTimer = setTimeout(() => loadOpps({ keep: true }), 500);
}
onWs('opportunity:new', scheduleReload);
// Cambios de etapa/estado hechos en otro sitio (p. ej. desde la cita en el calendario)
onWs('opportunity:updated', scheduleReload);

// Nº de condiciones realmente aplicadas (con valor válido).
const activeFilterCount = computed(() => conditions.value.filter(
  c => c.field && c.op && (NO_VALUE.includes(c.op) || (c.value !== '' && c.value != null)),
).length);
function clearFilters() { conditions.value = []; loadOpps(); }

let searchTimer: ReturnType<typeof setTimeout>;
function onSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(loadOpps, 250); }

// ── Kanban helpers ───────────────────────────────────────────────────────────
function stageOpps(stageId: string) { return opps.value.filter(o => o.stage_id === stageId); }
// Total y suma de la columna: de TODO lo filtrado, no solo de las tarjetas cargadas
function stageCount(stageId: string) { return totals.value.reduce((s, t) => s + (t.stage_id === stageId ? t.count : 0), 0); }
function stageSum(stageId: string) { return money(totals.value.reduce((s, t) => s + (t.stage_id === stageId ? Number(t.value) : 0), 0)); }
function stageHasMore(stageId: string) { return stageOpps(stageId).length < stageCount(stageId); }
// Mueve una oportunidad entre columnas en los totales locales (antes de que llegue la recarga)
function moveInTotals(o: Opportunity, from: string, to: string) {
  const v = Number(o.value);
  const row = (stage: string) => {
    let t = totals.value.find(x => x.stage_id === stage && x.status === o.status);
    if (!t) { t = { stage_id: stage, status: o.status, count: 0, value: 0 }; totals.value.push(t); }
    return t;
  };
  const a = row(from); a.count = Math.max(0, a.count - 1); a.value = Number(a.value) - v;
  const b = row(to); b.count += 1; b.value = Number(b.value) + v;
}

// ── Drag & drop ──────────────────────────────────────────────────────────────
function onDragStart(id: string) { dragId.value = id; }
async function onDrop(stageId: string) {
  const id = dragId.value; dragId.value = null;
  if (!id) return;
  const opp = opps.value.find(o => o.id === id);
  if (!opp || opp.stage_id === stageId) return;
  const from = opp.stage_id;
  opp.stage_id = stageId;
  moveInTotals(opp, from, stageId);
  try {
    await api.patch(`/opportunities/${id}`, { stage_id: stageId });
  } catch (e) {
    opp.stage_id = from; // revertir si el servidor lo rechazó
    moveInTotals(opp, stageId, from);
    throw e;
  }
}

// ── Filtros ──────────────────────────────────────────────────────────────────
function addCondition() { conditions.value.push({ field: 'title', op: 'contains', value: '' }); }
function removeCondition(i: number) { conditions.value.splice(i, 1); loadOpps(); }
function onFieldChange(c: FilterCondition) { c.op = OPS_BY_TYPE[fieldType(c.field)][0]; c.value = ''; loadOpps(); }

// ── Import / Export CSV ──────────────────────────────────────────────────────
const fileInput = ref<HTMLInputElement | null>(null);
// Exporta TODO lo filtrado (búsqueda + filtros + orden), no solo las tarjetas cargadas en pantalla
async function exportCsv() {
  const res = await fetch('/api/opportunities/export/csv', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(queryBody()),
  });
  if (!res.ok) { alert('No se pudo exportar el CSV'); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = 'oportunidades.csv'; a.click();
  URL.revokeObjectURL(url);
}
async function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const csv = await file.text();
  const res = await api.post<{ imported: number; errors: string[] }>('/opportunities/import', { pipelineId: currentId.value, csv });
  alert(`Importadas: ${res.imported}${res.errors.length ? `\nErrores:\n${res.errors.join('\n')}` : ''}`);
  if (fileInput.value) fileInput.value.value = '';
  await loadOpps({ keep: true });
}

function openConversation(contactId: string) {
  router.push({ path: '/conversations', query: { contact_id: contactId } });
}

// ── Formulario de oportunidad (components/opportunities/OpportunityFormModal.vue) ──
const oppForm = ref<InstanceType<typeof OpportunityFormModal> | null>(null);
function openCreate() { oppForm.value?.openCreate(); }
async function openEdit(o: Opportunity, tab: 'detalles' | 'notas' = 'detalles') { await oppForm.value?.openEdit(o, tab); }
</script>

<template>
  <div class="flex h-full flex-col">
    <OppTabs />

    <!-- Toolbar superior: tabs de vista + controles -->
    <div class="z-[4] border-b border-slate-200 bg-white shadow-toolbar">

      <!-- Fila 1 MÓVIL: view tabs a todo ancho | Fila 1 DESKTOP: tabs + pipeline + acciones -->
      <div class="flex items-center gap-0 px-3 pt-1 sm:px-4">
        <!-- View tabs (Tablero / Lista) -->
        <button class="view-tab" :class="viewMode === 'board' ? 'view-tab--active' : ''" @click="viewMode = 'board'">
          <Kanban class="h-3.5 w-3.5" /> Tablero
        </button>
        <button class="view-tab" :class="viewMode === 'list' ? 'view-tab--active' : ''" @click="viewMode = 'list'">
          <SlidersHorizontal class="h-3.5 w-3.5" /> Lista
        </button>

        <!-- Divider + pipeline + acciones (solo en ≥ sm, en móvil van en fila 2) -->
        <div class="hidden items-center gap-0 sm:flex sm:flex-1">
          <div class="mx-3 h-5 w-px flex-shrink-0 bg-slate-200"></div>

          <!-- Pipeline selector -->
          <Dropdown width="240px">
            <template #trigger="{ open }">
              <button class="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-all hover:border-slate-300 hover:shadow-sm" :class="open && 'border-primary ring-2 ring-primary/20'">
                <span class="h-2 w-2 flex-shrink-0 rounded-full bg-primary"></span>
                <span class="max-w-[200px] truncate">{{ current?.name ?? 'Pipeline' }}</span>
                <ChevronDown class="h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform" :class="open && 'rotate-180'" />
              </button>
            </template>
            <template #default="{ close }">
              <button v-for="p in pipelines" :key="p.id"
                class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-slate-100"
                :class="p.id === currentId ? 'text-primary' : 'text-slate-700'"
                @click="currentId = p.id; close()">
                {{ p.name }}
                <Check v-if="p.id === currentId" class="h-4 w-4" />
              </button>
            </template>
          </Dropdown>

          <span class="ml-2 flex-shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-500">{{ totalLeads }}</span>

          <!-- Right actions (desktop) -->
          <div class="ml-auto flex flex-shrink-0 items-center gap-1.5 py-2">
            <div class="relative hidden md:block">
              <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input v-model="search" @input="onSearch" placeholder="Buscar oportunidades…" class="w-40 rounded-lg border border-slate-200 py-1.5 pl-9 pr-3 text-sm transition-all focus:border-primary focus:shadow-sm focus:ring-2 focus:ring-primary/20 focus:outline-none lg:w-52" />
            </div>
            <button class="btn btn-sm" :class="showFilters || activeQfCount ? 'btn-secondary btn-secondary--active' : 'btn-secondary'" @click="showFilters = true">
              <Filter class="h-4 w-4" /> Filtros
              <span v-if="activeQfCount" class="rounded-full bg-primary px-1.5 text-xs font-bold text-white">{{ activeQfCount }}</span>
            </button>
            <Dropdown align="right" width="260px">
              <template #trigger="{ open }">
                <button class="btn btn-sm" :class="hasSort || open ? 'btn-secondary btn-secondary--active' : 'btn-secondary'">
                  <ArrowUpDown class="h-4 w-4" /> Ordenar
                  <span v-if="hasSort" class="rounded-full bg-primary px-1.5 text-xs font-bold text-white">1</span>
                </button>
              </template>
              <div class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <p class="text-[13px] font-semibold text-slate-800">Ordenar por</p>
                <button v-if="hasSort" class="cursor-pointer text-[11px] font-medium text-primary hover:underline" @click="clearSort">Limpiar</button>
              </div>
              <div class="py-1.5">
                <button v-for="opt in SORT_OPTIONS" :key="opt.key"
                  class="flex w-full cursor-pointer items-center justify-between px-4 py-2 text-[13px] transition-colors"
                  :class="sortBy === opt.key ? 'bg-primary/5 font-semibold text-primary' : 'text-slate-700 hover:bg-slate-50'"
                  @click="selectSort(opt.key)">
                  <span>{{ opt.label }}</span>
                  <span v-if="sortBy === opt.key" class="flex items-center gap-1 text-[11px] font-medium">
                    <component :is="sortDir === 'asc' ? ArrowUp : ArrowDown" class="h-3.5 w-3.5" />
                    {{ sortDir === 'asc' ? 'A → Z' : 'Z → A' }}
                  </span>
                </button>
              </div>
            </Dropdown>
            <Dropdown align="right" width="180px">
              <template #trigger="{ open }">
                <button class="cursor-pointer rounded-lg border border-slate-200 p-2 text-slate-400 transition-all hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700" :class="open && 'border-primary text-primary'" aria-label="Más acciones">
                  <MoreVertical class="h-4 w-4" />
                </button>
              </template>
              <button class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100" @click="exportCsv">
                <Download class="h-4 w-4 text-slate-400" /> Exportar CSV
              </button>
              <button class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100" @click="fileInput?.click()">
                <Upload class="h-4 w-4 text-slate-400" /> Importar CSV
              </button>
              <div class="my-1 border-t border-slate-100"></div>
              <button class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100" @click="showCustomize = true">
                <SlidersHorizontal class="h-4 w-4 text-slate-400" /> Personalizar tarjetas
              </button>
            </Dropdown>
            <input ref="fileInput" type="file" accept=".csv" class="hidden" @change="onImportFile" />
            <button class="btn btn-primary btn-sm" @click="openCreate">
              <Plus class="h-4 w-4" /> Crear
            </button>
          </div>
        </div>

        <!-- Acciones móviles (solo < sm, junto a los tabs) -->
        <div class="ml-auto flex flex-shrink-0 items-center gap-1 py-1.5 sm:hidden">
          <button class="btn btn-sm" :class="showFilters || activeQfCount ? 'btn-secondary btn-secondary--active' : 'btn-secondary'" @click="showFilters = true">
            <Filter class="h-4 w-4" />
            <span v-if="activeQfCount" class="rounded-full bg-primary px-1.5 text-xs font-bold text-white">{{ activeQfCount }}</span>
          </button>
          <Dropdown align="right" width="200px">
            <template #trigger="{ open }">
              <button class="cursor-pointer rounded-lg border border-slate-200 p-1.5 text-slate-400 transition-all hover:border-slate-300 hover:bg-slate-50 hover:text-slate-700" :class="open && 'border-primary text-primary'" aria-label="Más">
                <MoreVertical class="h-4 w-4" />
              </button>
            </template>
            <p class="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Ordenar por</p>
            <button v-for="opt in SORT_OPTIONS" :key="opt.key"
              class="flex w-full cursor-pointer items-center justify-between px-3 py-2 text-[13px] transition-colors"
              :class="sortBy === opt.key ? 'font-semibold text-primary' : 'text-slate-700 hover:bg-slate-50'"
              @click="selectSort(opt.key)">
              <span>{{ opt.label }}</span>
              <component v-if="sortBy === opt.key" :is="sortDir === 'asc' ? ArrowUp : ArrowDown" class="h-3.5 w-3.5" />
            </button>
            <div class="my-1 border-t border-slate-100"></div>
            <button class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100" @click="exportCsv">
              <Download class="h-4 w-4 text-slate-400" /> Exportar CSV
            </button>
            <button class="flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100" @click="showCustomize = true">
              <SlidersHorizontal class="h-4 w-4 text-slate-400" /> Personalizar tarjetas
            </button>
          </Dropdown>
          <input ref="fileInput" type="file" accept=".csv" class="hidden" @change="onImportFile" />
          <button class="btn btn-primary btn-sm" @click="openCreate">
            <Plus class="h-4 w-4" />
          </button>
        </div>
      </div>

      <!-- Fila 2 MÓVIL: pipeline selector + count (solo < sm) -->
      <div class="flex items-center gap-2 border-t border-slate-100 px-3 py-2 sm:hidden">
        <Dropdown width="240px">
          <template #trigger="{ open }">
            <button class="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-700 transition-all hover:border-slate-300" :class="open && 'border-primary ring-2 ring-primary/20'">
              <span class="h-2 w-2 flex-shrink-0 rounded-full bg-primary"></span>
              <span class="max-w-[180px] truncate">{{ current?.name ?? 'Pipeline' }}</span>
              <ChevronDown class="h-3.5 w-3.5 flex-shrink-0 text-slate-400 transition-transform" :class="open && 'rotate-180'" />
            </button>
          </template>
          <template #default="{ close }">
            <button v-for="p in pipelines" :key="p.id"
              class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-slate-100"
              :class="p.id === currentId ? 'text-primary' : 'text-slate-700'"
              @click="currentId = p.id; close()">
              {{ p.name }}
              <Check v-if="p.id === currentId" class="h-4 w-4" />
            </button>
          </template>
        </Dropdown>
        <span class="flex-shrink-0 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-500">{{ totalLeads }} oportunidades</span>
      </div>

      <!-- Fila 2: filter chips activos -->
      <div v-if="activeFilterCount > 0" class="flex flex-wrap items-center gap-2 px-4 pb-2">
        <span class="text-xs font-medium text-slate-400">Filtros activos:</span>
        <div v-for="(c, i) in conditions.filter(c => c.field && c.op && (NO_VALUE.includes(c.op) || (c.value !== '' && c.value != null)))" :key="i"
          class="toolbar-chip toolbar-chip--active"
          @click="removeCondition(conditions.indexOf(c))"
        >
          <span>{{ FIELDS.find(f => f.key === c.field)?.label ?? c.field }}: {{ c.value }}</span>
          <span class="toolbar-chip__remove"><X class="h-3 w-3" /></span>
        </div>
        <button class="text-xs font-medium text-slate-400 hover:text-red-600 transition-colors" @click="clearFilters">Limpiar todo</button>
      </div>
    </div>

    <!-- Sidebar de filtros (estilo GHL) -->
    <Teleport to="body">
      <Transition name="filter-sidebar">
        <div v-if="showFilters" class="fixed inset-0 z-50 flex justify-end" @click.self="showFilters = false">
          <!-- Backdrop -->
          <div class="absolute inset-0 bg-black/20 backdrop-blur-[1px]" @click="showFilters = false"></div>

          <!-- Panel -->
          <div class="relative flex h-full w-[340px] flex-col bg-white shadow-2xl">
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div class="flex items-center gap-2.5">
                <Filter class="h-4 w-4 text-primary" />
                <span class="text-[15px] font-semibold text-slate-900">Filtros</span>
                <span v-if="activeQfCount" class="rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-white">{{ activeQfCount }}</span>
              </div>
              <button class="cursor-pointer rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" @click="showFilters = false">
                <X style="height:18px;width:18px" />
              </button>
            </div>

            <!-- Body -->
            <div class="flex-1 overflow-y-auto px-5 py-4 space-y-6">

              <!-- Estado -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Estado</p>
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="s in STATUS_OPTS" :key="s.v"
                    class="qf-chip"
                    :class="qf.statuses.includes(s.v) ? 'qf-chip--on' : ''"
                    @click="toggleQfStatus(s.v)"
                  >{{ s.l }}</button>
                </div>
              </div>

              <!-- Etapa -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Etapa</p>
                <div class="space-y-1.5">
                  <label
                    v-for="stage in current?.stages ?? []" :key="stage.id"
                    class="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-50"
                  >
                    <span
                      class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors"
                      :style="qf.stageIds.includes(stage.id)
                        ? { background: stage.color, borderColor: stage.color }
                        : { borderColor: '#CBD5E1', background: 'white' }"
                      @click.prevent="toggleQfStage(stage.id)"
                    >
                      <Check v-if="qf.stageIds.includes(stage.id)" class="h-2.5 w-2.5 text-white" />
                    </span>
                    <span class="h-2 w-2 rounded-full flex-shrink-0" :style="{ background: stage.color }"></span>
                    <span class="text-[13px] text-slate-700">{{ stage.name }}</span>
                    <input type="checkbox" class="sr-only" :checked="qf.stageIds.includes(stage.id)" @change="toggleQfStage(stage.id)" />
                  </label>
                </div>
              </div>

              <!-- Responsable -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Responsable</p>
                <BizSelect v-model="qf.owner_id" placeholder="Cualquiera" input-class="qf-input w-full"
                  :options="users.map(u => ({ value: u.id, label: u.name }))" />
              </div>

              <!-- Valor -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Valor (USD)</p>
                <div class="flex items-center gap-2">
                  <input v-model="qf.value_min" type="number" placeholder="Mínimo" class="qf-input flex-1 min-w-0" />
                  <span class="text-slate-300 text-sm">—</span>
                  <input v-model="qf.value_max" type="number" placeholder="Máximo" class="qf-input flex-1 min-w-0" />
                </div>
              </div>

              <!-- Origen -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Origen</p>
                <BizSelect v-model="qf.source" placeholder="Todas las fuentes" input-class="qf-input w-full"
                  :options="SOURCE_OPTS.filter(o => o.value !== 'otro')" />
              </div>

              <!-- Empresa -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Empresa</p>
                <input v-model="qf.business_name" type="text" placeholder="Nombre de la empresa" class="qf-input w-full" />
              </div>

              <!-- Contacto -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Contacto</p>
                <input v-model="qf.contact" type="text" placeholder="Nombre del contacto" class="qf-input w-full" />
              </div>

              <!-- Etiquetas -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Etiquetas</p>
                <input v-model="qf.tags" type="text" placeholder="Ej. vip, caliente" class="qf-input w-full" />
              </div>

              <!-- Fecha de creación -->
              <div>
                <p class="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-slate-400">Fecha de creación</p>
                <div class="space-y-2">
                  <div class="flex items-center gap-2">
                    <span class="w-12 text-right text-[11px] text-slate-400">Desde</span>
                    <input v-model="qf.created_from" type="date" class="qf-input flex-1 min-w-0" />
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="w-12 text-right text-[11px] text-slate-400">Hasta</span>
                    <input v-model="qf.created_to" type="date" class="qf-input flex-1 min-w-0" />
                  </div>
                </div>
              </div>

            </div>

            <!-- Footer -->
            <div class="flex items-center gap-2 border-t border-slate-100 px-5 py-3.5">
              <button class="btn btn-ghost" @click="clearQf">Limpiar</button>
              <button class="btn btn-primary ml-auto" @click="applyQf">Aplicar filtros</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Tablero kanban -->
    <LoadingState v-if="loading" label="Cargando oportunidades…" />
    <div v-else-if="viewMode === 'board'" class="flex flex-1 gap-3 overflow-x-auto bg-slate-100/60 p-3 sm:gap-4 sm:p-6" ref="boardEl" @dragover="autoScroll.onDragOver" @drop="autoScroll.stop" @dragend="autoScroll.stop">
      <div
        v-for="stage in current?.stages ?? []"
        :key="stage.id"
        class="flex w-[calc(100vw-3.5rem)] flex-shrink-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card sm:w-80"
        @dragover.prevent
        @drop="onDrop(stage.id)"
      >
        <!-- Kanban column header — estilo GHL/Flowlu -->
        <div
          class="flex-shrink-0 rounded-t-xl px-4 pb-3 pt-3.5"
          :style="{
            borderTop: `3px solid ${stage.color}`,
            background: `color-mix(in srgb, ${stage.color} 12%, #ffffff)`,
          }"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span class="text-[13px] font-semibold text-slate-800 leading-tight">{{ stage.name }}</span>
              <span
                class="flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-slate-800"
                :style="{ backgroundColor: stage.color }"
                :title="stageHasMore(stage.id) ? `${stageOpps(stage.id).length} cargadas de ${stageCount(stage.id)}` : undefined"
              >{{ stageCount(stage.id) }}</span>
            </div>
            <span class="text-xs font-semibold text-slate-600">{{ stageSum(stage.id) }}</span>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto bg-slate-50/40 p-2.5" @scroll.passive="onScrollEnd($event, stage.id)">
          <TransitionGroup name="list" tag="div" class="space-y-2.5">
            <OpportunityCard
              v-for="opp in stageOpps(stage.id)"
              :key="opp.id"
              :opp="opp"
              :config="cardConfig"
              draggable="true"
              class="cursor-grab active:cursor-grabbing"
              @dragstart="onDragStart(opp.id)"
              @click="openEdit(opp)"
              @action="(tab: 'detalles' | 'notas') => openEdit(opp, tab)"
              @open-conversation="openConversation"
            />
          </TransitionGroup>
          <p v-if="stageOpps(stage.id).length === 0 && !stageHasMore(stage.id)" class="py-8 text-center text-xs text-slate-400">Sin oportunidades</p>

          <!-- Paginación de la columna: se cargan PAGE tarjetas y el resto al llegar al final -->
          <button v-if="stageHasMore(stage.id)" class="kanban-load-more" :disabled="loadingMore[stage.id]" @click="loadMore(stage.id)">
            <Spinner v-if="loadingMore[stage.id]" :size="14" />
            <template v-else>Cargar más · {{ stageOpps(stage.id).length }} de {{ stageCount(stage.id) }}</template>
          </button>

          <!-- Quick Add button (estilo Flowlu) -->
          <button
            class="kanban-quick-add"
            @click="openCreate"
          >
            <Plus class="h-3.5 w-3.5" />
            Añadir oportunidad
          </button>
        </div>
      </div>
    </div>

    <!-- Vista de lista -->
    <div v-else class="flex-1 overflow-auto bg-slate-100/40 p-6" @scroll.passive="onScrollEnd($event)">
      <div class="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
        <table class="data-table w-full text-sm">
          <thead>
            <tr class="border-b border-slate-200 bg-slate-50 text-left">
              <th class="sortable px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Oportunidad</th>
              <th class="sortable px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Etapa</th>
              <th class="sortable px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Valor</th>
              <th class="sortable px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Estado</th>
              <th class="px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Contacto</th>
              <th class="px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Responsable</th>
              <th class="sortable px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Creado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            <tr
              v-for="opp in opps"
              :key="opp.id"
              class="group cursor-pointer transition-colors hover:bg-[#F69008]/5"
              @click="openEdit(opp)"
            >
              <td class="px-4 py-3">
                <span class="font-semibold text-slate-900 group-hover:text-primary transition-colors">{{ opp.title }}</span>
                <p v-if="opp.business_name" class="text-xs text-slate-400 mt-0.5">{{ opp.business_name }}</p>
              </td>
              <td class="px-3 py-3">
                <span class="rounded-full px-2.5 py-0.5 text-xs font-medium text-slate-700" :style="{ backgroundColor: (stageById[opp.stage_id]?.color ?? '#e2e8f0') + '33', color: stageById[opp.stage_id]?.color ?? '#475569' }">
                  {{ stageById[opp.stage_id]?.name ?? '—' }}
                </span>
              </td>
              <td class="px-3 py-3 font-semibold text-emerald-600">{{ money(Number(opp.value)) }}</td>
              <td class="px-3 py-3">
                <span class="rounded-full px-2.5 py-0.5 text-[11px] font-semibold" :class="statusBadgeCls[opp.status]">{{ statusLbl[opp.status] }}</span>
              </td>
              <td class="px-3 py-3 text-slate-600">{{ [opp.contact_first_name, opp.contact_last_name].filter(Boolean).join(' ') || '—' }}</td>
              <td class="px-3 py-3 text-slate-600">{{ opp.owner_name || '—' }}</td>
              <td class="px-3 py-3 text-xs text-slate-400">{{ new Date(opp.created_at).toLocaleDateString('es-VE', { day: '2-digit', month: 'short', year: 'numeric' }) }}</td>
            </tr>
            <tr v-if="opps.length === 0">
              <td colspan="7" class="px-4 py-12 text-center text-slate-400">Sin oportunidades para mostrar</td>
            </tr>
          </tbody>
        </table>
        <div v-if="opps.length < totalLeads" class="border-t border-slate-100 p-2">
          <button class="kanban-load-more" :disabled="loadingMore.__list" @click="loadMore()">
            <Spinner v-if="loadingMore.__list" :size="14" />
            <template v-else>Cargar más · {{ opps.length }} de {{ totalLeads }}</template>
          </button>
        </div>
      </div>
    </div>

    <OpportunityFormModal ref="oppForm" :pipelines="pipelines" :users="users" :default-pipeline-id="currentId" @changed="loadOpps({ keep: true })" />

    <!-- Panel de personalización de tarjetas -->
    <Transition name="slideover">
      <CustomizeCardPanel
        v-if="showCustomize"
        :config="cardConfig"
        :sample="opps[0] ?? null"
        @apply="applyCardConfig"
        @close="showCustomize = false"
      />
    </Transition>
  </div>
</template>

<style>
/* ── Filter sidebar transitions ─────────────────────────────────────────── */
.filter-sidebar-enter-active,
.filter-sidebar-leave-active { transition: opacity 0.22s ease; }
.filter-sidebar-enter-active .relative,
.filter-sidebar-leave-active .relative { transition: transform 0.25s cubic-bezier(0.4,0,0.2,1); }
.filter-sidebar-enter-from,
.filter-sidebar-leave-to { opacity: 0; }
.filter-sidebar-enter-from .relative,
.filter-sidebar-leave-to .relative { transform: translateX(100%); }

/* ── Quick-filter chip ───────────────────────────────────────────────────── */
.qf-chip {
  cursor: pointer; border-radius: 999px; border: 1.5px solid #E2E8F0;
  padding: 4px 14px; font-size: 12px; font-weight: 500;
  color: #64748B; background: white;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}
.qf-chip:hover { border-color: #F69008; color: #F69008; }
.qf-chip--on { border-color: #F69008; background: #FFF7ED; color: #F69008; font-weight: 600; }

/* ── Quick-filter input ─────────────────────────────────────────────────── */
.qf-input {
  border-radius: 8px; border: 1.5px solid #E2E8F0;
  padding: 6px 10px; font-size: 13px; color: #1E293B;
  background: white; transition: border-color 0.15s, box-shadow 0.15s; outline: none;
}
.qf-input:focus { border-color: #F69008; box-shadow: 0 0 0 3px rgba(246,144,8,0.15); }
.qf-input::placeholder { color: #94A3B8; }

/* ── "Cargar más" de una columna / de la lista ─────────────────────────── */
.kanban-load-more {
  display: flex; align-items: center; justify-content: center; gap: 0.375rem;
  width: 100%; margin-top: 0.625rem; padding: 0.5rem 0.75rem; border-radius: 0.375rem;
  border: 1px solid #E2E8F0; background: white;
  font-size: 0.75rem; font-weight: 600; color: #475569; cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.kanban-load-more:hover:not(:disabled) { border-color: #F69008; color: #D97706; background: rgba(246,144,8,0.05); }
.kanban-load-more:disabled { cursor: default; opacity: 0.7; }
</style>

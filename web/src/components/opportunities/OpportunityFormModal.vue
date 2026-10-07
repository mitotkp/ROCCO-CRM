<script setup lang="ts">
// Formulario completo de una oportunidad (crear y editar): detalles, contacto, etiquetas,
// seguidores, notas y tareas. La vista lo abre con openCreate() / openEdit() y recibe `changed`
// cuando se guardó o se eliminó, para recargar el tablero.
import { ref, computed, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { X, Trash2, UserRound, Briefcase, Kanban, StickyNote, UserPlus, Link2, ListTodo, CalendarClock } from 'lucide-vue-next';
import { api } from '../../api';
import { useDialog } from '../../composables/useDialog';
import { useAuthStore } from '../../stores/auth';
import type { Pipeline, Opportunity, Note, User, Task, TaskStatus } from '../../types';
import { KNOWN_SOURCES, SOURCE_OPTS, STATUS_OPTS, dateTime } from '../../utils/opportunities';
import Dropdown from '../Dropdown.vue';
import Spinner from '../Spinner.vue';
import StatusSelect from '../StatusSelect.vue';
import BizSelect from '../BizSelect.vue';
import AdSourceCard from '../AdSourceCard.vue';

const props = defineProps<{ pipelines: Pipeline[]; users: User[]; defaultPipelineId: string }>();
const emit = defineEmits<{ changed: [] }>();
defineExpose({ openCreate, openEdit });

const router = useRouter();
const auth = useAuthStore();
const { confirm } = useDialog();

// Fuente personalizada: se muestra el input libre (antes se ocultaba al elegir "Otro").
const sourceCustom = ref(false);
function onSourcePick(v: string) {
  sourceCustom.value = v === 'otro';
  form.value.source = v === 'otro' ? '' : v;
  if (v === 'otro') nextTick(() => { (document.getElementById('source-custom') as HTMLInputElement | null)?.focus(); });
}

// ── Formulario completo (estilo GHL) ─────────────────────────────────────────
const showForm = ref(false);
const modalTab = ref<'detalles' | 'notas' | 'tareas'>('detalles');
const editing = ref<Opportunity | null>(null);
const saving = ref(false);
const tagInput = ref('');
const notes = ref<Note[]>([]);
const newNote = ref('');

// Tareas de la oportunidad (tab Tareas, solo si el usuario tiene el módulo).
const oppTasks = ref<Task[]>([]);
const newTask = ref({ title: '', description: '', assignee_ids: [] as string[], due_at: '' });
const newTaskAssignees = computed(() => props.users.filter(u => newTask.value.assignee_ids.includes(u.id)));
const newTaskAvailable = computed(() => props.users.filter(u => !newTask.value.assignee_ids.includes(u.id)));
function addTaskAssignee(id: string) { if (!newTask.value.assignee_ids.includes(id)) newTask.value.assignee_ids.push(id); }
function removeTaskAssignee(id: string) { newTask.value.assignee_ids = newTask.value.assignee_ids.filter(x => x !== id); }

async function loadOppTasks(oppId: string) {
  if (!auth.can('tasks')) return;
  oppTasks.value = await api.get<Task[]>(`/tasks?opportunityId=${oppId}`);
}
async function addOppTask() {
  if (!editing.value || !newTask.value.title.trim()) return;
  await api.post('/tasks', {
    title: newTask.value.title,
    description: newTask.value.description || null,
    opportunity_id: editing.value.id,
    assignee_ids: newTask.value.assignee_ids,
    due_at: newTask.value.due_at ? new Date(newTask.value.due_at).toISOString() : null,
  });
  newTask.value = { title: '', description: '', assignee_ids: [], due_at: '' };
  await loadOppTasks(editing.value.id);
}
async function changeOppTaskStatus(t: Task, status: TaskStatus) {
  await api.patch(`/tasks/${t.id}`, { status });
  await loadOppTasks(editing.value!.id);
}
async function removeOppTask(t: Task) {
  await api.del(`/tasks/${t.id}`);
  await loadOppTasks(editing.value!.id);
}
const taskInitials = (n: string) => n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
const fmtTaskDue = (iso: string) => new Date(iso).toLocaleString('es-VE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const blankForm = () => ({
  title: '', value: 0, status: 'open', pipeline_id: props.defaultPipelineId,
  stage_id: props.pipelines.find(p => p.id === props.defaultPipelineId)?.stages[0]?.id ?? '',
  source: '', business_name: '', tags: [] as string[], owner_id: '', follower_ids: [] as string[],
  contact_name: '', contact_email: '', contact_phone: '',
});
const form = ref(blankForm());
// Al abrir el formulario (form reemplazado), detecta si la fuente guardada es personalizada.
watch(form, f => { sourceCustom.value = f.source !== '' && !KNOWN_SOURCES.includes(f.source); });

// Seguidores del formulario
const followerUsers = computed(() => props.users.filter(u => form.value.follower_ids.includes(u.id)));
const availableFollowers = computed(() => props.users.filter(u => !form.value.follower_ids.includes(u.id)));
function addFollower(id: string) { if (!form.value.follower_ids.includes(id)) form.value.follower_ids.push(id); }
function removeFollower(id: string) { form.value.follower_ids = form.value.follower_ids.filter(x => x !== id); }
const userInitials = (name: string) => name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

function openCreate() {
  editing.value = null;
  modalTab.value = 'detalles';
  form.value = blankForm();
  showForm.value = true;
}
function openConversation(contactId: string) {
  router.push({ path: '/conversations', query: { contact_id: contactId } });
}

async function openEdit(o: Opportunity, tab: 'detalles' | 'notas' = 'detalles') {
  editing.value = o;
  modalTab.value = tab;
  form.value = {
    title: o.title, value: Number(o.value), status: o.status, pipeline_id: o.pipeline_id, stage_id: o.stage_id,
    source: o.source ?? '', business_name: o.business_name ?? '', tags: [...(o.tags ?? [])], owner_id: o.owner_id ?? '',
    follower_ids: (o.followers ?? []).map(f => f.id),
    contact_name: [o.contact_first_name, o.contact_last_name].filter(Boolean).join(' '),
    contact_email: o.contact_email ?? '', contact_phone: o.contact_phone ?? '',
  };
  showForm.value = true;
  // El kanban trae el anuncio de origen sin miniatura (pesa): se carga del detalle al abrir
  if (o.contact_ad_source && !o.contact_ad_source.thumbnail) {
    api.get<Opportunity>(`/opportunities/${o.id}`).then(full => {
      if (editing.value?.id === o.id && full.contact_ad_source) editing.value.contact_ad_source = full.contact_ad_source;
    }).catch(() => { /* sin miniatura: la tarjeta se muestra igual */ });
  }
  notes.value = await api.get<Note[]>(`/opportunities/${o.id}/notes`);
  await loadOppTasks(o.id);
}
const formPipeline = computed(() => props.pipelines.find(p => p.id === form.value.pipeline_id) ?? null);
function onFormPipelineChange() { form.value.stage_id = formPipeline.value?.stages[0]?.id ?? ''; }

// Avatar e indicador de contacto (nuevo vs. existente vinculado).
const contactInitials = computed(() => {
  const n = form.value.contact_name.trim();
  if (!n) return '?';
  return n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
});
const isExistingContact = computed(() => !!editing.value?.contact_first_name);
const hasContactData = computed(() => !!(form.value.contact_name || form.value.contact_email || form.value.contact_phone));

function addTag() {
  const t = tagInput.value.trim();
  if (t && !form.value.tags.includes(t)) form.value.tags.push(t);
  tagInput.value = '';
}
function removeTag(i: number) { form.value.tags.splice(i, 1); }

async function saveForm() {
  saving.value = true;
  try {
    const payload = {
      pipeline_id: form.value.pipeline_id, stage_id: form.value.stage_id, title: form.value.title,
      value: Number(form.value.value), status: form.value.status,
      source: form.value.source || null, business_name: form.value.business_name || null,
      tags: form.value.tags, owner_id: form.value.owner_id || null, follower_ids: form.value.follower_ids,
      contact_name: form.value.contact_name || null, contact_email: form.value.contact_email || null, contact_phone: form.value.contact_phone || null,
    };
    if (editing.value) await api.patch(`/opportunities/${editing.value.id}`, payload);
    else await api.post('/opportunities', payload);
    showForm.value = false;
    emit('changed');
  } finally { saving.value = false; }
}
async function deleteOpp() {
  if (!editing.value || !await confirm('¿Eliminar esta oportunidad?', 'Eliminar oportunidad')) return;
  await api.del(`/opportunities/${editing.value.id}`);
  showForm.value = false;
  emit('changed');
}
async function addNote() {
  if (!editing.value || !newNote.value.trim()) return;
  await api.post(`/opportunities/${editing.value.id}/notes`, { body: newNote.value.trim() });
  newNote.value = '';
  notes.value = await api.get<Note[]>(`/opportunities/${editing.value.id}/notes`);
}
async function deleteNote(id: string) {
  await api.del(`/opportunities/notes/${id}`);
  notes.value = notes.value.filter(n => n.id !== id);
}
</script>

<template>
<Transition name="modal">
<div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="showForm = false">
  <div class="modal-panel flex max-h-[92vh] w-full max-w-2xl flex-col rounded-md bg-white shadow-modal">
    <div class="flex items-start justify-between border-b border-slate-200 bg-gradient-to-b from-slate-50 to-white px-6 py-4">
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[#F69008] to-[#D97706] text-white shadow-sm shadow-[#F69008]/30">
          <Kanban class="h-5 w-5" />
        </div>
        <div>
          <h2 class="text-base font-semibold text-slate-900">{{ editing ? form.title || 'Editar oportunidad' : 'Nueva oportunidad' }}</h2>
          <p class="text-xs text-slate-500">{{ editing ? 'Actualiza los datos de la oportunidad y su contacto' : 'Crea la oportunidad junto con su contacto' }}</p>
        </div>
      </div>
      <button class="cursor-pointer rounded-md p-1 text-slate-400 hover:bg-slate-100" @click="showForm = false"><X class="h-5 w-5" /></button>
    </div>

    <!-- Tabs del modal -->
    <div class="flex gap-1 border-b border-slate-200 px-6">
      <button class="flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors" :class="modalTab === 'detalles' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-800'" @click="modalTab = 'detalles'"><Briefcase class="h-4 w-4" /> Detalles</button>
      <button v-if="editing" class="flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors" :class="modalTab === 'notas' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-800'" @click="modalTab = 'notas'"><StickyNote class="h-4 w-4" /> Notas <span class="ml-0.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{{ notes.length }}</span></button>
      <button v-if="editing && auth.can('tasks')" class="flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors" :class="modalTab === 'tareas' ? 'border-primary text-primary' : 'border-transparent text-slate-500 hover:text-slate-800'" @click="modalTab = 'tareas'"><ListTodo class="h-4 w-4" /> Tareas <span class="ml-0.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-500">{{ oppTasks.length }}</span></button>
    </div>

    <div class="flex-1 overflow-auto px-6 py-5">
      <!-- DETALLES -->
      <form v-show="modalTab === 'detalles'" class="space-y-6" @submit.prevent="saveForm">
        <AdSourceCard v-if="editing?.contact_ad_source" :ad="editing.contact_ad_source" />
        <!-- Datos del contacto -->
        <section class="rounded-lg border border-slate-200 bg-slate-50/60 p-4 shadow-sm">
          <div class="mb-3 flex items-center justify-between">
            <h3 class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <UserRound class="h-4 w-4" /> Datos del contacto
            </h3>
            <span v-if="isExistingContact" class="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600"><Link2 class="h-3 w-3" /> Contacto vinculado</span>
            <span v-else-if="hasContactData" class="flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600"><UserPlus class="h-3 w-3" /> Se creará un contacto</span>
          </div>
          <div class="flex gap-4">
            <div class="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#F69008] to-[#D97706] text-lg font-semibold text-white shadow-sm">{{ contactInitials }}</div>
            <div class="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label class="mb-1 block text-xs font-medium text-slate-600">Nombre</label>
                <input v-model="form.contact_name" placeholder="Nombre del contacto" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-slate-600">Email</label>
                <input v-model="form.contact_email" type="email" placeholder="correo@ejemplo.com" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
              </div>
              <div>
                <label class="mb-1 block text-xs font-medium text-slate-600">Teléfono</label>
                <input v-model="form.contact_phone" placeholder="+58 …" class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
              </div>
            </div>
          </div>
        </section>

        <!-- Datos de la oportunidad -->
        <section>
          <h3 class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <Briefcase class="h-4 w-4" /> Datos de la oportunidad
          </h3>
          <div class="space-y-3">
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700">Nombre de la oportunidad *</label>
              <input v-model="form.title" required class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700">Pipeline</label>
                <BizSelect v-model="form.pipeline_id" @update:model-value="onFormPipelineChange"
                  :options="pipelines.map(p => ({ value: p.id, label: p.name }))" input-class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm" />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700">Etapa</label>
                <BizSelect v-model="form.stage_id"
                  :options="(formPipeline?.stages ?? []).map(s => ({ value: s.id, label: s.name }))" input-class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700">Estado</label>
                <BizSelect v-model="form.status"
                  :options="STATUS_OPTS.map(s => ({ value: s.v, label: s.l }))" input-class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm" />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700">Valor (USD)</label>
                <input v-model.number="form.value" type="number" min="0" step="0.01" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700">Responsable</label>
                <BizSelect v-model="form.owner_id" placeholder="Sin asignar"
                  :options="users.map(u => ({ value: u.id, label: u.name }))" input-class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm" />
              </div>
              <div>
                <label class="mb-1 block text-sm font-medium text-slate-700">Empresa</label>
                <input v-model="form.business_name" placeholder="Nombre de la empresa" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
              </div>
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700">Fuente</label>
              <BizSelect :model-value="sourceCustom ? 'otro' : form.source" placeholder="Sin especificar"
                :options="SOURCE_OPTS" input-class="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm" @update:model-value="onSourcePick" />
              <input
                v-if="sourceCustom"
                id="source-custom"
                v-model="form.source"
                placeholder="Escribe la fuente…"
                class="mt-1.5 w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none"
              />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700">Seguidores</label>
              <div class="flex flex-wrap items-center gap-2 rounded-md border border-slate-300 bg-white p-2 shadow-sm">
                <span v-for="f in followerUsers" :key="f.id" class="flex items-center gap-1.5 rounded-full bg-slate-100 py-0.5 pl-0.5 pr-2 text-xs font-medium text-slate-700">
                  <span class="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-[#F69008] to-[#D97706] text-[9px] font-semibold text-white">{{ userInitials(f.name) }}</span>
                  {{ f.name }}
                  <button type="button" class="cursor-pointer text-slate-400 hover:text-red-500" @click="removeFollower(f.id)"><X class="h-3 w-3" /></button>
                </span>
                <Dropdown v-if="availableFollowers.length" width="220px">
                  <template #trigger>
                    <button type="button" class="flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:border-primary hover:text-primary"><UserPlus class="h-3.5 w-3.5" /> Añadir</button>
                  </template>
                  <button v-for="u in availableFollowers" :key="u.id" type="button" class="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100" @click="addFollower(u.id)">
                    <span class="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[#F69008] to-[#D97706] text-[10px] font-semibold text-white">{{ userInitials(u.name) }}</span>
                    {{ u.name }}
                  </button>
                </Dropdown>
                <span v-if="!followerUsers.length && !availableFollowers.length" class="px-1 text-xs text-slate-400">No hay usuarios</span>
              </div>
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-slate-700">Etiquetas</label>
              <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-white p-2 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
                <span v-for="(t, i) in form.tags" :key="i" class="flex items-center gap-1 rounded-sm bg-[#F69008]/10 px-2 py-0.5 text-xs font-medium text-[#D97706]">
                  {{ t }}
                  <button type="button" class="cursor-pointer hover:text-[#7C4A00]" @click="removeTag(i)"><X class="h-3 w-3" /></button>
                </span>
                <input v-model="tagInput" @keydown.enter.prevent="addTag" @keydown.,.prevent="addTag" placeholder="Añadir etiqueta y Enter…" class="min-w-[120px] flex-1 border-0 bg-transparent text-sm focus:outline-none" />
              </div>
            </div>
          </div>
        </section>
      </form>

      <!-- NOTAS -->
      <div v-show="modalTab === 'notas'" class="space-y-4">
        <div>
          <textarea v-model="newNote" rows="3" placeholder="Escribe una nota…" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none"></textarea>
          <button class="btn btn-primary btn-sm mt-2" :disabled="!newNote.trim()" @click="addNote">Agregar nota</button>
        </div>
        <div class="space-y-2">
          <div v-for="n in notes" :key="n.id" class="group rounded-md border border-slate-200 bg-slate-50 p-3 shadow-sm transition-shadow hover:shadow-md">
            <p class="whitespace-pre-wrap text-sm text-slate-800">{{ n.body }}</p>
            <div class="mt-2 flex items-center justify-between text-xs text-slate-400">
              <span>{{ n.author_name }} · {{ dateTime(n.created_at) }}</span>
              <button class="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600" @click="deleteNote(n.id)"><Trash2 class="h-4 w-4" /></button>
            </div>
          </div>
          <p v-if="notes.length === 0" class="py-6 text-center text-sm text-slate-400">Sin notas todavía.</p>
        </div>
      </div>

      <!-- TAREAS -->
      <div v-show="modalTab === 'tareas'" class="space-y-4">
        <div class="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <input v-model="newTask.title" placeholder="Título de la tarea…" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none" />
          <textarea v-model="newTask.description" rows="2" placeholder="Descripción (opcional)…" class="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none"></textarea>
          <!-- Responsables múltiples -->
          <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-white p-1.5">
            <span v-for="u in newTaskAssignees" :key="u.id" class="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-0.5 pr-1.5 text-xs font-medium text-slate-700">
              <span class="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-gradient-to-br from-[#F69008] to-[#D97706] text-[8px] font-semibold text-white" style="height:18px;width:18px">{{ taskInitials(u.name) }}</span>
              {{ u.name }}
              <button type="button" class="cursor-pointer text-slate-400 hover:text-red-500" @click="removeTaskAssignee(u.id)"><X class="h-3 w-3" /></button>
            </span>
            <Dropdown v-if="newTaskAvailable.length" width="200px">
              <template #trigger>
                <button type="button" class="flex cursor-pointer items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs font-medium text-slate-500 hover:border-primary hover:text-primary"><UserPlus class="h-3 w-3" /> Responsable</button>
              </template>
              <button v-for="u in newTaskAvailable" :key="u.id" type="button" class="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100" @click="addTaskAssignee(u.id)">
                <span class="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-[#F69008] to-[#D97706] text-[10px] font-semibold text-white">{{ taskInitials(u.name) }}</span>
                {{ u.name }}
              </button>
            </Dropdown>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="newTask.due_at" type="datetime-local" class="rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:outline-none" />
            <button class="btn btn-primary btn-sm ml-auto" :disabled="!newTask.title.trim()" @click="addOppTask">Añadir tarea</button>
          </div>
        </div>
        <div class="space-y-2">
          <div v-for="t in oppTasks" :key="t.id" class="rounded-md border border-slate-200 bg-white p-2.5 shadow-sm">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium" :class="t.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'">{{ t.title }}</p>
                <p v-if="t.description" class="mt-0.5 text-xs text-slate-500">{{ t.description }}</p>
                <div class="mt-1 flex flex-wrap items-center gap-3">
                  <span v-if="t.due_at" class="flex items-center gap-1 text-xs" :class="t.status !== 'done' && t.status !== 'cancelled' && new Date(t.due_at) < new Date() ? 'font-medium text-red-600' : 'text-slate-400'"><CalendarClock class="h-3 w-3" /> {{ fmtTaskDue(t.due_at) }}</span>
                  <div v-if="t.assignees.length" class="flex items-center -space-x-1.5">
                    <span v-for="a in t.assignees" :key="a.id" class="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-[#F69008] to-[#D97706] text-[8px] font-semibold text-white ring-2 ring-white" :title="a.name">{{ taskInitials(a.name) }}</span>
                  </div>
                </div>
              </div>
              <StatusSelect :model-value="t.status" @update:model-value="s => changeOppTaskStatus(t, s)" />
              <button class="cursor-pointer rounded-md p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600" @click="removeOppTask(t)"><Trash2 class="h-4 w-4" /></button>
            </div>
          </div>
          <p v-if="oppTasks.length === 0" class="py-6 text-center text-sm text-slate-400">Sin tareas para esta oportunidad.</p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="flex flex-col gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-6 sm:py-4">
      <p v-if="editing" class="text-xs text-slate-400">Creado el {{ dateTime(editing.created_at) }}</p>
      <div class="flex items-center justify-end gap-2 sm:ml-auto">
        <button v-if="editing" type="button" class="btn btn-danger" @click="deleteOpp">Eliminar</button>
        <button type="button" class="btn btn-ghost" @click="showForm = false">Cancelar</button>
        <button type="button" :disabled="saving" class="btn btn-primary" @click="saveForm">
          <Spinner v-if="saving" :size="16" light /> {{ saving ? 'Guardando…' : editing ? 'Actualizar' : 'Crear' }}
        </button>
      </div>
    </div>
  </div>
</div>
</Transition>
</template>

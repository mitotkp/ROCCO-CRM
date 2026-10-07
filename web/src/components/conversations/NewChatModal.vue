<script setup lang="ts">
// Modal «Nueva conversación» de la bandeja: elegir un contacto (o escribir un teléfono) y abrir
// su chat de WhatsApp. Avisa con `created` (id de la conversación) cuando el chat ya existe.
import { ref, watch } from 'vue';
import { Search, Plus, X, MessageCircle, RefreshCw } from 'lucide-vue-next';
import { api } from '../../api';
import { initials, avatarColor } from '../../utils/chatFormat';

const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ created: [id: string] }>();

type ContactRow = { id: string; first_name: string; last_name: string | null; phone: string | null };
const newPhone = ref('');
const newName = ref('');
const creatingChat = ref(false);
const newChatSearch = ref('');
const newChatContacts = ref<ContactRow[]>([]);
const newChatSearching = ref(false);
const newChatShowManual = ref(false);
let newChatSearchTimer: ReturnType<typeof setTimeout> | null = null;

// Al abrirse empieza limpio y con los primeros contactos
watch(open, isOpen => {
  if (!isOpen) return;
  newChatSearch.value = '';
  newChatShowManual.value = false;
  newPhone.value = '';
  newName.value = '';
  fetchNewChatContacts('');
});

async function fetchNewChatContacts(q: string) {
  newChatSearching.value = true;
  try {
    const res = await api.get<{ data: ContactRow[] }>(`/contacts?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    newChatContacts.value = res.data ?? [];
  } catch { newChatContacts.value = []; }
  finally { newChatSearching.value = false; }
}

function onNewChatSearch() {
  if (newChatSearchTimer) clearTimeout(newChatSearchTimer);
  newChatSearchTimer = setTimeout(() => fetchNewChatContacts(newChatSearch.value), 250);
}

async function startChatWithContact(c: ContactRow) {
  if (!c.phone) return;
  newPhone.value = c.phone;
  newName.value = [c.first_name, c.last_name ?? ''].join(' ').trim();
  open.value = false;
  await createChat(c.id);
}

async function createChat(contactId?: string) {
  if (!newPhone.value.trim()) return;
  creatingChat.value = true;
  try {
    const res = await api.post<{ id: string }>('/conversations', {
      phone: newPhone.value.trim(),
      display_name: newName.value.trim() || undefined,
      contact_id: contactId ?? undefined,
    });
    emit('created', res.id);
    open.value = false;
    newPhone.value = '';
    newName.value = '';
  } finally {
    creatingChat.value = false;
  }
}
</script>

<template>
<Teleport to="body">
  <Transition name="fade">
    <div v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="open = false">
      <div class="flex w-full max-w-md flex-col rounded-2xl bg-white shadow-2xl" style="max-height: 80vh">

        <!-- Header del modal -->
        <div class="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 class="text-base font-bold text-slate-900">Nueva conversación</h3>
          <button class="cursor-pointer rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" @click="open = false">
            <X class="h-4 w-4" />
          </button>
        </div>

        <!-- Cuerpo -->
        <div class="flex flex-col gap-3 overflow-hidden p-5">

          <!-- Label + buscador -->
          <div>
            <label class="mb-1.5 block text-sm font-bold text-slate-800">
              Seleccionar contacto <span class="text-red-500">*</span>
            </label>
            <div class="relative">
              <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                v-model="newChatSearch"
                @input="onNewChatSearch"
                placeholder="Buscar por nombre, teléfono…"
                class="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                autofocus
              />
            </div>
          </div>

          <!-- Lista de contactos -->
          <div class="overflow-y-auto rounded-xl border border-slate-100 bg-slate-50" style="max-height: 260px; min-height: 100px">
            <!-- Cargando -->
            <div v-if="newChatSearching" class="flex items-center justify-center py-8">
              <RefreshCw class="h-5 w-5 animate-spin text-slate-400" />
            </div>

            <!-- Resultados -->
            <template v-else-if="newChatContacts.length">
              <button v-for="c in newChatContacts" :key="c.id"
                class="flex w-full cursor-pointer items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-white"
                :class="!c.phone ? 'opacity-50 cursor-not-allowed' : ''"
                :disabled="!c.phone"
                @click="c.phone && startChatWithContact(c)"
                :title="!c.phone ? 'Este contacto no tiene número de teléfono' : ''"
              >
                <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
                  :class="avatarColor(c.id)">
                  {{ initials(`${c.first_name} ${c.last_name ?? ''}`) }}
                </div>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold text-slate-900">{{ c.first_name }} {{ c.last_name ?? '' }}</p>
                  <p class="truncate text-xs text-slate-500">{{ c.phone ? `+${c.phone}` : 'Sin teléfono' }}</p>
                </div>
              </button>
            </template>

            <!-- Sin resultados -->
            <div v-else class="flex flex-col items-center justify-center gap-2 py-8 text-slate-400">
              <MessageCircle class="h-8 w-8 opacity-30" />
              <p class="text-sm font-medium">Sin datos</p>
              <p v-if="newChatSearch" class="text-xs text-slate-400">Sin resultados para "{{ newChatSearch }}"</p>
            </div>
          </div>

          <!-- Separador + opción manual -->
          <div>
            <button
              class="flex w-full cursor-pointer items-center gap-2 rounded-lg py-1.5 text-sm font-semibold text-primary transition-colors hover:text-primary-dark"
              @click="newChatShowManual = !newChatShowManual">
              <Plus class="h-4 w-4" />
              Nuevo número de teléfono
            </button>

            <Transition name="expand">
              <form v-if="newChatShowManual" @submit.prevent="createChat()" class="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div>
                  <label class="mb-1 block text-xs font-semibold text-slate-700">Teléfono <span class="text-red-500">*</span></label>
                  <input v-model="newPhone" placeholder="+58 414 000 0000" required
                    class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-primary focus:outline-none" />
                </div>
                <div>
                  <label class="mb-1 block text-xs font-semibold text-slate-700">Nombre (opcional)</label>
                  <input v-model="newName" placeholder="Ej: Juan García"
                    class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-primary focus:outline-none" />
                </div>
                <button type="submit" :disabled="creatingChat"
                  class="w-full cursor-pointer rounded-lg bg-[#25D366] py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[#1ea855] disabled:opacity-60">
                  {{ creatingChat ? 'Iniciando…' : 'Iniciar conversación' }}
                </button>
              </form>
            </Transition>
          </div>

        </div>
      </div>
    </div>
  </Transition>
</Teleport>
</template>

<style scoped>
.expand-enter-active, .expand-leave-active { transition: max-height 0.25s ease, opacity 0.2s ease; overflow: hidden; }
.expand-enter-from, .expand-leave-to { max-height: 0; opacity: 0; }
.expand-enter-to, .expand-leave-from { max-height: 200px; }
</style>

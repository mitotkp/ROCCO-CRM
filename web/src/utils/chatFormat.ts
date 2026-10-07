// Formato de la bandeja de conversaciones: horas y fechas de los mensajes, iniciales y color del
// avatar, y el nombre con el que se muestra un chat.
import type { Conversation } from '../types';

export function fmtTime(iso: string): string {
  const d = new Date(iso), now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('es-VE', { day: '2-digit', month: 'short' });
}

export function fmtFull(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-VE', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function dateSeparatorLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (day.getTime() === today.getTime()) return 'Hoy';
  if (day.getTime() === yesterday.getTime()) return 'Ayer';
  return d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function initials(name: string): string {
  return name.split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

const avatarColors = [
  'bg-green-100 text-green-700',
  'bg-purple-100 text-purple-700',
  'bg-sky-100 text-sky-700',
  'bg-rose-100 text-rose-700',
  'bg-amber-100 text-amber-700',
  'bg-teal-100 text-teal-700',
  'bg-indigo-100 text-indigo-700',
  'bg-orange-100 text-orange-700',
];
export function avatarColor(id: string): string {
  const n = id.charCodeAt(0) + id.charCodeAt(id.length - 1);
  return avatarColors[n % avatarColors.length];
}

export function convName(c: Conversation): string {
  if (c.contact_full_name?.trim()) return c.contact_full_name.trim();
  // display_name puede ser pushName real o vacío (limpiado en DB)
  const name = c.display_name?.trim();
  if (name && !/^\d+$/.test(name)) return name;
  // Solo mostrar teléfono si la conversación es @c.us (teléfono real) Y tiene ≤ 15 dígitos
  const isRealPhone = c.wa_chat_id?.endsWith('@c.us');
  if (isRealPhone && c.phone && /^\d{7,15}$/.test(c.phone)) return `+${c.phone}`;
  return 'Desconocido';
}

export function formatAudioTime(secs: number): string {
  if (!secs || isNaN(secs) || !isFinite(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

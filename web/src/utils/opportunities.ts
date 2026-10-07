// Catálogos y formato compartidos por el tablero de oportunidades y su formulario.

export const KNOWN_SOURCES = ['whatsapp','facebook','instagram','tiktok','google','linkedin','referido','sitio_web','email','llamada'];
export const SOURCE_OPTS = [
  { value: 'whatsapp', label: 'WhatsApp' }, { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' }, { value: 'tiktok', label: 'TikTok' },
  { value: 'google', label: 'Google' }, { value: 'linkedin', label: 'LinkedIn' },
  { value: 'referido', label: 'Referido' }, { value: 'sitio_web', label: 'Sitio web' },
  { value: 'email', label: 'Email' }, { value: 'llamada', label: 'Llamada telefónica' },
  { value: 'otro', label: 'Otro (personalizado)' },
];

export const STATUS_OPTS = [{ v: 'open', l: 'Abierta' }, { v: 'won', l: 'Ganada' }, { v: 'lost', l: 'Perdida' }];

export const dateTime = (d: string) => new Date(d).toLocaleString('es-VE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

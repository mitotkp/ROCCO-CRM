// <img>/<video>/<audio> no pueden mandar la cabecera Authorization: la URL lleva un token de
// media propio (10 min, solo vale para /api/media), nunca la sesión. Se renueva cada 8 min y
// al volver a la pestaña si ya está viejo.
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api';

export function useMediaToken() {
  const mediaToken = ref('');
  let mediaTokenAt = 0;
  let mediaTimer: ReturnType<typeof setInterval> | undefined;
  async function refreshMediaToken() {
    try {
      mediaToken.value = (await api.post<{ token: string }>('/media-token')).token;
      mediaTokenAt = Date.now();
    } catch { /* sin permiso o sin red: los adjuntos no se verán, el resto sigue */ }
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - mediaTokenAt > 8 * 60_000) refreshMediaToken();
  };
  onMounted(() => {
    refreshMediaToken();
    mediaTimer = setInterval(refreshMediaToken, 8 * 60_000);
    document.addEventListener('visibilitychange', onVisible);
  });
  onUnmounted(() => {
    clearInterval(mediaTimer);
    document.removeEventListener('visibilitychange', onVisible);
  });

  function mediaUrl(msgId: unknown): string {
    if (!mediaToken.value) return '';
    return `/api/media/${encodeURIComponent(String(msgId))}?t=${encodeURIComponent(mediaToken.value)}`;
  }

  return { mediaToken, mediaUrl };
}

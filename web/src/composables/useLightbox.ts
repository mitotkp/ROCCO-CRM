// Visor a pantalla completa de una imagen o un video; se cierra con Escape.
import { ref, onMounted, onUnmounted } from 'vue';

export function useLightbox() {
  const lightboxUrl = ref<string | null>(null);
  const lightboxMime = ref<string>('image/jpeg');

  function openLightbox(url: string, mime = 'image/jpeg') {
    lightboxUrl.value = url;
    lightboxMime.value = mime;
  }
  function closeLightbox() { lightboxUrl.value = null; }

  // Cerrar lightbox con Escape
  const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeLightbox(); };
  onMounted(() => document.addEventListener('keydown', onKeyDown));
  onUnmounted(() => document.removeEventListener('keydown', onKeyDown));

  return { lightboxUrl, lightboxMime, openLightbox, closeLightbox };
}

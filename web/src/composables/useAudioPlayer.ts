// Reproductor de las notas de voz de la bandeja: un <audio> por mensaje, solo uno sonando a la vez.
import { ref, onUnmounted } from 'vue';
import { formatAudioTime } from '../utils/chatFormat';

export function useAudioPlayer() {
  const audioState = ref<Record<string, { playing: boolean; currentTime: number; duration: number }>>({});
  const audioElements = new Map<string, HTMLAudioElement>();

  onUnmounted(() => {
    for (const el of audioElements.values()) el.pause();
    audioElements.clear();
  });

  function getAudioEl(msgId: string, src: string): HTMLAudioElement {
    if (!audioElements.has(msgId)) {
      const el = new Audio(src);
      el.ontimeupdate = () => {
        if (audioState.value[msgId]) audioState.value[msgId].currentTime = el.currentTime;
      };
      el.onloadedmetadata = () => {
        if (!audioState.value[msgId]) audioState.value[msgId] = { playing: false, currentTime: 0, duration: 0 };
        audioState.value[msgId].duration = el.duration;
      };
      el.onended = () => {
        if (audioState.value[msgId]) { audioState.value[msgId].playing = false; audioState.value[msgId].currentTime = 0; }
      };
      audioElements.set(msgId, el);
      if (!audioState.value[msgId]) audioState.value[msgId] = { playing: false, currentTime: 0, duration: 0 };
    }
    return audioElements.get(msgId)!;
  }

  function toggleAudio(msgId: string, src: string) {
    const el = getAudioEl(msgId, src);
    for (const [id, audioEl] of audioElements) {
      if (id !== msgId && !audioEl.paused) {
        audioEl.pause();
        if (audioState.value[id]) audioState.value[id].playing = false;
      }
    }
    if (el.paused) { el.play(); audioState.value[msgId].playing = true; }
    else { el.pause(); audioState.value[msgId].playing = false; }
  }

  function seekAudio(msgId: string, src: string, e: MouseEvent) {
    const el = getAudioEl(msgId, src);
    const bar = e.currentTarget as HTMLElement;
    el.currentTime = (e.offsetX / bar.clientWidth) * (el.duration || 0);
  }

  function audioProgress(msgId: string): number {
    const st = audioState.value[msgId];
    if (!st || !st.duration) return 0;
    return (st.currentTime / st.duration) * 100;
  }

  function audioDurationLabel(msgId: string): string {
    const st = audioState.value[msgId];
    if (!st) return '';
    return st.playing || st.currentTime > 0 ? formatAudioTime(st.currentTime) : formatAudioTime(st.duration);
  }

  return { audioState, toggleAudio, seekAudio, audioProgress, audioDurationLabel };
}

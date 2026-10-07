// Adjuntos de los mensajes (fotos, audios, videos, documentos) en disco, no en la BD.
// Antes se guardaban en conv_messages.media_url como data URI en base64 (~1 MB por mensaje, un
// tercio más que el archivo): la BD y sus backups crecían con cada foto. Ahora el archivo vive en
// MEDIA_DIR/messages/<organización>/<mensaje> y media_url guarda solo la referencia
// `file:<organización>/<mensaje>`. Se sirve como siempre por /api/media/:id (index.ts), con el
// token de media: la carpeta no se expone por ninguna ruta.
// ponytail: disco local, una sola instancia del servidor; si algún día hay varias, esto pasa a
// un almacén compartido (S3 o similar) cambiando solo este archivo.

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename, unlink, readdir, stat, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.ts';
import { MEDIA_DIR } from '../routes/automation-media.ts';

const ROOT = path.join(MEDIA_DIR, 'messages');
const PREFIX = 'file:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFileRef(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

// Ruta en disco de una referencia, o null si no tiene la forma esperada (nunca sale de ROOT).
export function mediaFilePath(ref: string): string | null {
  const [orgId, msgId, ...rest] = ref.slice(PREFIX.length).split('/');
  if (rest.length || !UUID.test(orgId ?? '') || !UUID.test(msgId ?? '')) return null;
  return path.join(ROOT, orgId.toLowerCase(), msgId.toLowerCase());
}

// Guarda el archivo y devuelve su referencia. Escribe a un temporal y renombra: un corte a
// medias no deja un adjunto truncado con el nombre definitivo.
export async function saveMessageMedia(orgId: string, msgId: string, data: Buffer): Promise<string> {
  const ref = `${PREFIX}${orgId}/${msgId}`;
  const file = mediaFilePath(ref);
  if (!file) throw new Error(`referencia de adjunto no válida: ${ref}`);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
  return ref;
}

export async function deleteMessageMedia(ref: string): Promise<void> {
  const file = mediaFilePath(ref);
  if (file) await unlink(file).catch(() => {});
}

export function parseDataUri(uri: string): { mime: string; data: Buffer } | null {
  if (!uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const mime = uri.slice(5, comma).split(';')[0] || 'application/octet-stream';
  return { mime, data: Buffer.from(uri.slice(comma + 1), 'base64') };
}

// Pasa a disco el data URI de un mensaje y deja la referencia en la BD. El UPDATE exige que la
// fila siga teniendo un data URI: si otra petición ya lo movió, no se pisa nada.
export async function moveDataUriToDisk(msg: { id: string; organization_id: string; media_url: string }): Promise<string | null> {
  const parsed = parseDataUri(msg.media_url);
  if (!parsed) return null;
  const ref = await saveMessageMedia(msg.organization_id, msg.id, parsed.data);
  await pool.query(
    `UPDATE conv_messages SET media_url = $1, media_mime = COALESCE(media_mime, $2)
     WHERE id = $3 AND media_url LIKE 'data:%'`,
    [ref, parsed.mime, msg.id],
  );
  return ref;
}

// Migración de lo que ya había: mueve a disco los data URI guardados antes de este cambio, de
// pocos en pocos (cada fila puede pesar más de 1 MB). Devuelve cuántos movió; 0 = no queda nada.
let migrationDone = false;
export async function migrateMediaToDisk(max = 200): Promise<number> {
  if (migrationDone) return 0;
  let moved = 0;
  while (moved < max) {
    const rows = (await pool.query<{ id: string; organization_id: string; media_url: string }>(
      `SELECT id, organization_id, media_url FROM conv_messages WHERE media_url LIKE 'data:%' LIMIT 10`,
    )).rows;
    if (!rows.length) { migrationDone = true; break; }
    for (const row of rows) {
      // Un data URI ilegible no puede bloquear la cola: se deja sin media (no había nada que servir)
      if (!(await moveDataUriToDisk(row))) await pool.query(`UPDATE conv_messages SET media_url = NULL WHERE id = $1`, [row.id]);
      moved++;
    }
  }
  if (moved) console.log(`[media] ${moved} adjuntos pasados de la BD al disco${migrationDone ? ' (migración terminada)' : ''}`);
  return moved;
}

// Borra del disco los archivos que ya no tienen mensaje (conversación, contacto u organización
// borrados: la BD hace el CASCADE, el disco no). Solo toca archivos con más de una hora, para no
// competir con un adjunto que se está guardando. `orgId` limita a una organización (tests).
export async function sweepOrphanMedia(orgId?: string): Promise<number> {
  const orgDirs = orgId ? [orgId] : await readdir(ROOT).catch(() => [] as string[]);
  const cutoff = Date.now() - 3600_000;
  let removed = 0;
  for (const org of orgDirs) {
    if (!UUID.test(org)) continue;
    const dir = path.join(ROOT, org);
    const names = await readdir(dir).catch(() => [] as string[]);
    const ids = names.filter(n => UUID.test(n));
    const alive = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = (await pool.query<{ id: string }>(
        `SELECT id FROM conv_messages WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND media_url LIKE 'file:%'`,
        [ids.slice(i, i + 1000), org],
      )).rows;
      for (const r of rows) alive.add(r.id);
    }
    for (const name of names) {
      if (alive.has(name.toLowerCase())) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile() || info.mtimeMs > cutoff) continue;
      await unlink(file).then(() => { removed++; }, () => {});
    }
    await rmdir(dir).catch(() => {});   // solo se borra si quedó vacía
  }
  return removed;
}

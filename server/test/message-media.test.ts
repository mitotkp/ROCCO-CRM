// Adjuntos de los mensajes en disco (services/message-media.ts): el proxy /api/media/:id los sirve
// desde el archivo, baja de Evolution lo que falta y lo guarda; los data URI de versiones
// anteriores se pasan de la BD al disco; la retención y la limpieza borran sus archivos.
// Las peticiones van al servidor de pruebas (`npm test`); la migración, la retención y la limpieza
// corren EN ESTE PROCESO (importadas de src/), que comparte MEDIA_DIR con ese servidor.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, unlink, utimes, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { pool as appPool } from '../src/db.ts';
import { mediaFilePath, migrateMediaToDisk, sweepOrphanMedia } from '../src/services/message-media.ts';
import { runRetention } from '../src/services/retention.ts';

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3202';
const FAKE_PORT = Number(new URL(process.env.TEST_FAKE_URL ?? 'http://localhost:4202').port) + 104;
const FAKE = `http://localhost:${FAKE_PORT}`;
if ((process.env.DATABASE_URL ?? '').includes('rocco.arbolaureo.org')) throw new Error('No correr contra producción');

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const stamp = Date.now();
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

// ── Evolution falso: entrega la media de un mensaje y acepta el envío de imágenes ──
const EVO_MEDIA: Record<string, { base64: string; mimetype: string }> = {};
const calls: { path: string; body: any }[] = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url!, body });
    const reply = (status: number, json: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
    if (req.url!.startsWith('/message/getBase64FromMediaMessage/')) {
      const media = EVO_MEDIA[body.message?.key?.id];
      return media ? reply(201, media) : reply(404, { error: 'sin media' });
    }
    if (req.url!.startsWith('/message/sendMedia/')) {
      return reply(201, { key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id: `EVO-IMG-${stamp}-${calls.length}` }, status: 'PENDING' });
    }
    reply(404, { error: 'no simulado' });
  });
});
const downloads = () => calls.filter(c => c.path.startsWith('/message/getBase64FromMediaMessage/')).length;

const ctx = {} as { orgId: string; token: string; mediaToken: string; conv: string };
let seq = 0;
const dataUri = (mime: string, content: string) => `data:${mime};base64,${Buffer.from(content).toString('base64')}`;

async function message(o: { mediaUrl?: string | null; mime?: string | null; waId?: string | null; direction?: string; age?: string } = {}) {
  return (await one(
    `INSERT INTO conv_messages (conversation_id, organization_id, wa_message_id, direction, msg_type, media_url, media_mime, created_at)
     VALUES ($1, $2, $3, $4, 'image', $5, $6, NOW() - $7::interval) RETURNING id`,
    [ctx.conv, ctx.orgId, o.waId === undefined ? `WA-MM-${stamp}-${++seq}` : o.waId, o.direction ?? 'inbound',
      o.mediaUrl ?? null, o.mime === undefined ? 'image/png' : o.mime, o.age ?? '0 days'],
  )).id as string;
}
const row = (id: string) => one(`SELECT media_url, media_mime FROM conv_messages WHERE id = $1`, [id]);
const fileOf = (id: string) => mediaFilePath(`file:${ctx.orgId}/${id}`)!;
const getMedia = (id: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}/api/media/${id}?t=${encodeURIComponent(ctx.mediaToken)}`, { headers });

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 6000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado esperando: ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
const onDisk = (id: string) => until('adjunto en disco', async () => {
  const r = await row(id);
  return r.media_url === `file:${ctx.orgId}/${id}` && existsSync(fileOf(id)) ? r : null;
});

before(async () => {
  await new Promise<void>(r => fake.listen(FAKE_PORT, r));
  ctx.orgId = (await one(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`Adjuntos ${stamp}`])).id;
  const userId = (await one(
    `INSERT INTO users (organization_id, email, password_hash, name, role) VALUES ($1, $2, 'x', 'Dueña Adjuntos', 'owner') RETURNING id`,
    [ctx.orgId, `adjuntos-${stamp}@test.local`],
  )).id;
  await db.query(
    `INSERT INTO wa_settings (organization_id, evo_url, evo_api_key, instance_name, session_status, display_name, is_default)
     VALUES ($1, $2, 'evo-test-key', $3, 'connected', 'WA adjuntos', true)`,
    [ctx.orgId, FAKE, `mm-${stamp}`],
  );
  ctx.conv = (await one(
    `INSERT INTO conversations (organization_id, wa_chat_id, display_name) VALUES ($1, $2, 'Adjuntos') RETURNING id`,
    [ctx.orgId, `58412${String(stamp).slice(-7)}@s.whatsapp.net`],
  )).id;
  ctx.token = jwt.sign({ userId, organizationId: ctx.orgId, role: 'owner' }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const r = await fetch(`${BASE}/api/media-token`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.token}` } });
  ctx.mediaToken = (await r.json() as { token: string }).token;
});

after(async () => {
  fake.closeAllConnections();
  fake.close();
  await db.query(`DELETE FROM organizations WHERE id = $1`, [ctx.orgId]).catch(() => {});
  await sweepOrphanMedia(ctx.orgId).catch(() => {});
  await db.end();
  await appPool.end();
});

test('un data URI antiguo se sirve y pasa al disco; después se sirve del archivo (con Range)', async () => {
  const id = await message({ mediaUrl: dataUri('image/png', 'png-antiguo'), mime: null });
  const first = await getMedia(id);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'png-antiguo');

  const r = await onDisk(id);
  assert.equal(r.media_mime, 'image/png', 'el tipo sale del data URI si la fila no lo tenía');
  assert.equal((await readFile(fileOf(id))).toString(), 'png-antiguo');

  const second = await getMedia(id);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('content-type'), 'image/png');
  assert.match(second.headers.get('cache-control') ?? '', /^private/);
  assert.equal(Buffer.from(await second.arrayBuffer()).toString(), 'png-antiguo');

  const part = await getMedia(id, { Range: 'bytes=4-10' });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), 'antiguo');
});

test('la media que aún no está se baja de Evolution una sola vez y queda en disco, no en la BD', async () => {
  const waId = `WA-MM-EVO-${stamp}`;
  EVO_MEDIA[waId] = { base64: Buffer.from('audio-de-evolution').toString('base64'), mimetype: 'audio/ogg' };
  const id = await message({ waId, mime: null });

  const before = downloads();
  const first = await getMedia(id);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'audio/ogg');
  assert.equal(Buffer.from(await first.arrayBuffer()).toString(), 'audio-de-evolution');

  const r = await onDisk(id);
  assert.equal(r.media_mime, 'audio/ogg');
  assert.equal((await readFile(fileOf(id))).toString(), 'audio-de-evolution');

  assert.equal((await getMedia(id)).status, 200);
  assert.equal(downloads() - before, 1, 'el segundo acceso sale del disco');

  // Si el archivo se pierde (disco restaurado sin los adjuntos), se vuelve a pedir a Evolution
  await unlink(fileOf(id));
  const again = await getMedia(id);
  assert.equal(again.status, 200);
  assert.equal(Buffer.from(await again.arrayBuffer()).toString(), 'audio-de-evolution');
  assert.equal(downloads() - before, 2);
  await until('archivo repuesto', async () => existsSync(fileOf(id)));
});

test('la imagen enviada desde el CRM queda en disco y en la BD solo su referencia', async () => {
  const uri = dataUri('image/jpeg', 'foto-enviada');
  const res = await fetch(`${BASE}/api/conversations/${ctx.conv}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ type: 'image', mediaUrl: uri, body: 'Mira' }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const sent = await res.json() as { id: string };
  assert.ok(calls.some(c => c.path.startsWith('/message/sendMedia/') && c.body.media === uri), 'Evolution recibió la imagen');

  const r = await row(sent.id);
  assert.equal(r.media_url, `file:${ctx.orgId}/${sent.id}`);
  assert.equal(r.media_mime, 'image/jpeg');
  assert.equal((await readFile(fileOf(sent.id))).toString(), 'foto-enviada');
  const served = await getMedia(sent.id);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await served.arrayBuffer()).toString(), 'foto-enviada');
});

test('migración: los data URI que quedaban en la BD pasan a disco', async () => {
  const a = await message({ mediaUrl: dataUri('image/png', 'migrado-a') });
  const b = await message({ mediaUrl: dataUri('video/mp4', 'migrado-b'), mime: null, direction: 'outbound' });
  const roto = await message({ mediaUrl: 'data:sin-contenido' });

  assert.ok(await migrateMediaToDisk() >= 3);
  assert.equal((await row(a)).media_url, `file:${ctx.orgId}/${a}`);
  assert.equal((await readFile(fileOf(a))).toString(), 'migrado-a');
  assert.deepEqual(await row(b), { media_url: `file:${ctx.orgId}/${b}`, media_mime: 'video/mp4' });
  assert.equal((await readFile(fileOf(b))).toString(), 'migrado-b');
  assert.equal((await row(roto)).media_url, null, 'un data URI ilegible no bloquea la cola');
  const left = await one(`SELECT count(*)::int AS n FROM conv_messages WHERE organization_id = $1 AND media_url LIKE 'data:%'`, [ctx.orgId]);
  assert.equal(left.n, 0);
});

test('retención: la media entrante antigua se vacía con su archivo; la enviada y la reciente no', async () => {
  const mk = async (direction: string, age: string) => {
    const id = await message({ direction, age });
    await mkdir(path.dirname(fileOf(id)), { recursive: true });
    await writeFile(fileOf(id), 'contenido');
    await db.query(`UPDATE conv_messages SET media_url = $1 WHERE id = $2`, [`file:${ctx.orgId}/${id}`, id]);
    return id;
  };
  const inOld = await mk('inbound', '40 days');
  const outOld = await mk('outbound', '40 days');
  const inNew = await mk('inbound', '5 days');

  await runRetention({ orgId: ctx.orgId, purgeMedia: false });
  assert.ok(existsSync(fileOf(inOld)), 'sin RETENTION_PURGE_MEDIA no se toca');

  const res = await runRetention({ orgId: ctx.orgId, purgeMedia: true });
  assert.equal(res['media cacheada'], 1);
  assert.equal((await row(inOld)).media_url, null);
  assert.equal(existsSync(fileOf(inOld)), false);
  assert.ok(existsSync(fileOf(outOld)), 'la imagen enviada desde el CRM es la única copia');
  assert.ok(existsSync(fileOf(inNew)));
});

test('limpieza: se borran los archivos cuyo mensaje ya no existe, pasada una hora', async () => {
  const mk = async () => {
    const id = await message();
    await mkdir(path.dirname(fileOf(id)), { recursive: true });
    await writeFile(fileOf(id), 'contenido');
    await db.query(`UPDATE conv_messages SET media_url = $1 WHERE id = $2`, [`file:${ctx.orgId}/${id}`, id]);
    return id;
  };
  const old = new Date(Date.now() - 2 * 3600_000);
  const vivo = await mk();
  const borrado = await mk();
  const reciente = await mk();
  for (const id of [vivo, borrado]) await utimes(fileOf(id), old, old);
  await db.query(`DELETE FROM conv_messages WHERE id = ANY($1::uuid[])`, [[borrado, reciente]]);

  assert.equal(await sweepOrphanMedia(ctx.orgId), 1);
  assert.ok(existsSync(fileOf(vivo)), 'el archivo de un mensaje que sigue ahí no se toca');
  assert.equal(existsSync(fileOf(borrado)), false);
  assert.ok(existsSync(fileOf(reciente)), 'un archivo reciente puede ser de un adjunto que se está guardando');
});

test('una referencia que no tiene la forma esperada nunca sale de la carpeta de adjuntos', () => {
  for (const ref of ['file:../../etc/passwd', `file:${'a'.repeat(36)}/x`, 'file:', `file:${ctx.orgId}/../${ctx.orgId}`, `file:${ctx.orgId}/${ctx.orgId}/extra`]) {
    assert.equal(mediaFilePath(ref), null, ref);
  }
});

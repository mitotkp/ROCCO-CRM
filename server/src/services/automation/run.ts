// Ejecución de un run de automatización: recorre los pasos de la regla, guarda el progreso tras
// cada uno, y sabe esperar (minutos, respuesta de WhatsApp, antes de una cita) y reanudar.
// También el planificador que reanuda las esperas vencidas y recupera los runs atascados.

import { pool } from '../../db.ts';
import { broadcast } from '../ws-manager.ts';
import { notify, notifyNewLead } from '../notify.ts';
import { evolutionFor, isNotOnWhatsapp, type EvolutionClient } from '../evolution.ts';
import { sendIgDm, sendIgPrivateReply, replyToIgComment } from '../instagram.ts';
import { upsertSocialConversation } from '../social-inbox.ts';
import { mediaPublicUrl } from '../../routes/automation-media.ts';
import { AREA_CODE_MAP, detectUsState } from './us-states.ts';
import { interpolate, appointmentTimeFields } from './templates.ts';

// ── Obtener cliente WA activo de la org ─────────────────────────────────────

async function getWaClient(orgId: string): Promise<EvolutionClient | null> {
  const res = await pool.query<{ evo_url: string; evo_api_key: string; instance_name: string }>(
    `SELECT evo_url, evo_api_key, instance_name
     FROM wa_settings
     WHERE organization_id = $1 AND session_status = 'connected'
     ORDER BY is_default DESC, created_at LIMIT 1`,
    [orgId],
  );
  if (!res.rows[0]) return null;
  return evolutionFor(res.rows[0]);
}

// ── Ejecución de un run ─────────────────────────────────────────────────────

// Zona de la cita para los recordatorios: la del calendario; si no tiene, la guardada en la cita
// (que al crearla ya se resolvió como calendario → navegador → organización).
const APPT_SQL = `SELECT a.status, a.start_at, COALESCE(c.timezone, a.timezone) AS timezone
  FROM appointments a LEFT JOIN calendars c ON c.id = a.calendar_id
  WHERE a.id = $1 AND a.organization_id = $2`;

type ApptWait = { appointment_id?: string | null; minutes_before?: number; resume_step?: number };

// Antes de continuar un run que esperaba "X minutos antes de la cita": si la cita se canceló, el run se
// cancela (no salen recordatorios de citas canceladas); si se reagendó, se reprograma con la hora nueva;
// si la cita ya empezó (p. ej. el servidor estuvo caído), se salta el recordatorio que seguía a la espera.
// `startIdx` es el paso por el que se va a reanudar (ya resuelto por id); devuelve el paso por el que seguir
// o 'stop'. La comparación con resume_step usa el current_step guardado (los dos se guardaron a la vez).
async function checkAppointmentWait(run: {
  id: string; organization_id: string; current_step: number; step_data: Record<string, Record<string, unknown>>;
}, steps: StepDef[], startIdx: number): Promise<number | 'stop'> {
  const w = run.step_data?.['__appt_wait__'] as ApptWait | undefined;
  if (!w?.appointment_id || run.current_step !== w.resume_step) return startIdx;
  const appt = (await pool.query<{ status: string; start_at: Date; timezone: string }>(
    APPT_SQL, [w.appointment_id, run.organization_id],
  )).rows[0];
  if (!appt || appt.status !== 'scheduled') {
    await pool.query(`UPDATE automation_runs SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [run.id]);
    return 'stop';
  }
  const prev = run.step_data['__appointment__'] as Record<string, unknown> | undefined;
  const start = new Date(appt.start_at);
  const now = new Date();
  if (start <= now) {
    // La cita ya empezó: un recordatorio a destiempo confunde más de lo que ayuda (se salta el paso que seguía a la espera)
    const next = startIdx + 1;
    await pool.query(`UPDATE automation_runs SET current_step = $1, step_data = $2, updated_at = NOW() WHERE id = $3`,
      [next, withCursor(run.step_data, steps, next), run.id]);
    return next;
  }
  if (!prev?.start_at || new Date(prev.start_at as string).getTime() === start.getTime()) return startIdx;

  // Reagendada: actualizar fecha/hora para los mensajes y recalcular cuándo toca el recordatorio
  run.step_data['__appointment__'] = { ...prev, ...appointmentTimeFields(start, appt.timezone) };
  const resumeAt = new Date(start.getTime() - (w.minutes_before ?? 120) * 60_000);
  if (resumeAt > now) {
    await pool.query(
      `UPDATE automation_runs SET status = 'waiting_timed', step_data = $1, resume_at = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(run.step_data), resumeAt.toISOString(), run.id],
    );
    return 'stop';
  }
  await pool.query(`UPDATE automation_runs SET step_data = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(run.step_data), run.id]);
  return startIdx;
}

/**
 * Sincroniza los runs que esperan "X minutos antes" de una cita tras cambiarla (reagendar, cancelar, borrar):
 * - cita cancelada/borrada/no programada → se cancelan los runs en espera;
 * - nueva hora → se actualizan {{appointment.start_*}} y se recalcula resume_at (si ya pasó, toca ya).
 * Llamar después de guardar el cambio en appointments.
 */
export async function rescheduleAppointmentWaits(orgId: string, appointmentId: string): Promise<void> {
  const runs = (await pool.query<{ id: string; current_step: number; step_data: Record<string, Record<string, unknown>> }>(
    `SELECT id, current_step, step_data FROM automation_runs
     WHERE organization_id = $1 AND status = 'waiting_timed'
       AND step_data->'__appt_wait__'->>'appointment_id' = $2
       AND current_step = (step_data->'__appt_wait__'->>'resume_step')::int`,
    [orgId, appointmentId],
  )).rows;
  if (!runs.length) return;
  const appt = (await pool.query<{ status: string; start_at: Date; timezone: string }>(APPT_SQL, [appointmentId, orgId])).rows[0];
  if (!appt || appt.status !== 'scheduled') {
    await pool.query(`UPDATE automation_runs SET status = 'cancelled', updated_at = NOW() WHERE id = ANY($1)`, [runs.map(r => r.id)]);
    return;
  }
  const start = new Date(appt.start_at);
  for (const run of runs) {
    const w = run.step_data['__appt_wait__'] as ApptWait;
    run.step_data['__appointment__'] = { ...run.step_data['__appointment__'], ...appointmentTimeFields(start, appt.timezone) };
    const resumeAt = new Date(Math.max(start.getTime() - (w.minutes_before ?? 120) * 60_000, Date.now()));
    await pool.query(
      `UPDATE automation_runs SET step_data = $1, resume_at = $2, updated_at = NOW() WHERE id = $3 AND status = 'waiting_timed'`,
      [JSON.stringify(run.step_data), resumeAt.toISOString(), run.id],
    );
  }
}

// ── Progreso y garantías de ejecución ───────────────────────────────────────
// Cada paso, al terminar, guarda en UNA sola UPDATE el índice siguiente (current_step), los datos
// (step_data) y el cursor `__cursor__.next_step_id` = id del paso por el que seguir. Al reanudar se
// busca ese id en la versión ACTUAL de la regla: si alguien insertó, movió o borró pasos mientras el
// run esperaba, se sigue por el mismo paso y no se repite ni se salta un mensaje. Si ese paso ya no
// existe, el run termina como completado con una nota (`__note__`).
// Un reinicio a mitad de un paso (corte de luz) solo puede repetir ESE paso, y nunca un envío de
// WhatsApp: antes de llamar a Evolution se guarda la marca `{sending: true}` del paso; si al reanudar
// la marca sigue ahí, no se sabe si el mensaje salió y se prefiere no duplicarlo (se marca
// `sent: 'unknown'` y se sigue). Un timeout de Evolution, en cambio, se reintenta (el mensaje podría
// llegar dos veces si Evolution lo envió pero respondió tarde: preferible a perderlo).

type StepData = Record<string, Record<string, unknown>>;

// Serializa step_data con el cursor apuntando al paso `idx` de `steps`
function withCursor(stepData: StepData, steps: StepDef[], idx: number): string {
  stepData['__cursor__'] = { next_step_id: steps[idx]?.id ?? null, done: idx >= steps.length };
  return JSON.stringify(stepData);
}

// Paso por el que reanudar un run: por el id del cursor; sin cursor (runs anteriores a este cambio,
// o pasos sin id) por el índice guardado. 'gone' = el paso pendiente se borró de la regla.
function resolveStart(run: { current_step: number; step_data: StepData }, steps: StepDef[]): number | 'gone' {
  const cur = run.step_data?.['__cursor__'] as { next_step_id?: string | null; done?: boolean } | undefined;
  if (!cur) return run.current_step;
  if (cur.done) return steps.length;
  if (!cur.next_step_id) return run.current_step;
  if (steps[run.current_step]?.id === cur.next_step_id) return run.current_step;   // sin cambios (o ids repetidos)
  const idx = steps.findIndex(s => s.id === cur.next_step_id);
  return idx >= 0 ? idx : 'gone';
}

// WhatsApp no disponible: cada cuánto se reintenta un envío y cuántas veces (12 × 5 min = 1 hora)
const WA_RETRY_MINUTES = 5;
const WA_MAX_RETRIES = 12;

// Aviso en la campanita a owner/admin cuando una automatización no pudo enviar un WhatsApp
async function notifySendFailure(orgId: string, runId: string, automationId: string, contact: Record<string, unknown>, phone: string, reason: string) {
  const rule = (await pool.query<{ name: string }>(`SELECT name FROM automation_rules WHERE id = $1`, [automationId])).rows[0];
  const who = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
  const to = who ? `${who} (+${phone})` : `+${phone}`;
  await notify({
    orgId, audience: 'admins', type: 'system', bellType: 'automation',
    title: 'Mensaje de automatización no enviado',
    body: `No se pudo enviar el mensaje de la automatización «${rule?.name ?? 'sin nombre'}» a ${to}: ${reason}. ` +
      `Se reintentó durante ${WA_RETRY_MINUTES * WA_MAX_RETRIES} minutos. Revisa la conexión en Configuración → WhatsApp y envíalo a mano.`,
    entityType: 'automation_run', entityId: runId,
    data: { contactId: typeof contact.id === 'string' ? contact.id : undefined },
  });
}

export async function executeRun(runId: string): Promise<void> {
  // Cargar el run
  const runRes = await pool.query<{
    id: string;
    organization_id: string;
    automation_id: string;
    contact_id: string | null;
    contact_phone: string | null;
    status: string;
    current_step: number;
    step_data: StepData;
  }>(
    `SELECT * FROM automation_runs WHERE id = $1`,
    [runId],
  );
  const run = runRes.rows[0];
  if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return;
  run.step_data ??= {};

  // Cargar la automatización
  const autoRes = await pool.query<{ config: { steps: StepDef[] } }>(
    `SELECT config FROM automation_rules WHERE id = $1`,
    [run.automation_id],
  );
  const autoRule = autoRes.rows[0];
  if (!autoRule) return;

  const steps: StepDef[] = autoRule.config?.steps ?? [];
  const orgId = run.organization_id;

  // Paso por el que seguir (por id, ver arriba)
  const resolved = resolveStart(run, steps);
  if (resolved === 'gone') {
    const missing = (run.step_data['__cursor__'] as { next_step_id?: string }).next_step_id;
    run.step_data['__note__'] = { message: `El paso ${missing} se eliminó de la automatización mientras el run esperaba: se dio por terminado.` };
    await pool.query(
      `UPDATE automation_runs SET status = 'completed', step_data = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(run.step_data), runId],
    );
    return;
  }
  const start = await checkAppointmentWait(run, steps, resolved);
  if (start === 'stop') return;

  // Flujo de "No asistió": si mientras esperaba la cita dejó de estar en no_show (la corrigieron
  // o el lead reagendó), no se envía nada
  const noShow = (run.step_data as Record<string, unknown>).__no_show__ as { appointment_id?: string } | undefined;
  if (noShow?.appointment_id) {
    const st = (await pool.query<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [noShow.appointment_id])).rows[0]?.status;
    if (st !== 'no_show') {
      await pool.query(`UPDATE automation_runs SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [runId]);
      return;
    }
  }

  // Cargar contacto
  let contact: Record<string, unknown> = {};
  if (run.contact_id) {
    const cRes = await pool.query(
      `SELECT * FROM contacts WHERE id = $1`,
      [run.contact_id],
    );
    contact = cRes.rows[0] ?? {};
  }

  const stepData: StepData = run.step_data;
  let currentStep = start;

  for (let i = currentStep; i < steps.length; i++) {
    const step = steps[i];

    try {
      if (step.type === 'detect_us_state') {
        const phone = (contact.phone as string) ?? run.contact_phone ?? '';
        const state = detectUsState(phone);
        stepData[step.id] = { state };
        currentStep = i + 1;
        await persistRunProgress(runId, steps, currentStep, stepData);

      } else if (step.type === 'create_opportunity') {
        // Usar pipeline/stage del config si están definidos, si no tomar el primero
        let pipelineId = step.pipeline_id as string | undefined;
        let stageId    = step.stage_id    as string | undefined;

        if (!pipelineId) {
          const pipeRes = await pool.query<{ id: string }>(
            `SELECT id FROM pipelines WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
            [orgId],
          );
          if (!pipeRes.rows[0]) { currentStep = i + 1; await persistRunProgress(runId, steps, currentStep, stepData); continue; }
          pipelineId = pipeRes.rows[0].id;
        }

        if (!stageId) {
          const stageRes = await pool.query<{ id: string }>(
            `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position LIMIT 1`,
            [pipelineId],
          );
          if (!stageRes.rows[0]) { currentStep = i + 1; await persistRunProgress(runId, steps, currentStep, stepData); continue; }
          stageId = stageRes.rows[0].id;
        }

        const title  = interpolate(step.title  ?? '{{contact.name}}', contact, stepData);
        const source = interpolate(step.source ?? '', contact, stepData);

        const oppRes = await pool.query<{ id: string }>(
          `INSERT INTO opportunities (organization_id, pipeline_id, stage_id, contact_id, title, source)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [orgId, pipelineId, stageId, run.contact_id ?? null, title, source || null],
        );
        stepData[step.id] = { opportunity_id: oppRes.rows[0].id };
        broadcast(orgId, 'opportunity:new', { id: oppRes.rows[0].id });
        // Lead nuevo (WhatsApp, Instagram, reserva… todos entran por aquí): aviso + push
        notifyNewLead(orgId, oppRes.rows[0].id, run.contact_id ?? null, title, source);
        currentStep = i + 1;
        await persistRunProgress(runId, steps, currentStep, stepData);

      } else if (step.type === 'send_notification') {
        const notifTitle = interpolate(step.notification_title ?? '', contact, stepData);
        const notifBody  = interpolate(step.notification_body  ?? '', contact, stepData);

        await notify({
          orgId, audience: 'all', type: 'system', bellType: 'automation',
          title: notifTitle, body: notifBody, entityType: 'automation_run', entityId: runId,
          data: { contactId: run.contact_id },
        });
        stepData[step.id] = { sent: true };
        currentStep = i + 1;
        await persistRunProgress(runId, steps, currentStep, stepData);

      } else if (step.type === 'wait_minutes') {
        // Espera N minutos desde ahora antes de continuar con el siguiente paso
        const minutes = (step.minutes as number) ?? 3;
        const resumeAt = new Date(Date.now() + minutes * 60_000);
        currentStep = i + 1;
        await pool.query(
          `UPDATE automation_runs
           SET status = 'waiting_timed', current_step = $1, step_data = $2,
               resume_at = $3, updated_at = NOW()
           WHERE id = $4`,
          [currentStep, withCursor(stepData, steps, currentStep), resumeAt.toISOString(), runId],
        );
        return;

      } else if (step.type === 'send_whatsapp') {
        // Si el step define `to_phone` se usa ese número fijo; de lo contrario el del contacto
        const phone = (step.to_phone as string | undefined)
          ? (step.to_phone as string).replace(/\D/g, '')
          : normalizeContactPhone(contact, run);
        const retry = stepData['__wa_retry__'] as { step_id?: string; count?: number } | undefined;

        if (!phone) {
          stepData[step.id] = { sent: false, reason: 'sin_telefono' };
        } else if (stepData[step.id]?.sending) {
          // Se reinició el servidor en pleno envío: no se sabe si salió → no se repite (ver garantías arriba)
          console.warn(`[automation-engine] run ${runId} ${step.id}: envío interrumpido por un reinicio; no se repite`);
          stepData[step.id] = { sent: 'unknown' };
        } else {
          const message = interpolate(step.message ?? '', contact, stepData);
          // Adjunto opcional (video/imagen del almacén de medios de la org): el mensaje va como caption
          const media = await resolveStepMedia(orgId, step, runId);
          const client = await getWaClient(orgId);
          let outcome: 'sent' | 'no_wa' | 'retry' = 'retry';
          let reason = 'WhatsApp desconectado';
          if (client) {
            // Marca de "enviando" ANTES de llamar a Evolution (si el proceso muere aquí, no se duplica)
            stepData[step.id] = { sending: true };
            await persistRunProgress(runId, steps, i, stepData);
            try {
              if (media) {
                await client.sendMedia(phone, {
                  mediatype: media.type, media: media.url, caption: message,
                  fileName: media.file_name, mimetype: media.mime,
                });
              } else {
                await client.sendText(phone, message);
              }
              outcome = 'sent';
            } catch (sendErr: unknown) {
              if (isNotOnWhatsapp(sendErr)) {
                outcome = 'no_wa';
              } else {
                // 5xx, instancia caída, sin red, timeout…: pasajero, se reintenta
                const msg = !(sendErr instanceof Error) ? String(sendErr)
                  : sendErr.name === 'TimeoutError' ? 'Evolution no respondió a tiempo' : sendErr.message;
                reason = `error al enviar (${msg.slice(0, 160)})`;
              }
            }
          }

          if (outcome === 'retry') {
            const count = (retry?.step_id === step.id ? retry.count ?? 0 : 0) + 1;
            if (count > WA_MAX_RETRIES) {
              stepData[step.id] = { sent: false, error: reason };
              delete stepData['__wa_retry__'];
              console.warn(`[automation-engine] run ${runId} ${step.id}: sin enviar tras ${WA_MAX_RETRIES} reintentos (${reason})`);
              await pool.query(
                `UPDATE automation_runs SET status = 'failed', current_step = $1, step_data = $2, updated_at = NOW() WHERE id = $3`,
                [i, withCursor(stepData, steps, i), runId],
              );
              await notifySendFailure(orgId, runId, run.automation_id, contact, phone, reason);
              return;
            }
            // Mismo paso dentro de 5 min (resumeTimedRuns lo retoma)
            delete stepData[step.id];
            stepData['__wa_retry__'] = { step_id: step.id, count, last_error: reason };
            await pool.query(
              `UPDATE automation_runs
               SET status = 'waiting_timed', current_step = $1, step_data = $2,
                   resume_at = NOW() + make_interval(mins => $3), updated_at = NOW()
               WHERE id = $4`,
              [i, withCursor(stepData, steps, i), WA_RETRY_MINUTES, runId],
            );
            return;
          }

          if (outcome === 'no_wa') {
            // El número no tiene WhatsApp: se sigue con la automatización sin reintentar
            console.warn(`[automation-engine] ${step.id}: número ${phone} sin WA, continuando`);
            stepData[step.id] = { sent: false, reason: 'sin_whatsapp' };
          } else {
            stepData[step.id] = media ? { sent: true, media_id: media.id } : { sent: true };
            await logOutboundWa(orgId, phone, message, media);
          }
          if (retry?.step_id === step.id) delete stepData['__wa_retry__'];
        }
        currentStep = i + 1;
        await persistRunProgress(runId, steps, currentStep, stepData);

      } else if (step.type === 'wait_for_reply') {
        // Avanzar current_step al siguiente para que al retomar empiece después de este
        currentStep = i + 1;
        withCursor(stepData, steps, currentStep);
        const phone = normalizeContactPhone(contact, run);
        await pool.query(
          `UPDATE automation_runs
           SET status = 'waiting', current_step = $1, step_data = $2,
               contact_phone = $3, waiting_since = NOW(), updated_at = NOW()
           WHERE id = $4`,
          [currentStep, JSON.stringify(stepData), phone ?? run.contact_phone, runId],
        );
        return; // parar ejecución hasta que llegue una respuesta

      } else if (step.type === 'ig_reply_comment') {
        // Responde al comentario de IG con uno de los mensajes del array (rotación circular)
        const commentId = (stepData['__ig_comment__']?.commentId as string | undefined) ?? '';
        const accessToken = (stepData['__ig_comment__']?.accessToken as string | undefined) ?? '';
        const messages: string[] = (step.messages as string[] | undefined) ?? [];
        // Aleatorio: cada comentario abre una ejecución nueva, así que un contador por run
        // siempre elegía el primer mensaje (respuestas idénticas = patrón de spam para IG).
        const message = messages.length ? messages[Math.floor(Math.random() * messages.length)] : (step.message as string ?? '');
        if (commentId && accessToken && message) {
          const interpolated = interpolate(message, contact, stepData);
          const reply = await replyToIgComment(commentId, accessToken, interpolated);
          const ig = stepData['__ig_comment__'] ?? {};
          await logIgInbox(orgId, ig, contact, `💬 Comentó en tu publicación: "${ig.text ?? ''}"`, `igc_${commentId}`, 'inbound');
          if (reply.id) await logIgInbox(orgId, ig, contact, `💬 Respuesta pública: ${interpolated}`, `igr_${reply.id}`, 'outbound');
        }
        stepData[step.id] = { replied: true };
        currentStep = i + 1;
        await persistRunProgress(runId, steps, currentStep, stepData);

      } else if (step.type === 'ig_send_dm') {
        // Envía un DM al usuario que comentó
        // El primer DM a quien comentó va como private reply (recipient.comment_id): un DM por
        // IGSID solo se permite si la persona escribió en las últimas 24h.
        const ig = stepData['__ig_comment__'] ?? {};
        const commentId = (ig.commentId as string | undefined) ?? '';
        const senderId = (ig.senderId as string | undefined) ?? '';
        const igUserId = (ig.igUserId as string | undefined) ?? '';
        const accessToken = (ig.accessToken as string | undefined) ?? '';
        const privateReplyUsed = Boolean(stepData['__ig_private_reply__']);
        const message = interpolate((step.message as string) ?? '', contact, stepData);
        let result: { message_id?: string; error?: unknown } = {};
        if (igUserId && accessToken && message) {
          if (commentId && !privateReplyUsed) {
            result = await sendIgPrivateReply(igUserId, accessToken, commentId, message);
            stepData['__ig_private_reply__'] = { used: true };
          } else if (senderId) {
            result = await sendIgDm(igUserId, accessToken, senderId, message);
          }
        }
        if (result.message_id) await logIgInbox(orgId, ig, contact, message, result.message_id, 'outbound');
        stepData[step.id] = { sent: Boolean(result.message_id), ...(result.error ? { error: result.error } : {}) };
        currentStep = i + 1;
        await persistRunProgress(runId, steps, currentStep, stepData);

      } else if (step.type === 'wait_before_appointment') {
        const minutesBefore = (step.minutes_before as number) ?? 120;
        const apptData = stepData['__appointment__'] as { start_at?: string } | undefined;

        if (!apptData?.start_at) {
          // Sin datos de cita, saltar este paso
          currentStep = i + 1;
          await persistRunProgress(runId, steps, currentStep, stepData);
          continue;
        }

        const resumeAt = new Date(new Date(apptData.start_at).getTime() - minutesBefore * 60_000);

        if (new Date(apptData.start_at) <= new Date()) {
          // La cita ya empezó: saltar la espera y el recordatorio que la sigue
          currentStep = i + 2;
          i++;
          await persistRunProgress(runId, steps, currentStep, stepData);
          continue;
        }

        if (resumeAt <= new Date()) {
          // El tiempo ya pasó, continuar de inmediato
          currentStep = i + 1;
          await persistRunProgress(runId, steps, currentStep, stepData);
          continue;
        }

        currentStep = i + 1;
        // Al reanudar se revisa la cita: si se canceló no sale el recordatorio; si se reagendó, se reprograma
        stepData['__appt_wait__'] = { appointment_id: (apptData as { appointment_id?: string }).appointment_id ?? null, minutes_before: minutesBefore, resume_step: currentStep };
        await pool.query(
          `UPDATE automation_runs
           SET status = 'waiting_timed', current_step = $1, step_data = $2,
               resume_at = $3, updated_at = NOW()
           WHERE id = $4`,
          [currentStep, withCursor(stepData, steps, currentStep), resumeAt.toISOString(), runId],
        );
        return; // parar hasta que el scheduler lo reanude
      }

    } catch (err) {
      console.error(`[automation-engine] Error en step ${step.id} (${step.type}):`, err);
      await pool.query(
        `UPDATE automation_runs SET status = 'failed', updated_at = NOW() WHERE id = $1`,
        [runId],
      );
      return;
    }
  }

  // Todos los pasos completados
  await pool.query(
    `UPDATE automation_runs
     SET status = 'completed', current_step = $1, step_data = $2,
         completed_at = NOW(), updated_at = NOW()
     WHERE id = $3`,
    [currentStep, withCursor(stepData, steps, currentStep), runId],
  );
}

// ── Helpers internos ─────────────────────────────────────────────────────────

// Registra en la bandeja (conversación de IG del contacto) lo que pasa en el flujo de comentarios.
async function logIgInbox(
  orgId: string,
  ig: Record<string, unknown>,
  contact: Record<string, unknown>,
  text: string,
  mid: string,
  direction: 'inbound' | 'outbound',
) {
  const peerId = ig.senderId as string | undefined;
  const connectionId = ig.connectionId as string | undefined;
  if (!peerId || !connectionId) return;
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || (ig.senderName as string) || peerId;
  await upsertSocialConversation({
    orgId, socialAccountId: connectionId, channel: 'instagram_dm', chatId: `ig_${peerId}`,
    displayName: name, text, mid, direction, contactId: (contact.id as string) ?? null,
  });
}

async function persistRunProgress(
  runId: string,
  steps: StepDef[],
  currentStep: number,
  stepData: StepData,
): Promise<void> {
  await pool.query(
    `UPDATE automation_runs SET current_step = $1, step_data = $2, updated_at = NOW() WHERE id = $3`,
    [currentStep, withCursor(stepData, steps, currentStep), runId],
  );
}

// Registra en la conversación del chat (si existe) el mensaje que envió la automatización
async function logOutboundWa(orgId: string, phone: string, message: string, media?: StepMedia | null): Promise<void> {
  const chatJid = `${phone}@s.whatsapp.net`;
  const convRes = await pool.query<{ id: string }>(
    `SELECT id FROM conversations WHERE organization_id = $1 AND wa_chat_id = $2 LIMIT 1`,
    [orgId, chatJid],
  );
  if (!convRes.rows[0]) return;
  const convId = convRes.rows[0].id;
  const msgType = media?.type ?? 'text';
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO conv_messages (conversation_id, organization_id, direction, msg_type, body, status)
     VALUES ($1, $2, 'outbound', $3, $4, 'sent')
     RETURNING id`,
    [convId, orgId, msgType, message],
  );
  if (inserted.rows[0] && media) {
    await pool.query(`UPDATE conv_messages SET media_url = $1, media_mime = $2 WHERE id = $3`, [media.url, media.mime, inserted.rows[0].id]);
  }
  if (!inserted.rows[0]) return;
  await pool.query(
    `UPDATE conversations SET last_message_at = NOW(), last_message_preview = $1, updated_at = NOW() WHERE id = $2`,
    [(message || (media?.type === 'video' ? '🎥 Video' : media ? '📷 Imagen' : '')).slice(0, 100), convId],
  );
  broadcast(orgId, 'message:new', {
    conversationId: convId,
    message: {
      id: inserted.rows[0].id, conversation_id: convId, wa_message_id: null,
      direction: 'outbound', msg_type: msgType, body: message,
      media_url: media?.url ?? null, media_mime: media?.mime ?? null, sender_name: null,
      status: 'sent', created_at: new Date().toISOString(),
    },
  });
}

// Adjunto de un paso send_whatsapp: `media_id` de automation_media de la MISMA org. Si no existe (borrado,
// de otra org, id inválido) se envía solo el texto y queda un aviso en el log.
type StepMedia = { id: string; type: 'video' | 'image'; url: string; mime: string; file_name: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveStepMedia(orgId: string, step: StepDef, runId: string): Promise<StepMedia | null> {
  const mediaId = step.media_id;
  if (!mediaId) return null;
  const row = UUID_RE.test(mediaId)
    ? (await pool.query<{ id: string; token: string; mime: string; file_name: string }>(
        `SELECT id, token, mime, file_name FROM automation_media WHERE id = $1 AND organization_id = $2`,
        [mediaId, orgId],
      )).rows[0]
    : undefined;
  if (!row) {
    console.warn(`[automation-engine] run ${runId} ${step.id}: el adjunto ${mediaId} no existe en la organización; se envía solo el texto`);
    return null;
  }
  const type = step.media_type === 'video' || step.media_type === 'image' ? step.media_type
    : row.mime.startsWith('video/') ? 'video' : 'image';
  return { id: row.id, type, url: mediaPublicUrl(row.token), mime: row.mime, file_name: row.file_name };
}

function normalizeContactPhone(
  contact: Record<string, unknown>,
  run: { contact_phone: string | null },
): string | null {
  const raw = (contact.phone as string) ?? run.contact_phone ?? null;
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // Números de EE.UU. de 10 dígitos: añadir prefijo de país 1
  if (digits.length === 10 && AREA_CODE_MAP[digits.slice(0, 3)]) {
    return '1' + digits;
  }
  return digits;
}

// ── Tipos internos ───────────────────────────────────────────────────────────

interface StepDef {
  id: string;
  type: string;
  label?: string;
  // detect_us_state — sin campos extra
  // create_opportunity
  title?: string;
  source?: string;
  pipeline_id?: string;
  stage_id?: string;
  // send_notification
  notification_title?: string;
  notification_body?: string;
  // send_whatsapp
  message?: string;
  media_id?: string | null;          // adjunto (automation_media) enviado con el mensaje como caption
  media_type?: 'video' | 'image';    // opcional: se deduce del mime
  // wait_for_reply — sin campos extra
  to_phone?: string;
  // wait_before_appointment
  minutes_before?: number;
  // wait_minutes
  minutes?: number;
  // ig_reply_comment — rotación circular de respuestas
  messages?: string[];
}

// ── Scheduler: reanudar esperas por tiempo ───────────────────────────────────

// `onlyOrgId` limita a una organización (lo usan los tests: la BD local es compartida).
export async function resumeTimedRuns(onlyOrgId?: string): Promise<void> {
  try {
    const runsRes = await pool.query<{ id: string }>(
      `UPDATE automation_runs
       SET status = 'running', updated_at = NOW()
       WHERE status = 'waiting_timed' AND resume_at <= NOW()
         AND ($1::uuid IS NULL OR organization_id = $1)
       RETURNING id`,
      [onlyOrgId ?? null],
    );
    for (const row of runsRes.rows) {
      executeRun(row.id).catch(e => console.error('[automation-engine] timed resume error:', e));
    }
  } catch (e) {
    console.error('[automation-engine] resumeTimedRuns error:', e);
  }
}

// ── Recuperar runs atascados ─────────────────────────────────────────────────
// Un run en 'running' solo dura lo que tarda un paso (segundos; cada paso actualiza updated_at). Si
// lleva más de 10 min sin moverse, el proceso murió a mitad (reinicio, corte de luz): se pasa a
// 'waiting_timed' para que resumeTimedRuns lo retome por el paso guardado (ver garantías en executeRun).
// Los que llevan más de 24 h atascados (p. ej. de antes de este arreglo) no se reanudan: un mensaje
// automático con días de retraso confunde al lead; se marcan 'failed' con una nota.
export async function recoverStuckRuns(onlyOrgId?: string): Promise<number> {
  await pool.query(
    `UPDATE automation_runs
     SET status = 'failed', updated_at = NOW(),
         step_data = step_data || '{"__note__":{"message":"Quedó atascado más de 24 h (reinicio del servidor): no se reanudó."}}'::jsonb
     WHERE status = 'running' AND updated_at < NOW() - INTERVAL '24 hours'
       AND ($1::uuid IS NULL OR organization_id = $1)`,
    [onlyOrgId ?? null],
  );
  const { rowCount } = await pool.query(
    `UPDATE automation_runs SET status = 'waiting_timed', resume_at = NOW(), updated_at = NOW()
     WHERE status = 'running' AND updated_at < NOW() - INTERVAL '10 minutes'
       AND ($1::uuid IS NULL OR organization_id = $1)`,
    [onlyOrgId ?? null],
  );
  if (rowCount) console.warn(`[automation-engine] ${rowCount} run(s) atascados en 'running' se reanudarán`);
  return rowCount ?? 0;
}

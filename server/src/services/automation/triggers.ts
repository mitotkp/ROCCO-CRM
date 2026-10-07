// Disparadores de las automatizaciones: cada evento del CRM (etiqueta añadida, mensaje de
// WhatsApp, contacto creado, cita agendada o no asistida, comentario de Instagram) busca las
// reglas activas de la organización y arranca un run por cada una.

import { pool } from '../../db.ts';
import { wantsInfo, captionKeywords, matchesKeyword } from '../ig-intent.ts';
import { phoneMatchKey } from '../../phone.ts';
import { env } from '../../env.ts';
import { appointmentTimeFields } from './templates.ts';
import { executeRun } from './run.ts';

// ── Iniciar automatización ───────────────────────────────────────────────────

async function startAutomation(
  orgId: string,
  ruleId: string,
  contactId: string,
  extraStepData?: Record<string, Record<string, unknown>>,
): Promise<void> {
  const contactRes = await pool.query(
    `SELECT * FROM contacts WHERE id = $1 AND organization_id = $2`,
    [contactId, orgId],
  );
  const contact = contactRes.rows[0];
  if (!contact) return;

  const phone = contact.phone ? String(contact.phone).replace(/\D/g, '') : null;
  const initialStepData = extraStepData ? JSON.stringify(extraStepData) : '{}';

  const runRes = await pool.query<{ id: string }>(
    `INSERT INTO automation_runs
       (organization_id, automation_id, contact_id, contact_phone, status, current_step, step_data)
     VALUES ($1, $2, $3, $4, 'running', 0,
       -- cursor al primer paso de la regla tal como está ahora (se reanuda por id, no por índice)
       $5::jsonb || jsonb_build_object('__cursor__', jsonb_build_object(
         'next_step_id', (SELECT config->'steps'->0->>'id' FROM automation_rules WHERE id = $2),
         'done', COALESCE((SELECT jsonb_array_length(config->'steps') = 0 FROM automation_rules WHERE id = $2), true))))
     RETURNING id`,
    [orgId, ruleId, contactId, phone, initialStepData],
  );
  const runId = runRes.rows[0].id;

  pool.query(
    `UPDATE automation_rules SET run_count = run_count + 1, last_run_at = NOW() WHERE id = $1`,
    [ruleId],
  ).catch(console.error);

  executeRun(runId).catch(e => console.error('[automation-engine] executeRun error:', e));
}

// ── Trigger por tag añadido ──────────────────────────────────────────────────

export async function fireTagTrigger(
  orgId: string,
  contactId: string,
  newlyAddedTags: string[],
): Promise<void> {
  try {
    const rulesRes = await pool.query<{ id: string; config: { trigger: { tag: string } } }>(
      `SELECT id, config FROM automation_rules
       WHERE organization_id = $1 AND trigger_type = 'tag_added' AND enabled = true`,
      [orgId],
    );
    for (const rule of rulesRes.rows) {
      const triggerTag = rule.config?.trigger?.tag;
      if (triggerTag && newlyAddedTags.includes(triggerTag)) {
        await startAutomation(orgId, rule.id, contactId);
      }
    }
  } catch (e) {
    console.error('[automation-engine] fireTagTrigger error:', e);
  }
}

// ── Disparador: nuevo mensaje de WhatsApp ───────────────────────────────────

export async function fireWaNewMessageTrigger(
  orgId: string,
  contactId: string | null,
): Promise<void> {
  if (!contactId) return;
  try {
    const rulesRes = await pool.query<{ id: string }>(
      `SELECT id FROM automation_rules
       WHERE organization_id = $1 AND trigger_type = 'whatsapp_new_message' AND enabled = true`,
      [orgId],
    );
    for (const rule of rulesRes.rows) {
      await startAutomation(orgId, rule.id, contactId);
    }
  } catch (e) {
    console.error('[automation-engine] fireWaNewMessageTrigger error:', e);
  }
}

// ── Disparador: contacto creado ──────────────────────────────────────────────
// Se llama justo después de insertar un contacto nuevo (alta manual, CSV, WhatsApp,
// reserva pública, Instagram, oportunidad, Lead Ads). Nunca lanza.

export async function fireContactCreatedTrigger(orgId: string, contactId: string | null | undefined): Promise<void> {
  if (!contactId) return;
  try {
    const rulesRes = await pool.query<{ id: string }>(
      `SELECT id FROM automation_rules
       WHERE organization_id = $1 AND trigger_type = 'contact_created' AND enabled = true`,
      [orgId],
    );
    for (const rule of rulesRes.rows) {
      await startAutomation(orgId, rule.id, contactId);
    }
  } catch (e) {
    console.error('[automation-engine] fireContactCreatedTrigger error:', e);
  }
}

// ── Disparador: cita agendada ────────────────────────────────────────────────

export interface AppointmentTriggerData {
  appointment_id?: string; // para revisar la cita antes de cada recordatorio
  start_at: string;       // ISO UTC
  start_date: string;     // "lunes, 18 de septiembre de 2026"
  start_time: string;     // "10:00"
  meeting_url: string;    // enlace Google Meet / Zoom / ubicación
  reschedule_link: string;
}

export async function fireAppointmentBookedTrigger(
  orgId: string,
  contactId: string,
  appointmentData: AppointmentTriggerData,
  source: 'booking' | 'manual' = 'booking',
): Promise<void> {
  try {
    // Las citas creadas a mano solo disparan las reglas que lo activan (config.include_manual): así una
    // regla existente que manda WhatsApp al contacto no cambia de comportamiento sin que nadie lo decida.
    const rulesRes = await pool.query<{ id: string }>(
      `SELECT id FROM automation_rules
       WHERE organization_id = $1 AND trigger_type = 'appointment_booked' AND enabled = true
         AND ($2 = 'booking' OR (config->>'include_manual')::boolean IS TRUE)`,
      [orgId, source],
    );
    const extraStepData: Record<string, Record<string, unknown>> = {
      // reschedule_url: mismo enlace que reschedule_link (nombre que usa también "Cita: no asistió")
      __appointment__: { ...appointmentData, reschedule_url: appointmentData.reschedule_link },
    };
    for (const rule of rulesRes.rows) {
      await startAutomation(orgId, rule.id, contactId, extraStepData);
    }
  } catch (e) {
    console.error('[automation-engine] fireAppointmentBookedTrigger error:', e);
  }
}

// ── Disparador: cita marcada como "No asistió" ───────────────────────────────
// Se llama tras guardar appointments.status = 'no_show'. Solo citas con contacto y UNA sola vez por cita
// (marca appointments.no_show_notified_at, tomada de forma atómica): si la corrigen y la vuelven a marcar,
// no se repite. Datos para las plantillas: los mismos que "cita agendada" + {{appointment.reschedule_url}}.
// Nunca lanza.

// Enlace para reagendar: la página de gestión de la cita (/book/<slug>/manage/<token>) si tiene calendario
// y token; si no, la página de reservas del calendario de la cita o, sin calendario, la del calendario
// por defecto de la org (el primero activo, preferiblemente con reservas públicas).
async function appointmentRescheduleUrl(orgId: string, calendarSlug: string | null, token: string | null): Promise<string> {
  const base = env.publicUrl.replace(/\/$/, '');
  if (calendarSlug && token) return `${base}/book/${calendarSlug}/manage/${token}`;
  if (calendarSlug) return `${base}/book/${calendarSlug}`;
  const def = (await pool.query<{ slug: string }>(
    `SELECT slug FROM calendars WHERE organization_id = $1 AND is_active = true
     ORDER BY booking_enabled DESC, created_at ASC LIMIT 1`,
    [orgId],
  )).rows[0];
  return def ? `${base}/book/${def.slug}` : '';
}

// La cita dejó de estar en "No asistió" (corrección o el lead reagendó): se cancelan los mensajes
// pendientes de ese flujo y se quita la marca, para que una nueva falta sí vuelva a avisar.
export async function clearAppointmentNoShow(orgId: string, appointmentId: string): Promise<void> {
  await pool.query(
    `UPDATE automation_runs SET status = 'cancelled', updated_at = NOW()
     WHERE organization_id = $1 AND status IN ('waiting_timed', 'waiting', 'running')
       AND step_data->'__no_show__'->>'appointment_id' = $2`,
    [orgId, appointmentId],
  );
  await pool.query(
    `UPDATE appointments SET no_show_notified_at = NULL WHERE id = $1 AND organization_id = $2 AND status <> 'no_show'`,
    [appointmentId, orgId],
  );
}

export async function fireAppointmentNoShowTrigger(orgId: string, appointmentId: string): Promise<void> {
  try {
    const rulesRes = await pool.query<{ id: string }>(
      `SELECT id FROM automation_rules
       WHERE organization_id = $1 AND trigger_type = 'appointment_no_show' AND enabled = true`,
      [orgId],
    );
    if (!rulesRes.rows.length) return;   // sin reglas no se marca: una regla creada después aún puede dispararse

    // Marca atómica: dos PATCH simultáneos no disparan dos veces
    const appt = (await pool.query<{
      contact_id: string; start_at: Date; timezone: string; meeting_url: string | null; location: string | null;
      cancel_token: string | null; slug: string | null; cal_location: string | null;
    }>(
      `UPDATE appointments a SET no_show_notified_at = NOW()
       FROM appointments x LEFT JOIN calendars c ON c.id = x.calendar_id
       WHERE a.id = x.id AND a.id = $1 AND a.organization_id = $2
         AND a.status = 'no_show' AND a.contact_id IS NOT NULL AND a.no_show_notified_at IS NULL
       RETURNING a.contact_id, a.start_at, COALESCE(c.timezone, a.timezone) AS timezone, a.meeting_url, a.location,
                 a.cancel_token, c.slug, c.location AS cal_location`,
      [appointmentId, orgId],
    )).rows[0];
    if (!appt) return;

    const rescheduleUrl = await appointmentRescheduleUrl(orgId, appt.slug, appt.cancel_token);
    const extraStepData: Record<string, Record<string, unknown>> = {
      __appointment__: {
        appointment_id:  appointmentId,
        ...appointmentTimeFields(new Date(appt.start_at), appt.timezone),
        meeting_url:     appt.meeting_url ?? appt.location ?? appt.cal_location ?? '',
        reschedule_link: rescheduleUrl,
        reschedule_url:  rescheduleUrl,
      },
      __no_show__: { appointment_id: appointmentId },
    };
    for (const rule of rulesRes.rows) {
      await startAutomation(orgId, rule.id, appt.contact_id, extraStepData);
    }
  } catch (e) {
    console.error('[automation-engine] fireAppointmentNoShowTrigger error:', e);
  }
}

// ── Manejar mensaje WA entrante ──────────────────────────────────────────────

export async function handleIncomingWaMessage(
  orgId: string,
  waChatId: string,
  messageText: string,
): Promise<void> {
  try {
    // Extraer el número de teléfono del chatId (ej: "16893183087@s.whatsapp.net")
    const rawPhone = waChatId.split('@')[0];
    if (!rawPhone) return;

    // Misma comparación tolerante que los contactos (últimos 10 dígitos, ver phone.ts)
    const phoneKey = phoneMatchKey(rawPhone);
    if (!phoneKey) return;

    // Tomar de forma atómica el run en estado 'waiting' cuyo contact_phone coincida: dos mensajes
    // simultáneos del mismo lead no pueden reanudar el mismo run (SKIP LOCKED + condición de estado).
    const runRes = await pool.query<{ id: string }>(
      `UPDATE automation_runs SET status = 'running', waiting_since = NULL, updated_at = NOW()
       WHERE status = 'waiting' AND id = (
         SELECT id FROM automation_runs
         WHERE organization_id = $1
           AND status = 'waiting'
           AND right(crm_phone_digits(contact_phone), 10) = $2
         ORDER BY waiting_since ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [orgId, phoneKey],
    );
    const runRow = runRes.rows[0];
    if (!runRow) return;

    executeRun(runRow.id).catch(e => console.error('[automation-engine] resumeRun error:', e));
  } catch (e) {
    console.error('[automation-engine] handleIncomingWaMessage error:', e);
  }
}

// ── Trigger: comentario recibido en Instagram ────────────────────────────────

export interface IgCommentTriggerData {
  commentId: string;
  senderId: string;
  senderName: string;
  text: string;
  mediaId: string;
  caption?: string;            // caption del post: de ahí sale su palabra clave ("Comenta CAMBIO")
  accessToken: string;
  igUserId: string;
  connectionId?: string;       // social_connections.id, para registrar la conversación
}

export async function fireIgCommentTrigger(
  orgId: string,
  commentData: IgCommentTriggerData,
): Promise<void> {
  try {
    const allRules = await pool.query<{ id: string; config: { intent_filter?: boolean; exclude_usernames?: string[] } | null }>(
      `SELECT id, config FROM automation_rules
       WHERE organization_id = $1 AND trigger_type = 'ig_comment_received' AND enabled = true`,
      [orgId],
    );
    if (!allRules.rows.length) {
      console.log(`[automation-engine] comentario IG ${commentData.commentId} ignorado: org ${orgId} sin regla ig_comment_received activa`);
      return;
    }

    // Filtros: nunca las cuentas del propio equipo, y solo comentarios que piden información
    const author = commentData.senderName.toLowerCase();
    const team = (await pool.query<{ u: string }>(
      `SELECT lower(username) AS u FROM social_connections WHERE organization_id = $1 AND username IS NOT NULL`, [orgId],
    )).rows.map(r => r.u);
    const keywords = captionKeywords(commentData.caption ?? '');
    const asksInfo = wantsInfo(commentData.text) || matchesKeyword(commentData.text, keywords);
    const rulesRes = {
      rows: allRules.rows.filter(r => {
        const excluded = (r.config?.exclude_usernames ?? []).map(u => u.toLowerCase().replace(/^@/, ''));
        if (team.includes(author) || excluded.includes(author)) return false;
        return r.config?.intent_filter === false || asksInfo;
      }),
    };
    if (!rulesRes.rows.length) {
      console.log(`[automation-engine] comentario IG ${commentData.commentId} de @${author} ignorado: no pide información o es del equipo (texto: "${commentData.text.slice(0, 60)}", palabras clave del post: ${keywords.join(', ') || 'ninguna'})`);
      return;
    }

    // Crear o encontrar contacto por senderId de IG
    const existingContact = await pool.query<{ id: string }>(
      `SELECT id FROM contacts WHERE organization_id = $1 AND ig_sender_id = $2 LIMIT 1`,
      [orgId, commentData.senderId],
    );

    let contactId: string;
    if (existingContact.rows[0]) {
      contactId = existingContact.rows[0].id;
      // Una persona que comenta en varios posts recibe el flujo (DM + lead) una sola vez por semana
      const recent = await pool.query(
        `SELECT 1 FROM automation_runs WHERE contact_id = $1 AND automation_id = ANY($2::uuid[])
           AND created_at > NOW() - INTERVAL '7 days' LIMIT 1`,
        [contactId, rulesRes.rows.map(r => r.id)],
      );
      if (recent.rowCount) {
        console.log(`[automation-engine] comentario IG ${commentData.commentId} ignorado: el contacto ${contactId} ya recibió el flujo esta semana`);
        return;
      }
    } else {
      const parts = commentData.senderName.trim().split(/\s+/);
      const created = await pool.query<{ id: string }>(
        `INSERT INTO contacts (organization_id, first_name, last_name, tags, ig_sender_id)
         VALUES ($1, $2, $3, ARRAY['instagram']::text[], $4)
         RETURNING id`,
        [orgId, parts[0] || commentData.senderId, parts.slice(1).join(' ') || null, commentData.senderId || null],
      );
      contactId = created.rows[0].id;
      fireContactCreatedTrigger(orgId, contactId).catch(console.error);
    }

    const extraStepData: Record<string, Record<string, unknown>> = {
      __ig_comment__: { ...commentData },
    };
    for (const rule of rulesRes.rows) {
      await startAutomation(orgId, rule.id, contactId, extraStepData);
    }
  } catch (e) {
    console.error('[automation-engine] fireIgCommentTrigger error:', e);
  }
}

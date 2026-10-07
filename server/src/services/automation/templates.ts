// Plantillas de los mensajes de las automatizaciones: variables {{contact.X}}, {{step.N.campo}}
// y {{appointment.X}}, y los campos de fecha y hora de una cita.

/**
 * Interpola plantillas reemplazando {{contact.X}}, {{step.N.field}} y {{appointment.X}}.
 */
export function interpolate(
  template: string,
  contact: Record<string, unknown>,
  stepOutputs: Record<string, Record<string, unknown>>,
): string {
  const appt = (stepOutputs['__appointment__'] ?? {}) as Record<string, unknown>;
  return template
    .replace(/\{\{contact\.name\}\}/g, () => {
      const fn = (contact.first_name as string) ?? '';
      const ln = (contact.last_name as string) ?? '';
      return [fn, ln].filter(Boolean).join(' ');
    })
    .replace(/\{\{contact\.id\}\}/g, () => (contact.id as string) ?? '')
    .replace(/\{\{contact\.first_name\}\}/g, () => (contact.first_name as string) ?? '')
    .replace(/\{\{contact\.last_name\}\}/g, () => (contact.last_name as string) ?? '')
    .replace(/\{\{contact\.email\}\}/g, () => (contact.email as string) ?? '')
    .replace(/\{\{contact\.phone\}\}/g, () => (contact.phone as string) ?? '')
    .replace(/\{\{appointment\.([^}]+)\}\}/g, (_match, field) => String(appt[field] ?? ''))
    .replace(/\{\{step\.([^.]+)\.([^}]+)\}\}/g, (_match, stepId, field) => {
      return String(stepOutputs[stepId]?.[field] ?? '');
    });
}

// Campos de fecha/hora de una cita para las plantillas ({{appointment.start_date}}, {{appointment.start_time}}),
// formateados en la zona horaria de la cita.
export function appointmentTimeFields(start: Date, tz: string): { start_at: string; start_date: string; start_time: string } {
  return {
    start_at:   start.toISOString(),
    start_date: start.toLocaleDateString('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    start_time: start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }),
  };
}

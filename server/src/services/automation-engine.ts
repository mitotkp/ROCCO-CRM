// Motor de automatizaciones del CRM.
// Soporta triggers por tag, ejecución de pasos secuenciales,
// espera de respuestas WA y reanudación tras respuesta entrante.
// El código vive en ./automation/: este archivo solo reexporta lo que usa el resto del servidor.

export { detectUsState } from './automation/us-states.ts';
export { interpolate, appointmentTimeFields } from './automation/templates.ts';
export { executeRun, rescheduleAppointmentWaits, resumeTimedRuns, recoverStuckRuns } from './automation/run.ts';
export {
  fireTagTrigger, fireWaNewMessageTrigger, fireContactCreatedTrigger, fireAppointmentBookedTrigger,
  fireAppointmentNoShowTrigger, clearAppointmentNoShow, handleIncomingWaMessage, fireIgCommentTrigger,
  type AppointmentTriggerData, type IgCommentTriggerData,
} from './automation/triggers.ts';

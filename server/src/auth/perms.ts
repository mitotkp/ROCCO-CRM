import type { Request, Response, NextFunction } from 'express';

// Módulos que se pueden restringir por permiso. Se amplía al añadir features (tareas, etc.).
export const MODULES = ['contacts', 'opportunities', 'tasks', 'calendar', 'conversations', 'automations'] as const;
export type ModuleKey = (typeof MODULES)[number];

// Rol y permisos vienen de la BD (no del JWT): requireAuth los deja en req.authUser al validar
// la sesión (auth/session.ts, caché de 60 s que se invalida al cambiar rol o permisos), así que
// los cambios aplican sin re-login y aquí no hace falta otra consulta por petición.
const isAdmin = (role: string) => role === 'owner' || role === 'admin';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const u = req.authUser;
  return u && isAdmin(u.role) ? next() : res.status(403).json({ error: 'Requiere rol de administrador' });
}

export function requireModule(key: ModuleKey) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = req.authUser;
    if (!u) return res.status(401).json({ error: 'No autenticado' });
    if (isAdmin(u.role)) return next();
    return u.permissions.includes(key) ? next() : res.status(403).json({ error: 'Sin permiso para este módulo' });
  };
}

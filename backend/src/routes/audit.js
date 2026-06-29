import { Router } from 'express';

function toPublic(event) {
  return {
    id: event.id,
    tenantId: event.tenant_id,
    userId: event.user_id,
    username: event.username,
    role: event.role,
    eventType: event.event_type,
    method: event.method,
    path: event.path,
    status: event.status,
    ip: event.ip,
    userAgent: event.user_agent,
    details: event.details,
    createdAt: event.created_at,
  };
}

export function auditRouter(audit) {
  const router = Router();

  router.get('/events', (req, res) => {
    const limit = parseInt(String(req.query.limit || '100'), 10);
    const eventType = typeof req.query.eventType === 'string' ? req.query.eventType : '';
    const rows = audit.dao.list({
      tenantId: req.auth?.tenantId || null,
      limit: Number.isFinite(limit) ? limit : 100,
      eventType: eventType || undefined,
    });
    res.json(rows.map(toPublic));
  });

  return router;
}

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Role } from '../models/User.js';
import { HttpError } from '../utils/helpers.js';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  firstName: string;
  lastName: string;
  patientRef?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      patientRef: user.patientRef ?? null,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions
  );
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new HttpError(401, 'Authentication required'));
  }
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    // Portal tokens are signed with the same secret but are not staff
    // sessions: they carry no role, so every permission check would evaluate
    // against `undefined`. Reject them here rather than relying on each route
    // to have a permission guard — the ones that only call requireAuth would
    // otherwise let a patient's portal token straight through.
    if (payload.scope === 'portal') {
      return next(new HttpError(401, 'This is a patient portal session, not a staff session'));
    }
    req.user = {
      id: String(payload.sub),
      email: payload.email,
      role: payload.role,
      firstName: payload.firstName,
      lastName: payload.lastName,
      patientRef: payload.patientRef ?? null,
    };
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

/**
 * Accepts only a patient portal token, and hands the controller the one
 * patient it is scoped to. A staff token is refused here on purpose: the
 * portal endpoints return a patient-shaped payload, and a member of staff
 * wanting that data should go through the audited clinical routes.
 */
export function requirePortal(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new HttpError(401, 'Please sign in to the patient portal'));
  }
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    if (payload.scope !== 'portal' || !payload.patientRef) {
      return next(new HttpError(401, 'Please sign in to the patient portal'));
    }
    (req as Request & { portalPatientId?: string }).portalPatientId = String(
      payload.patientRef
    );
    next();
  } catch {
    next(new HttpError(401, 'Your portal session has expired. Please sign in again.'));
  }
}

/**
 * Like requirePortal, but never rejects: a signed-in patient gets
 * `portalPatientId`, anyone else passes through untouched. Lets a public
 * route trust the session instead of asking for the date of birth again.
 */
export function optionalPortal(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    if (payload.scope === 'portal' && payload.patientRef) {
      (req as Request & { portalPatientId?: string }).portalPatientId = String(
        payload.patientRef
      );
    }
  } catch {
    /* an expired session just falls back to the normal lookup */
  }
  next();
}

/** Attaches req.user when a valid token is present, but never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_SECRET) as jwt.JwtPayload;
    if (payload.scope === 'portal') return next();
    req.user = {
      id: String(payload.sub),
      email: payload.email,
      role: payload.role,
      firstName: payload.firstName,
      lastName: payload.lastName,
      patientRef: payload.patientRef ?? null,
    };
  } catch {
    /* ignore */
  }
  next();
}

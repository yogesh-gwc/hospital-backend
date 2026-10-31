import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Appointment } from '../models/Appointment.js';
import { Patient } from '../models/Patient.js';
import { Specialty } from '../models/Specialty.js';
import { User } from '../models/User.js';
import { env } from '../config/env.js';
import { suggestSpecialty, detectEmergency } from '../services/triageService.js';
import {
  createPublicBooking,
  findPatientByIdentifier,
  freeSlots,
  isoDate,
  LOOKUP_FAILED,
} from '../services/bookingService.js';
import { greeting, respond, type AgentState } from '../services/bookingAgent.js';
import { asyncHandler, badRequest, notFound, age } from '../utils/helpers.js';
import { ID_PREFIX, nextId } from '../utils/idGenerator.js';
import { audit } from '../middleware/audit.js';

/* ═══════════════════════════════════════════════════════════════════════════
   The public face of the hospital. Nothing here requires a token.

   Two rules hold across this whole file:

   1. Never confirm what you were not asked. A lookup that says "no patient
      with that ID" is an oracle for walking IDs, so every failure returns the
      same message whether the identifier was wrong, the date of birth was
      wrong, or both.
   2. Never return more of a chart than the step needs. The portal lookup
      returns a patient's own appointments and nothing else — no notes, no
      medications, no admission history.
   ═══════════════════════════════════════════════════════════════════════════ */

const DOCTOR_CARD =
  'firstName lastName role department specialization doctorProfile avatar';

/** GET /api/public/hospital — the masthead content the website renders. */
export const hospitalInfo = asyncHandler(async (_req: Request, res: Response) => {
  const [specialties, doctors, beds] = await Promise.all([
    Specialty.countDocuments({ isActive: true }),
    User.countDocuments({ role: 'physician', isActive: true }),
    // A soft stat for the website; the real bed board lives behind auth.
    import('../models/Bed.js').then((m) => m.Bed.countDocuments({})),
  ]);

  res.json({
    name: 'Aarogya General Hospital',
    tagline: 'Specialist care, close to home.',
    about:
      'A multi-speciality hospital serving the city since 1998, with round-the-clock ' +
      'emergency cover, an in-house pharmacy and a diagnostics lab under one roof.',
    address: '14 Anna Salai, Chennai 600002',
    phone: '+91 44 4000 1200',
    emergencyPhone: '108',
    email: 'care@aarogyahospital.example',
    hours: {
      outpatient: 'Mon–Sat, 9:00–17:00',
      emergency: 'Open 24 hours, every day',
      pharmacy: 'Mon–Sun, 8:00–22:00',
    },
    stats: { specialties, doctors, beds },
  });
});

/** GET /api/public/specialties — the department dropdown and cards. */
export const listSpecialties = asyncHandler(async (_req: Request, res: Response) => {
  const specialties = await Specialty.find({ isActive: true })
    .sort('displayOrder name')
    .select('slug name tagline description icon commonConditions consultationFee location')
    .lean();
  res.json({ specialties });
});

/** GET /api/public/doctors?specialty=cardiology */
export const listDoctors = asyncHandler(async (req: Request, res: Response) => {
  const filter: Record<string, unknown> = {
    role: 'physician',
    isActive: true,
    'doctorProfile.isBookable': true,
  };
  if (req.query.specialty) filter['doctorProfile.specialty'] = String(req.query.specialty);

  const doctors = await User.find(filter).select(DOCTOR_CARD).sort('firstName').lean();
  res.json({ doctors });
});

/**
 * POST /api/public/triage — suggest a department from a described complaint.
 * Read-only: nothing is stored until the patient actually books.
 */
export const triage = asyncHandler(async (req: Request, res: Response) => {
  const { complaint = '', symptoms = [], age: patientAge } = req.body ?? {};
  const text = String(complaint).slice(0, 2000);

  const result = await suggestSpecialty(
    text,
    Array.isArray(symptoms) ? symptoms.map(String) : [],
    typeof patientAge === 'number' ? patientAge : undefined
  );

  const doctors = result.specialty
    ? await User.find({
        role: 'physician',
        isActive: true,
        'doctorProfile.isBookable': true,
        'doctorProfile.specialty': result.specialty,
      })
        .select(DOCTOR_CARD)
        .limit(6)
        .lean()
    : [];

  res.json({ ...result, doctors });
});

/** GET /api/public/doctors/:id/slots?date=YYYY-MM-DD */
export const doctorSlots = asyncHandler(async (req: Request, res: Response) => {
  const doctor = await User.findOne({
    _id: req.params.id,
    role: 'physician',
    'doctorProfile.isBookable': true,
  })
    .select(DOCTOR_CARD)
    .lean();
  if (!doctor) throw notFound('Doctor');

  const date = req.query.date ? new Date(String(req.query.date)) : new Date();
  if (Number.isNaN(date.getTime())) throw badRequest('That date is not valid');

  const { slots, reason } = await freeSlots(String(doctor._id), date);
  res.json({ date: isoDate(date), slots, ...(reason ? { reason } : {}) });
});

/**
 * POST /api/public/appointments — book, as either a new or returning patient.
 *
 * A new patient gets a real chart here rather than a pending request that
 * somebody has to key in later. That is the whole point: by the time they
 * arrive, reception already has them.
 */
export const bookAppointment = asyncHandler(async (req: Request, res: Response) => {
  const portalPatientId = (req as Request & { portalPatientId?: string }).portalPatientId;
  const result = await createPublicBooking({ ...req.body, portalPatientId }, req);
  res.status(201).json({
    ...result,
    symptomsRecorded: Array.isArray(req.body?.symptoms) ? req.body.symptoms.length : 0,
  });
});

/**
 * POST /api/public/agent — one turn of the booking assistant.
 *
 * The whole conversation is driven here. The client posts back the state it
 * was given plus the visitor's reply, and gets the next thing to say. State
 * is never trusted: every step re-reads the database, and the booking itself
 * goes through the same `createPublicBooking` the form uses.
 */
export const agentTurn = asyncHandler(async (req: Request, res: Response) => {
  const { state, message } = req.body ?? {};
  if (!state || typeof state !== 'object' || !state.step) {
    return res.json(greeting());
  }
  const reply = await respond(state as AgentState, String(message ?? ''), req);
  res.json(reply);
});

/** GET /api/public/agent — how the assistant opens. */
export const agentGreeting = asyncHandler(async (_req: Request, res: Response) => {
  res.json(greeting());
});

/**
 * POST /api/public/portal/login — patient ID or phone, plus date of birth.
 *
 * Issues a short-lived token scoped to this one patient. It is deliberately
 * not the staff token: it carries `scope: 'portal'`, so `requireAuth` can
 * refuse it anywhere outside the portal even if it leaks.
 */
export const portalLogin = asyncHandler(async (req: Request, res: Response) => {
  const { identifier, dateOfBirth } = req.body ?? {};
  const patient = await findPatientByIdentifier(identifier, dateOfBirth);
  if (!patient) throw badRequest(LOOKUP_FAILED);

  const token = jwt.sign(
    { sub: String(patient._id), scope: 'portal', patientRef: String(patient._id) },
    env.JWT_SECRET,
    { expiresIn: '2h' }
  );

  await audit(req, {
    action: 'portal.login',
    entity: 'Patient',
    entityId: patient._id,
    patientId: patient._id,
    description: `${patient.demographics.firstName} ${patient.demographics.lastName} signed in to the patient portal`,
  });

  res.json({
    token,
    patient: portalView(patient),
  });
});

/** GET /api/public/portal/me — the patient's own dashboard. */
export const portalMe = asyncHandler(async (req: Request, res: Response) => {
  const patientRef = (req as Request & { portalPatientId?: string }).portalPatientId;
  if (!patientRef) throw badRequest('Your portal session has expired. Please sign in again.');

  const patient = await Patient.findById(patientRef).lean();
  if (!patient) throw notFound('Patient');

  const appointments = await Appointment.find({ patientId: patient._id })
    .sort('-scheduledDate')
    .limit(25)
    .populate('doctorId', 'firstName lastName department doctorProfile.specialty')
    .select('appointmentId scheduledDate scheduledTime status specialty reason doctorId duration')
    .lean();

  const now = Date.now();
  res.json({
    patient: portalView(patient),
    appointments: {
      upcoming: appointments.filter(
        (a) => new Date(a.scheduledDate).getTime() >= now && a.status !== 'cancelled'
      ),
      past: appointments.filter(
        (a) => new Date(a.scheduledDate).getTime() < now || a.status === 'cancelled'
      ),
    },
  });
});

/** Only what the portal is allowed to show. Never the full chart. */
function portalView(patient: {
  patientId: string;
  demographics: {
    firstName: string;
    lastName: string;
    dateOfBirth: Date;
    gender: string;
    phone: string;
    email?: string;
  };
}) {
  return {
    patientId: patient.patientId,
    firstName: patient.demographics.firstName,
    lastName: patient.demographics.lastName,
    age: age(patient.demographics.dateOfBirth),
    gender: patient.demographics.gender,
    phone: maskPhone(patient.demographics.phone),
    email: patient.demographics.email ?? '',
  };
}

function maskPhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `••••••${digits.slice(-4)}`;
}

/** POST /api/public/emergency-check — used by the booking form as you type. */
export const emergencyCheck = asyncHandler(async (req: Request, res: Response) => {
  const text = String(req.body?.complaint ?? '').slice(0, 2000);
  res.json({ emergency: detectEmergency(text) });
});

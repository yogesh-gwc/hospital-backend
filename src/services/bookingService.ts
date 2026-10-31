import type { Request } from 'express';
import { Appointment } from '../models/Appointment.js';
import { Patient } from '../models/Patient.js';
import { User } from '../models/User.js';
import { audit } from '../middleware/audit.js';
import { badRequest } from '../utils/helpers.js';
import { ID_PREFIX, nextId } from '../utils/idGenerator.js';

/* ═══════════════════════════════════════════════════════════════════════════
   The one place a public appointment is created.

   Both front doors go through here — the step-by-step form and the booking
   assistant. They are two conversations about the same thing, and the moment
   they each grew their own copy of "is this slot still free" they would start
   disagreeing about it.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Same text for every failure mode, so the lookup is not an oracle. */
export const LOOKUP_FAILED =
  'We could not match those details. Check the patient ID or phone number and the date of birth, or call the hospital on +91 44 4000 1200.';

/**
 * Finds a patient by ID *or* phone, and only when the date of birth agrees.
 * Returns null for every kind of miss — the caller must not distinguish them.
 */
export async function findPatientByIdentifier(identifier: unknown, dobInput: unknown) {
  const id = String(identifier ?? '').trim();
  if (!id || !dobInput) return null;

  const dob = new Date(String(dobInput));
  if (Number.isNaN(dob.getTime())) return null;

  // Compare the calendar day, not the instant: a date of birth typed into a
  // form is midnight local, while a seeded one may carry a time.
  const dayStart = new Date(dob);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dob);
  dayEnd.setHours(23, 59, 59, 999);

  const digits = id.replace(/\D/g, '');
  const or: Record<string, unknown>[] = [{ patientId: id.toUpperCase() }];
  // Only treat it as a phone number when it actually looks like one.
  if (digits.length >= 10) {
    or.push({ 'demographics.phone': id });
    or.push({ 'demographics.phone': digits });
  }

  return Patient.findOne({
    $or: or,
    'demographics.dateOfBirth': { $gte: dayStart, $lte: dayEnd },
  });
}

export interface BookingInput {
  isNewPatient: boolean;
  /** Set only from a verified portal token, never from the request body. */
  portalPatientId?: string;
  identifier?: string;
  dateOfBirth?: string | Date;
  firstName?: string;
  lastName?: string;
  gender?: string;
  phone?: string;
  email?: string;
  doctorId: string;
  date: string | Date;
  time: string;
  complaint?: string;
  triage?: {
    specialty?: string;
    reason?: string;
    confidence?: number;
    matched?: string[];
    overridden?: boolean;
  };
}

export interface BookingResult {
  appointment: {
    appointmentId: string;
    scheduledDate: Date;
    scheduledTime: string;
    specialty: string;
  };
  doctor: { name: string; specialty: string; department: string };
  patient: { patientId: string; firstName: string; isNew: boolean };
}

export async function createPublicBooking(
  input: BookingInput,
  req: Request | null = null
): Promise<BookingResult> {
  const { doctorId, date, time } = input;
  if (!doctorId || !date || !time) throw badRequest('Pick a doctor, a date and a time');

  const doctor = await User.findOne({
    _id: doctorId,
    role: 'physician',
    isActive: true,
    'doctorProfile.isBookable': true,
  }).lean();
  if (!doctor) throw badRequest('That doctor is not available for booking');

  const scheduledDate = new Date(date);
  if (Number.isNaN(scheduledDate.getTime())) throw badRequest('That date is not valid');
  scheduledDate.setHours(0, 0, 0, 0);

  // Never let the website book something that has already happened.
  const when = new Date(scheduledDate);
  when.setMinutes(toMinutes(String(time)));
  if (when.getTime() <= Date.now()) throw badRequest('That slot is in the past');

  const days = doctor.doctorProfile?.availableDays ?? [1, 2, 3, 4, 5];
  if (days.length && !days.includes(scheduledDate.getDay())) {
    throw badRequest('The doctor does not hold clinic on that day');
  }

  let patient;

  if (input.portalPatientId) {
    // Already proved who they are when they signed in to the portal; asking
    // for the date of birth again is what broke "Book another".
    patient = await Patient.findById(input.portalPatientId);
    if (!patient) throw badRequest(LOOKUP_FAILED);
  } else if (input.isNewPatient) {
    const { firstName, lastName, phone } = input;
    if (!firstName || !lastName || !input.dateOfBirth || !phone) {
      throw badRequest('Name, date of birth and phone number are required');
    }
    const dob = new Date(input.dateOfBirth);
    if (Number.isNaN(dob.getTime())) throw badRequest('That date of birth is not valid');

    // Someone booking a second time without realising they are already on the
    // system should not end up with two charts.
    patient = await Patient.findOne({
      'demographics.phone': String(phone).trim(),
      'demographics.dateOfBirth': dob,
    });

    if (!patient) {
      patient = await Patient.create({
        patientId: await nextId(Patient, 'patientId', ID_PREFIX.patient),
        demographics: {
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          dateOfBirth: dob,
          gender: input.gender ?? 'other',
          phone: String(phone).trim(),
          email: input.email ? String(input.email).trim() : '',
        },
        registrationSource: 'public_booking',
      });
    }
  } else {
    patient = await findPatientByIdentifier(input.identifier, input.dateOfBirth);
    if (!patient) throw badRequest(LOOKUP_FAILED);
  }

  // Re-check the slot against the database rather than trusting that the one
  // the browser saw free a minute ago still is.
  const slotMinutes = doctor.doctorProfile?.slotMinutes || 30;
  const taken = await Appointment.findOne({
    doctorId: doctor._id,
    scheduledDate,
    scheduledTime: time,
    status: { $in: ['scheduled', 'confirmed'] },
  }).lean();
  if (taken) throw badRequest('Someone just took that slot. Please pick another time.');

  const complaintText = String(input.complaint ?? '').slice(0, 2000);
  const specialty = doctor.doctorProfile?.specialty ?? '';

  const appointment = await Appointment.create({
    appointmentId: await nextId(Appointment, 'appointmentId', ID_PREFIX.appointment),
    patientId: patient._id,
    doctorId: doctor._id,
    type: 'specialist',
    specialty,
    scheduledDate,
    scheduledTime: time,
    duration: slotMinutes,
    status: 'scheduled',
    reason: complaintText.slice(0, 200),
    complaint: complaintText,
    source: 'public',
    triage: {
      specialty: input.triage?.specialty ?? specialty,
      reason: input.triage?.reason ?? '',
      confidence: input.triage?.confidence ?? 0,
      matched: input.triage?.matched ?? [],
      overridden: Boolean(input.triage?.overridden),
    },
  });

  await audit(req, {
    action: 'appointment.book.public',
    entity: 'Appointment',
    entityId: appointment._id,
    patientId: patient._id,
    description:
      `${patient.demographics.firstName} ${patient.demographics.lastName} booked ` +
      `${appointment.appointmentId} on the website with ${doctor.firstName} ${doctor.lastName}`,
  });

  return {
    appointment: {
      appointmentId: appointment.appointmentId,
      scheduledDate: appointment.scheduledDate,
      scheduledTime: appointment.scheduledTime,
      specialty,
    },
    doctor: {
      name: `${doctor.firstName} ${doctor.lastName}`,
      specialty,
      department: doctor.department,
    },
    patient: {
      patientId: patient.patientId,
      firstName: patient.demographics.firstName,
      isNew: Boolean(input.isNewPatient),
    },
  };
}

/** Free slots for a doctor on a date, honouring clinic days and hours. */
export async function freeSlots(
  doctorId: string,
  date: Date
): Promise<{ slots: { time: string; available: boolean }[]; reason?: string }> {
  const doctor = await User.findById(doctorId).lean();
  if (!doctor) return { slots: [], reason: 'Doctor not found.' };

  const profile = doctor.doctorProfile ?? ({} as NonNullable<typeof doctor.doctorProfile>);
  const days = profile.availableDays?.length ? profile.availableDays : [1, 2, 3, 4, 5];
  const slotMinutes = profile.slotMinutes || 30;

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  if (!days.includes(start.getDay())) {
    return { slots: [], reason: 'The doctor does not hold clinic on this day.' };
  }

  const booked = await Appointment.find({
    doctorId: doctor._id,
    scheduledDate: { $gte: start, $lte: end },
    status: { $in: ['scheduled', 'confirmed'] },
  })
    .select('scheduledTime duration')
    .lean();

  const open = toMinutes(profile.clinicStart || '09:00');
  const close = toMinutes(profile.clinicEnd || '17:00');
  const now = Date.now();

  const slots: { time: string; available: boolean }[] = [];
  for (let m = open; m + slotMinutes <= close; m += slotMinutes) {
    const clash = booked.some((a) => {
      const s = toMinutes(a.scheduledTime);
      return m < s + (a.duration ?? slotMinutes) && s < m + slotMinutes;
    });
    // A slot earlier today has already gone, so never offer it.
    const slotAt = new Date(start);
    slotAt.setMinutes(m);
    slots.push({ time: toHHMM(m), available: !clash && slotAt.getTime() > now });
  }
  return { slots };
}

/** The next `count` days the doctor actually holds clinic, starting tomorrow. */
export function upcomingClinicDays(days: number[], count = 3): Date[] {
  const out: Date[] = [];
  const today = new Date();
  for (let i = 1; i <= 30 && out.length < count; i += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    d.setHours(0, 0, 0, 0);
    if (!days.length || days.includes(d.getDay())) out.push(d);
  }
  return out;
}

export function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Local calendar day — toISOString() would shift it across a timezone. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

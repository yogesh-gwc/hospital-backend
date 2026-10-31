import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// The rules live in the agent service; it may be checked out as `agents/` or `agent/`.
const rulesDir =
  ['../../../agents/rules', '../../../agent/rules']
    .map((p) => resolve(here, p))
    .find((p) => existsSync(p)) ?? resolve(here, '../../../agents/rules');

function load<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(rulesDir, file), 'utf8')) as T;
}

export interface InteractionRule {
  drugA: string;
  drugB: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  mechanism: string;
  effect: string;
  recommendation: string;
}

export interface AllergyRule {
  allergen: string;
  drugs: string[];
  severity: 'critical' | 'high' | 'medium' | 'low';
  note: string;
}

export interface DrugInteractionDb {
  interactions: InteractionRule[];
  allergy_cross_reactions: AllergyRule[];
  drug_classes: Record<string, string>;
  high_risk_classes: string[];
  dose_change_thresholds: { significant_ratio: number; critical_ratio: number };
}

export interface ProtocolRecommendation {
  type:
    | 'pcp_visit'
    | 'specialist'
    | 'lab_work'
    | 'home_health'
    | 'physical_therapy'
    | 'dme'
    | 'other';
  specialty: string;
  description: string;
  dueInDays: number;
  timeframe: string;
  priority: 'required' | 'recommended' | 'optional';
}

export interface FollowUpDb {
  by_icd_prefix: Record<string, { label: string; recommendations: ProtocolRecommendation[] }>;
  by_keyword: Record<string, string>;
  default: { label: string; recommendations: ProtocolRecommendation[] };
  medication_triggered: (ProtocolRecommendation & {
    when_drug_class: string;
    /** Keyword used to decide whether the diagnosis protocol already covers this. */
    subject?: string;
  })[];
}

export const interactionDb = load<DrugInteractionDb>('drug_interactions.json');
export const followUpDb = load<FollowUpDb>('follow_up_protocols.json');

/** Normalises a drug name to the lowercase generic key used by the rule tables. */
export function normaliseDrug(name: string): string {
  const n = name.toLowerCase().trim();
  // strip trailing dose/form noise, e.g. "Lisinopril 10 mg tablet" -> "lisinopril"
  const cleaned = n
    .replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|units?|iu)\b.*$/i, '')
    .replace(/\b(tablet|capsule|solution|inhaler|injection|patch|er|xr|sr)\b/g, '')
    .replace(/[(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const aliases: Record<string, string> = {
    bactrim: 'trimethoprim-sulfamethoxazole',
    septra: 'trimethoprim-sulfamethoxazole',
    'smx-tmp': 'trimethoprim-sulfamethoxazole',
    'sulfamethoxazole-trimethoprim': 'trimethoprim-sulfamethoxazole',
    coumadin: 'warfarin',
    lasix: 'furosemide',
    lipitor: 'atorvastatin',
    zocor: 'simvastatin',
    glucophage: 'metformin',
    prinivil: 'lisinopril',
    zestril: 'lisinopril',
    lopressor: 'metoprolol',
    toprol: 'metoprolol',
    norvasc: 'amlodipine',
    plavix: 'clopidogrel',
    lantus: 'insulin glargine',
    humalog: 'insulin lispro',
    ventolin: 'albuterol',
    proair: 'albuterol',
    oxycontin: 'oxycodone',
    percocet: 'oxycodone',
    ativan: 'lorazepam',
    protonix: 'pantoprazole',
    prilosec: 'omeprazole',
    synthroid: 'levothyroxine',
    zoloft: 'sertraline',
    neurontin: 'gabapentin',
    aldactone: 'spironolactone',
    'k-dur': 'potassium chloride',
    'klor-con': 'potassium chloride',
    ecotrin: 'aspirin',
    asa: 'aspirin',
    tylenol: 'acetaminophen',
    advil: 'ibuprofen',
    motrin: 'ibuprofen',
    aleve: 'naproxen',
    augmentin: 'amoxicillin-clavulanate',
    rocephin: 'ceftriaxone',
    zithromax: 'azithromycin',
    levaquin: 'levofloxacin',
    cipro: 'ciprofloxacin',
  };

  return aliases[cleaned] ?? cleaned;
}

export function drugClassOf(name: string): string {
  const key = normaliseDrug(name);
  if (interactionDb.drug_classes[key]) return interactionDb.drug_classes[key];
  // partial match for combination products
  for (const [drug, cls] of Object.entries(interactionDb.drug_classes)) {
    if (key.includes(drug) || drug.includes(key)) return cls;
  }
  return 'Unclassified';
}

export function isHighRisk(name: string): boolean {
  return interactionDb.high_risk_classes.includes(drugClassOf(name));
}

/** Finds an interaction rule for an unordered pair of drugs. */
export function findInteraction(a: string, b: string): InteractionRule | null {
  const na = normaliseDrug(a);
  const nb = normaliseDrug(b);
  return (
    interactionDb.interactions.find(
      (i) =>
        (normaliseDrug(i.drugA) === na && normaliseDrug(i.drugB) === nb) ||
        (normaliseDrug(i.drugA) === nb && normaliseDrug(i.drugB) === na)
    ) ?? null
  );
}

/** Matches a drug against the patient's documented allergies. */
export function findAllergyConflict(
  drug: string,
  allergies: { substance: string; severity?: string }[]
): { rule: AllergyRule; allergy: { substance: string; severity?: string } } | null {
  const nd = normaliseDrug(drug);
  for (const allergy of allergies) {
    const substance = allergy.substance.toLowerCase().trim();
    for (const rule of interactionDb.allergy_cross_reactions) {
      const allergenMatches =
        substance.includes(rule.allergen) || rule.allergen.includes(substance);
      if (!allergenMatches) continue;
      if (rule.drugs.some((d) => normaliseDrug(d) === nd)) {
        return { rule, allergy };
      }
    }
    // direct name match (patient allergic to the exact drug)
    if (normaliseDrug(substance) === nd) {
      return {
        rule: {
          allergen: substance,
          drugs: [nd],
          severity: 'critical',
          note: 'Documented allergy to this exact agent.',
        },
        allergy,
      };
    }
  }
  return null;
}

/** Parses the numeric magnitude out of a free-text dose string. */
export function parseDose(dosage: string): { value: number; unit: string } | null {
  const m = /(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|units?|iu)/i.exec(dosage || '');
  if (!m) return null;
  return { value: Number(m[1]), unit: m[2].toLowerCase().replace(/s$/, '') };
}

/** Resolves a diagnosis + ICD codes to a follow-up protocol. */
export function resolveProtocol(
  diagnosis: string,
  icdCodes: string[] = []
): { label: string; recommendations: ProtocolRecommendation[] } {
  for (const code of icdCodes) {
    const prefix = code.slice(0, 3).toUpperCase();
    const hit = followUpDb.by_icd_prefix[prefix];
    if (hit) return hit;
  }
  const dx = (diagnosis || '').toLowerCase();
  for (const [keyword, prefix] of Object.entries(followUpDb.by_keyword)) {
    if (dx.includes(keyword)) {
      const hit = followUpDb.by_icd_prefix[prefix];
      if (hit) return hit;
    }
  }
  return followUpDb.default;
}

'use strict'

import { R4 } from '@ahryman40k/ts-fhir-types'
import Client from 'fhirclient/lib/Client'
import URI from 'urijs'
import config from '../lib/config'
import got from 'got'
import logger from '../lib/winston'

// Generating an IPS Bundle (https://build.fhir.org/ig/HL7/fhir-ips/)
// List of Resources:
/*
    Medication Summary (R)
    Allergies and Intolerances (R)
    Problem List (R)
    Immunizations (S)
    History of Procedures (S)
    Medical Devices (S)
    Diagnostic Results (S)
    Laboratory results
    Pathology results
    Past history of illnesses
    Pregnancy (status and history summary)
    Social History
    Functional Status (Autonomy / Invalidity)
    Plan of care
    Advance Directives
*/

const IPS_COMPOSITION_TITLE = 'International Patient Summary'

const IPS_COMPOSITION_TYPE: R4.ICodeableConcept = {
  coding: [
    {
      system: 'http://loinc.org',
      code: '60591-5',
      display: 'Patient summary Document',
    },
  ],
}

const LOCAL_SECTION_SYSTEM = 'http://openhie.org/sedish/CodeSystem/ips-sections'

// LOINC codes are used for sections that map to the IPS IG; project-local
// codes are used for the custom sections this mediator exposes.
const SECTION_CODES: Record<string, { system: string; code: string; display: string }> = {
  'Patient Records': { system: LOCAL_SECTION_SYSTEM, code: 'patient-records', display: 'Patient Records' },
  'Allergies and Intolerances': { system: 'http://loinc.org', code: '48765-2', display: 'Allergies and adverse reactions Document' },
  'Problem List': { system: 'http://loinc.org', code: '11450-4', display: 'Problem list - Reported' },
  'Medication Summary': { system: 'http://loinc.org', code: '10160-0', display: 'History of Medication use Narrative' },
  'Encounters': { system: 'http://loinc.org', code: '46240-8', display: 'History of encounters Document' },
  'Service Requests': { system: LOCAL_SECTION_SYSTEM, code: 'service-requests', display: 'Service Requests' },
  'Diagnostic Reports': { system: 'http://loinc.org', code: '30954-2', display: 'Relevant diagnostic tests/laboratory data Narrative' },
  'Observations': { system: LOCAL_SECTION_SYSTEM, code: 'observations', display: 'Observations' },
  'Immunizations': { system: 'http://loinc.org', code: '11369-6', display: 'History of Immunization Narrative' },
  'Procedures': { system: 'http://loinc.org', code: '47519-4', display: 'History of Procedures Document' },
}

const IPS_EMPTY_REASON: R4.ICodeableConcept = {
  coding: [
    {
      system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason',
      code: 'unavailable',
      display: 'Unavailable',
    },
  ],
  text: 'No data available',
}

function escapeXml(input: string): string {
  return input.replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[c] as string))
}

function buildLocalSectionCode(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'section'
}

function buildIpsSection(title: string, entries: R4.IReference[]): R4.IComposition_Section {
  const coded = SECTION_CODES[title]
  const sectionCoding = coded
    ? { system: coded.system, code: coded.code, display: coded.display }
    : { system: LOCAL_SECTION_SYSTEM, code: buildLocalSectionCode(title), display: title }

  if (!coded) {
    logger.warn(
      `Missing IPS section code mapping for title "${title}", using deterministic local code "${sectionCoding.code}"`,
    )
  }

  const code: R4.ICodeableConcept = {
    coding: [sectionCoding],
    text: title,
  }

  const safeTitle = escapeXml(title)
  const hasEntries = entries.length > 0
  const div = hasEntries
    ? `<div xmlns="http://www.w3.org/1999/xhtml"><p>${safeTitle} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})</p></div>`
    : `<div xmlns="http://www.w3.org/1999/xhtml"><p>No ${safeTitle.toLowerCase()} available.</p></div>`

  const section: R4.IComposition_Section = {
    title,
    code,
    text: { status: R4.NarrativeStatusKind._generated, div },
    entry: entries,
  }

  if (!hasEntries) {
    section.emptyReason = IPS_EMPTY_REASON
  }

  return section
}

function buildIpsComposition(
  subject: R4.IReference | null,
  sections: R4.IComposition_Section[],
): R4.IComposition {
  const composition: R4.IComposition = {
    resourceType: 'Composition',
    status: R4.CompositionStatusKind._final,
    type: IPS_COMPOSITION_TYPE,
    date: new Date().toISOString(),
    title: IPS_COMPOSITION_TITLE,
    author: [{ display: 'SHR System' }],
    section: sections,
  }
  if (subject) {
    composition.subject = subject
  }
  return composition
}

export async function generateIpsbundle(
  patients: R4.IPatient[],
  shrClient: Client,
  lastUpdated: string,
  system: string,
): Promise<R4.IBundle> {
  const patientIdentifiers = grabTargetIdentifiers(patients, system)
  const query = new URLSearchParams()

  query.set('subject', patientIdentifiers.join(','))
  query.set('_lastUpdated', lastUpdated)

  // Fetch SHR components
  /**
   * Get Encounters where: relevant to medical summary
   * Get AllergyIntolerance
   * Get observations relevant to problem lists
   * Get observations relevant to immunizations
   * Get observations relevant to diagnostic results
   * Get observations relevant to labs
   * Get plan of care?
   */
  const shrPatients = await shrClient.request<R4.IPatient[]>(
    `Patient?_id=${patientIdentifiers.join(',')}`,
    { flat: true },
  )
  const encounters = await shrClient.request<R4.IEncounter[]>(`Encounter?${query}`, { flat: true })
  const observations = await shrClient.request<R4.IObservation[]>(`Observation?${query}`, {
    flat: true,
  })

  const ipsBundle: R4.IBundle = {
    resourceType: 'Bundle',
  }

  const ipsComposition = buildIpsComposition(null, [
    buildIpsSection(
      'Patient Records',
      shrPatients.map((p: R4.IPatient) => ({ reference: `Patient/${p.id!}` })),
    ),
    buildIpsSection(
      'Encounters',
      encounters.map((e: R4.IEncounter) => ({ reference: `Encounter/${e.id!}` })),
    ),
    buildIpsSection(
      'Observations',
      observations.map((o: R4.IObservation) => ({ reference: `Observation/${o.id!}` })),
    ),
  ])

  ipsBundle.type = R4.BundleTypeKind._document
  ipsBundle.entry = []
  ipsBundle.entry.push(ipsComposition)
  ipsBundle.entry = ipsBundle.entry.concat(shrPatients)
  ipsBundle.entry = ipsBundle.entry.concat(encounters)
  ipsBundle.entry = ipsBundle.entry.concat(observations)

  return ipsBundle
}
/**
 * Generate an IPS bundle that aggregates clinical data across multiple patients
 * that share the same golden record. This enables cross-facility patient summaries.
 *
 * @param patientIds - Array of patient IDs linked to the same golden record
 */
export async function generateCrossFacilityIpsBundle(
  patientIds: string[],
  goldenRecordId?: string | null,
): Promise<R4.IBundle> {
  const ipsBundle: R4.IBundle = {
    resourceType: 'Bundle',
  }

  try {
    const fhirBase = config.get('fhirServer:baseURL')
    const options = {
      username: config.get('fhirServer:username'),
      password: config.get('fhirServer:password'),
    }

    const ipsSections: any = {
      Patient: [],
      Encounter: [],
      ServiceRequest: [],
      DiagnosticReport: [],
      Observation: [],
      AllergyIntolerance: [],
      Condition: [],
      MedicationRequest: [],
      MedicationStatement: [],
      Immunization: [],
      Procedure: [],
    }

    // Track seen resource IDs per type to deduplicate in O(1) per entry
    const seenIds: Record<string, Set<string>> = {}

    // Fetch data for each linked patient with bounded parallelism and merge into sections
    const IPS_FETCH_CONCURRENCY = 4

    const processBundleEntries = (searchBundle: R4.IBundle) => {
      if (searchBundle && searchBundle.entry && searchBundle.entry.length > 0) {
        for (const e of searchBundle.entry) {
          if (e.resource && e.resource.id) {
            const resourceKey = String(e.resource.resourceType)

            if (!ipsSections[resourceKey]) {
              ipsSections[resourceKey] = []
            }
            if (!seenIds[resourceKey]) {
              seenIds[resourceKey] = new Set()
            }

            // Deduplicate by resource ID using Set for O(1) lookup
            if (!seenIds[resourceKey].has(e.resource.id)) {
              seenIds[resourceKey].add(e.resource.id)
              ipsSections[resourceKey].push(e.resource)
            }
          }
        }
      }
    }

    const SEARCH_COUNT = 200
    for (let i = 0; i < patientIds.length; i += IPS_FETCH_CONCURRENCY) {
      const batch = patientIds.slice(i, i + IPS_FETCH_CONCURRENCY)
      await Promise.all(
        batch.map(async (pid) => {
          let nextUrl: string | null = `${fhirBase}/Patient?_id=${encodeURIComponent(pid)}&_include=*&_revinclude=*&_count=${SEARCH_COUNT}`
          try {
            while (nextUrl) {
              const searchBundle = <R4.IBundle>await got.get(nextUrl, options).json()
              processBundleEntries(searchBundle)
              const nextLink = searchBundle.link
                ? searchBundle.link.find(
                    (link: NonNullable<R4.IBundle['link']>[number]) => link.relation === 'next' && link.url,
                  )
                : undefined
              nextUrl = nextLink?.url || null
            }
          } catch (err: any) {
            logger.warn(`Failed to fetch data for Patient/${pid}: ${err.message}`)
            return
          }
        }),
      )
    }

    const primaryPatientById = goldenRecordId
      ? ipsSections['Patient'].find((p: R4.IPatient) => p.id === goldenRecordId)
      : null

    // Prefer the golden record Patient as the primary subject.
    // Fall back to "seealso", then first patient with demographics, then first patient.
    const primaryPatient = primaryPatientById || ipsSections['Patient'].find((p: any) =>
      p.link && p.link.some((l: any) => l.type === 'seealso')
    ) || ipsSections['Patient'].find((p: any) => p.name && p.name.length > 0)
      || ipsSections['Patient'][0]

    if (primaryPatient) {
      const ipsComposition = buildIpsComposition(
        { reference: `Patient/${primaryPatient.id}` },
        [
          buildIpsSection(
            'Patient Records',
            ipsSections['Patient'].map((p: R4.IPatient) => ({ reference: `Patient/${p.id!}` })),
          ),
          buildIpsSection(
            'Allergies and Intolerances',
            ipsSections['AllergyIntolerance'].map((a: any) => ({ reference: `AllergyIntolerance/${a.id}` })),
          ),
          buildIpsSection(
            'Problem List',
            ipsSections['Condition'].map((c: any) => ({ reference: `Condition/${c.id}` })),
          ),
          buildIpsSection('Medication Summary', [
            ...ipsSections['MedicationRequest'].map((m: any) => ({ reference: `MedicationRequest/${m.id}` })),
            ...ipsSections['MedicationStatement'].map((m: any) => ({ reference: `MedicationStatement/${m.id}` })),
          ]),
          buildIpsSection(
            'Encounters',
            ipsSections['Encounter'].map((e: R4.IEncounter) => ({ reference: `Encounter/${e.id!}` })),
          ),
          buildIpsSection(
            'Service Requests',
            ipsSections['ServiceRequest'].map((sr: any) => ({ reference: `ServiceRequest/${sr.id}` })),
          ),
          buildIpsSection(
            'Diagnostic Reports',
            ipsSections['DiagnosticReport'].map((dr: any) => ({ reference: `DiagnosticReport/${dr.id}` })),
          ),
          buildIpsSection(
            'Observations',
            ipsSections['Observation'].map((o: R4.IObservation) => ({ reference: `Observation/${o.id!}` })),
          ),
          buildIpsSection(
            'Immunizations',
            ipsSections['Immunization'].map((i: any) => ({ reference: `Immunization/${i.id}` })),
          ),
          buildIpsSection(
            'Procedures',
            ipsSections['Procedure'].map((p: any) => ({ reference: `Procedure/${p.id}` })),
          ),
        ],
      )

      ipsBundle.type = R4.BundleTypeKind._document
      ipsBundle.entry = []
      ipsBundle.entry.push(ipsComposition)

      // Add all resources to the bundle
      const bundleTypes = [
        'Patient', 'AllergyIntolerance', 'Condition', 'MedicationRequest',
        'MedicationStatement', 'Encounter', 'ServiceRequest', 'DiagnosticReport',
        'Observation', 'Immunization', 'Procedure',
      ]
      for (const rt of bundleTypes) {
        if (ipsSections[rt] && ipsSections[rt].length > 0 && ipsBundle.entry) {
          ipsBundle.entry = ipsBundle.entry.concat(ipsSections[rt])
        }
      }
    } else {
      logger.error(`Cannot generate cross-facility IPS: no patients found for IDs ${patientIds.join(', ')}`)
    }
  } catch (e) {
    logger.error(`Cannot generate cross-facility IPS for patients ${patientIds.join(', ')}:\n${e}`)
  }

  return ipsBundle
}

export function generateUpdateBundle(
  values: R4.IDomainResource[][],
  lastUpdated?: string,
  location?: string,
): R4.IBundle {
  let patients: R4.IPatient[] = <R4.IPatient[]>values[0]
  const encounters: R4.IEncounter[] = <R4.IEncounter[]>values[1]
  const observations: R4.IObservation[] = <R4.IObservation[]>values[2]

  // Filter patients here since location is not queryable
  if (patients.length > 0 && location) {
    patients = patients.filter((p: R4.IPatient) => {
      if (p.identifier && p.identifier.length > 0 && p.identifier[0].extension) {
        return p.identifier[0].extension[0].valueReference!.reference!.includes(location)
      } else {
        return false
      }
    })
  }

  const ipsBundle: R4.IBundle = {
    resourceType: 'Bundle',
  }

  // let ipsCompositionType: R4.ICodeableConcept = {
  //     coding: [{ system: "http://loinc.org", code: "60591-5", display: "Patient summary Document" }]
  // };

  const ipsCompositionType: R4.ICodeableConcept = {
    text: 'iSantePlus Instance Update Bundle',
  }

  const ipsComposition: R4.IComposition = {
    resourceType: 'Composition',
    type: ipsCompositionType,
    author: [{ display: 'SHR System' }],
    section: [
      {
        title: 'Patients',
        entry: patients.map((p: R4.IPatient) => {
          return { reference: `Patient/${p.id!}` }
        }),
      },
      {
        title: 'Encounters',
        entry: encounters.map((e: R4.IEncounter) => {
          return { reference: `Encounter/${e.id!}` }
        }),
      },
      {
        title: 'Observations',
        entry: observations.map((o: R4.IObservation) => {
          return { reference: `Observation/${o.id!}` }
        }),
      },
    ],
  }

  // Create Document Bundle
  ipsBundle.type = R4.BundleTypeKind._document
  ipsBundle.entry = []
  ipsBundle.entry.push(ipsComposition)
  ipsBundle.entry = ipsBundle.entry.concat(patients)
  ipsBundle.entry = ipsBundle.entry.concat(encounters)
  ipsBundle.entry = ipsBundle.entry.concat(observations)

  return ipsBundle
}

function grabTargetIdentifiers(patients: R4.IPatient[], system: string): string[] {
  // Filter results for unique idenitifers with the correct system
  return patients
    .map<string>(patient => {
      if (patient.identifier) {
        const targetId = patient.identifier.find((i: R4.IIdentifier) => {
          return i.system && i.system === system
        })

        if (targetId && targetId.value) {
          const uuid = targetId.value.split('/').pop()
          if (uuid) {
            return uuid
          }
        }
      }
      return ''
    })
    .filter(i => i != '')
}

async function getRelatedResources(
  patientId: string,
  resourceType: string,
): Promise<R4.IResource[]> {
  // TODO: Consider bulk export
  const query = new URLSearchParams()

  const options = {
    username: config.get('fhirServer:username'),
    password: config.get('fhirServer:password'),
  }

  const uri = URI(config.get('fhirServer:baseURL'))

  query.set('subject', `Patient/${patientId}`)

  const resources = await got.get(`${uri.toString()}/${resourceType}?${query}`, options).json()

  return <R4.IResource[]>resources
}

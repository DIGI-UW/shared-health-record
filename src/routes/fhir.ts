'use strict'
import express, { Request, Response } from 'express'
import got from 'got'
import URI from 'urijs'
import config from '../lib/config'
import { emptyBundle, emptyBundleResponse, getHapiPassthrough, invalidBundle, invalidBundleMessage } from '../lib/helpers'
import logger from '../lib/winston'
import { R4 } from '@ahryman40k/ts-fhir-types'
import { generateCrossFacilityIpsBundle, generateSimpleIpsBundle } from '../workflows/ipsWorkflows'
import { getResourceTypeEnum, isValidResourceType } from '../lib/validate'
import { getMetadata } from '../lib/helpers'

export const router = express.Router()

const GOLDEN_RECORD_CODE = config.get('goldenRecordCode') || '5c827da5-4858-4f3d-a50c-62ece001efea'

// Timeout for MPI lookups — prevents slow CR from stalling SHR writes.
// Falls back to 5 seconds if not configured or invalid.
const rawMpiLookupTimeoutMs = config.get('mpiLookupTimeoutMs')
const parsedMpiLookupTimeoutMs = Number(rawMpiLookupTimeoutMs)
const MPI_LOOKUP_TIMEOUT_MS =
  rawMpiLookupTimeoutMs === undefined || rawMpiLookupTimeoutMs === null || Number.isNaN(parsedMpiLookupTimeoutMs)
    ? 5000
    : parsedMpiLookupTimeoutMs

/**
 * Look up a Patient's golden record (master patient ID) in the Client Registry.
 * If found, adds a Patient.link entry pointing to the golden record.
 * This ensures the SHR stores patients with their MPI identifier,
 * enabling cross-facility longitudinal queries.
 *
 * Returns the enriched patient resource, or the original if no CR match found.
 */
interface MpiResolution {
  patient: R4.IPatient
  goldenRecordId: string | null
  crSourcePatients: R4.IPatient[]
}

async function resolvePatientMpi(patient: R4.IPatient): Promise<MpiResolution> {
  const crUrl = config.get('clientRegistryUrl')
  if (!crUrl || !patient || patient.resourceType !== 'Patient') {
    return { patient, goldenRecordId: null, crSourcePatients: [] }
  }

  const identifiers = patient.identifier ? (Array.isArray(patient.identifier) ? patient.identifier  :  [patient.identifier]): []
  let goldenRecordId: string | null = null
  const crSourcePatients: R4.IPatient[] = []

  const options = {
    username: config.get('clientRegistryUsername') || config.get('fhirServer:username'),
    password: config.get('clientRegistryPassword') || config.get('fhirServer:password'),
    timeout: { request: MPI_LOOKUP_TIMEOUT_MS },
    retry: { limit: 1, methods: ['GET' as const] },
  }

  for (const identifier of identifiers) {
    if (!identifier.system || !identifier.value) continue

    const idValue = String(identifier.value)
    const maskedValue = idValue.slice(0, 3) + '***'

    try {
      const searchUrl = `${crUrl}/Patient?identifier=${encodeURIComponent(identifier.system)}|${encodeURIComponent(idValue)}&_include=Patient:link`
      logger.debug(`MPI lookup: ${identifier.system}|${maskedValue}`)

      const response: any = await got.get(searchUrl, options).json()

      if (response && response.entry) {
        for (const entry of response.entry) {
          const resource = entry.resource
          if (
            resource &&
            resource.meta &&
            resource.meta.tag &&
            resource.meta.tag.some((t: any) => t.code === GOLDEN_RECORD_CODE)
          ) {
            goldenRecordId = resource.id
          } else if (resource && resource.resourceType === 'Patient') {
            crSourcePatients.push(resource)
          }
        }
      }

      if (goldenRecordId) break // Found a match, stop searching
    } catch (error: any) {
      // Log and continue to the next identifier
      logger.warn(`MPI lookup failed for identifier ${identifier.system}|${maskedValue}: ${error.message}`)
    }
  }

  if (goldenRecordId) {
    logger.info(`MPI resolved: Patient/${patient.id} → golden record ${goldenRecordId}`)

    if (!patient.link) patient.link = []

    const alreadyLinked = patient.link.some(
      (l: any) => l.other && l.other.reference === `Patient/${goldenRecordId}`,
    )

    if (!alreadyLinked) {
      patient.link.push({
        other: { reference: `Patient/${goldenRecordId}` },
        type: R4.Patient_LinkTypeKind._refer,
      })
    }
  } else {
    logger.info(`MPI lookup: no golden record found for Patient/${patient.id}`)
  }

  return { patient, goldenRecordId, crSourcePatients }
}

/**
 * Build a golden record Patient resource from OpenCR source patients.
 *
 * Demographics resolution:
 * - name: Takes the "official" name from the most recently updated source patient.
 *         Falls back to any name if no "official" use is found.
 *         All unique names from all sources are included on the resource.
 * - gender, birthDate: Taken from the most recently updated source.
 * - identifier: Merged from all sources, deduplicated by system|value.
 * - link: "seealso" entries pointing to each source patient in the SHR.
 */
function buildGoldenRecordPatient(
  goldenRecordId: string,
  crSourcePatients: R4.IPatient[],
  shrSourcePatientIds: string[],
): R4.IPatient {
  // Sort sources by lastUpdated descending — most recent first
  const sorted = [...crSourcePatients].sort((a, b) => {
    const ta = a.meta?.lastUpdated || ''
    const tb = b.meta?.lastUpdated || ''
    return tb.localeCompare(ta)
  })

  // Resolve official name: pick from the most recent source that has one
  let officialName: R4.IHumanName | null = null
  const allNames: R4.IHumanName[] = []
  const seenNames = new Set<string>()

  for (const source of sorted) {
    for (const name of source.name || []) {
      const key = `${name.use || ''}|${name.family || ''}|${(name.given || []).join(',')}`
      if (seenNames.has(key)) continue
      seenNames.add(key)

      if (name.use === 'official' && !officialName) {
        officialName = { ...name }
      }
      allNames.push(name)
    }
  }

  // Build the name array: official name first, then others
  const names: R4.IHumanName[] = []
  if (officialName) {
    names.push(officialName)
  }
  for (const name of allNames) {
    const isOfficial = officialName &&
      name.family === officialName.family &&
      JSON.stringify(name.given) === JSON.stringify(officialName.given) &&
      name.use === officialName.use
    if (!isOfficial) {
      names.push(name)
    }
  }
  // If no official name found, just use all names as-is
  if (names.length === 0 && allNames.length > 0) {
    names.push(...allNames)
  }

  // Gender and birthDate from most recent source
  const mostRecent = sorted[0]
  const gender = mostRecent?.gender
  const birthDate = mostRecent?.birthDate

  // Merge identifiers from all sources, deduplicated
  const identifiers: R4.IIdentifier[] = []
  const seenIds = new Set<string>()
  for (const source of crSourcePatients) {
    for (const ident of source.identifier || []) {
      const key = `${ident.system || ''}|${ident.value || ''}`
      if (!seenIds.has(key)) {
        seenIds.add(key)
        identifiers.push(ident)
      }
    }
  }

  return {
    resourceType: 'Patient',
    id: goldenRecordId,
    identifier: identifiers,
    active: true,
    name: names,
    gender,
    birthDate,
    link: shrSourcePatientIds.map(pid => ({
      other: { reference: `Patient/${pid}` },
      type: R4.Patient_LinkTypeKind._seealso,
    })),
  }
}

/**
 * Update the golden record Patient resource in the SHR with demographics
 * resolved from OpenCR source patients. Runs as a background operation
 * so it does not block the main write path.
 */
async function updateGoldenRecordInShr(goldenRecordId: string, crSourcePatients: R4.IPatient[], shrSourcePatientIds: string[]): Promise<void> {
  const fhirBase = config.get('fhirServer:baseURL')
  try {
    const goldenPatient = buildGoldenRecordPatient(goldenRecordId, crSourcePatients, shrSourcePatientIds)
    await got.put(`${fhirBase}/Patient/${goldenRecordId}`, {
      json: goldenPatient,
      username: config.get('fhirServer:username'),
      password: config.get('fhirServer:password'),
      timeout: { request: 5000 },
      retry: { limit: 1, methods: ['PUT' as const] },
    })
    logger.info(`Updated golden record Patient/${goldenRecordId} with resolved demographics`)
  } catch (error: any) {
    logger.warn(`Failed to update golden record Patient/${goldenRecordId}: ${error.message}`)
  }
}

/**
 * Rewrite Patient references in a clinical resource to use the golden record ID.
 * Recursively traverses the resource to catch nested references (e.g., performer.actor,
 * participant.individual) in addition to top-level fields like subject and patient.
 */
function rewritePatientReferences(resource: any, patientReferenceMap: Map<string, string>): void {
  if (!resource || typeof resource !== 'object') return

  const visited = new WeakSet<object>()

  const visit = (node: any, path: string): void => {
    if (!node || typeof node !== 'object') return
    if (visited.has(node)) return
    visited.add(node)

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        visit(node[i], `${path}[${i}]`)
      }
      return
    }

    if (typeof node.reference === 'string') {
      const ref = node.reference as string
      const goldenId = patientReferenceMap.get(ref)
      if (goldenId) {
        logger.info(`Rewriting ${path}.reference: ${ref} → Patient/${goldenId}`)
        node.reference = `Patient/${goldenId}`
      }
    }

    for (const key of Object.keys(node)) {
      visit(node[key], path ? `${path}.${key}` : key)
    }
  }

  visit(resource, 'resource')
}

/**
 * Enrich a FHIR Bundle by resolving Patient resources against the MPI.
 * After resolving golden records, rewrites patient references in clinical
 * resources so all data points to the golden record Patient ID.
 * Processes patients in batches of MPI_CONCURRENCY to avoid overwhelming the CR.
 */
const MPI_CONCURRENCY = 5

async function enrichBundleWithMpi(bundle: any): Promise<any> {
  if (!bundle || !bundle.entry) return bundle

  const patientEntries = bundle.entry.filter(
    (e: any) => e.resource && e.resource.resourceType === 'Patient',
  )

  if (patientEntries.length === 0) return bundle

  // Build a mapping of local patient references (Patient/<id> or fullUrl) → golden record ID
  const patientReferenceMap = new Map<string, string>()
  // Collect CR source patients per golden record for demographics resolution
  const goldenRecordSources = new Map<string, R4.IPatient[]>()
  const goldenRecordShrPatients = new Map<string, Set<string>>()

  // Process in batches to limit concurrent CR requests
  for (let i = 0; i < patientEntries.length; i += MPI_CONCURRENCY) {
    const batch = patientEntries.slice(i, i + MPI_CONCURRENCY)
    await Promise.all(
      batch.map((entry: any) =>
        resolvePatientMpi(entry.resource)
          .then((resolution: MpiResolution) => {
            entry.resource = resolution.patient
            if (resolution.goldenRecordId) {
              const patientId = resolution.patient.id
              if (patientId) {
                patientReferenceMap.set(`Patient/${patientId}`, resolution.goldenRecordId)
              }
              if (typeof entry.fullUrl === 'string' && entry.fullUrl.length > 0) {
                patientReferenceMap.set(entry.fullUrl, resolution.goldenRecordId)
              }

              // Collect CR sources for golden record demographics — merge across resolutions
              if (!goldenRecordSources.has(resolution.goldenRecordId)) {
                goldenRecordSources.set(resolution.goldenRecordId, [...resolution.crSourcePatients])
              } else {
                const existing = goldenRecordSources.get(resolution.goldenRecordId)!
                const existingIds = new Set(existing.map((p: R4.IPatient) => p.id))
                for (const src of resolution.crSourcePatients) {
                  if (src.id && !existingIds.has(src.id)) {
                    existing.push(src)
                    existingIds.add(src.id)
                  }
                }
              }
              if (!goldenRecordShrPatients.has(resolution.goldenRecordId)) {
                goldenRecordShrPatients.set(resolution.goldenRecordId, new Set())
              }
              if (patientId) {
                goldenRecordShrPatients.get(resolution.goldenRecordId)!.add(patientId)
              }
            }
          })
          .catch((err: any) => {
            logger.warn(`MPI enrichment failed for Patient/${entry.resource.id}: ${err.message}`)
          }),
      ),
    )
  }

  // Rewrite patient references in all non-Patient resources
  if (patientReferenceMap.size > 0) {
    logger.info(`Rewriting patient references for ${patientReferenceMap.size} patient reference(s) in bundle`)
    for (const entry of bundle.entry) {
      if (entry.resource && entry.resource.resourceType !== 'Patient') {
        rewritePatientReferences(entry.resource, patientReferenceMap)
      }
    }
  }

  // Update golden record Patient resources in the SHR with resolved demographics (background)
  for (const [grId, crSources] of goldenRecordSources.entries()) {
    if (crSources.length > 0) {
      const shrPids = Array.from(goldenRecordShrPatients.get(grId) || [])
      updateGoldenRecordInShr(grId, crSources, shrPids).catch((err: any) => {
        logger.warn(`Background golden record update failed for ${grId}: ${err.message}`)
      })
    }
  }

  return bundle
}

/**
 * Given a patient ID, find all patients in the SHR that share the same golden record.
 * 1. Fetch Patient/<id> from HAPI FHIR
 * 2. Check if it has a link of type "refer" to a golden record
 * 3. If so, search for all other patients that also link to that golden record
 * 4. Return all linked patient IDs (including the original)
 *
 * Falls back to [patientId] if no golden record link is found.
 */
interface LinkedPatientsResolution {
  patientIds: string[]
  goldenRecordId: string | null
}

async function resolveAllLinkedPatients(patientId: string): Promise<LinkedPatientsResolution> {
  const fhirBase = config.get('fhirServer:baseURL')
  const options = {
    username: config.get('fhirServer:username'),
    password: config.get('fhirServer:password'),
  }

  try {
    // Step 1: Fetch the requested patient
    const patient: any = await got.get(`${fhirBase}/Patient/${patientId}`, options).json()
    if (!patient || !patient.link) return { patientIds: [patientId], goldenRecordId: null }

    // Step 2: Find the golden record reference
    let goldenRecordId: string | null = null
    for (const link of patient.link) {
      if (link.type === 'refer' && link.other && link.other.reference) {
        const match = link.other.reference.match(/^Patient\/(.+)$/)
        if (match) {
          goldenRecordId = match[1]
          break
        }
      }
    }

    if (!goldenRecordId) return { patientIds: [patientId], goldenRecordId: null }

    // Step 3: Find all patients that link to this golden record (with pagination)
    let searchUrl: string | null = `${fhirBase}/Patient?link=${encodeURIComponent(`Patient/${goldenRecordId}`)}&_elements=id&_count=200`
    const patientIds = new Set<string>()

    while (searchUrl) {
      const bundle: any = await got.get(searchUrl, options).json()

      if (bundle && bundle.entry) {
        for (const entry of bundle.entry) {
          if (entry.resource && entry.resource.id) {
            patientIds.add(entry.resource.id)
          }
        }
      }

      const nextLink = bundle && bundle.link
        ? bundle.link.find((link: any) => link.relation === 'next' && link.url)
        : null
      searchUrl = nextLink ? nextLink.url : null
    }

    // Include the golden record itself — clinical data may reference it directly
    patientIds.add(goldenRecordId)

    // Ensure the original patient is included
    patientIds.add(patientId)

    const resolvedPatientIds = Array.from(patientIds)
    logger.info(`Golden record ${goldenRecordId}: found ${resolvedPatientIds.length} linked patients: ${resolvedPatientIds.join(', ')}`)
    return { patientIds: resolvedPatientIds, goldenRecordId }
  } catch (error: any) {
    logger.warn(`Failed to resolve linked patients for ${patientId}: ${error.message}`)
    return { patientIds: [patientId], goldenRecordId: null }
  }
}

router.get('/', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

router.get('/metadata', getMetadata())

router.get('/:resource/:id?/:operation?', async (req: Request, res: Response) => {
  let result = {}
  try {
    let uri = URI(config.get('fhirServer:baseURL'))

    if (isValidResourceType(req.params.resource)) {
      uri = uri.segment(getResourceTypeEnum(req.params.resource).toString())
    } else {
      return res.status(400).json({ message: `Invalid resource type ${req.params.resource}` })
    }

    if (req.params.id && /^[a-zA-Z0-9\-_]+$/.test(req.params.id)) {
      uri = uri.segment(encodeURIComponent(req.params.id))
    } else {
      logger.info(`Invalid id ${req.params.id} - falling back on pass-through to HAPI FHIR server`)
      return getHapiPassthrough()(req, res)
    }

    for (const param in req.query) {
      const value = req.query[param]
      if (value && /^[a-zA-Z0-9\-_]+$/.test(value.toString())) {
        uri.addQuery(param, encodeURIComponent(value.toString()))
      } else {
        logger.info(
          `Invalid query parameter ${param}=${value} - falling back on pass-through to HAPI FHIR server`,
        )
        return getHapiPassthrough()(req, res)
      }
    }

    logger.info(`Getting ${uri.toString()}`)

    const options = {
      username: config.get('fhirServer:username'),
      password: config.get('fhirServer:password'),
    }

    if (
      req.params.id &&
      req.params.resource == 'Patient' &&
      (req.params.id == '$summary' || req.params.operation == '$summary')
    ) {
      // Handle IPS Generation.

      if (req.params.id && req.params.id.length > 0 && req.params.id[0] != '$') {
        // Using logical id — resolve all linked patients via golden record for cross-facility IPS.
        const { patientIds: allPatientIds, goldenRecordId } = await resolveAllLinkedPatients(req.params.id)
        if (allPatientIds.length > 1) {
          logger.info(`IPS: Patient/${req.params.id} has ${allPatientIds.length} linked patients, generating cross-facility summary`)
          result = await generateCrossFacilityIpsBundle(allPatientIds, goldenRecordId)
        } else {
          result = await generateSimpleIpsBundle(req.params.id)
        }
      } else if (req.params.id == '$summary') {
        /**
         * If not using logical id, use the Client Registry to resolve patient identity:
         * 1. Each time a Patient Object is Created or Updated, a copy is sent to the attached CR
         * 2. Assumption: The CR is set up to correctly match the Patient to other sources.
         * 3. When IPS is requested with an identifier query parameter and no logical id parameter:
         *   a. The Client Registry is queried with an $ihe-pix request to get identifiers cross-referenced with the given identifier.
         *   b. All Patient IDs from the SHR are filtered (in query or post-process)
         *   c. Patient data is composed of multiple patient resources, the golden record resource, and all owned data
         * */
      } else {
        // Unsupported Operation
      }
    } else {
      result = await got.get(uri.toString(), options).json()
    }

    res.status(200).json(result)
  } catch (error: any) {
    const statusCode = error?.response?.statusCode || 500
    const body = error?.response?.body
    try {
      return res.status(statusCode).json(body ? JSON.parse(body) : { error: error.message })
    } catch {
      return res.status(statusCode).json({ error: error.message })
    }
  }
})

// Post a bundle of resources — enriched with MPI golden record links
router.post('/', async (req, res) => {
  try {
    logger.info('Received a request to add a bundle of resources')
    let resource = req.body

    // Verify the bundle
    if (invalidBundle(resource)) {
      return res.status(400).json(invalidBundleMessage())
    }

    if (emptyBundle(resource)) {
      logger.info('Received empty bundle, returning empty response')
      return res.status(200).json(emptyBundleResponse())
    }

    // Resolve Patient resources against the MPI before saving
    resource = await enrichBundleWithMpi(resource)

    const uri = URI(config.get('fhirServer:baseURL'))

    const ret = await got.post(uri.toString(), { json: resource })

    res.status(ret.statusCode).json(JSON.parse(ret.body))
  } catch (error: any) {
    const statusCode = error?.response?.statusCode || 500
    const body = error?.response?.body
    try {
      return res.status(statusCode).json(body ? JSON.parse(body) : { error: error.message })
    } catch {
      return res.status(statusCode).json({ error: error.message })
    }
  }
})

// Create resource
router.post('/:resourceType', (req: any, res: any) => {
  saveResource(req, res)
})

// Update resource
router.put('/:resourceType/:id', (req: any, res: any) => {
  saveResource(req, res)
})

/** Helpers */

export async function saveResource(req: any, res: any, operation?: string) {
  let resource = req.body
  const resourceType = req.params.resourceType
  const id = req.params.id
  if (id && !resource.id) {
    resource.id = id
  }

  logger.info('Received a request to add resource type ' + resourceType + ' with id ' + id)

  // Resolve Patient against MPI before saving, but do not block the save if MPI resolution fails.
  if (resourceType === 'Patient') {
    try {
      const resolution = await resolvePatientMpi(resource)
      resource = resolution.patient
      // Update golden record demographics in the background
      if (resolution.goldenRecordId && resolution.crSourcePatients.length > 0 && resource.id) {
        updateGoldenRecordInShr(resolution.goldenRecordId, resolution.crSourcePatients, [resource.id]).catch((err: any) => {
          logger.warn(`Background golden record update failed: ${err.message}`)
        })
      }
    } catch (error: any) {
      logger.warn(
        'Failed to resolve Patient against MPI during saveResource; continuing with original resource: ' +
          (error?.message || String(error))
      )
    }
  }

  let ret, uri, errorFromHapi
  try {
    if (req.method === 'POST') {
      uri = config.get('fhirServer:baseURL') + '/' + getResourceTypeEnum(resourceType).toString()
    } else if (req.method === 'PUT') {
      uri = config.get('fhirServer:baseURL') + '/' + getResourceTypeEnum(resourceType).toString() + '/' + id
    } else {
      // Invalid request method
      res.status(400).json({ error: 'Invalid request method' })
      return
    }

    // Perform request
    logger.info('Sending ' + req.method + ' request to ' + uri)
    ret = await got({
      method: req.method,
      url: uri,
      json: resource,
      hooks: {
        beforeError: [
          error => {
            if (error.response) {
              logger.error('Error response from FHIR server: ' + JSON.stringify(error.response.body))
              errorFromHapi = JSON.parse(error.response.body as string)
            }
            return error
          },
        ],
      },
    });

    res.status(ret.statusCode).json(JSON.parse(ret.body))
  } catch (error: any) {
    const statusCode = error?.response?.statusCode || 500
    if (errorFromHapi) {
      return res.status(statusCode).json(errorFromHapi)
    }
    const body = error?.response?.body
    try {
      return res.status(statusCode).json(body ? JSON.parse(body) : { error: error.message })
    } catch {
      return res.status(statusCode).json({ error: error.message })
    }
  }
}
    
export default router

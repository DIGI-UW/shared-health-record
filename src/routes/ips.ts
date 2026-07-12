'use strict'
import { R4 } from '@ahryman40k/ts-fhir-types'
import express, { Request, Response } from 'express'
import fhirClient from 'fhirclient'
import got from 'got'
import config from '../lib/config'
import logger from '../lib/winston'
import {
  GOLDEN_RECORD_TAG,
  generateConsolidatedIpsBundle,
  generateUpdateBundle,
} from '../workflows/ipsWorkflows'
import { sprintf } from 'sprintf-js'
import { getMetadata } from '../lib/helpers'

export const router = express.Router()

const system = config.get('app:mpiSystem')
const fpnidSystem = config.get('app:fpnidSystem')
const isantePlusSystem = config.get('app:isantePlusSystem')

// Server-to-server search against the MPI (OpenCR via OpenHIM). Uses the client-registry
// credentials — the same ones the FHIR write path uses — rather than the (empty) fhirServer creds
// or the SMART fhirclient, which OpenHIM's private CR channel rejects with 401.
async function mpiSearch(query: string): Promise<R4.IPatient[]> {
  const url = `${config.get('clientRegistryUrl')}/${query}`
  const options = {
    username: config.get('clientRegistryUsername') || config.get('fhirServer:username'),
    password: config.get('clientRegistryPassword') || config.get('fhirServer:password'),
  }
  const bundle = <R4.IBundle>await got.get(url, options).json()
  return (bundle.entry || [])
    .map(e => e.resource as R4.IPatient)
    .filter(r => r && r.resourceType === 'Patient')
}

// Resolve any site-held identifier (source key, fpnid, ...) to the golden record and every
// linked source. OpenCR is asked for the identifier; whichever record carries it is followed to
// its golden (per the spec: CRUID -> else source key -> plus fpnid, all resolve to the golden).
// Returns the golden + all sources, or null when no golden is found for the identifier.
async function resolveGoldenAndSources(
  identifierSystem: string,
  value: string,
): Promise<R4.IPatient[] | null> {
  const hits = await mpiSearch(
    `Patient?identifier=${identifierSystem}|${value}&_include=Patient:link`,
  )
  const goldenRecord = hits.find(
    x => x.meta && x.meta.tag && x.meta.tag.some(t => t.code === GOLDEN_RECORD_TAG),
  )
  if (!goldenRecord) {
    return null
  }
  // Re-query by golden id so we get the golden + every source linked to it (not just the
  // source that happened to carry the queried identifier).
  return mpiSearch(`Patient?_id=${goldenRecord.id}&_include=Patient:link`)
}

router.get('/', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

router.get('/metadata', getMetadata())

// Consolidated IPS by golden-record id (CRUID). Identity (golden + all linked site source-ids)
// is resolved from the MPI; clinical is gathered from the SHR per source-id. See
// generateConsolidatedIpsBundle for why this works with demographics held only in the MPI.
router.get('/Patient/cruid/:id', async (req: Request, res: Response) => {
  const cruid = req.params.id
  logger.info('Received a request for a consolidated IPS by cruid')

  // The golden record + every site source linked to it (golden.link[seealso] -> sources).
  const mpiPatients = await mpiSearch(`Patient?_id=${cruid}&_include=Patient:link`)

  const ipsBundle = await generateConsolidatedIpsBundle(mpiPatients)
  res.status(200).json(ipsBundle)
})

// Consolidated IPS by biometric national FP ID (fpnid, system = app:fpnidSystem). Resolves the
// fpnid to its golden record, then to all linked sources, then assembles the consolidated IPS.
router.get('/Patient/fpnid/:id', async (req: Request, res: Response) => {
  const fpnid = req.params.id
  logger.info('Received a request for a consolidated IPS by fpnid')

  if (!fpnidSystem) {
    logger.error('app:fpnidSystem is not configured; cannot resolve fpnid retrieval')
    return res.sendStatus(501)
  }

  const mpiPatients = await resolveGoldenAndSources(fpnidSystem, fpnid)
  if (mpiPatients) {
    res.status(200).json(await generateConsolidatedIpsBundle(mpiPatients))
  } else {
    res.sendStatus(404)
  }
})

// Consolidated IPS by iSantePlus identifier (system = app:isantePlusSystem). The EMR sends only its
// own iSantePlus ID; the mediator resolves it to the golden record in the CR, gathers every linked
// source, and assembles the consolidated IPS from the SHR — the EMR never talks to OpenCR directly.
router.get('/Patient/isanteplus/:id', async (req: Request, res: Response) => {
  const isantePlusId = req.params.id
  logger.info('Received a request for a consolidated IPS by iSantePlus id')

  if (!isantePlusSystem) {
    logger.error('app:isantePlusSystem is not configured; cannot resolve iSantePlus retrieval')
    return res.sendStatus(501)
  }

  const mpiPatients = await resolveGoldenAndSources(isantePlusSystem, isantePlusId)
  if (mpiPatients) {
    res.status(200).json(await generateConsolidatedIpsBundle(mpiPatients))
  } else {
    res.sendStatus(404)
  }
})

// Consolidated IPS by a site identifier (system = app:mpiSystem, i.e. the source key). Resolves
// the identifier to its golden record, then to all linked sources, then assembles the IPS.
router.get('/Patient/:id', async (req: Request, res: Response) => {
  const patientId = req.params.id
  logger.info('Received a request for a consolidated IPS by site identifier')

  const mpiPatients = await resolveGoldenAndSources(system, patientId)
  if (mpiPatients) {
    res.status(200).send(await generateConsolidatedIpsBundle(mpiPatients))
  } else {
    res.sendStatus(404)
  }
})

router.get('/:location?/:lastUpdated?', (req: Request, res: Response) => {
  const location = req.params.location
  const lastUpdated = req.params.lastUpdated
  const query = new URLSearchParams()
  const obsQuery = new URLSearchParams()

  if (lastUpdated) {
    query.set('_lastUpdated', lastUpdated)
    obsQuery.set('_lastUpdated', lastUpdated)
  }

  logger.info(
    sprintf(
      'Received a request for an ISP with a bundle of resources\nlocation: %s | lastUpdagted: %s',
      location,
      lastUpdated,
    ),
  )

  // Create Client
  const client = fhirClient(req, res).client({
    serverUrl: config.get('fhirServer:baseURL'),
  })

  /**
   * For now:
   * 1. Set lastUpdated and location based on parameters
   * 2. Get all Patients that were lastUpdated and from a given location
   * 3. Get all Encounters that were lastUpdated and from a given location
   * 4. Get all Observations that were lastUpdated and from a given location
   * 5. Combine them into a single bundle w/ composition
   *
   */
  
  const patientP = client.request<R4.IPatient[]>(`Patient?${query}`, {
    flat: true,
  })

  if (location) {
    query.set('location', location)
    obsQuery.set('encounter.location', location)
  }
  const encounterP = client.request<R4.IEncounter[]>(`Encounter?${query}`, {
    flat: true,
  })
  const obsP = client.request<R4.IObservation[]>(`Observation?${obsQuery}`, {
    flat: true,
  })

  Promise.all([patientP, encounterP, obsP])
    .then(values => {
      res.status(200).json(generateUpdateBundle(values, location))
    })
    .catch(e => {
      res.status(500).render('error', { error: e })
    })
})

export default router

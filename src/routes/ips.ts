'use strict'
import { R4 } from '@ahryman40k/ts-fhir-types'
import express, { Request, Response } from 'express'
import fhirClient from 'fhirclient'
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

router.get('/', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

router.get('/metadata', getMetadata())

// Consolidated IPS by golden-record id (CRUID). Identity (golden + all linked site source-ids)
// is resolved from the MPI; clinical is gathered from the SHR per source-id. See
// generateConsolidatedIpsBundle for why this works with demographics held only in the MPI.
router.get('/Patient/cruid/:id', async (req: Request, res: Response) => {
  const cruid = req.params.id
  const mpiUrl = config.get('clientRegistryUrl')

  logger.info(sprintf('Received a request for a consolidated IPS for cruid: %s', cruid))

  const mpiClient = fhirClient(req, res).client({
    serverUrl: mpiUrl,
    username: config.get('fhirServer:username'),
    password: config.get('fhirServer:password'),
  })

  // The golden record + every site source linked to it (golden.link[seealso] -> sources).
  const mpiPatients = await mpiClient.request<R4.IPatient[]>(
    `Patient?_id=${cruid}&_include=Patient:link`,
    { flat: true },
  )

  const ipsBundle = await generateConsolidatedIpsBundle(mpiPatients)
  res.status(200).json(ipsBundle)
})

// Consolidated IPS by a site identifier (system = app:mpiSystem). Resolves the identifier to its
// golden record, then to all linked sources, then assembles the same consolidated IPS.
router.get('/Patient/:id', async (req: Request, res: Response) => {
  const patientId = req.params.id
  const mpiUrl = config.get('clientRegistryUrl')

  logger.info(sprintf('Received a request for a consolidated IPS for patient id: %s', patientId))

  const mpiClient = fhirClient(req, res).client({
    serverUrl: mpiUrl,
    username: config.get('fhirServer:username'),
    password: config.get('fhirServer:password'),
  })

  // Resolve the identifier to its golden record, then enumerate all linked sources by cruid.
  const goldenRecordRes = await mpiClient.request<R4.IPatient[]>(
    `Patient?identifier=${system}|${patientId}&_include=Patient:link`,
    { flat: true },
  )
  const goldenRecord = goldenRecordRes.find(
    x => x.meta && x.meta.tag && x.meta.tag.some(t => t.code === GOLDEN_RECORD_TAG),
  )

  if (goldenRecord) {
    const mpiPatients = await mpiClient.request<R4.IPatient[]>(
      `Patient?_id=${goldenRecord.id}&_include=Patient:link`,
      { flat: true },
    )
    const ipsBundle = await generateConsolidatedIpsBundle(mpiPatients)
    res.status(200).send(ipsBundle)
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

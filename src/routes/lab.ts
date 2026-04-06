'use strict'
import { R4 } from '@ahryman40k/ts-fhir-types'
import express, { Request, Response } from 'express'
import got from 'got/dist/source'
import { saveBundle } from '../hapi/lab'
import { getMetadata, invalidBundle, invalidBundleMessage, emptyBundle, emptyBundleResponse } from '../lib/helpers'
import logger from '../lib/winston'
import { LabWorkflows } from '../workflows/labWorkflows'

export const router = express.Router()

router.get('/metadata', getMetadata())

router.all('/', async (req: Request, res: Response) => {
  if (req.method == 'GET') {
    const task: R4.ITask = <R4.ITask><unknown>got(
      'https://b-techbw.github.io/bw-lab-ig/Task-example-laboratory-task-simple-requested.json'
    ).json()
    const patient: R4.IPatient = <R4.IPatient><unknown>got(
      'https://digi-uw.github.io/laboratory-workflows-ig/Patient-example-laboratory-patient.json'
    ).json()

    // Temporary Testing Bundle
    return res.status(200).send(LabWorkflows.generateLabBundle(task, patient))
  } else {
    logger.info('Received a Lab Order bundle to save')
    const orderBundle: R4.IBundle = req.body

    // Validate Bundle
    if (invalidBundle(orderBundle)) {
      return res.status(400).json(invalidBundleMessage())
    }

    if (emptyBundle(orderBundle)) {
      return res.status(200).json(emptyBundleResponse())
    }

    let resultBundle: R4.IBundle

    try {
      resultBundle = <R4.IBundle>await saveBundle(orderBundle)
    } catch (error) {
      logger.error(error)
      return res.status(500).send(error)
    }

    return res.status(200).json(resultBundle)
  }
})

router.get('/example-result', async (req: Request, res: Response) => {
  const bundle: R4.IBundle = <R4.IBundle>(
    await got(
      'https://b-techbw.github.io/bw-lab-ig/Bundle-example-bw-lab-results-bundle.json',
    ).json()
  )

  return res.status(200).send(bundle)
})

// Create a new lab order in SHR based on bundle
// (https://i-tech-uw.github.io/emr-lis-ig/Bundle-example-emr-lis-bundle.html)
// router.post('/'), async (req: Request, res: Response) => {
//   logger.info('Received a Lab Order bundle to save');
//   let orderBundle: R4.IBundle = req.body

//   // Validate Bundle
//   if (invalidBundle(orderBundle)) {
//     return res.status(400).json(invalidBundleMessage())
//   }

//   let result: any = await saveLabBundle(orderBundle)

//   return res.status(result.statusCode).json(result.body)
// }

// Get list of active orders targetting :facility
router.get('/orders/target/:facilityId/:_lastUpdated?', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

// Get
router.get('/orders/source/:facilityId/:_lastUpdated?', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

router.put('/orders/:id')

// // Create resource
// router.post('/orders', (req, res) => {
//     saveResource(req, res);
// });

// // Update resource
// router.put('/:resourceType/:id', (req, res) => {
//     saveResource(req, res);
// });

export default router

'use strict'

import { R4 } from '@ahryman40k/ts-fhir-types'
import express, { Request, Response } from 'express'
import { saveBundle } from '../hapi/lab'
import { getMetadata, invalidBundle, invalidBundleMessage, emptyBundle, emptyBundleResponse } from '../lib/helpers'
import logger from '../lib/winston'
import { WorkflowHandler } from '../workflows/botswana/workflowHandler'

export const router = express.Router()

router.get('/metadata', getMetadata())

router.all('/', async (req: Request, res: Response) => {
  let orderBundle: R4.IBundle
  if (req.method == 'POST' || req.method == 'PUT') {
    try {
      logger.info('Received a Lab Order bundle to save.')

      // Make sure JSON is parsed
      if (req.is('text/plain')) {
        orderBundle = JSON.parse(req.body)
      } else if (req.is('application/json') || req.is('application/fhir+json')) {
        orderBundle = req.body
      } else {
        const m = `Invalid content type! ${req.headers}`
        logger.error(m)
        return res.status(400).send(m)
      }

      // Validate Bundle
      if (invalidBundle(orderBundle)) {
        return res.status(400).json(invalidBundleMessage())
      }

      if (emptyBundle(orderBundle)) {
        return res.status(200).json(emptyBundleResponse())
      }

      // Save Bundle
      const resultBundle: R4.IBundle = await saveBundle(orderBundle)

      // Trigger Background Tasks if bundle saved correctly
      if (
        resultBundle &&
        resultBundle.entry &&
        orderBundle.entry &&
        resultBundle.entry.length == orderBundle.entry.length
      ) {
        WorkflowHandler.handleLabOrder(orderBundle)
        return res.status(200).json(resultBundle)
      } else {
        return res.status(400).send(resultBundle)
      }
    } catch (e) {
      logger.error(`Error saving bundle: ${e}`)

      return res.status(500).send("Couldn't save bundle!")
    }
  }
})

// Get list of active orders targetting :facility
router.get('/orders/target/:facilityId/:_lastUpdated?', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

// Get
router.get('/orders/source/:facilityId/:_lastUpdated?', (req: Request, res: Response) => {
  return res.status(200).send(req.url)
})

export default router

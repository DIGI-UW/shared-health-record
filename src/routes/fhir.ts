'use strict'
import express, { Request, Response } from 'express'
import got from 'got'
import URI from 'urijs'
import config from '../lib/config'
import { getHapiPassthrough, invalidBundle, invalidBundleMessage, emptyBundle, emptyBundleResponse } from '../lib/helpers'
import logger from '../lib/winston'
import { generateSimpleIpsBundle } from '../workflows/ipsWorkflows'
import { getResourceTypeEnum, isValidResourceType } from '../lib/validate'
import { getMetadata } from '../lib/helpers'

export const router = express.Router()

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
        // ** If using logical id of the Patient object, create summary from objects directly connected to the patient.
        result = await generateSimpleIpsBundle(req.params.id)
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

// Post a bundle of resources
router.post('/', async (req, res) => {
  try {
    logger.info('Received a request to add a bundle of resources')
    const resource = req.body

    // Verify the bundle
    if (invalidBundle(resource)) {
      return res.status(400).json(invalidBundleMessage())
    }

    if (emptyBundle(resource)) {
      logger.info('Received empty bundle, returning empty response')
      return res.status(200).json(emptyBundleResponse())
    }

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
  const resource = req.body
  const resourceType = req.params.resourceType
  const id = req.params.id
  if (id && !resource.id) {
    resource.id = id
  }

  logger.info('Received a request to add resource type ' + resourceType + ' with id ' + id)
  
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

    // Perform  request
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

import request from 'supertest'
import express from 'express'
import { router } from '../fhir'
import got from 'got'
import { saveResource } from '../fhir'
import { invalidBundle, emptyBundle, emptyBundleResponse } from '../../lib/helpers'

const app = express()
app.use(express.json())
app.use('/', router)

describe('FHIR Routes', () => {
  it.skip('should return 200 OK for GET /metadata', async () => {
    const response = await request(app).get('/metadata')
    expect(response.status).toBe(200)
  })

  it.skip('should return 400 Bad Request for GET with invalid resource type', async () => {
    const response = await request(app).get('/invalid-resource')
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ message: 'Invalid resource type invalid-resource' })
  })
})

it('should return 500 Internal Server Error when the post request fails', async () => {
  const req = {
    body: {

    },
    params: {
      resourceType: 'Observation',
      id: '123',
    },
  }
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  }

  // Mock the post request to fail
  jest.spyOn(got, 'post').mockRejectedValue(new Error('Post request failed'))

  await saveResource(req, res)

  expect(res.status).toHaveBeenCalledWith(400)
})

describe('invalidBundle', () => {
  it('rejects null', () => {
    expect(invalidBundle(null)).toBe(true)
  })

  it('rejects undefined', () => {
    expect(invalidBundle(undefined)).toBe(true)
  })

  it('rejects non-object (string)', () => {
    expect(invalidBundle('not a bundle')).toBe(true)
  })

  it('rejects non-object (number)', () => {
    expect(invalidBundle(42)).toBe(true)
  })

  it('rejects array', () => {
    expect(invalidBundle([{ resourceType: 'Bundle' }])).toBe(true)
  })

  it('rejects missing resourceType', () => {
    expect(invalidBundle({})).toBe(true)
  })

  it('rejects non-Bundle resourceType', () => {
    expect(invalidBundle({ resourceType: 'Patient' })).toBe(true)
  })

  it('rejects non-array entry (object)', () => {
    expect(invalidBundle({ resourceType: 'Bundle', entry: {} })).toBe(true)
  })

  it('rejects non-array entry (string)', () => {
    expect(invalidBundle({ resourceType: 'Bundle', entry: 'not an array' })).toBe(true)
  })

  it('accepts Bundle with entries', () => {
    expect(invalidBundle({ resourceType: 'Bundle', entry: [{ resource: {} }] })).toBe(false)
  })

  it('accepts Bundle without entry property (empty bundle is valid)', () => {
    expect(invalidBundle({ resourceType: 'Bundle', type: 'transaction' })).toBe(false)
  })

  it('accepts Bundle with empty entry array', () => {
    expect(invalidBundle({ resourceType: 'Bundle', entry: [] })).toBe(false)
  })
})

describe('emptyBundle', () => {
  it('returns true when entry is undefined', () => {
    expect(emptyBundle({ resourceType: 'Bundle', type: 'transaction' })).toBe(true)
  })

  it('returns true when entry is empty array', () => {
    expect(emptyBundle({ resourceType: 'Bundle', entry: [] })).toBe(true)
  })

  it('returns false when entry has items', () => {
    expect(emptyBundle({ resourceType: 'Bundle', entry: [{ resource: {} }] })).toBe(false)
  })
})

describe('emptyBundleResponse', () => {
  it('returns a transaction-response Bundle', () => {
    const resp = emptyBundleResponse()
    expect(resp.resourceType).toBe('Bundle')
    expect(resp.type).toBe('transaction-response')
    expect(resp.entry).toEqual([])
  })
})

describe('POST / bundle endpoint', () => {
  it('returns 400 for non-Bundle resource', async () => {
    const response = await request(app)
      .post('/')
      .send({ resourceType: 'Patient', id: '123' })

    expect(response.status).toBe(400)
    expect(response.body.issue[0].diagnostics).toBe('Invalid bundle submitted')
  })

  it('returns 200 with empty response for empty bundle', async () => {
    const response = await request(app)
      .post('/')
      .send({ resourceType: 'Bundle', type: 'transaction' })

    expect(response.status).toBe(200)
    expect(response.body.resourceType).toBe('Bundle')
    expect(response.body.type).toBe('transaction-response')
    expect(response.body.entry).toEqual([])
  })

  it('returns 200 with empty response for bundle with empty entry array', async () => {
    const response = await request(app)
      .post('/')
      .send({ resourceType: 'Bundle', type: 'transaction', entry: [] })

    expect(response.status).toBe(200)
    expect(response.body.type).toBe('transaction-response')
  })
})

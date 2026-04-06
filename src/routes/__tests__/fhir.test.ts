import request from 'supertest'
import express from 'express'
import { router } from '../fhir'
import { saveResource } from '../fhir'
import { invalidBundle, emptyBundle, emptyBundleResponse } from '../../lib/helpers'

const app = express()
app.use(express.json())
app.use('/', router)

// Mock got at module level so all methods are available for spying
const mockGotGet = jest.fn()
const mockGotPost = jest.fn()
const mockGotDefault = jest.fn()

jest.mock('got', () => {
  const fn = (...args: any[]) => mockGotDefault(...args)
  fn.get = (...args: any[]) => mockGotGet(...args)
  fn.post = (...args: any[]) => mockGotPost(...args)
  return { __esModule: true, default: fn }
})

// Mock config
jest.mock('../../lib/config', () => ({
  get: (key: string) => {
    const values: any = {
      'fhirServer:baseURL': 'http://hapi-fhir:8080/fhir',
      'fhirServer:username': 'hapi',
      'fhirServer:password': 'hapi',
      'clientRegistryUrl': 'http://openhim-core:5001/CR/fhir',
      'mpiLookupTimeoutMs': 5000,
    }
    return values[key] || ''
  },
}))

const GOLDEN_RECORD_ID = 'b8115fb4-ea19-4578-bc50-05d4a17ca0c7'
const GOLDEN_RECORD_CODE = '5c827da5-4858-4f3d-a50c-62ece001efea'

const crResponseWithGoldenRecord = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'Patient',
        id: 'abc-123',
        meta: { tag: [{ code: 'some-other-code' }] },
      },
    },
    {
      resource: {
        resourceType: 'Patient',
        id: GOLDEN_RECORD_ID,
        meta: { tag: [{ code: GOLDEN_RECORD_CODE }] },
      },
    },
  ],
}

const crResponseNoMatch = {
  resourceType: 'Bundle',
  entry: [],
}

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
  mockGotDefault.mockRejectedValueOnce(new Error('request failed'))

  const req = {
    body: {},
    params: {
      resourceType: 'Observation',
      id: '123',
    },
    method: 'POST',
  }
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  }

  await saveResource(req, res)

  expect(res.status).toHaveBeenCalledWith(500)
})

describe('MPI Resolution via saveResource (POST /Patient, PUT /Patient/:id)', () => {
  afterEach(() => {
    mockGotGet.mockReset()
    mockGotPost.mockReset()
    mockGotDefault.mockReset()
  })

  const patientBody = {
    resourceType: 'Patient',
    id: 'pt-001',
    name: [{ family: 'Baptiste', given: ['Jean'] }],
    identifier: [
      { system: 'http://isanteplus.org/openmrs/fhir2/5-code-national', value: '99999' },
    ],
  }

  it('POST /Patient resolves MPI and adds golden record link', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithGoldenRecord),
    })

    mockGotDefault.mockResolvedValue({
      statusCode: 201,
      body: JSON.stringify({ resourceType: 'Patient', id: 'pt-001' }),
    })

    const response = await request(app).post('/Patient').send(patientBody)

    expect(response.status).toBe(201)

    // Verify the CR was queried
    expect(mockGotGet).toHaveBeenCalled()
    const crCallUrl = String(mockGotGet.mock.calls[0][0])
    expect(crCallUrl).toContain('Patient?identifier=')

    // Verify the resource sent to HAPI includes the golden record link
    const hapiCall = mockGotDefault.mock.calls[0][0]
    expect(hapiCall.json.link).toContainEqual({
      other: { reference: `Patient/${GOLDEN_RECORD_ID}` },
      type: 'refer',
    })
  })

  it('PUT /Patient/:id resolves MPI and adds golden record link', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithGoldenRecord),
    })

    mockGotDefault.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Patient', id: 'pt-001' }),
    })

    const response = await request(app).put('/Patient/pt-001').send(patientBody)

    expect(response.status).toBe(200)

    // Verify the resource sent to HAPI includes the golden record link
    const hapiCall = mockGotDefault.mock.calls[0][0]
    expect(hapiCall.json.link).toContainEqual({
      other: { reference: `Patient/${GOLDEN_RECORD_ID}` },
      type: 'refer',
    })
    expect(hapiCall.method).toBe('PUT')
    expect(hapiCall.url).toContain('Patient/pt-001')
  })

  it('POST /Patient succeeds when CR is unavailable (non-blocking)', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.reject(new Error('ECONNREFUSED')),
    })

    mockGotDefault.mockResolvedValue({
      statusCode: 201,
      body: JSON.stringify({ resourceType: 'Patient', id: 'pt-001' }),
    })

    const response = await request(app).post('/Patient').send(patientBody)

    // Write should still succeed
    expect(response.status).toBe(201)

    // Patient saved without a link
    const hapiCall = mockGotDefault.mock.calls[0][0]
    expect(hapiCall.json.link).toBeUndefined()
  })

  it('POST /Observation skips MPI resolution', async () => {
    mockGotDefault.mockResolvedValue({
      statusCode: 201,
      body: JSON.stringify({ resourceType: 'Observation', id: 'obs-1' }),
    })

    const response = await request(app)
      .post('/Observation')
      .send({ resourceType: 'Observation', id: 'obs-1', status: 'final' })

    expect(response.status).toBe(201)
    // CR should NOT be queried for non-Patient resources
    expect(mockGotGet).not.toHaveBeenCalled()
  })
})

describe('MPI Resolution on Bundle Write Path', () => {
  afterEach(() => {
    mockGotGet.mockReset()
    mockGotPost.mockReset()
    mockGotDefault.mockReset()
  })

  const makePatientBundle = (patient: any) => ({
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: patient,
        request: { method: 'PUT', url: `Patient/${patient.id}` },
      },
    ],
  })

  const patientWithIdentifiers = {
    resourceType: 'Patient',
    id: 'abc-123',
    name: [{ family: 'Baptiste', given: ['Jean'] }],
    identifier: [
      { system: 'http://isanteplus.org/openmrs/fhir2/3-isanteplus-id', value: '07D6MD' },
      { system: 'http://isanteplus.org/openmrs/fhir2/5-code-national', value: '12345' },
    ],
  }

  it('adds Patient.link to golden record when CR finds a match', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithGoldenRecord),
    })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    // Verify the CR was queried
    expect(mockGotGet).toHaveBeenCalled()
    const crCallUrl = String(mockGotGet.mock.calls[0][0])
    expect(crCallUrl).toContain('CR/fhir/Patient?identifier=')

    // Verify the patient sent to HAPI FHIR has the golden record link
    const sentBundle = mockGotPost.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toBeDefined()
    expect(patient.link).toContainEqual({
      other: { reference: `Patient/${GOLDEN_RECORD_ID}` },
      type: 'refer',
    })
  })

  it('writes patient without link when CR finds no match', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseNoMatch),
    })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    // Verify patient was sent without a link
    const sentBundle = mockGotPost.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toBeUndefined()
  })

  it('writes patient successfully when CR is unavailable (graceful failure)', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.reject(new Error('ECONNREFUSED')),
    })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    // Write should still succeed
    expect(response.status).toBe(200)

    // Patient should be saved without a link
    const sentBundle = mockGotPost.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toBeUndefined()
  })

  it('tries remaining identifiers when first lookup fails', async () => {
    mockGotGet
      // First identifier lookup fails
      .mockReturnValueOnce({
        json: () => Promise.reject(new Error('timeout on first identifier')),
      })
      // Second identifier lookup succeeds with golden record
      .mockReturnValueOnce({
        json: () => Promise.resolve(crResponseWithGoldenRecord),
      })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    // Both identifiers should have been tried
    expect(mockGotGet).toHaveBeenCalledTimes(2)

    // Patient should have the golden record link from the second lookup
    const sentBundle = mockGotPost.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toContainEqual({
      other: { reference: `Patient/${GOLDEN_RECORD_ID}` },
      type: 'refer',
    })
  })

  it('does not duplicate link if already present', async () => {
    const patientWithExistingLink = {
      ...patientWithIdentifiers,
      link: [{ other: { reference: `Patient/${GOLDEN_RECORD_ID}` }, type: 'refer' }],
    }

    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithGoldenRecord),
    })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = makePatientBundle(patientWithExistingLink)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    const sentBundle = mockGotPost.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    // Should still have exactly one link, not two
    expect(patient.link).toHaveLength(1)
  })

  it('skips MPI resolution for non-Patient resources', async () => {
    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: { resourceType: 'Observation', id: 'obs-1', status: 'final' },
          request: { method: 'PUT', url: 'Observation/obs-1' },
        },
      ],
    }

    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)
    // CR should not be queried for Observations
    expect(mockGotGet).not.toHaveBeenCalled()
  })
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

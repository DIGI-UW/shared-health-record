import request from 'supertest'
import express from 'express'
import { router } from '../fhir'
import { saveResource } from '../fhir'
import { emptyBundle, emptyBundleResponse, invalidBundle } from '../../lib/helpers'

const app = express()
app.use(express.json())
app.use('/', router)

// Mock got at module level so all methods are available for spying
const mockGotGet = jest.fn()
const mockGotPost = jest.fn()
const mockGotPut = jest.fn()
const mockGotDefault = jest.fn()

jest.mock('got', () => {
  const fn = (...args: any[]) => mockGotDefault(...args)
  fn.get = (...args: any[]) => mockGotGet(...args)
  fn.post = (...args: any[]) => mockGotPost(...args)
  fn.put = (...args: any[]) => mockGotPut(...args)
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

describe('Reference Rewriting on Bundle Write Path', () => {
  afterEach(() => {
    mockGotGet.mockReset()
    mockGotPost.mockReset()
    mockGotPut.mockReset()
    mockGotDefault.mockReset()
  })

  const crResponseWithSources = {
    resourceType: 'Bundle',
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: 'source-hueh',
          name: [{ use: 'official', family: 'OJOK', given: ['OWITO'] }],
          gender: 'male',
          birthDate: '1997',
          meta: { tag: [{ code: 'hueh' }], lastUpdated: '2026-04-10T07:08:57Z' },
          identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/3-isanteplus-id', value: '03N3AN' }],
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

  it('rewrites clinical resource patient references to golden record ID', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithSources),
    })

    // Mock the golden record PUT (background update)
    mockGotPut.mockResolvedValue({ statusCode: 200, body: '{}' })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pt-facility-1',
            identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/5-code-national', value: '45678' }],
          },
          request: { method: 'PUT', url: 'Patient/pt-facility-1' },
        },
        {
          resource: {
            resourceType: 'AllergyIntolerance',
            id: 'allergy-1',
            patient: { reference: 'Patient/pt-facility-1' },
            code: { text: 'Penicillin' },
          },
          request: { method: 'PUT', url: 'AllergyIntolerance/allergy-1' },
        },
        {
          resource: {
            resourceType: 'Observation',
            id: 'obs-1',
            subject: { reference: 'Patient/pt-facility-1' },
            status: 'final',
          },
          request: { method: 'PUT', url: 'Observation/obs-1' },
        },
      ],
    }

    const response = await request(app).post('/').send(bundle)
    expect(response.status).toBe(200)

    const sentBundle = mockGotPost.mock.calls[0][1].json

    // Patient should have golden record link
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toContainEqual({
      other: { reference: `Patient/${GOLDEN_RECORD_ID}` },
      type: 'refer',
    })

    // AllergyIntolerance.patient should be rewritten to golden record
    const allergy = sentBundle.entry[1].resource
    expect(allergy.patient.reference).toBe(`Patient/${GOLDEN_RECORD_ID}`)

    // Observation.subject should be rewritten to golden record
    const obs = sentBundle.entry[2].resource
    expect(obs.subject.reference).toBe(`Patient/${GOLDEN_RECORD_ID}`)
  })

  it('rewrites nested patient references via recursive traversal', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithSources),
    })

    mockGotPut.mockResolvedValue({ statusCode: 200, body: '{}' })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pt-nested',
            identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/5-code-national', value: '99999' }],
          },
          request: { method: 'PUT', url: 'Patient/pt-nested' },
        },
        {
          resource: {
            resourceType: 'Encounter',
            id: 'enc-1',
            subject: { reference: 'Patient/pt-nested' },
            participant: [
              {
                individual: { reference: 'Practitioner/prac-1' },
              },
            ],
            serviceProvider: { reference: 'Organization/org-1' },
          },
          request: { method: 'PUT', url: 'Encounter/enc-1' },
        },
      ],
    }

    const response = await request(app).post('/').send(bundle)
    expect(response.status).toBe(200)

    const sentBundle = mockGotPost.mock.calls[0][1].json
    const encounter = sentBundle.entry[1].resource

    // subject should be rewritten
    expect(encounter.subject.reference).toBe(`Patient/${GOLDEN_RECORD_ID}`)
    // Practitioner reference should NOT be rewritten (not a Patient ref)
    expect(encounter.participant[0].individual.reference).toBe('Practitioner/prac-1')
  })

  it('does not rewrite references when no golden record is found', async () => {
    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseNoMatch),
    })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pt-no-match',
            identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/5-code-national', value: '00000' }],
          },
          request: { method: 'PUT', url: 'Patient/pt-no-match' },
        },
        {
          resource: {
            resourceType: 'AllergyIntolerance',
            id: 'allergy-2',
            patient: { reference: 'Patient/pt-no-match' },
          },
          request: { method: 'PUT', url: 'AllergyIntolerance/allergy-2' },
        },
      ],
    }

    const response = await request(app).post('/').send(bundle)
    expect(response.status).toBe(200)

    const sentBundle = mockGotPost.mock.calls[0][1].json
    const allergy = sentBundle.entry[1].resource

    // Reference should be unchanged
    expect(allergy.patient.reference).toBe('Patient/pt-no-match')
  })
})

describe('Golden Record Demographics Resolution', () => {
  afterEach(() => {
    mockGotGet.mockReset()
    mockGotPost.mockReset()
    mockGotPut.mockReset()
    mockGotDefault.mockReset()
  })

  it('updates golden record Patient in SHR with official name from CR sources', async () => {
    const crResponseWithMultipleNames = {
      resourceType: 'Bundle',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'source-1',
            name: [{ use: 'official', family: 'DOE', given: ['JOHN'] }],
            gender: 'male',
            birthDate: '1985',
            meta: { tag: [{ code: 'facility-a' }], lastUpdated: '2026-04-09T10:00:00Z' },
            identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/3-isanteplus-id', value: 'AAA' }],
          },
        },
        {
          resource: {
            resourceType: 'Patient',
            id: 'source-2',
            name: [{ use: 'official', family: 'KUNTA', given: ['SMITH'] }],
            gender: 'male',
            birthDate: '1985',
            meta: { tag: [{ code: 'facility-b' }], lastUpdated: '2026-04-10T12:00:00Z' },
            identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/3-isanteplus-id', value: 'BBB' }],
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

    mockGotGet.mockReturnValue({
      json: () => Promise.resolve(crResponseWithMultipleNames),
    })

    mockGotPut.mockResolvedValue({ statusCode: 200, body: '{}' })

    mockGotPost.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    })

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pt-test',
            identifier: [{ system: 'http://isanteplus.org/openmrs/fhir2/3-isanteplus-id', value: 'AAA' }],
          },
          request: { method: 'PUT', url: 'Patient/pt-test' },
        },
      ],
    }

    await request(app).post('/').send(bundle)

    // Wait briefly for background golden record update
    await new Promise(resolve => setTimeout(resolve, 100))

    // Verify golden record PUT was called
    expect(mockGotPut).toHaveBeenCalled()
    const putCall = mockGotPut.mock.calls[0]
    expect(putCall[0]).toContain(`Patient/${GOLDEN_RECORD_ID}`)

    const goldenPatient = putCall[1].json

    // Should have the official name from the MOST RECENT source (source-2, updated later)
    expect(goldenPatient.name[0].use).toBe('official')
    expect(goldenPatient.name[0].family).toBe('KUNTA')
    expect(goldenPatient.name[0].given).toEqual(['SMITH'])

    // Should also include the other name
    expect(goldenPatient.name.length).toBe(2)

    // Identifiers should be merged from both sources
    expect(goldenPatient.identifier.length).toBe(2)
    expect(goldenPatient.identifier.map((i: any) => i.value).sort()).toEqual(['AAA', 'BBB'])
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

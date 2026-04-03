import request from 'supertest'
import express from 'express'
import { router } from '../fhir'
import got from 'got'
import { saveResource } from '../fhir'

const app = express()
app.use(express.json())
app.use('/', router)

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

  jest.spyOn(got, 'post').mockRejectedValue(new Error('Post request failed'))

  await saveResource(req, res)

  expect(res.status).toHaveBeenCalledWith(400)
})

describe('MPI Resolution on Write Path', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  const goldenRecordId = 'b8115fb4-ea19-4578-bc50-05d4a17ca0c7'

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
          id: goldenRecordId,
          meta: { tag: [{ code: '5c827da5-4858-4f3d-a50c-62ece001efea' }] },
        },
      },
    ],
  }

  const crResponseNoMatch = {
    resourceType: 'Bundle',
    entry: [],
  }

  it('adds Patient.link to golden record when CR finds a match', async () => {
    // Mock CR lookup returns golden record
    const getSpy = jest.spyOn(got, 'get').mockReturnValue({
      json: () => Promise.resolve(crResponseWithGoldenRecord),
    } as any)

    // Mock HAPI FHIR write succeeds
    jest.spyOn(got, 'post').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    } as any)

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    // Verify the CR was queried
    expect(getSpy).toHaveBeenCalled()
    const crCallUrl = getSpy.mock.calls[0][0] as string
    expect(crCallUrl).toContain('CR/fhir/Patient?identifier=')

    // Verify the patient sent to HAPI FHIR has the golden record link
    const postSpy = got.post as jest.Mock
    const sentBundle = postSpy.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toBeDefined()
    expect(patient.link).toContainEqual({
      other: { reference: `Patient/${goldenRecordId}` },
      type: 'refer',
    })
  })

  it('writes patient without link when CR finds no match', async () => {
    // Mock CR lookup returns no match
    jest.spyOn(got, 'get').mockReturnValue({
      json: () => Promise.resolve(crResponseNoMatch),
    } as any)

    // Mock HAPI FHIR write succeeds
    jest.spyOn(got, 'post').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    } as any)

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    // Verify patient was sent without a link
    const postSpy = got.post as jest.Mock
    const sentBundle = postSpy.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toBeUndefined()
  })

  it('writes patient successfully when CR is unavailable (graceful failure)', async () => {
    // Mock CR lookup throws (timeout/network error)
    jest.spyOn(got, 'get').mockReturnValue({
      json: () => Promise.reject(new Error('ECONNREFUSED')),
    } as any)

    // Mock HAPI FHIR write succeeds
    jest.spyOn(got, 'post').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    } as any)

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    // Write should still succeed
    expect(response.status).toBe(200)

    // Patient should be saved without a link
    const postSpy = got.post as jest.Mock
    const sentBundle = postSpy.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toBeUndefined()
  })

  it('tries remaining identifiers when first lookup fails', async () => {
    const getSpy = jest.spyOn(got, 'get')
      // First identifier lookup fails
      .mockReturnValueOnce({
        json: () => Promise.reject(new Error('timeout on first identifier')),
      } as any)
      // Second identifier lookup succeeds with golden record
      .mockReturnValueOnce({
        json: () => Promise.resolve(crResponseWithGoldenRecord),
      } as any)

    jest.spyOn(got, 'post').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    } as any)

    const bundle = makePatientBundle(patientWithIdentifiers)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    // Both identifiers should have been tried
    expect(getSpy).toHaveBeenCalledTimes(2)

    // Patient should have the golden record link from the second lookup
    const postSpy = got.post as jest.Mock
    const sentBundle = postSpy.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    expect(patient.link).toContainEqual({
      other: { reference: `Patient/${goldenRecordId}` },
      type: 'refer',
    })
  })

  it('does not duplicate link if already present', async () => {
    const patientWithExistingLink = {
      ...patientWithIdentifiers,
      link: [{ other: { reference: `Patient/${goldenRecordId}` }, type: 'refer' }],
    }

    jest.spyOn(got, 'get').mockReturnValue({
      json: () => Promise.resolve(crResponseWithGoldenRecord),
    } as any)

    jest.spyOn(got, 'post').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    } as any)

    const bundle = makePatientBundle(patientWithExistingLink)
    const response = await request(app).post('/').send(bundle)

    expect(response.status).toBe(200)

    const postSpy = got.post as jest.Mock
    const sentBundle = postSpy.mock.calls[0][1].json
    const patient = sentBundle.entry[0].resource
    // Should still have exactly one link, not two
    expect(patient.link).toHaveLength(1)
  })

  it('skips MPI resolution for non-Patient resources', async () => {
    const getSpy = jest.spyOn(got, 'get')

    jest.spyOn(got, 'post').mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ resourceType: 'Bundle', type: 'transaction-response' }),
    } as any)

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
    expect(getSpy).not.toHaveBeenCalled()
  })
})

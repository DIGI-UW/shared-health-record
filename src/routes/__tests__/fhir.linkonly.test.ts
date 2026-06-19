import request from 'supertest'
import express from 'express'

// got mock (all methods spyable)
const mockGotGet = jest.fn()
const mockGotPost = jest.fn()
const mockGotPut = jest.fn()
const mockGotDefault = jest.fn()
jest.mock('got', () => {
  const fn = (...a: any[]) => mockGotDefault(...a)
  fn.get = (...a: any[]) => mockGotGet(...a)
  fn.post = (...a: any[]) => mockGotPost(...a)
  fn.put = (...a: any[]) => mockGotPut(...a)
  return { __esModule: true, default: fn }
})

// config with link-only ON
jest.mock('../../lib/config', () => ({
  get: (key: string) =>
    (({
      'fhirServer:baseURL': 'http://hapi-fhir:8080/fhir',
      clientRegistryUrl: 'http://openhim-core:5001/CR/fhir',
      mpiLookupTimeoutMs: 5000,
      mpiLinkOnly: true,
    } as any)[key] || ''),
}))

import { router, stripDemographics } from '../fhir'

const app = express()
app.use(express.json())
app.use('/', router)

const GOLD = 'gold-1'
const GOLDEN_RECORD_CODE = '5c827da5-4858-4f3d-a50c-62ece001efea'
const crWithGolden = {
  resourceType: 'Bundle',
  entry: [{ resource: { resourceType: 'Patient', id: GOLD, meta: { tag: [{ code: GOLDEN_RECORD_CODE }] } } }],
}

beforeEach(() => {
  ;[mockGotGet, mockGotPost, mockGotPut, mockGotDefault].forEach(m => m.mockReset())
})

describe('stripDemographics', () => {
  it('keeps id/identifier/link/meta and drops all demographics', () => {
    const out: any = stripDemographics({
      resourceType: 'Patient',
      id: 'p1',
      name: [{ family: 'X' }],
      gender: 'male',
      birthDate: '2000-01-01',
      address: [{ city: 'PaP' }],
      telecom: [{ value: '123' }],
      identifier: [{ system: 's', value: 'v' }],
      link: [{ type: 'refer', other: { reference: 'Patient/g' } }],
    } as any)
    expect(out).toEqual({
      resourceType: 'Patient',
      id: 'p1',
      active: true,
      identifier: [{ system: 's', value: 'v' }],
      link: [{ type: 'refer', other: { reference: 'Patient/g' } }],
    })
    expect(out.name).toBeUndefined()
    expect(out.gender).toBeUndefined()
    expect(out.address).toBeUndefined()
  })
})

describe('link-only enrichment (mpiLinkOnly=true)', () => {
  it('stores a stripped+linked Patient stub, leaves clinical on the site id, no golden write', async () => {
    mockGotGet.mockReturnValue({ json: () => Promise.resolve(crWithGolden) })
    mockGotPost.mockResolvedValue({ statusCode: 201, body: JSON.stringify({ resourceType: 'Bundle' }) })

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: {
            resourceType: 'Patient',
            id: 'pt-001',
            name: [{ family: 'Baptiste', given: ['Jean'] }],
            gender: 'male',
            identifier: [{ system: 'http://sedish-haiti.org/fhir/source-key', value: '21100-1' }],
          },
        },
        {
          resource: {
            resourceType: 'Observation',
            id: 'o1',
            status: 'final',
            code: { text: 'x' },
            subject: { reference: 'Patient/pt-001' },
          },
        },
      ],
    }

    const res = await request(app).post('/').send(bundle)
    expect(res.status).toBe(201)
    expect(mockGotPost).toHaveBeenCalled()

    const sent = mockGotPost.mock.calls[0][1].json // got.post(uri, { json: <enriched bundle> })
    const pat = sent.entry.find((e: any) => e.resource.resourceType === 'Patient').resource
    const obs = sent.entry.find((e: any) => e.resource.resourceType === 'Observation').resource

    // stub: demographics stripped, golden link present, identifier kept
    expect(pat.name).toBeUndefined()
    expect(pat.gender).toBeUndefined()
    expect(pat.link).toContainEqual({ other: { reference: `Patient/${GOLD}` }, type: 'refer' })
    expect(pat.identifier).toBeDefined()

    // clinical untouched — stays on the site id, NOT rewritten to the golden
    expect(obs.subject.reference).toBe('Patient/pt-001')

    // no golden-record demographics written to the SHR
    expect(mockGotPut).not.toHaveBeenCalled()
  })
})

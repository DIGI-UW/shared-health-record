const GOLDEN_TAG = '5c827da5-4858-4f3d-a50c-62ece001efea'
const FPNID_SYSTEM = 'http://isanteplus.org/openmrs/fhir2/6-biometrics-national-reference-code'
const SOURCE_KEY_SYSTEM = 'http://sedish-haiti.org/fhir/source-key'

const golden = {
  resourceType: 'Patient',
  id: 'golden-1',
  meta: { tag: [{ code: GOLDEN_TAG }] },
  link: [{ type: 'seealso', other: { reference: 'Patient/src-1' } }],
}
const source = {
  resourceType: 'Patient',
  id: 'src-1',
  identifier: [{ system: FPNID_SYSTEM, value: 'HT-0001' }],
}

// mpiSearch calls got.get(url, opts).json(); capture the url so we can assert the query system.
const mockGotGet = jest.fn()
jest.mock('got', () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockGotGet(...args) },
}))

// Isolate the route from the (heavy) IPS assembler while keeping the real GOLDEN_RECORD_TAG.
jest.mock('../../workflows/ipsWorkflows', () => {
  const actual = jest.requireActual('../../workflows/ipsWorkflows')
  return {
    ...actual,
    generateConsolidatedIpsBundle: jest.fn(async () => ({
      resourceType: 'Bundle',
      type: 'document',
      id: 'ips-1',
    })),
  }
})

import request from 'supertest'
import express from 'express'
import { router } from '../ips'
import { generateConsolidatedIpsBundle } from '../../workflows/ipsWorkflows'

const app = express()
app.use('/', router)

describe('IPS Routes', () => {
  it.skip('should return 200 OK for GET /metadata', async () => {
    const response = await request(app).get('/metadata')
    expect(response.status).toBe(200)
  })
})

describe('IPS fpnid retrieval', () => {
  beforeEach(() => {
    mockGotGet.mockReset()
    ;(generateConsolidatedIpsBundle as jest.Mock).mockClear()
  })

  it('resolves an fpnid to the golden record and returns a consolidated IPS (200)', async () => {
    mockGotGet.mockImplementation((url: string) => ({
      json: async () => {
        // fpnid lookup: OpenCR returns the source carrying the fpnid + its golden (via _include)
        if (url.includes('identifier=')) {
          return { entry: [{ resource: source }, { resource: golden }] }
        }
        // re-query by golden id: golden + all linked sources
        if (url.includes('_id=golden-1')) {
          return { entry: [{ resource: golden }, { resource: source }] }
        }
        return { entry: [] }
      },
    }))

    const res = await request(app).get('/Patient/fpnid/HT-0001')

    expect(res.status).toBe(200)
    expect(res.body.id).toBe('ips-1')
    // the identifier query must have used the fpnid system, not the source-key system.
    // Assert on the exact `identifier=` query-param value rather than a loose URL substring.
    const identifierArg = mockGotGet.mock.calls
      .map(c => String(c[0]).split('identifier=')[1]?.split('&')[0])
      .find(Boolean)
    expect(identifierArg).toBe(`${FPNID_SYSTEM}|HT-0001`)
    expect(generateConsolidatedIpsBundle).toHaveBeenCalled()
  })

  it('returns 404 when no golden record resolves for the fpnid', async () => {
    mockGotGet.mockImplementation(() => ({ json: async () => ({ entry: [] }) }))

    const res = await request(app).get('/Patient/fpnid/UNKNOWN')

    expect(res.status).toBe(404)
    expect(generateConsolidatedIpsBundle).not.toHaveBeenCalled()
  })
})

describe('IPS source-key retrieval', () => {
  const skSource = {
    resourceType: 'Patient',
    id: 'src-2',
    identifier: [{ system: SOURCE_KEY_SYSTEM, value: '73106-3' }],
  }

  beforeEach(() => {
    mockGotGet.mockReset()
    ;(generateConsolidatedIpsBundle as jest.Mock).mockClear()
  })

  it('resolves a source-key to the golden record and returns a consolidated IPS (200)', async () => {
    mockGotGet.mockImplementation((url: string) => ({
      json: async () => {
        // source-key lookup: OpenCR returns the source carrying the key + its golden (via _include)
        if (url.includes('identifier=')) {
          return { entry: [{ resource: skSource }, { resource: golden }] }
        }
        // re-query by golden id: golden + all linked sources
        if (url.includes('_id=golden-1')) {
          return { entry: [{ resource: golden }, { resource: skSource }] }
        }
        return { entry: [] }
      },
    }))

    const res = await request(app).get('/Patient/source-key/73106-3')

    expect(res.status).toBe(200)
    expect(res.body.id).toBe('ips-1')
    // the identifier query must have used the source-key system, keyed on the nationally-unique key
    const identifierArg = mockGotGet.mock.calls
      .map(c => String(c[0]).split('identifier=')[1]?.split('&')[0])
      .find(Boolean)
    expect(identifierArg).toBe(`${SOURCE_KEY_SYSTEM}|73106-3`)
    expect(generateConsolidatedIpsBundle).toHaveBeenCalled()
  })

  it('returns 404 when no golden record resolves for the source-key', async () => {
    mockGotGet.mockImplementation(() => ({ json: async () => ({ entry: [] }) }))

    const res = await request(app).get('/Patient/source-key/99999-1')

    expect(res.status).toBe(404)
    expect(generateConsolidatedIpsBundle).not.toHaveBeenCalled()
  })
})

import { generateIpsbundle, generateSimpleIpsBundle } from '../ipsWorkflows'
import { R4 } from '@ahryman40k/ts-fhir-types'

// Mock got for generateSimpleIpsBundle
const mockGotGet = jest.fn()
jest.mock('got', () => {
  const fn = (...args: any[]) => mockGotGet(...args)
  fn.get = (...args: any[]) => mockGotGet(...args)
  return { __esModule: true, default: fn }
})

// Mock config
jest.mock('../../lib/config', () => ({
  get: (key: string) => {
    const values: any = {
      'fhirServer:baseURL': 'http://hapi-fhir:8080/fhir',
      'fhirServer:username': 'hapi',
      'fhirServer:password': 'hapi',
    }
    return values[key] || ''
  },
}))

// Silence winston output for error paths exercised by these tests
jest.mock('../../lib/winston', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

beforeEach(() => {
  mockGotGet.mockReset()
})

// --- Test data ---

const patient1: R4.IPatient = {
  resourceType: 'Patient',
  id: 'pt-001',
  name: [{ family: 'Doe', given: ['John'] }],
  identifier: [
    { system: 'http://example.org/ids', value: 'ID-001' },
  ],
}

const patient2: R4.IPatient = {
  resourceType: 'Patient',
  id: 'pt-002',
  name: [{ family: 'Doe', given: ['Jane'] }],
  identifier: [
    { system: 'http://example.org/ids', value: 'ID-002' },
  ],
}

const encounter1: R4.IEncounter = {
  resourceType: 'Encounter',
  id: 'enc-001',
  status: R4.EncounterStatusKind._finished,
  class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
}

const observation1: R4.IObservation = {
  resourceType: 'Observation',
  id: 'obs-001',
  status: R4.ObservationStatusKind._final,
  code: { text: 'Blood Pressure' },
}

// --- generateIpsbundle ---

describe('generateIpsbundle', () => {
  it('returns a document bundle with patients, encounters, and observations', async () => {
    const mockClient = {
      request: jest.fn()
        .mockResolvedValueOnce([patient1])
        .mockResolvedValueOnce([encounter1])
        .mockResolvedValueOnce([observation1]),
    }

    const result = await generateIpsbundle(
      [patient1],
      mockClient as any,
      '2026-01-01',
      'http://example.org/ids',
    )

    expect(result.resourceType).toBe('Bundle')
    expect(result.type).toBe(R4.BundleTypeKind._document)
    expect(result.entry).toBeDefined()
    expect(result.entry!.length).toBe(4) // Composition + 1 Patient + 1 Encounter + 1 Observation

    const composition = result.entry![0] as R4.IComposition
    expect(composition.resourceType).toBe('Composition')
    expect(composition.type!.coding![0].code).toBe('60591-5')
    expect(composition.section).toHaveLength(3)
    expect(composition.section![0].title).toBe('Patient Records')
    expect(composition.section![0].entry).toHaveLength(1)
    expect(composition.section![0].entry![0].reference).toBe('Patient/pt-001')
    expect(composition.section![1].title).toBe('Encounters')
    expect(composition.section![1].entry).toHaveLength(1)
    expect(composition.section![1].entry![0].reference).toBe('Encounter/enc-001')
    expect(composition.section![2].title).toBe('Observations')
    expect(composition.section![2].entry).toHaveLength(1)
    expect(composition.section![2].entry![0].reference).toBe('Observation/obs-001')
  })

  it('filters patients by identifier system and only queries matching IDs', async () => {
    const patientNoMatch: R4.IPatient = {
      resourceType: 'Patient',
      id: 'pt-no-match',
      identifier: [{ system: 'http://other-system.org/ids', value: 'OTHER' }],
    }

    const mockClient = {
      request: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    }

    await generateIpsbundle(
      [patientNoMatch],
      mockClient as any,
      '2026-01-01',
      'http://example.org/ids',
    )

    // Patient query should be called with empty ID list since no identifier matches the system
    const patientQuery = mockClient.request.mock.calls[0][0]
    expect(patientQuery).toBe('Patient?_id=')
  })

  it('returns bundle with empty sections when SHR has no data', async () => {
    const mockClient = {
      request: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    }

    const result = await generateIpsbundle(
      [patient1],
      mockClient as any,
      '2026-01-01',
      'http://example.org/ids',
    )

    expect(result.type).toBe(R4.BundleTypeKind._document)
    const composition = result.entry![0] as R4.IComposition
    expect(composition.section![0].entry).toHaveLength(0)
    expect(composition.section![1].entry).toHaveLength(0)
    expect(composition.section![2].entry).toHaveLength(0)
    // Bundle has only the Composition since there's no data
    expect(result.entry!.length).toBe(1)
  })

  it('includes multiple patients when multiple identifiers match', async () => {
    const mockClient = {
      request: jest.fn()
        .mockResolvedValueOnce([patient1, patient2])
        .mockResolvedValueOnce([encounter1])
        .mockResolvedValueOnce([]),
    }

    const result = await generateIpsbundle(
      [patient1, patient2],
      mockClient as any,
      '2026-01-01',
      'http://example.org/ids',
    )

    const composition = result.entry![0] as R4.IComposition
    expect(composition.section![0].entry).toHaveLength(2)
    expect(result.entry!.length).toBe(4) // Composition + 2 patients + 1 encounter
  })

  it('passes lastUpdated parameter in queries', async () => {
    const mockClient = {
      request: jest.fn()
        .mockResolvedValueOnce([patient1])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    }

    await generateIpsbundle(
      [patient1],
      mockClient as any,
      '2026-03-15',
      'http://example.org/ids',
    )

    // Encounter and Observation queries should include _lastUpdated
    const encounterQuery = mockClient.request.mock.calls[1][0]
    expect(encounterQuery).toContain('_lastUpdated=2026-03-15')
    const obsQuery = mockClient.request.mock.calls[2][0]
    expect(obsQuery).toContain('_lastUpdated=2026-03-15')
  })
})

// --- generateSimpleIpsBundle ---

describe('generateSimpleIpsBundle', () => {
  const makeFhirSearchResponse = (entries: any[]) => ({
    resourceType: 'Bundle',
    type: 'searchset',
    entry: entries.map(r => ({ resource: r })),
  })

  // BUG: generateSimpleIpsBundle initializes ipsSections with 'DiagnosticResult' (typo)
  // but later maps ipsSections['DiagnosticReport']. When no DiagnosticReport resources
  // are returned, that key is never created, Composition creation throws, and the
  // function returns an empty bundle. This test documents the current behavior. See issue #132.
  it('returns empty bundle when no DiagnosticReport resources are returned due to DiagnosticResult/DiagnosticReport typo bug', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1, encounter1, observation1])),
    })

    const result = await generateSimpleIpsBundle('pt-001')

    expect(result.resourceType).toBe('Bundle')
    // Bug causes entry to be undefined instead of populated
    expect(result.entry).toBeUndefined()
  })

  it('queries HAPI FHIR with _id, _include, and _revinclude', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1])),
    })

    await generateSimpleIpsBundle('pt-001')

    expect(mockGotGet).toHaveBeenCalledTimes(1)
    const url = mockGotGet.mock.calls[0][0]
    expect(url).toContain('Patient?_id=pt-001')
    expect(url).toContain('_include=*')
    expect(url).toContain('_revinclude=*')
  })

  it('groups resources by type into correct sections', async () => {
    const serviceRequest = { resourceType: 'ServiceRequest', id: 'sr-001' }
    const diagnosticReport = { resourceType: 'DiagnosticReport', id: 'dr-001' }

    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([
        patient1, encounter1, observation1, serviceRequest, diagnosticReport,
      ])),
    })

    const result = await generateSimpleIpsBundle('pt-001')

    const composition = result.entry![0] as R4.IComposition
    const encounterSection = composition.section!.find(s => s.title === 'Encounters')
    expect(encounterSection!.entry).toHaveLength(1)
    expect(encounterSection!.entry![0].reference).toBe('Encounter/enc-001')

    const srSection = composition.section!.find(s => s.title === 'Service Requests')
    expect(srSection!.entry).toHaveLength(1)

    const drSection = composition.section!.find(s => s.title === 'Diagnostic Reports')
    expect(drSection!.entry).toHaveLength(1)

    const obsSection = composition.section!.find(s => s.title === 'Observations')
    expect(obsSection!.entry).toHaveLength(1)
  })

  it('returns empty bundle when patient not found', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([])),
    })

    const result = await generateSimpleIpsBundle('pt-nonexistent')

    expect(result.resourceType).toBe('Bundle')
    // No Composition generated because no patient found
    expect(result.entry).toBeUndefined()
  })

  it('returns empty bundle on HAPI FHIR error', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.reject(new Error('connection refused')),
    })

    const result = await generateSimpleIpsBundle('pt-001')

    expect(result.resourceType).toBe('Bundle')
    expect(result.entry).toBeUndefined()
  })

  it('only generates IPS when exactly one patient is returned', async () => {
    // When _revinclude returns multiple patients (linked via references),
    // generateSimpleIpsBundle expects exactly 1 patient
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1, patient2])),
    })

    const result = await generateSimpleIpsBundle('pt-001')

    // With 2 patients, it logs error and returns empty bundle
    expect(result.entry).toBeUndefined()
  })

  // Returns an empty bundle for this patient + encounter-only search result
  it('returns empty bundle with patient + encounter only', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1, encounter1])),
    })

    const result = await generateSimpleIpsBundle('pt-001')

    expect(result.resourceType).toBe('Bundle')
    expect(result.entry).toBeUndefined()
  })
})

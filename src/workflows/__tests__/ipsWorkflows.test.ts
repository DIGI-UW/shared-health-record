import { generateIpsbundle, generateCrossFacilityIpsBundle } from '../ipsWorkflows'
import { R4 } from '@ahryman40k/ts-fhir-types'

// Mock got for generateCrossFacilityIpsBundle
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

// --- generateCrossFacilityIpsBundle ---

describe('generateCrossFacilityIpsBundle', () => {
  const makeFhirSearchResponse = (entries: any[], nextUrl?: string): R4.IBundle => {
    const bundle: R4.IBundle = {
      resourceType: 'Bundle',
      type: R4.BundleTypeKind._searchset,
      entry: entries.map(r => ({ resource: r })),
    }
    if (nextUrl) {
      bundle.link = [{ relation: 'next', url: nextUrl }]
    }
    return bundle
  }

  it('queries HAPI FHIR with _id, _include, _revinclude, and _count', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1])),
    })

    await generateCrossFacilityIpsBundle(['pt-001'])

    expect(mockGotGet).toHaveBeenCalledTimes(1)
    const url = mockGotGet.mock.calls[0][0]
    expect(url).toContain('Patient?_id=pt-001')
    expect(url).toContain('_include=*')
    expect(url).toContain('_revinclude=*')
    expect(url).toContain('_count=200')
  })

  it('groups resources by type into correct sections (including DiagnosticReport)', async () => {
    const serviceRequest = { resourceType: 'ServiceRequest', id: 'sr-001' }
    const diagnosticReport = { resourceType: 'DiagnosticReport', id: 'dr-001' }
    const allergy = { resourceType: 'AllergyIntolerance', id: 'al-001' }
    const condition = { resourceType: 'Condition', id: 'cd-001' }
    const medRequest = { resourceType: 'MedicationRequest', id: 'mr-001' }

    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([
        patient1, encounter1, observation1, serviceRequest, diagnosticReport,
        allergy, condition, medRequest,
      ])),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-001'])

    const composition = result.entry![0] as R4.IComposition
    const sectionBy = (title: string) => composition.section!.find(s => s.title === title)
    expect(sectionBy('Encounters')!.entry![0].reference).toBe('Encounter/enc-001')
    expect(sectionBy('Service Requests')!.entry![0].reference).toBe('ServiceRequest/sr-001')
    // Typo fix verification — DiagnosticReport key now populated correctly
    expect(sectionBy('Diagnostic Reports')!.entry![0].reference).toBe('DiagnosticReport/dr-001')
    expect(sectionBy('Observations')!.entry![0].reference).toBe('Observation/obs-001')
    expect(sectionBy('Allergies and Intolerances')!.entry![0].reference).toBe('AllergyIntolerance/al-001')
    expect(sectionBy('Problem List')!.entry![0].reference).toBe('Condition/cd-001')
    expect(sectionBy('Medication Summary')!.entry![0].reference).toBe('MedicationRequest/mr-001')
  })

  it('populates a Diagnostic Reports section even when no DiagnosticReport resources are returned', async () => {
    // Regression guard for the old DiagnosticResult/DiagnosticReport typo: the
    // rewritten function must not throw when no DiagnosticReport resources come back.
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1, encounter1, observation1])),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-001'])

    expect(result.entry).toBeDefined()
    const composition = result.entry![0] as R4.IComposition
    const drSection = composition.section!.find(s => s.title === 'Diagnostic Reports')
    expect(drSection).toBeDefined()
    expect(drSection!.entry).toHaveLength(0)
  })

  it('returns empty bundle when no patients are returned', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([])),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-nonexistent'])

    expect(result.resourceType).toBe('Bundle')
    // No primaryPatient, so no Composition is produced
    expect(result.entry).toBeUndefined()
  })

  it('returns empty bundle when the HAPI request fails', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.reject(new Error('connection refused')),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-001'])

    expect(result.resourceType).toBe('Bundle')
    expect(result.entry).toBeUndefined()
  })

  it('aggregates resources across multiple linked patient IDs', async () => {
    const observation2: R4.IObservation = {
      resourceType: 'Observation',
      id: 'obs-002',
      status: R4.ObservationStatusKind._final,
      code: { text: 'Heart Rate' },
    }

    mockGotGet.mockImplementation((url: string) => ({
      json: () => {
        if (url.includes('_id=pt-001')) {
          return Promise.resolve(makeFhirSearchResponse([patient1, observation1]))
        }
        if (url.includes('_id=pt-002')) {
          return Promise.resolve(makeFhirSearchResponse([patient2, observation2]))
        }
        return Promise.resolve(makeFhirSearchResponse([]))
      },
    }))

    const result = await generateCrossFacilityIpsBundle(['pt-001', 'pt-002'])

    expect(mockGotGet).toHaveBeenCalledTimes(2)
    const composition = result.entry![0] as R4.IComposition
    const patientSection = composition.section!.find(s => s.title === 'Patient Records')
    const obsSection = composition.section!.find(s => s.title === 'Observations')
    expect(patientSection!.entry).toHaveLength(2)
    expect(obsSection!.entry).toHaveLength(2)
  })

  it('deduplicates resources that appear in results for multiple patient IDs', async () => {
    // Same observation returned for both patient fetches — should appear once.
    mockGotGet.mockImplementation((url: string) => ({
      json: () => {
        if (url.includes('_id=pt-001')) {
          return Promise.resolve(makeFhirSearchResponse([patient1, observation1]))
        }
        if (url.includes('_id=pt-002')) {
          return Promise.resolve(makeFhirSearchResponse([patient2, observation1]))
        }
        return Promise.resolve(makeFhirSearchResponse([]))
      },
    }))

    const result = await generateCrossFacilityIpsBundle(['pt-001', 'pt-002'])

    const composition = result.entry![0] as R4.IComposition
    const obsSection = composition.section!.find(s => s.title === 'Observations')
    expect(obsSection!.entry).toHaveLength(1)
    expect(obsSection!.entry![0].reference).toBe('Observation/obs-001')
  })

  it('uses the golden record patient as Composition.subject when provided', async () => {
    const goldenPatient: R4.IPatient = {
      resourceType: 'Patient',
      id: 'gr-001',
      name: [{ family: 'Golden', given: ['Record'] }],
    }

    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1, goldenPatient, observation1])),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-001'], 'gr-001')

    const composition = result.entry![0] as R4.IComposition
    expect(composition.subject!.reference).toBe('Patient/gr-001')
  })

  it('follows pagination via the bundle "next" link', async () => {
    const nextPageUrl = 'http://hapi-fhir:8080/fhir?_getpages=xyz&_count=200'
    mockGotGet
      .mockReturnValueOnce({
        json: () => Promise.resolve(makeFhirSearchResponse([patient1], nextPageUrl)),
      })
      .mockReturnValueOnce({
        json: () => Promise.resolve(makeFhirSearchResponse([observation1])),
      })

    const result = await generateCrossFacilityIpsBundle(['pt-001'])

    expect(mockGotGet).toHaveBeenCalledTimes(2)
    expect(mockGotGet.mock.calls[1][0]).toBe(nextPageUrl)
    const composition = result.entry![0] as R4.IComposition
    const obsSection = composition.section!.find(s => s.title === 'Observations')
    expect(obsSection!.entry).toHaveLength(1)
  })
})

// --- IPS Composition profile conformance ---

describe('IPS Composition required fields (issue #132)', () => {
  const makeFhirSearchResponse = (entries: any[]): R4.IBundle => ({
    resourceType: 'Bundle',
    type: R4.BundleTypeKind._searchset,
    entry: entries.map(r => ({ resource: r })),
  })

  const assertCompositionMetadata = (composition: R4.IComposition) => {
    expect(composition.status).toBe(R4.CompositionStatusKind._final)
    expect(composition.title).toBe('International Patient Summary')
    expect(composition.date).toBeDefined()
    // date must be a valid ISO-8601 timestamp
    expect(Number.isNaN(Date.parse(composition.date!))).toBe(false)
    // LOINC 60591-5 (Patient summary Document) still set on .type
    expect(composition.type!.coding![0].code).toBe('60591-5')
  }

  const assertSectionConformance = (
    section: NonNullable<R4.IComposition['section']>[number],
    expectedLoincCode?: string,
  ) => {
    // section.code is 1..1 in the IPS profile
    expect(section.code).toBeDefined()
    expect(section.code!.coding).toBeDefined()
    expect(section.code!.coding!.length).toBeGreaterThan(0)
    if (expectedLoincCode) {
      const loinc = section.code!.coding!.find(c => c.system === 'http://loinc.org')
      expect(loinc).toBeDefined()
      expect(loinc!.code).toBe(expectedLoincCode)
    }

    // section.text (narrative) is 1..1 in the IPS profile
    expect(section.text).toBeDefined()
    expect(section.text!.status).toBe(R4.NarrativeStatusKind._generated)
    expect(section.text!.div).toMatch(/^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/)

    // emptyReason is required when there are no entries
    if (!section.entry || section.entry.length === 0) {
      expect(section.emptyReason).toBeDefined()
      expect(section.emptyReason!.coding![0].system).toBe(
        'http://terminology.hl7.org/CodeSystem/list-empty-reason',
      )
    } else {
      expect(section.emptyReason).toBeUndefined()
    }
  }

  it('generateIpsbundle: Composition has status, date, title and IPS-conformant sections', async () => {
    const mockClient = {
      request: jest.fn()
        .mockResolvedValueOnce([patient1])
        .mockResolvedValueOnce([encounter1])
        .mockResolvedValueOnce([]),
    }

    const result = await generateIpsbundle(
      [patient1],
      mockClient as any,
      '2026-01-01',
      'http://example.org/ids',
    )

    const composition = result.entry![0] as R4.IComposition
    assertCompositionMetadata(composition)

    const sectionBy = (title: string) => composition.section!.find(s => s.title === title)!
    assertSectionConformance(sectionBy('Patient Records'))
    assertSectionConformance(sectionBy('Encounters'), '46240-8')
    // Observations is empty here → must carry emptyReason
    assertSectionConformance(sectionBy('Observations'))
  })

  it('generateCrossFacilityIpsBundle: Composition has status, date, title and IPS-conformant sections', async () => {
    const allergy = { resourceType: 'AllergyIntolerance', id: 'al-001' }
    const condition = { resourceType: 'Condition', id: 'cd-001' }
    const medRequest = { resourceType: 'MedicationRequest', id: 'mr-001' }
    const immunization = { resourceType: 'Immunization', id: 'im-001' }
    const procedure = { resourceType: 'Procedure', id: 'pr-001' }

    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([
        patient1, encounter1, observation1,
        allergy, condition, medRequest, immunization, procedure,
      ])),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-001'])
    const composition = result.entry![0] as R4.IComposition
    assertCompositionMetadata(composition)

    const sectionBy = (title: string) => composition.section!.find(s => s.title === title)!
    // Required IPS sections must carry the IG-specified LOINC codes
    assertSectionConformance(sectionBy('Allergies and Intolerances'), '48765-2')
    assertSectionConformance(sectionBy('Problem List'), '11450-4')
    assertSectionConformance(sectionBy('Medication Summary'), '10160-0')
    assertSectionConformance(sectionBy('Immunizations'), '11369-6')
    assertSectionConformance(sectionBy('Procedures'), '47519-4')
    assertSectionConformance(sectionBy('Diagnostic Reports'), '30954-2')
    // Non-IPS sections still get a code (project-local or LOINC) and narrative
    assertSectionConformance(sectionBy('Patient Records'))
    assertSectionConformance(sectionBy('Encounters'), '46240-8')
    assertSectionConformance(sectionBy('Service Requests'))
    assertSectionConformance(sectionBy('Observations'))
  })

  it('empty sections carry an emptyReason and narrative; populated sections do not', async () => {
    mockGotGet.mockReturnValueOnce({
      json: () => Promise.resolve(makeFhirSearchResponse([patient1])),
    })

    const result = await generateCrossFacilityIpsBundle(['pt-001'])
    const composition = result.entry![0] as R4.IComposition

    const emptySection = composition.section!.find(s => s.title === 'Allergies and Intolerances')!
    expect(emptySection.entry).toHaveLength(0)
    expect(emptySection.emptyReason).toBeDefined()
    expect(emptySection.text!.div).toContain('No allergies and intolerances available.')

    const populatedSection = composition.section!.find(s => s.title === 'Patient Records')!
    expect(populatedSection.entry!.length).toBeGreaterThan(0)
    expect(populatedSection.emptyReason).toBeUndefined()
    expect(populatedSection.text!.div).toContain('Patient Records (1 entry)')
  })
})

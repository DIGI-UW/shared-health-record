import { R4 } from '@ahryman40k/ts-fhir-types'
import got from 'got'
import { LabWorkflows } from '../labWorkflows'
const IG_URL = 'https://digi-uw.github.io/laboratory-workflows-ig'
let patient: R4.IPatient

beforeAll(async () => {
  patient = await got(IG_URL + '/Patient-example-laboratory-patient.json').json()
})

describe('generateLabBundle', () => {
  it('should return a Document Bundle with the correct type', async () => {
    const task: R4.ITask = await got(
      IG_URL + '/Task-example-laboratory-task-simple-requested.json',
    ).json()

    const result: R4.IBundle = LabWorkflows.generateLabBundle(task, patient)

    expect(result.resourceType!).toEqual('Bundle')
    expect(result.type!).toEqual(R4.BundleTypeKind._document)
  }),
    it('should return expected Document bundle given example data', async () => {
      // Load Example Data
      patient = await got(IG_URL + '/Patient-example-laboratory-patient.json').json()

      const getBundle = got(IG_URL + '/Bundle-example-laboratory-simple-bundle.json').json()
      const getTask = got(IG_URL + '/Task-example-laboratory-task-simple-requested.json').json()
      const getServiceRequest = got(
        IG_URL + '/ServiceRequest-example-laboratory-service-request.json',
      ).json()
      const getPractitioner = got(
        IG_URL + '/Practitioner-example-laboratory-practitioner.json',
      ).json()

      const [exampleBundle, task, serviceRequest, practitioner] = await Promise.all([
        getBundle,
        getTask,
        getServiceRequest,
        getPractitioner,
      ])

      const result = LabWorkflows.generateLabBundle(
        <R4.ITask>task,
        patient,
        [<R4.IServiceRequest>serviceRequest],
        <R4.IPractitioner>practitioner,
      )

      expect(result.resourceType!).toEqual('Bundle')
      expect(result.type!).toEqual(R4.BundleTypeKind._document)
      expect(result.entry?.length).toBe(4)
    })
})

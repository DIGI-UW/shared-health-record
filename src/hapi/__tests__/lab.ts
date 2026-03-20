import { R4 } from '@ahryman40k/ts-fhir-types'
import { BundleTypeKind } from '@ahryman40k/ts-fhir-types/lib/R4'
import got from 'got/dist/source'
import nock from 'nock'
import { config } from '../../lib/config'
import { getResource, saveBundle, translateToTransactionBundle } from '../lab'

const IG_URL = 'https://digi-uw.github.io/laboratory-workflows-ig'

const fhirUrl: string = config.get('fhirServer:baseURL')

describe('saveBundle', () => {
  it('should save a a document bundle', async () => {
    // Load data
    const transactionBundle: R4.IBundle = await got(
      IG_URL + '/Bundle-example-laboratory-simple-bundle-transaction.json',
    ).json()
    const transactionResultBundle: R4.IBundle = await got(
      IG_URL + '/Bundle-example-transaction-response-bundle.json',
    ).json()

    // Mock server
    const scope = nock(fhirUrl)
      .post(
        '',
        body =>
          body.resourceType == 'Bundle' &&
          body.type == transactionBundle.type! &&
          body.id == transactionBundle.id! &&
          body.entry[0].request.method == 'PUT',
      )
      .once()
      .reply(200, transactionResultBundle)

    const result = await saveBundle(transactionBundle)

    expect(result).toEqual(transactionResultBundle)
  })
})

describe(translateToTransactionBundle, () => {
  it('should translate document bundle to transaction bundle', async () => {
    const docBundle: R4.IBundle = await got(
      IG_URL + '/Bundle-example-laboratory-simple-bundle.json',
    ).json()

    const result = translateToTransactionBundle(docBundle)

    expect(result.type).toEqual(BundleTypeKind._transaction)
  })
})
describe('getResource', () => {
  it('should return resource of given type', async () => {
    const resource: R4.IPatient = await got(
      IG_URL + '/Patient-example-laboratory-patient.json',
    ).json()
    const type = 'Patient'
    const id: string = resource.id!

    const scope = nock(fhirUrl).get(`/${type}/${id}`).once().reply(200, resource)

    const result: R4.IPatient = await getResource(type, id)

    expect(result).toEqual(resource)
  })
})

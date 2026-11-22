/**
 * setes-sync:CNPJ.E1.P2 — a LIGAÇÃO da peça `FederalId` nos endpoints (gate socrático do delta, LOW 3): a institution com CNPJ
 * alfanumérico se reconhece como a própria vendedora (comparação da forma canônica, `sameDocument`) e nunca casa por letra apagada.
 * Sem banco (molde `orderservice.open-lock.test.ts`).
 */

type Ev = { sql: string; params?: unknown[] }
const mockEvents: Ev[] = []

function mockConn() {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      mockEvents.push({ sql, params })
      if (/^\s*SELECT/i.test(sql)) return [[{ id: 1 }]]          // papéis existem
      return [{ affectedRows: 1, insertId: 0 }]
    }),
    beginTransaction: jest.fn(async () => undefined),
    commit:           jest.fn(async () => undefined),
    rollback:         jest.fn(async () => undefined),
    release:          jest.fn(() => undefined),
    destroy:          jest.fn(() => undefined),
  }
}

jest.mock('@shared/db/connection', () => ({
  __esModule: true,
  default: {
    getConnection: jest.fn(async () => mockConn()),
    query: jest.fn(async (sql: string) => {
      if (/tb_sync_api_key/.test(sql)) {
        return [[{ tb_institution_id: 7, establishment_code: '001', active: 'S', schema_name: 'setes_teste' }]]
      }
      return [[]]
    }),
  },
}))

const mockFindByDocument = jest.fn(async (_conn: unknown, _doc: string) => 42)
const mockSelfSalesman = jest.fn(async () => undefined)
jest.mock('@modules/sync/sync.entity', () => ({
  ...jest.requireActual('@modules/sync/sync.entity'),
  findEntityIdByDocument: (conn: unknown, doc: string) => mockFindByDocument(conn, doc),
  getInstitutionDocument: jest.fn(async () => '12ABC345000188'),
  resolveSelfSalesman: () => mockSelfSalesman(),
}))

jest.mock('@modules/sync/sync.user', () => ({
  ...jest.requireActual('@modules/sync/sync.user'),
  resolveFallbackUserId: jest.fn(async () => 9),
}))

import request from 'supertest'
import app from '../app'

beforeEach(() => { mockEvents.length = 0; mockFindByDocument.mockClear(); mockSelfSalesman.mockClear() })

const post = (key: string, salesmanDocument: string) => request(app)
  .post('/order-service/sincronize')
  .set('X-Api-Key', key)
  .send({ id: 2001, terminal: 0, service: { number: 56, customerDocument: '52998224725' }, sale: { number: 56, salesmanDocument } })

describe('/order-service — vendedor = a própria empresa com CNPJ alfanumérico', () => {
  it('institution 12ABC345000188 se reconhece em salesmanDocument "12.abc.345/0001-88" (minúscula + máscara)', async () => {
    const res = await post('k-cnpj-alfa-1', '12.abc.345/0001-88')
    expect(res.status).toBe(200)
    expect(mockSelfSalesman).toHaveBeenCalledTimes(1)
    expect(mockFindByDocument.mock.calls.map(c => c[1])).not.toContain('12.abc.345/0001-88')
  })

  it('a letra APAGADA (12345000188) não é a institution — vai à busca normal', async () => {
    const res = await post('k-cnpj-alfa-2', '12345000188')
    expect(res.status).toBe(200)
    expect(mockSelfSalesman).not.toHaveBeenCalled()
    expect(mockFindByDocument.mock.calls.map(c => c[1])).toContain('12345000188')
  })
})

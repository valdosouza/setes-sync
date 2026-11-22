/**
 * setes-sync:CNPJ.E1.P2 (frente do CNPJ alfanumérico — D-CJ3, D-CJ12, D-CJ30, D-CJ31; SETES-SYNC#6 e #9): o indexador por documento
 * aceita e PRESERVA o CNPJ canônico (12 letras/números + 2 dígitos, DV ASCII − 48), nunca apaga letra, minúscula não vira outro CNPJ,
 * o que não chega à forma é recusado, a recusa do CHECK do banco é 422 por registro e nenhum caminho grava `'0'`.
 * SÓ MOCK: a conexão é falsa e o pool do módulo é substituído — nada toca o banco (o `.env` é produção).
 * Ficha: D:\Vault\projetos\setes-sync\SUBJECT\CNPJ_ALFANUMERICO\ficha-cnpj-e1-inventario-e-correcao.md §6 passos 2 e 3.
 */
jest.mock('@shared/db/connection', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async () => { throw new Error('o teste não pode tocar o pool real') }),
    getConnection: jest.fn(async () => { throw new Error('o teste não pode tocar o pool real') }),
  },
}))

import { z } from 'zod'
import { PoolConnection } from 'mysql2/promise'
import {
  syncEntityBody, stripDocumentMasks, saveSyncEntity, findEntityIdByDocument,
  validDocumentOrUndefined, sameDocument, SyncEntityInput,
} from '@modules/sync/sync.entity'
import { upsertFiscal, CNPJ_FORM_CHECK } from '@shared/fiscal/fiscal.repository'
import fs from 'fs'
import path from 'path'
import { HttpError } from '@shared/errors/http-error'
import { refDocument } from '@modules/sync/endpoints/ordersale'
import { invoiceBody } from '@modules/sync/endpoints/invoice'

// Valores calculados pela peça do núcleo (cnpjCheckDigits): 3 letras — sem elas viraria 11 dígitos (12345000188), o "CPF" de antes.
const ALFA3 = '12ABC345000188'
const ALFA5 = '12ABC34501DE35'           // vetor oficial da peça
const NUM   = '11222333000181'
const CPF   = '52998224725'

interface Call { sql: string; params: unknown[] }

/** Conexão falsa: registra as consultas; SELECT devolve vazio (nada achado), MAX+1 devolve um id, o resto "afeta 1 linha". */
function fakeConn(opts: { found?: (sql: string, params: unknown[]) => any[]; fail?: (sql: string) => unknown } = {}) {
  const calls: Call[] = []
  const conn = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      const err = opts.fail?.(sql)
      if (err) throw err
      if (/MAX\(id\)/.test(sql)) return [[{ nextId: 900001 }], []]
      if (/^\s*SELECT/i.test(sql)) return [opts.found?.(sql, params) ?? [], []]
      return [{ affectedRows: 1, insertId: 0 }, []]
    }),
  }
  return { conn: conn as unknown as PoolConnection, calls }
}

const companyInserts = (calls: Call[]) => calls.filter(c => /INSERT INTO setes_central\.tb_company/.test(c.sql))

function parseCompany(cnpj: unknown) {
  return syncEntityBody.safeParse(stripDocumentMasks({
    entity: { nameCompany: 'EMPRESA CNPJ ALFA', nickTrade: 'ALFA' },
    personType: 'J', company: { cnpj },
  }))
}

describe('cadastro (bloco entity) — a forma canônica é a gravada, nunca se apaga letra (P2.T1/T2)', () => {
  it.each([ALFA3, ALFA5, NUM])('%s passa e chega INTACTO ao INSERT de tb_company', async cnpj => {
    const parsed = parseCompany(cnpj)
    expect(parsed.success).toBe(true)
    const { conn, calls } = fakeConn()
    await saveSyncEntity(conn, parsed.data as SyncEntityInput)
    const ins = companyInserts(calls)
    expect(ins).toHaveLength(1)
    expect(ins[0].params[1]).toBe(cnpj)
  })

  it.each([
    ['minúscula', '12abc345000188'],
    ['máscara', '12.ABC.345/0001-88'],
    ['máscara + minúscula + espaço', ' 12.abc.345/0001-88 '],
  ])('SETES-SYNC#6 — %s é CORRIGIDA pela peça e gravada como 12ABC345000188', async (_c, raw) => {
    const parsed = parseCompany(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.company!.cnpj).toBe(ALFA3)
    const { conn, calls } = fakeConn()
    await saveSyncEntity(conn, parsed.data as SyncEntityInput)
    expect(companyInserts(calls)[0].params[1]).toBe(ALFA3)
  })

  it('CNPJ numérico com máscara continua aceito (o legado de hoje) e vira só dígitos', () => {
    const parsed = parseCompany('11.222.333/0001-81')
    expect(parsed.success && parsed.data.company!.cnpj).toBe(NUM)
  })

  it.each([
    ['letra no DV', '12ABC3450001AB'],
    ['DV errado', '12ABC345000189'],
    ['acento', '12ÁBC345000188'],
    ['sublinhado (nunca é apagado)', '12_ABC345000188'],
    ['o sentinela 0 (D-CJ31)', '0'],
    ['14 iguais', '11111111111111'],
    ['letra fora das 12 primeiras posições', '12ABC3450001A8'],
    ['comprimento errado', '12ABC34500018'],
  ])('recusado no cadastro: %s', (_c, raw) => {
    expect(parseCompany(raw).success).toBe(false)
  })

  it('array/objeto não vira documento (String([…]) dava um CNPJ válido — gate adversarial)', () => {
    expect(parseCompany([ALFA3]).success).toBe(false)
    expect(parseCompany({ v: ALFA3 }).success).toBe(false)
    expect(parseCompany(11222333000181).success).toBe(true)    // número segue aceito (vira texto)
  })

  it('CPF com caractere fora da máscara é recusado (antes era apagado — §4.2: nunca apagar)', () => {
    const bad = syncEntityBody.safeParse(stripDocumentMasks({
      entity: { nameCompany: 'PESSOA', nickTrade: 'P' }, personType: 'F', person: { cpf: '529,982,247_25' } }))
    expect(bad.success).toBe(false)
  })

  it('CPF: máscara corrigida pela peça; letra recusada', () => {
    const ok = syncEntityBody.safeParse(stripDocumentMasks({
      entity: { nameCompany: 'PESSOA', nickTrade: 'P' }, personType: 'F', person: { cpf: '529.982.247-25' } }))
    expect(ok.success && ok.data.person!.cpf).toBe(CPF)
    const bad = syncEntityBody.safeParse(stripDocumentMasks({
      entity: { nameCompany: 'PESSOA', nickTrade: 'P' }, personType: 'F', person: { cpf: '5299822472A' } }))
    expect(bad.success).toBe(false)
  })
})

describe('"achou pelo documento, reusa o id" — leitura canonicaliza e escolhe a tabela pela forma (D-CJ3)', () => {
  it.each([ALFA3, '12abc345000188', '12.ABC.345/0001-88'])('%s consulta tb_company com 12ABC345000188 e NUNCA tb_person', async doc => {
    const { conn, calls } = fakeConn()
    await findEntityIdByDocument(conn, doc)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toMatch(/tb_company WHERE cnpj = \?/)
    expect(calls[0].params).toEqual([ALFA3])
  })

  it('CPF consulta tb_person; fora das duas formas não consulta nada', async () => {
    const a = fakeConn()
    await findEntityIdByDocument(a.conn, '529.982.247-25')
    expect(a.calls[0].sql).toMatch(/tb_person WHERE cpf = \?/)
    expect(a.calls[0].params).toEqual([CPF])
    for (const junk of ['123', '12ÁBC345000188', '', '0']) {
      const b = fakeConn()
      expect(await findEntityIdByDocument(b.conn, junk)).toBeNull()
      expect(b.calls).toHaveLength(0)
    }
  })

  it('o CNPJ achado no central é REUSADO pelo motor (mesmo id), sem regravar a cadeia', async () => {
    const parsed = parseCompany('12abc345000188')
    const { conn, calls } = fakeConn({ found: sql => (/tb_company WHERE cnpj/.test(sql) ? [{ id: 4242 }] : []) })
    const r = await saveSyncEntity(conn, parsed.success ? parsed.data as SyncEntityInput : ({} as SyncEntityInput))
    expect(r).toMatchObject({ entityId: 4242, reused: true })
    expect(calls.find(c => /tb_company WHERE cnpj/.test(c.sql))!.params).toEqual([ALFA3])
    expect(companyInserts(calls)).toHaveLength(0)
  })
})

describe('referências tolerantes do legado (pedido de venda, nota) — preservam a letra; inválido = sem documento', () => {
  const ref = z.object({ d: refDocument })
  const ent = invoiceBody.shape.entityDocument

  it.each([[ALFA3, ALFA3], ['12abc345000188', ALFA3], ['12.ABC.345/0001-88', ALFA3], ['529.982.247-25', CPF]])(
    'refDocument / entityDocument: %s → %s', (raw, expected) => {
      expect(ref.parse({ d: raw }).d).toBe(expected)
      expect(ent.parse(raw)).toBe(expected)
    })

  it('o descarte deixa rastro no log (o valor cru do legado)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(validDocumentOrUndefined('529,982,247_25')).toBeUndefined()
    expect(warn.mock.calls.some(c => String(c[0]).includes('529,982,247_25'))).toBe(true)
    warn.mockClear()
    expect(validDocumentOrUndefined('   ')).toBeUndefined()          // vazio não é descarte
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each(['12ABC345000189', '11222333000182', '0', '00000000000000', '12345', '52998224726', '529,982,247_25'])(
    'SETES-SYNC#9 — %s (inválido / DV errado / sentinela) vira undefined', raw => {
      expect(ref.parse({ d: raw }).d).toBeUndefined()
      expect(ent.parse(raw)).toBeUndefined()
      expect(validDocumentOrUndefined(raw)).toBeUndefined()
    })
})

describe('vendedor = a própria empresa — comparação da forma canônica', () => {
  it('institution com CNPJ com letra se reconhece no salesmanDocument', () => {
    expect(sameDocument(ALFA3, '12.abc.345/0001-88')).toBe(true)
    expect(sameDocument(ALFA3, ALFA3)).toBe(true)
    expect(sameDocument(NUM, '11.222.333/0001-81')).toBe(true)
  })
  it('nunca casa por apagar letra nem casa vazio/nulo', () => {
    expect(sameDocument(ALFA3, '12345000188')).toBe(false)
    expect(sameDocument(null, ALFA3)).toBe(false)
    expect(sameDocument('', '')).toBe(false)
    expect(sameDocument(ALFA3, '12ÁBC345000188')).toBe(false)
  })
  it('sentinela e lixo nunca casam entre si (gate adversarial)', () => {
    expect(sameDocument('0', '0..........')).toBe(false)
    expect(sameDocument('0', '0')).toBe(false)
    expect(sameDocument('ABC', 'abc')).toBe(false)
  })
})

describe('recusa do CHECK do banco central não trava a fila (P2.T2, D-CJ30)', () => {
  const company = (cnpj: string) => ({
    entity: { nameCompany: 'X', nickTrade: 'X' }, personType: 'J' as const, person: null, company: { cnpj },
  })

  const checkErr = (errno: number, name: string) => Object.assign(
    new Error(`CONSTRAINT \`${name}\` failed for \`setes_central\`.\`tb_company\``),
    { errno, sqlMessage: `CONSTRAINT \`${name}\` failed for \`setes_central\`.\`tb_company\`` })
  const failingCompany = (err: unknown) => fakeConn({
    fail: sql => (/INSERT INTO setes_central\.tb_company/.test(sql) ? err : undefined),
  })

  it.each([[4025, 'MariaDB ER_CONSTRAINT_FAILED'], [3819, 'MySQL ER_CHECK_CONSTRAINT_VIOLATED']])(
    'errno %s (%s) do CHECK ck_company_cnpj_form vira HttpError 422 CNPJ_FORM, com o campo', async errno => {
      const { conn } = failingCompany(checkErr(errno, CNPJ_FORM_CHECK))
      const err = await upsertFiscal(conn, 1, company(ALFA3) as any).catch(e => e)
      expect(err).toBeInstanceOf(HttpError)
      expect(err).toMatchObject({ statusCode: 422, code: 'CNPJ_FORM' })
      expect(err.fields).toEqual([expect.objectContaining({ field: 'company.cnpj' })])
    })

  it('OUTRO CHECK da tabela (4025 de ck_company_ie_x) sobe como veio — nunca diagnóstico falso de CNPJ (gate do delta)', async () => {
    const other = checkErr(4025, 'ck_company_ie_x')
    const { conn } = failingCompany(other)
    await expect(upsertFiscal(conn, 1, company(ALFA3) as any)).rejects.toBe(other)
  })

  it('outro erro do banco segue como veio (não vira 422)', async () => {
    const boom = Object.assign(new Error('Duplicate entry'), { errno: 1062, code: 'ER_DUP_ENTRY' })
    const { conn } = fakeConn({ fail: sql => (/INSERT INTO setes_central\.tb_company/.test(sql) ? boom : undefined) })
    await expect(upsertFiscal(conn, 1, company(ALFA3) as any)).rejects.toBe(boom)
  })

  it('a recusa sobe pelo motor como HttpError (o catch dos endpoints responde por registro, não 500)', async () => {
    const parsed = parseCompany(ALFA3)
    const { conn } = failingCompany(checkErr(4025, CNPJ_FORM_CHECK))
    await expect(saveSyncEntity(conn, parsed.success ? parsed.data as SyncEntityInput : ({} as SyncEntityInput)))
      .rejects.toMatchObject({ statusCode: 422, code: 'CNPJ_FORM' })
  })
})

describe("D-CJ31 — nenhum caminho do motor grava '0' nem omite a coluna cnpj", () => {
  const ext = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it.each([
    ['criação por documento', {}],
    ['graduação com externalCode órfão e documento livre (caso D1)', { externalCode: ext }],
  ])('%s', async (_c, extra) => {
    const parsed = syncEntityBody.safeParse(stripDocumentMasks({
      entity: { nameCompany: 'EMPRESA', nickTrade: 'E' }, personType: 'J', company: { cnpj: '12abc345000188' }, ...extra }))
    expect(parsed.success).toBe(true)
    const { conn, calls } = fakeConn()
    await saveSyncEntity(conn, parsed.data as SyncEntityInput, { origin: 'teste', institutionId: 1 })
    const ins = companyInserts(calls)
    expect(ins.length).toBeGreaterThan(0)
    for (const c of ins) {
      expect(c.sql).toMatch(/\(id, cnpj,/)
      expect(c.params[1]).toBe(ALFA3)
    }
  })

  it('graduação caso B (regravação pós-graduação: o documento já é da entity do externalCode)', async () => {
    const parsed = syncEntityBody.safeParse(stripDocumentMasks({
      entity: { nameCompany: 'EMPRESA', nickTrade: 'E' }, personType: 'J', company: { cnpj: '12abc345000188' }, externalCode: ext }))
    const { conn, calls } = fakeConn({ found: (sql, params) => {
      if (/tb_company WHERE cnpj/.test(sql)) return [{ id: 888 }]
      if (/FROM setes_central\.tb_no_doc WHERE external_id = \? AND id = \?/.test(sql)) return [{ 1: 1 }]
      return []
    } })
    const r = await saveSyncEntity(conn, parsed.success ? parsed.data as SyncEntityInput : ({} as SyncEntityInput))
    expect(r).toMatchObject({ entityId: 888, clearExternalCode: true })
    expect(companyInserts(calls).map(c => c.params[1])).toEqual([ALFA3])
  })

  it('graduação caso A (a entity do externalCode ganha o CNPJ com letra)', async () => {
    const parsed = syncEntityBody.safeParse(stripDocumentMasks({
      entity: { nameCompany: 'EMPRESA', nickTrade: 'E' }, personType: 'J', company: { cnpj: ALFA3 }, externalCode: ext }))
    const { conn, calls } = fakeConn({ found: sql => (/tb_no_doc\s+WHERE external_id/.test(sql) ? [{ id: 777 }] : []) })
    const r = await saveSyncEntity(conn, parsed.success ? parsed.data as SyncEntityInput : ({} as SyncEntityInput))
    expect(r).toMatchObject({ entityId: 777, clearExternalCode: true })
    expect(companyInserts(calls).map(c => c.params[1])).toEqual([ALFA3])
  })
})

describe('pacote do núcleo — o driver fica preso à versão do pacote (D-F227, SETES-SYNC#7)', () => {
  it('mysql2 com versão EXATA em package.json, igual à que o fiscal-api declara', () => {
    const root = path.resolve(__dirname, '..', '..')
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    const core = JSON.parse(fs.readFileSync(require.resolve('fiscal-api/package.json'), 'utf8'))
    expect(pkg.dependencies.mysql2).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.dependencies.mysql2).toBe(core.dependencies.mysql2)
  })
})

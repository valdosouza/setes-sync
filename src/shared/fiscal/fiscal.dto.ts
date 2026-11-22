import { z } from 'zod'
import { isValidCpf, isValidCnpj, normalizeCpf, normalizeCnpj } from '../validation'

/**
 * Schemas Zod FISCAIS (PF/PJ) — peça independente (SRP/ISP).
 * CPF/CNPJ com dígito verificador validado (decisão do Valdo, Rodada 3 — Fase 2
 * campos configuráveis) pela peça do núcleo `FederalId` (frente do CNPJ
 * alfanumérico, D-CJ2; setes-sync:CNPJ.E1.P2). SETES-SYNC#6 (Valdo, 2026-11-22):
 * máscara e minúscula vindas do Delphi são CORRIGIDAS pela peça (tira só `.` `/`
 * `-` e espaço, passa a maiúscula) e a forma canônica é a gravada; o que a peça
 * não consegue canonicalizar segue CRU e é recusado — nunca se apaga letra.
 */

/** Canonicaliza pela peça; sem forma canônica, devolve o valor cru para o refine recusar. */
const canonicalOr = (normalize: (raw: unknown) => string | null) =>
  (v: unknown) => (typeof v === 'string' ? normalize(v) ?? v : v)

const dateRe = /^\d{4}-\d{2}-\d{2}$/

// Legado manda data VAZIA ('') quando não preenchida — 1ª rodada real
// 2026-07-27: 70 clientes barrados por company.dtFoundation ''. Vazio = null.
const optionalDate = z.preprocess(
  v => (v === '' ? null : v),
  z.string().regex(dateRe).nullable().optional()
)

export const personBody = z.object({
  cpf:      z.preprocess(canonicalOr(normalizeCpf),
              z.string().refine(isValidCpf, 'CPF inválido: 11 dígitos com dígito verificador')),
  rg:       z.string().max(20).nullable().optional(),
  birthday: optionalDate,
})

export const companyBody = z.object({
  cnpj:         z.preprocess(canonicalOr(normalizeCnpj),
                  z.string().refine(isValidCnpj, 'CNPJ inválido: 12 letras ou números e 2 dígitos verificadores')),
  ie:           z.string().max(45).nullable().optional(),
  im:           z.string().max(45).nullable().optional(),
  dtFoundation: optionalDate,
})

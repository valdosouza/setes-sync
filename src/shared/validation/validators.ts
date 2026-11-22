/**
 * Validadores COMPARTILHADOS (Fase 2 campos configuráveis, decisão 18):
 * funções puras usadas pelos DTOs Zod e services de qualquer módulo.
 *
 * INSCRIÇÃO FEDERAL (CPF/CNPJ — frente do CNPJ alfanumérico, D-CJ2/§4.2; setes-sync:CNPJ.E1.P2, SETES-SYNC#7): a regra NÃO mora aqui — é
 * a peça pura do núcleo (`fiscal-api/federal-id`, pelo pacote em vendor/), reexportada abaixo como no setes-api. CNPJ = 12 alfanuméricos
 * MAIÚSCULOS + 2 DV numéricos (DV ASCII − 48); "normalizar" = canonicalizar (tira só `.` `/` `-` e espaço, passa a maiúscula), NUNCA
 * apagar. O antigo "tira o que não é dígito" aplicado a um CNPJ com letra dá OUTRO número (cerca D-CJ12).
 */
export {
  isValidCpf, isValidCnpj, normalizeCnpj, normalizeCpf, canonicalizeFederalIdText,
} from 'fiscal-api/federal-id'

/** true se o valor contém apenas dígitos (vazio conta como true). */
export function isOnlyDigits(value: string): boolean {
  return /^\d*$/.test(value)
}

/**
 * Valor casa com a máscara? Padrão técnico da casa (decisão 16):
 * `#` = dígito, `A` = letra, qualquer outro caractere é literal obrigatório.
 * Ex.: matchesMask('(##) #-####-####', '(31) 9-8888-7777') === true.
 * Máscara vazia/nula = sem restrição.
 */
export function matchesMask(mask: string | null | undefined, value: string): boolean {
  if (!mask) return true
  if (mask.length !== value.length) return false
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i]
    const c = value[i]
    if (m === '#') { if (!/\d/.test(c)) return false }
    else if (m === 'A') { if (!/[a-zA-ZÀ-ÿ]/.test(c)) return false }
    else if (m !== c) return false
  }
  return true
}

/**
 * Enum 'S'/'N' TOLERANTE ao legado (1ª rodada real 2026-07-27; espaço
 * 2026-08-01): campos CHAR não preenchidos chegam como '' OU ' ' (CHAR(1)
 * do Firebird vem PADDED com espaço) — vazio/branco vira undefined (aplica
 * o default); valor real é TRIMADO antes do enum.
 */
import { z } from 'zod'
export const snFlag = (def?: 'S' | 'N') => z.preprocess(
  v => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v),
  def === undefined ? z.enum(['S', 'N']).optional() : z.enum(['S', 'N']).optional().default(def)
)

/**
 * Char(1) ESPELHO do legado (decisão Valdo 2026-08-01, diagnóstico do
 * sync-errors.log): o valor do Firebird viaja COMO ESTÁ (ex.:
 * PRO_COMPOSICAO '1'/'2'/'3'/'5') — a web guarda o espelho, sem impor
 * domínio S/N. Vazio/branco = ausente (aplica o default, quando houver).
 */
export const legacyChar = (def?: string) => z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  def === undefined
    ? z.string().trim().max(1).optional()
    : z.string().trim().max(1).optional().default(def)
)

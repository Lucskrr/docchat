/**
 * Modelo de dados compartilhado entre o app Next.js e a Lambda de ingestão.
 *
 * DynamoDB em tabela única:
 *   pk = DOC#<id>   sk = META           -> status e metadados do documento
 *   pk = DOC#<id>   sk = CHUNK#00012    -> trecho de texto + embedding
 * Uma única Query por pk traz todos os trechos de um documento para a busca.
 */
export type DocStatus = "PENDING" | "PROCESSING" | "READY" | "ERROR";

export interface DocMeta {
  pk: string;
  sk: "META";
  docId: string;
  fileName: string;
  status: DocStatus;
  createdAt: string;
  updatedAt: string;
  pages?: number;
  chunks?: number;
  error?: string;
  /** Epoch em segundos; o TTL do DynamoDB apaga o item depois disso. */
  expiresAt: number;
}

/** O que o navegador pode ver de um documento (sem chaves internas). */
export type PublicDoc = Pick<
  DocMeta,
  "docId" | "fileName" | "status" | "pages" | "chunks" | "error" | "createdAt"
>;

export interface ChunkItem {
  pk: string;
  sk: string;
  page: number;
  text: string;
  embedding: Uint8Array;
  expiresAt: number;
}

export const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxPages: 300,
  maxChunks: 1500,
  retentionDays: 7,
  embeddingDimensions: 768,
  topK: 6,
  maxQuestionLength: 1000,
} as const;

export const META_SK = "META" as const;
export const docPk = (docId: string) => `DOC#${docId}`;
export const chunkSk = (index: number) => `CHUNK#${String(index).padStart(5, "0")}`;
export const uploadKey = (docId: string) => `uploads/${docId}.pdf`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDocId = (value: string) => UUID.test(value);

export function docIdFromKey(key: string): string | null {
  const match = /^uploads\/([^/]+)\.pdf$/.exec(key);
  return match && isDocId(match[1]) ? match[1] : null;
}

export function expiresAt(from = new Date()): number {
  return Math.floor(from.getTime() / 1000) + LIMITS.retentionDays * 24 * 60 * 60;
}

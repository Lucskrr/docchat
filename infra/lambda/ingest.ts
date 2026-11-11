import type { S3Event, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GoogleGenAI } from "@google/genai";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkPages } from "../../src/lib/core/chunking";
import { embedTexts } from "../../src/lib/core/embeddings";
import {
  LIMITS,
  META_SK,
  chunkSk,
  docIdFromKey,
  docPk,
  expiresAt,
  type DocStatus,
} from "../../src/lib/core/model";
import { encodeVector } from "../../src/lib/core/vectors";

/**
 * Pipeline de ingestão (assíncrono): S3 (upload) -> SQS -> esta Lambda.
 * Lê o PDF, extrai o texto por página, divide em trechos, gera os embeddings
 * no Gemini e grava tudo no DynamoDB. Falhas voltam para a fila (retry) e,
 * depois de 3 tentativas, vão para a DLQ.
 */
const TABLE = required("DOCS_TABLE");
const KEY_PARAM = required("GEMINI_KEY_PARAM");
/** Igual ao maxReceiveCount da DLQ definido na stack. */
const MAX_RECEIVES = Number(process.env.MAX_RECEIVES ?? 3);

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
let ai: GoogleGenAI | undefined;

/** A chave do Gemini fica no SSM Parameter Store (SecureString), não em variável de ambiente. */
async function gemini() {
  if (!ai) {
    const res = await ssm.send(new GetParameterCommand({ Name: KEY_PARAM, WithDecryption: true }));
    const apiKey = res.Parameter?.Value;
    if (!apiKey) throw new Error(`parâmetro ${KEY_PARAM} vazio`);
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

/** Erro de conteúdo (PDF inválido, sem texto): marca ERROR e não adianta tentar de novo. */
class PermanentError extends Error {}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const message of event.Records) {
    const s3Event = JSON.parse(message.body) as Partial<S3Event> & { Event?: string };
    if (s3Event.Event === "s3:TestEvent") continue; // mensagem de teste que o S3 envia ao configurar

    for (const record of s3Event.Records ?? []) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      const docId = docIdFromKey(key);
      if (!docId) {
        console.warn("chave ignorada", { key });
        continue;
      }
      try {
        await ingest(bucket, key, docId);
      } catch (err) {
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          console.warn("upload sem registro no app (ou já expirado); ignorado", { docId });
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        console.error("ingestão falhou", { docId, error: reason });
        const permanent = err instanceof PermanentError;
        // Na última tentativa a mensagem vai para a DLQ: o usuário precisa ver o erro.
        const lastAttempt = Number(message.attributes.ApproximateReceiveCount) >= MAX_RECEIVES;
        await setStatus(docId, permanent || lastAttempt ? "ERROR" : "PENDING", {
          error: permanent
            ? reason
            : lastAttempt
              ? "falha ao processar o documento; tente enviar de novo"
              : "nova tentativa em andamento",
        }).catch((e) => console.error("não consegui atualizar o status", e));
        if (!permanent) failures.push({ itemIdentifier: message.messageId });
      }
    }
  }
  return { batchItemFailures: failures };
}

async function ingest(bucket: string, key: string, docId: string) {
  const started = Date.now();
  await setStatus(docId, "PROCESSING");

  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await object.Body!.transformToByteArray();

  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new PermanentError("o arquivo não é um PDF válido");
  }
  if (pdf.numPages > LIMITS.maxPages) {
    throw new PermanentError(`o PDF tem ${pdf.numPages} páginas; o limite é ${LIMITS.maxPages}`);
  }

  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t, i) => ({ page: i + 1, text: t }));
  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    throw new PermanentError("não encontrei texto no PDF (pode ser um documento escaneado)");
  }
  if (chunks.length > LIMITS.maxChunks) {
    throw new PermanentError("o documento é grande demais para esta demonstração");
  }

  const vectors = await embedTexts(await gemini(), chunks.map((c) => c.text), "RETRIEVAL_DOCUMENT");

  const ttl = expiresAt();
  const items = chunks.map((c, i) => ({
    pk: docPk(docId),
    sk: chunkSk(c.index),
    page: c.page,
    text: c.text,
    embedding: encodeVector(vectors[i]),
    expiresAt: ttl,
  }));
  await batchWrite(items);

  await setStatus(docId, "READY", { pages: pdf.numPages, chunks: chunks.length });
  console.log("ingestão concluída", {
    docId,
    pages: pdf.numPages,
    chunks: chunks.length,
    ms: Date.now() - started,
  });
}

/** BatchWrite aceita 25 itens por chamada; itens não processados são reenviados. */
async function batchWrite(items: Record<string, unknown>[]) {
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; requests.length > 0; attempt++) {
      if (attempt > 5) throw new Error("DynamoDB não aceitou todos os itens");
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
      requests = (res.UnprocessedItems?.[TABLE] ?? []) as typeof requests;
    }
  }
}

async function setStatus(
  docId: string,
  status: DocStatus,
  extra: { pages?: number; chunks?: number; error?: string } = {},
) {
  const names: Record<string, string> = { "#s": "status", "#u": "updatedAt" };
  const values: Record<string, unknown> = { ":s": status, ":u": new Date().toISOString() };
  const sets = ["#s = :s", "#u = :u"];
  for (const [field, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    sets.push(`#${field} = :${field}`);
  }
  const remove = extra.error === undefined ? " REMOVE #err" : "";
  if (remove) names["#err"] = "error";

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: docPk(docId), sk: META_SK },
      // Só atualiza documentos registrados pelo app (evita criar META para uploads soltos).
      ConditionExpression: "attribute_exists(pk)",
      UpdateExpression: `SET ${sets.join(", ")}${remove}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`variável ${name} não definida`);
  return value;
}

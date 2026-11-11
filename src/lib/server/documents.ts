import "server-only";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { dynamo, s3Client } from "./clients";
import { env } from "./env";
import { decodeVector } from "../core/vectors";
import {
  LIMITS,
  META_SK,
  docPk,
  expiresAt,
  uploadKey,
  type DocMeta,
  type PublicDoc,
} from "../core/model";

/** Registra o documento como PENDING e devolve um POST pré-assinado para o upload direto ao S3. */
export async function createUpload(docId: string, fileName: string) {
  const now = new Date();
  const meta: DocMeta = {
    pk: docPk(docId),
    sk: META_SK,
    docId,
    fileName,
    status: "PENDING",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt(now),
  };
  await dynamo().send(
    new PutCommand({
      TableName: env().DOCS_TABLE,
      Item: meta,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  // O POST pré-assinado (diferente do PUT) deixa o S3 recusar arquivos grandes demais.
  const post = await createPresignedPost(s3Client(), {
    Bucket: env().DOCS_BUCKET,
    Key: uploadKey(docId),
    Conditions: [
      ["content-length-range", 1, LIMITS.maxFileBytes],
      ["eq", "$Content-Type", "application/pdf"],
    ],
    Fields: { "Content-Type": "application/pdf" },
    Expires: 300,
  });
  return { meta: publicMeta(meta), upload: post };
}

export async function getMeta(docId: string): Promise<DocMeta | null> {
  const res = await dynamo().send(
    new GetCommand({ TableName: env().DOCS_TABLE, Key: { pk: docPk(docId), sk: META_SK } }),
  );
  return (res.Item as DocMeta | undefined) ?? null;
}

export interface StoredChunk {
  page: number;
  text: string;
  vector: Float32Array;
}

/** Carrega todos os trechos de um documento (Query paginada pela partição do documento). */
export async function loadChunks(docId: string): Promise<StoredChunk[]> {
  const chunks: StoredChunk[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await dynamo().send(
      new QueryCommand({
        TableName: env().DOCS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": docPk(docId), ":prefix": "CHUNK#" },
        ProjectionExpression: "page, #t, embedding",
        ExpressionAttributeNames: { "#t": "text" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      chunks.push({
        page: item.page as number,
        text: item.text as string,
        vector: decodeVector(item.embedding as Uint8Array),
      });
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return chunks;
}

export function publicMeta(meta: DocMeta): PublicDoc {
  return {
    docId: meta.docId,
    fileName: meta.fileName,
    status: meta.status,
    pages: meta.pages,
    chunks: meta.chunks,
    error: meta.error,
    createdAt: meta.createdAt,
  };
}

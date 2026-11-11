import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GoogleGenAI } from "@google/genai";
import { env } from "./env";

/**
 * Clientes criados uma vez por instância do servidor.
 * Credenciais AWS: localmente vêm do `aws configure`; no Amplify, do compute role do app.
 */
let s3: S3Client | undefined;
let ddb: DynamoDBDocumentClient | undefined;
let ai: GoogleGenAI | undefined;

export function s3Client() {
  return (s3 ??= new S3Client({ region: env().APP_REGION }));
}

export function dynamo() {
  return (ddb ??= DynamoDBDocumentClient.from(new DynamoDBClient({ region: env().APP_REGION })));
}

export function gemini() {
  return (ai ??= new GoogleGenAI({ apiKey: env().GEMINI_API_KEY }));
}

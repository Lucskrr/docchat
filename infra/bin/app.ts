#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { DocChatStack } from "../lib/docchat-stack";

const app = new App();

// Origens liberadas no CORS do upload. Depois do primeiro deploy no Amplify, rode:
//   npx cdk deploy -c allowedOrigins=http://localhost:3000,https://main.xxxx.amplifyapp.com
const allowedOrigins = String(app.node.tryGetContext("allowedOrigins") ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const stack = new DocChatStack(app, "DocChat", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "sa-east-1",
  },
  allowedOrigins,
  geminiKeyParam: String(app.node.tryGetContext("geminiKeyParam") ?? "/docchat/gemini-api-key"),
});

Tags.of(stack).add("project", "docchat");

# DocChat

Converse com qualquer PDF. Você envia o arquivo, ele é processado de forma assíncrona numa
pipeline serverless na AWS, e as respostas vêm de um LLM (Gemini) usando **RAG**: só com
base nos trechos do documento, citando as páginas.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Gemini API (embeddings + geração) ·
AWS Lambda · S3 · SQS · DynamoDB · SSM Parameter Store · CloudWatch · Amplify Hosting ·
AWS CDK · Vitest · GitHub Actions

## Arquitetura

```
                        ┌──────────────────────── Amplify Hosting ───────────────────────┐
  Navegador ──────────► │ Next.js  /api/documents  /api/documents/[id]  /api/chat        │
     │                  └───────┬─────────────────────────┬──────────────────┬──────────┘
     │  POST pré-assinado       │ PutItem (PENDING)       │ GetItem / Query  │ embed + generate
     ▼                          ▼                         ▼                  ▼
  ┌──────┐  ObjectCreated  ┌─────────┐   ┌──────────────────────┐   ┌──────────────┐
  │  S3  │ ──────────────► │   SQS   │──►│ Lambda de ingestão   │──►│  Gemini API  │
  └──────┘                 └────┬────┘   │ PDF → texto → chunks │   └──────────────┘
                                │ 3 falhas│ → embeddings         │
                                ▼        └──────────┬───────────┘
                          ┌─────────┐               ▼
                          │   DLQ   │──► alarme   DynamoDB (status, trechos e vetores)
                          └─────────┘   CloudWatch
```

### Fluxo

1. **Upload direto ao S3.** O app registra o documento como `PENDING` no DynamoDB e devolve um
   *POST pré-assinado*. O navegador envia o PDF direto ao bucket, sem passar pelo servidor.
   A política do POST limita o tamanho (10 MB) e o tipo do arquivo.
2. **Ingestão orientada a eventos.** O `ObjectCreated` do S3 vai para uma fila SQS, que aciona a
   Lambda. A Lambda extrai o texto página por página (`unpdf`), divide em trechos de ~1.200
   caracteres com sobreposição, gera os embeddings em lote (`gemini-embedding-001`, 768
   dimensões) e grava tudo no DynamoDB. Erros temporários voltam para a fila (retry com
   *partial batch response*); depois de 3 tentativas a mensagem vai para a DLQ e um alarme
   do CloudWatch dispara.
3. **Chat com RAG.** O app gera o embedding da pergunta (`RETRIEVAL_QUERY`), carrega os trechos
   do documento com uma única Query, ordena por similaridade de cosseno, envia os 6 melhores ao
   Gemini como contexto e devolve a resposta em **streaming**, com as páginas usadas como fonte.

### Decisões de projeto

| Decisão | Por quê |
| --- | --- |
| SQS entre S3 e Lambda | Retry controlado, DLQ e limite de paralelismo (protege a cota do Gemini) |
| DynamoDB em tabela única (`pk = DOC#id`) | Status e trechos de um documento saem numa Query só; TTL apaga tudo em 7 dias |
| Vetores como binário Float32 | 3 KB por trecho em vez de ~15 KB como lista de números |
| Busca vetorial em memória | Cada pergunta busca só dentro de um documento (centenas de trechos). Para buscar em milhares de documentos, o próximo passo seria um banco vetorial (pgvector, OpenSearch ou S3 Vectors) |
| Chave do Gemini no SSM (SecureString) | A Lambda lê em runtime; a chave não fica no template nem em variável de ambiente |
| Núcleo compartilhado em `src/lib/core` | Mesmo código de chunking, vetores e embeddings no app e na Lambda, coberto por testes |
| Sem login | É uma demonstração: os documentos ficam só no navegador de quem enviou e expiram em 7 dias |

## Estrutura

```
src/
  app/api/documents/        cria o upload pré-assinado e consulta o status
  app/api/chat/             RAG + streaming da resposta
  components/doc-chat.tsx   interface (upload, status, chat, fontes)
  lib/core/                 chunking, vetores, embeddings, prompt e modelo de dados (+ testes)
  lib/server/               env validado (zod), clientes AWS/Gemini, acesso ao DynamoDB
infra/
  lib/docchat-stack.ts      S3, SQS + DLQ, Lambda, DynamoDB, alarme e role do Amplify (CDK)
  lambda/ingest.ts          pipeline de ingestão
amplify.yml                 build do Next.js no Amplify Hosting
.github/workflows/ci.yml    tipos, lint, testes, build e cdk synth
```

## Como rodar

Pré-requisitos: Node 22+, uma conta AWS com o [AWS CLI](https://aws.amazon.com/cli/) configurado
(`aws configure`) e uma chave da API do Gemini ([Google AI Studio](https://aistudio.google.com/apikey)).

### 1. Infra na AWS

```bash
# chave do Gemini no Parameter Store (criptografada)
aws ssm put-parameter --name /docchat/gemini-api-key --type SecureString --value "SUA_CHAVE" --region sa-east-1

cd infra
npm ci
npx cdk bootstrap        # só na primeira vez na conta/região
npm run deploy           # anote as saídas: BucketName, TableName, AmplifyComputeRoleArn
```

### 2. App local

```bash
npm ci
cp .env.example .env.local   # preencha DOCS_BUCKET, DOCS_TABLE e GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

Localmente, o app usa as credenciais do `aws configure`. A Lambda de ingestão roda na AWS
mesmo em desenvolvimento.

### 3. Deploy no Amplify Hosting

1. No console do Amplify: **Create new app → GitHub**, escolha este repositório e o branch `main`.
   O `amplify.yml` já é detectado.
2. Em **Environment variables**, cadastre `APP_REGION`, `DOCS_BUCKET`, `DOCS_TABLE` e `GEMINI_API_KEY`.
3. Em **App settings → IAM roles → Compute role**, selecione a role `AmplifyComputeRoleArn`
   (saída do CDK).
4. Libere o domínio do Amplify no CORS do upload e faça o redeploy da infra:

   ```bash
   cd infra
   npx cdk deploy -c allowedOrigins=http://localhost:3000,https://main.SEU_ID.amplifyapp.com
   ```

### Testes e qualidade

```bash
npm test             # Vitest: chunking, vetores, prompt e chaves
npm run typecheck
npm run lint
cd infra && npm run typecheck && npm run synth
```

### Custos e limpeza

Tudo fica no Free Tier ou perto de zero em uso de demonstração (DynamoDB sob demanda, Lambda,
SQS e S3 com expiração em 7 dias). Para apagar tudo: `cd infra && npm run destroy` e remova o
app no console do Amplify.

## Próximos passos

- Busca entre vários documentos com banco vetorial (pgvector, OpenSearch ou S3 Vectors)
- Histórico da conversa no prompt (perguntas de acompanhamento)
- OCR para PDFs escaneados (Amazon Textract)
- Autenticação (Cognito) e limite de uso por usuário

import * as path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_event_sources as sources,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export interface DocChatStackProps extends StackProps {
  /** Origens que podem enviar arquivos direto ao bucket (CORS do upload). */
  allowedOrigins: string[];
  /** Nome do parâmetro SecureString no SSM com a chave da API do Gemini. */
  geminiKeyParam: string;
}

const RETENTION_DAYS = 7; // igual a LIMITS.retentionDays no app
const MAX_RECEIVES = 3;

/**
 * Backend serverless do DocChat:
 *
 *   navegador --POST pré-assinado--> S3 (uploads/*.pdf)
 *        S3 ObjectCreated --> SQS --> Lambda de ingestão --> Gemini (embeddings)
 *                                          |
 *                                          +--> DynamoDB (status + trechos + vetores)
 *        mensagens que falham 3x --> DLQ --> alarme no CloudWatch
 *
 * O app Next.js roda no Amplify Hosting e acessa S3/DynamoDB com o compute role criado aqui.
 */
export class DocChatStack extends Stack {
  constructor(scope: Construct, id: string, props: DocChatStackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, "Docs", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bucket = new s3.Bucket(this, "Uploads", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(RETENTION_DAYS) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: props.allowedOrigins,
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const dlq = new sqs.Queue(this, "IngestDLQ", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, "IngestQueue", {
      // Precisa ser maior que o timeout da Lambda, senão a mensagem volta enquanto ainda processa.
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEIVES },
      enforceSSL: true,
    });

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(queue),
      { prefix: "uploads/", suffix: ".pdf" },
    );

    const geminiKey = ssm.StringParameter.fromSecureStringParameterAttributes(this, "GeminiKey", {
      parameterName: props.geminiKeyParam,
    });

    const ingest = new nodejs.NodejsFunction(this, "Ingest", {
      entry: path.join(__dirname, "..", "lambda", "ingest.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(2),
      environment: {
        DOCS_TABLE: table.tableName,
        GEMINI_KEY_PARAM: props.geminiKeyParam,
        GEMINI_EMBED_MODEL: "gemini-embedding-001",
        MAX_RECEIVES: String(MAX_RECEIVES),
        NODE_OPTIONS: "--enable-source-maps",
      },
      logGroup: new logs.LogGroup(this, "IngestLogs", {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node22",
        minify: true,
        sourceMap: true,
        // O pdf.js usado pelo unpdf ainda chama require() em alguns pontos.
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    ingest.addEventSource(
      new sources.SqsEventSource(queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
        // Limita o paralelismo: protege a cota gratuita do Gemini (2 é o mínimo permitido).
        maxConcurrency: 2,
      }),
    );
    bucket.grantRead(ingest, "uploads/*");
    table.grantReadWriteData(ingest);
    geminiKey.grantRead(ingest);

    new cloudwatch.Alarm(this, "IngestDLQAlarm", {
      alarmDescription: "Há documentos que falharam na ingestão (mensagens na DLQ).",
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Role assumida pelo servidor Next.js no Amplify Hosting (SSR compute role).
    const computeRole = new iam.Role(this, "AmplifyComputeRole", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "Permissões do servidor Next.js do DocChat no Amplify",
    });
    bucket.grantPut(computeRole, "uploads/*");
    computeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
        resources: [table.tableArn],
      }),
    );

    new CfnOutput(this, "BucketName", { value: bucket.bucketName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "AmplifyComputeRoleArn", { value: computeRole.roleArn });
  }
}

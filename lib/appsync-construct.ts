import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "path";
import * as kms from "aws-cdk-lib/aws-kms";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as s3Vectors from "cdk-s3-vectors";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as amplify from "aws-cdk-lib/aws-amplify";

import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { BEDROCK_MODELS, DEFAULT_API_KEY_EXPIRATION_DAYS } from "./constants";
import { CognitoConstruct } from "./cognito-construct";

interface AppSyncConstructProps {}

/**
 * Construct for AppSync API and related resources
 */
export class AppSyncConstruct extends Construct {
  public readonly api: appsync.GraphqlApi;
  public readonly invokeWorkflowFunction: NodejsFunction;
  public readonly saveEmbeddingsFunction: PythonFunction;
  public readonly mediaBucket: s3.Bucket;
  public readonly generateEmbeddingsStateMachine: sfn.StateMachine;
  public readonly vectorBucketName: string;
  public readonly vectorIndexName: string;
  public readonly eventBusName: string;

  constructor(scope: Construct, id: string, props: AppSyncConstructProps = {}) {
    super(scope, id);

    const currentDate = new Date();
    const keyExpirationDate = new Date(
      currentDate.getTime() + DEFAULT_API_KEY_EXPIRATION_DAYS * 24 * 60 * 60 * 1000
    );

    const encryptionKey = new kms.Key(this, "VectorBucketKey", {
      description: "KMS key for S3 vector bucket encryption",
      enableKeyRotation: true,
    });

    this.mediaBucket = new s3.Bucket(this, "VideoMediaBucket", {
      bucketName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-video-media-bucket`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      transferAcceleration: true,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
          ],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
        },
      ],
      lifecycleRules: [
        {
          id: "DeleteOldVersions",
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    const vectorBucket = new s3Vectors.Bucket(this, "VideoAgentVectorBucket", {
      vectorBucketName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-video-agent-vector-bucket`,
      encryptionConfiguration: {
        sseType: "aws:kms",
        kmsKey: encryptionKey,
      },
    });

    const vectorIndex = new s3Vectors.Index(this, "VideoAgentVectorIndex", {
      vectorBucketName: vectorBucket.vectorBucketName,
      indexName: "video-agent-vector-index",
      dataType: "float32",
      dimension: 1024,
      distanceMetric: "cosine",
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["source", "timestamp", "category"],
      },
    });
    vectorIndex.node.addDependency(vectorBucket);

    this.vectorBucketName = vectorBucket.vectorBucketName;
    this.vectorIndexName = vectorIndex.indexName;

    const videoAssetsTable = new dynamodb.Table(this, "VideoAssetsTable", {
      tableName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-video-assets-table`,
      partitionKey: { name: "videoUri", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const coursesTable = new dynamodb.Table(this, "CoursesTable", {
      tableName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-courses-table`,
      partitionKey: { name: "courseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const chatSessionsTable = new dynamodb.Table(this, "ChatSessionsTable", {
      tableName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-chat-sessions-table`,
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const contentDemandTelemetryTable = new dynamodb.Table(this, "ContentDemandTelemetryTable", {
      tableName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-content-demand-telemetry`,
      partitionKey: { name: "requestId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const chatEvaluationsTable = new dynamodb.Table(this, "ChatEvaluationsTable", {
      tableName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-chat-evaluations-table`,
      partitionKey: { name: "evaluationId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Immutable audit log of every user prompt sent to the chatbot.
    // Partitioned by sessionId with a timestamp sort key so all prompts for a
    // session are retrievable in order; a TTL attribute lets old records expire.
    const promptAuditTable = new dynamodb.Table(this, "PromptAuditTable", {
      tableName: `${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}-prompt-audit-table`,
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const tutorGuardrail = new bedrock.CfnGuardrail(this, "TutorGuardrail", {
      name: `TutorGuardrail-${cdk.Stack.of(this).stackName}-${cdk.Stack.of(this).region}`,
      description: "Guardrails for Educloud Tutor Agent",
      blockedInputMessaging: "I am an educational tutor and can only assist with course-related, cloud development, and educational questions.",
      blockedOutputsMessaging: "I am an educational tutor and can only assist with course-related, cloud development, and educational questions.",
      topicPolicyConfig: {
        topicsConfig: [
          {
            name: "Politics",
            definition: "Any discussion, opinions, or queries regarding politics, election campaigns, candidates, or government policies unrelated to cloud computing.",
            type: "DENY"
          },
          {
            name: "Financial Advice",
            definition: "Providing financial recommendations, investment advice, stock predictions, or commercial business advice.",
            type: "DENY"
          }
        ]
      },
      contentPolicyConfig: {
        filtersConfig: [
          { type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" },
          { type: "SEXUAL", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "VIOLENCE", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "HATE", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "INSULTS", inputStrength: "HIGH", outputStrength: "HIGH" }
        ]
      }
    });

    const tutorGuardrailVersion = new bedrock.CfnGuardrailVersion(this, "TutorGuardrailVersionV6", {
      guardrailIdentifier: tutorGuardrail.attrGuardrailId,
      description: "Updated version of TutorGuardrail with refined topics"
    });


    const cognitoResources = new CognitoConstruct(this, "CognitoResources");

    this.api = new appsync.GraphqlApi(this, "video-agent-api", {
      name: "video-agent-api",
      schema: appsync.SchemaFile.fromAsset(path.join(__dirname, "../schema.graphql")),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY,
          apiKeyConfig: {
            expires: cdk.Expiration.atDate(keyExpirationDate),
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.USER_POOL,
            userPoolConfig: {
              userPool: cognitoResources.userPool,
            },
          },
          {
            authorizationType: appsync.AuthorizationType.IAM,
          },
        ],
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ALL,
      },
    });

    const noneDs = this.api.addNoneDataSource("None");

    const approveVideoFunctionLogs = new logs.LogGroup(this, "approveVideoFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
        const embeddingsFunctionLogs = new logs.LogGroup(this, "embeddingsFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const invokeWorkflowFunctionLogs = new logs.LogGroup(this, "invokeWorkflowFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const transcribeFunctionLogs = new logs.LogGroup(this, "transcribeFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const translateFunctionLogs = new logs.LogGroup(this, "translateFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const segmentSyllabusFunctionLogs = new logs.LogGroup(this, "segmentSyllabusFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const sliceSegmentFunctionLogs = new logs.LogGroup(this, "sliceSegmentFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const generateAssetsFunctionLogs = new logs.LogGroup(this, "generateAssetsFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const saveDraftFunctionLogs = new logs.LogGroup(this, "saveDraftFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const strandsMultiAgentFunctionLogs = new logs.LogGroup(this, "strandsMultiAgentFunctionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const durableCourseIngestionLogs = new logs.LogGroup(this, "durableCourseIngestionLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const askChatbotLogs = new logs.LogGroup(this, "askChatbotLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const generateContentLogs = new logs.LogGroup(this, "generateContentLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });


    this.saveEmbeddingsFunction = new PythonFunction(this, "saveEmbeddingsFunction", {
      entry: "./src/py/",
      handler: "lambda_handler",
      index: "save_embeddings.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 512,
      timeout: cdk.Duration.minutes(10),
      logGroup: embeddingsFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName,
        VECTOR_INDEX_NAME: vectorIndex.indexName,
        SOURCE_BUCKET_NAME: this.mediaBucket.bucketName,
      },
    });

    const ffmpegLayer = new lambda.LayerVersion(this, "FfmpegLayer", {
      code: lambda.Code.fromAsset("layers/ffmpeg"),
      description: "Local FFmpeg executable layer",
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
    });

    const putEventsPolicy = new iam.PolicyStatement({
      actions: ["events:PutEvents"],
      resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/VideoAgentEventBus`],
    });

    const transcribeFunction = new PythonFunction(this, "transcribeFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "transcribe.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.minutes(5),
      logGroup: transcribeFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: videoAssetsTable.tableName,
      },
    });
    transcribeFunction.addToRolePolicy(putEventsPolicy);
    transcribeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"],
        resources: ["*"],
      })
    );
    this.mediaBucket.grantRead(transcribeFunction);

    const translateFunction = new PythonFunction(this, "translateFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "translate.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.minutes(5),
      logGroup: translateFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: videoAssetsTable.tableName,
      },
    });
    translateFunction.addToRolePolicy(putEventsPolicy);
    translateFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["translate:TranslateText"],
        resources: ["*"],
      })
    );

    const segmentSyllabusFunction = new PythonFunction(this, "segmentSyllabusFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "segment_syllabus.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.minutes(5),
      logGroup: segmentSyllabusFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: videoAssetsTable.tableName,
      },
    });
    segmentSyllabusFunction.addToRolePolicy(putEventsPolicy);
    segmentSyllabusFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
      })
    );

    const sliceSegmentFunction = new PythonFunction(this, "sliceSegmentFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "slice_segment.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      timeout: cdk.Duration.minutes(10),
      logGroup: sliceSegmentFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      layers: [ffmpegLayer],
    });
    sliceSegmentFunction.addToRolePolicy(putEventsPolicy);
    this.mediaBucket.grantReadWrite(sliceSegmentFunction);

    const generateAssetsFunction = new PythonFunction(this, "generateAssetsFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "generate_assets.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.minutes(10),
      logGroup: generateAssetsFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
    });
    generateAssetsFunction.addToRolePolicy(putEventsPolicy);
    generateAssetsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:ListAgentRuntimes",
          "bedrock-agentcore-control:ListAgentRuntimes",
          "translate:TranslateText",
        ],
        resources: ["*"],
      })
    );

    const saveDraftFunction = new PythonFunction(this, "saveDraftFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "save_draft.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.minutes(5),
      logGroup: saveDraftFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: videoAssetsTable.tableName,
      },
    });
    saveDraftFunction.addToRolePolicy(putEventsPolicy);
    videoAssetsTable.grantReadWriteData(saveDraftFunction);
    videoAssetsTable.grantReadWriteData(transcribeFunction);
    videoAssetsTable.grantReadWriteData(translateFunction);
    videoAssetsTable.grantReadWriteData(segmentSyllabusFunction);

    const strandsMultiAgentFunction = new PythonFunction(this, "strandsMultiAgentFunction", {
      entry: "./src/py/",
      handler: "lambda_handler",
      index: "strands_multi_agent.py",
      runtime: lambda.Runtime.PYTHON_3_13,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      logGroup: strandsMultiAgentFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: videoAssetsTable.tableName,
      },
      durableConfig: {
        executionTimeout: cdk.Duration.hours(1),
        retentionPeriod: cdk.Duration.days(7),
      },
    });

    const strandsMultiAgentVersion = strandsMultiAgentFunction.currentVersion;

    // S3 permissions
    this.mediaBucket.grantReadWrite(strandsMultiAgentFunction);

    // Transcribe permissions
    strandsMultiAgentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // EventBridge permissions
    strandsMultiAgentFunction.addToRolePolicy(putEventsPolicy);

    // Bedrock permissions
    strandsMultiAgentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // Bedrock AgentCore Control and Runtime permissions
    strandsMultiAgentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:ListAgentRuntimes",
          "bedrock-agentcore:InvokeAgentRuntime"
        ],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // Recursive self-invocation for Durable execution
    strandsMultiAgentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    const durableCourseIngestionFunction = new PythonFunction(this, "durableCourseIngestionFunction", {
      entry: "./src/py/",
      handler: "lambda_handler",
      index: "durable_course_ingestion.py",
      runtime: lambda.Runtime.PYTHON_3_13,
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      logGroup: durableCourseIngestionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        COURSES_TABLE_NAME: coursesTable.tableName,
        VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName,
        VECTOR_INDEX_NAME: vectorIndex.indexName,
      },
      durableConfig: {
        executionTimeout: cdk.Duration.hours(1),
        retentionPeriod: cdk.Duration.days(7),
      },
    });

    const durableCourseIngestionVersion = durableCourseIngestionFunction.currentVersion;

    this.mediaBucket.grantReadWrite(durableCourseIngestionFunction);
    coursesTable.grantReadWriteData(durableCourseIngestionFunction);

    durableCourseIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    durableCourseIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:PutVectors"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    durableCourseIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    encryptionKey.grantEncryptDecrypt(durableCourseIngestionFunction);

    const askChatbotFunction = new PythonFunction(this, "askChatbotFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "ask_chatbot.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      logGroup: askChatbotLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        COURSES_TABLE_NAME: coursesTable.tableName,
        CHAT_SESSIONS_TABLE_NAME: chatSessionsTable.tableName,
        VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName,
        VECTOR_INDEX_NAME: vectorIndex.indexName,
        CONTENT_DEMAND_TELEMETRY_TABLE_NAME: contentDemandTelemetryTable.tableName,
        CHAT_EVALUATIONS_TABLE_NAME: chatEvaluationsTable.tableName,
        PROMPT_AUDIT_TABLE_NAME: promptAuditTable.tableName,
        TUTOR_GUARDRAIL_ID: tutorGuardrail.attrGuardrailId,
        TUTOR_GUARDRAIL_VERSION: tutorGuardrailVersion.attrVersion,
        APPSYNC_ENDPOINT: this.api.graphqlUrl,
        APPSYNC_API_KEY: this.api.apiKey || "",
        // Media bucket — used by the architecture-review intent to fetch
        // student-uploaded diagrams (PNG/JPG) under `diagrams/`.
        MEDIA_BUCKET_NAME: this.mediaBucket.bucketName,
      },
    });

    coursesTable.grantReadData(askChatbotFunction);
    chatSessionsTable.grantReadWriteData(askChatbotFunction);
    contentDemandTelemetryTable.grantReadWriteData(askChatbotFunction);
    chatEvaluationsTable.grantReadData(askChatbotFunction);
    promptAuditTable.grantWriteData(askChatbotFunction);
    this.mediaBucket.grantRead(askChatbotFunction);

    askChatbotFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:QueryVectors", "s3vectors:GetIndex", "s3vectors:GetVectors", "s3vectors:PutVectors"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    askChatbotFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:ApplyGuardrail", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    encryptionKey.grantDecrypt(askChatbotFunction);

    // Overnight Evaluation LLM-as-a-Judge Lambda
    const evaluateChatlogsLogs = new logs.LogGroup(this, "EvaluateChatlogsLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const evaluateChatlogsFunction = new PythonFunction(this, "evaluateChatlogsFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "evaluate_chatlogs.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      logGroup: evaluateChatlogsLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        CHAT_SESSIONS_TABLE_NAME: chatSessionsTable.tableName,
        CHAT_EVALUATIONS_TABLE_NAME: chatEvaluationsTable.tableName,
      },
    });

    chatSessionsTable.grantReadData(evaluateChatlogsFunction);
    chatEvaluationsTable.grantReadWriteData(evaluateChatlogsFunction);

    evaluateChatlogsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    // Schedule daily overnight evaluation trigger at midnight
    const dailyEvaluationRule = new events.Rule(this, "DailyEvaluationRule", {
      schedule: events.Schedule.cron({ minute: "0", hour: "0" }),
      description: "Trigger the LLM-as-a-Judge overnight evaluation daily at midnight"
    });
    dailyEvaluationRule.addTarget(new targets.LambdaFunction(evaluateChatlogsFunction));

    const generateContentFunction = new PythonFunction(this, "generateContentFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "generate_content.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: generateContentLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        COURSES_TABLE_NAME: coursesTable.tableName,
      },
    });

    coursesTable.grantReadWriteData(generateContentFunction);

    generateContentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    const triggerCourseIngestionFunction = new PythonFunction(this, "triggerCourseIngestionFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "trigger_course_ingestion.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: cdk.Duration.seconds(30),
      environment: {
        DURABLE_COURSE_INGESTION_ARN: durableCourseIngestionVersion.functionArn,
      },
    });

    triggerCourseIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          durableCourseIngestionFunction.functionArn,
          `${durableCourseIngestionFunction.functionArn}:*`
        ],
        effect: iam.Effect.ALLOW,
      })
    );



    const stateMachineRole = new iam.Role(this, "StateMachineRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      description: "IAM Role assumed by the Step Functions state machine",
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(this, "LambdaRolePolicy", `arn:${cdk.Stack.of(this).partition}:iam::aws:policy/service-role/AWSLambdaRole`),
      ],
    });

    this.generateEmbeddingsStateMachine = new sfn.StateMachine(this, "GenerateEmbeddingsStateMachine", {
      definitionBody: sfn.DefinitionBody.fromFile(
        path.join(__dirname, "../workflow/generate_embeddings.asl.json")
      ),
      definitionSubstitutions: {
        FUNCTION_ARN: this.saveEmbeddingsFunction.functionArn,
        TRANSLATE_FUNCTION_ARN: translateFunction.functionArn,
        SEGMENT_SYLLABUS_FUNCTION_ARN: segmentSyllabusFunction.functionArn,
        SLICE_SEGMENT_FUNCTION_ARN: sliceSegmentFunction.functionArn,
        GENERATE_ASSETS_FUNCTION_ARN: generateAssetsFunction.functionArn,
        SAVE_DRAFT_FUNCTION_ARN: saveDraftFunction.functionArn,
      },
      role: stateMachineRole,
      tracingEnabled: true,
      logs: {
        destination: new cdk.aws_logs.LogGroup(this, "WithContextLogGroup", {
          logGroupName: "/aws/vendedlogs/states/GenerateEmbeddingsStateMachine",
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    this.mediaBucket.grantReadWrite(stateMachineRole);
    stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          this.saveEmbeddingsFunction.functionArn,
          translateFunction.functionArn,
          segmentSyllabusFunction.functionArn,
          sliceSegmentFunction.functionArn,
          generateAssetsFunction.functionArn,
          saveDraftFunction.functionArn,
        ],
        effect: iam.Effect.ALLOW,
      })
    );
    stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:StartAsyncInvoke", "bedrock:GetAsyncInvoke"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob"
        ],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/VideoAgentEventBus`],
        effect: iam.Effect.ALLOW,
      })
    );


    this.invokeWorkflowFunction = new NodejsFunction(this, "invokeWorkflowFunction", {
      entry: path.join(__dirname, "../src/ts/invokeWorkflowFunction.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      logGroup: invokeWorkflowFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        STATE_MACHINE_ARN: this.generateEmbeddingsStateMachine.stateMachineArn,
        SOURCE_BUCKET_NAME: this.mediaBucket.bucketName,
        DURABLE_ORCHESTRATOR_ARN: strandsMultiAgentVersion.functionArn,
      },
      bundling: {
        minify: true,
      },
    });

    const approveVideoFunction = new PythonFunction(this, "approveVideoDurableFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "approve_video.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 1024,
      logGroup: approveVideoFunctionLogs,
      tracing: lambda.Tracing.ACTIVE,
    });

    approveVideoFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:SendDurableExecutionCallbackSuccess", "lambda:SendDurableExecutionCallbackFailure"],
        resources: ["*"],
      })
    );

    this.mediaBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.invokeWorkflowFunction),
      {
        prefix: "videos/",
      }
    );

    this.mediaBucket.grantReadWrite(this.invokeWorkflowFunction);
    this.invokeWorkflowFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["states:StartExecution", "states:DescribeExecution"],
        resources: [this.generateEmbeddingsStateMachine.stateMachineArn],
        effect: iam.Effect.ALLOW,
      })
    );
    this.invokeWorkflowFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          strandsMultiAgentFunction.functionArn,
          `${strandsMultiAgentFunction.functionArn}:*`
        ],
        effect: iam.Effect.ALLOW,
      })
    );

    this.saveEmbeddingsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [this.mediaBucket.bucketArn, `${this.mediaBucket.bucketArn}/*`],
      })
    );

    this.saveEmbeddingsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3vectors:PutVectors"],
        resources: ["*"],
      })
    );
    encryptionKey.grantEncryptDecrypt(this.saveEmbeddingsFunction);

    const videoAgentEventBus = new cdk.aws_events.EventBus(this, "VideoAgentEventBus", {
      eventBusName: "VideoAgentEventBus",
    });

    const appSyncEventBridgeRole = new iam.Role(this, "AppSyncEventBridgeRole", {
      assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
      description: "Role for EventBridge to invoke AppSync mutations",
    });

    appSyncEventBridgeRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [`${this.api.arn}/types/Mutation/*`],
      })
    );

    const statusRule = new events.Rule(this, "VideoStatusRule", {
      eventBus: videoAgentEventBus,
      eventPattern: {
        source: ["video.pipeline"],
        detailType: ["video.processing.status"],
      },
    });

    statusRule.addTarget(
      new targets.AppSync(this.api, {
        graphQLOperation: `
          mutation UpdateVideoStatus(
            $requestId: String!
            $status: String!
            $message: String
            $callbackId: String
            $videoUrl: String
          ) {
            updateVideoStatus(
              requestId: $requestId
              status: $status
              message: $message
              callbackId: $callbackId
              videoUrl: $videoUrl
            ) {
              requestId
              status
              message
              callbackId
              videoUrl
            }
          }
        `,
        variables: events.RuleTargetInput.fromObject({
          requestId: events.EventField.fromPath("$.detail.requestId"),
          status: events.EventField.fromPath("$.detail.status"),
          message: events.EventField.fromPath("$.detail.message"),
          callbackId: events.EventField.fromPath("$.detail.callbackId"),
          videoUrl: events.EventField.fromPath("$.detail.videoUrl"),
        }),
        eventRole: appSyncEventBridgeRole,
      })
    );

    const logsGroup = new logs.LogGroup(this, "VideoAgentEventBusLogGroup", {
      logGroupName: "/aws/events/VideoAgentEventBus/logs",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new events.Rule(this, "CatchAllLogRule", {
      ruleName: "catch-all-events",
      eventBus: videoAgentEventBus,
      eventPattern: {
        source: events.Match.prefix(""),
      },
      targets: [new targets.CloudWatchLogGroup(logsGroup)],
    });

    this.eventBusName = videoAgentEventBus.eventBusName;

    const invokeSearchCutWorkflowFunction = new PythonFunction(this, "invokeSearchCutWorkflowFunction", {
      entry: "./src/py/",
      handler: "handler",
      index: "invoke_search_cut_workflow.py",
      runtime: lambda.Runtime.PYTHON_3_12,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: {
        SEARCH_CUT_WORKFLOW_FUNCTION_ARN: `arn:aws:lambda:us-east-1:${cdk.Stack.of(this).account}:function:SearchCutWorkflowFunction:prod`,
        TARGET_REGION: "us-east-1",
      },
    });

    invokeSearchCutWorkflowFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: ["*"],
        effect: iam.Effect.ALLOW,
      })
    );

    const getUploadUrlFunction = new NodejsFunction(this, "getUploadUrlFunction", {
      entry: path.join(__dirname, "../src/ts/getUploadUrl.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 256,
      environment: {
        BUCKET_NAME: this.mediaBucket.bucketName,
      },
      bundling: {
        minify: true,
        externalModules: ["@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
      },
    });

    this.mediaBucket.grantReadWrite(getUploadUrlFunction);

    this.api.createResolver("UpdateVideoStatus", {
      typeName: "Mutation",
      fieldName: "updateVideoStatus",
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      dataSource: noneDs,
      code: appsync.Code.fromAsset("./resolvers/updateVideoStatus.js"),
    });

    this.api.createResolver("PublishChatbotChunkResolver", {
      typeName: "Mutation",
      fieldName: "publishChatbotChunk",
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      dataSource: noneDs,
      code: appsync.Code.fromAsset("./resolvers/updateVideoStatus.js"),
    });

    this.api
      .addLambdaDataSource("approveVideoDataSource", approveVideoFunction)
      .createResolver("approveVideoFunctionResolver", {
        typeName: "Mutation",
        fieldName: "approveVideo",
        code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
        runtime: appsync.FunctionRuntime.JS_1_0_0,
      });

    this.api
      .addLambdaDataSource("invokeSearchCutWorkflowFunction", invokeSearchCutWorkflowFunction)
      .createResolver("invokeSearchCutWorkflowFunctionResolver", {
        typeName: "Mutation",
        fieldName: "search",
        code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
        runtime: appsync.FunctionRuntime.JS_1_0_0,
      });

    const getUploadUrlDs = this.api.addLambdaDataSource("getUploadUrlDataSource", getUploadUrlFunction);
    
    getUploadUrlDs.createResolver("getUploadUrlResolver", {
      typeName: "Mutation",
      fieldName: "getUploadUrl",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    getUploadUrlDs.createResolver("getDiagramUploadUrlResolver", {
      typeName: "Mutation",
      fieldName: "getDiagramUploadUrl",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    getUploadUrlDs.createResolver("initiateMultipartUploadResolver", {
      typeName: "Mutation",
      fieldName: "initiateMultipartUpload",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    getUploadUrlDs.createResolver("getMultipartUploadPartUrlsResolver", {
      typeName: "Mutation",
      fieldName: "getMultipartUploadPartUrls",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    getUploadUrlDs.createResolver("completeMultipartUploadResolver", {
      typeName: "Mutation",
      fieldName: "completeMultipartUpload",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    getUploadUrlDs.createResolver("getVideoUrlResolver", {
      typeName: "Query",
      fieldName: "getVideoUrl",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const videoAssetsDs = this.api.addDynamoDbDataSource("VideoAssetsDataSource", videoAssetsTable);
    
    this.api.createResolver("GetVideoAssetsResolver", {
      typeName: "Query",
      fieldName: "getVideoAssets",
      dataSource: videoAssetsDs,
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset("./resolvers/getVideoAssets.js"),
    });

    this.api.createResolver("ListVideoAssetsResolver", {
      typeName: "Query",
      fieldName: "listVideoAssets",
      dataSource: videoAssetsDs,
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset("./resolvers/listVideoAssets.js"),
    });

    this.api.createResolver("SaveDraftEditsResolver", {
      typeName: "Mutation",
      fieldName: "saveDraftEdits",
      dataSource: videoAssetsDs,
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset("./resolvers/saveDraftEdits.js"),
    });

    const coursesDs = this.api.addDynamoDbDataSource("CoursesDataSource", coursesTable);
    
    this.api.createResolver("ListCoursesResolver", {
      typeName: "Query",
      fieldName: "listCourses",
      dataSource: coursesDs,
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset("./resolvers/listCourses.js"),
    });

    this.api.createResolver("GetCourseResolver", {
      typeName: "Query",
      fieldName: "getCourse",
      dataSource: coursesDs,
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset("./resolvers/getCourse.js"),
    });

    const askChatbotDs = this.api.addLambdaDataSource("AskChatbotDataSource", askChatbotFunction);
    askChatbotDs.createResolver("AskCourseChatbotResolver", {
      typeName: "Query",
      fieldName: "askCourseChatbot",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });
    askChatbotDs.createResolver("DemystifyJargonResolver", {
      typeName: "Query",
      fieldName: "demystifyJargon",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });
    askChatbotDs.createResolver("GetContentDemandTelemetryResolver", {
      typeName: "Query",
      fieldName: "getContentDemandTelemetry",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });
    askChatbotDs.createResolver("GetChatEvaluationsResolver", {
      typeName: "Query",
      fieldName: "getChatEvaluations",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const triggerCourseIngestionDs = this.api.addLambdaDataSource("TriggerCourseIngestionDataSource", triggerCourseIngestionFunction);
    triggerCourseIngestionDs.createResolver("TriggerCourseIngestionResolver", {
      typeName: "Mutation",
      fieldName: "triggerCourseIngestion",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const generateContentDs = this.api.addLambdaDataSource("GenerateContentDataSource", generateContentFunction);
    generateContentDs.createResolver("GenerateQuizForLessonResolver", {
      typeName: "Mutation",
      fieldName: "generateQuizForLesson",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });
    generateContentDs.createResolver("GenerateFlashcardsForLessonResolver", {
      typeName: "Mutation",
      fieldName: "generateFlashcardsForLesson",
      code: appsync.Code.fromAsset(path.join(__dirname, "../resolvers/invoke/invoke.js")),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });


    this.api.addEnvironmentVariable("FOUNDATION_MODEL_ARN", BEDROCK_MODELS.CLAUDE_3_5_SONNET);

    // AWS Amplify App for manual deployment
    const amplifyApp = new amplify.CfnApp(this, "EducloudWorkflowPortalApp", {
      name: "educloud-workflow-portal",
      platform: "WEB",
    });

    const mainBranch = new amplify.CfnBranch(this, "EducloudWorkflowPortalMainBranch", {
      appId: amplifyApp.attrAppId,
      branchName: "main",
      enableAutoBuild: false,
    });

    new cdk.CfnOutput(this, "GraphQLAPIEndpoint", {
      value: this.api.graphqlUrl,
      description: " The GraphQL API Endpoint",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: cognitoResources.userPool.userPoolId,
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: cognitoResources.userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, "GraphQLAPIKey", {
      value: this.api.apiKey || "",
    });

    new cdk.CfnOutput(this, "MediaBucketName", {
      value: this.mediaBucket.bucketName,
    });

    new cdk.CfnOutput(this, "AmplifyAppId", {
      value: amplifyApp.attrAppId,
    });

    new cdk.CfnOutput(this, "AmplifyBranchName", {
      value: mainBranch.branchName,
    });
  }
}

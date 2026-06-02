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

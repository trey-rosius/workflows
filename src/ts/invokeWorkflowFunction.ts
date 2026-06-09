import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { S3Event } from "aws-lambda";

const lambdaClient = new LambdaClient({});
const durableOrchestratorArn = process.env.DURABLE_ORCHESTRATOR_ARN!;

export const handler = async (event: S3Event) => {
  console.log("Received S3 event:", JSON.stringify(event));

  for (const record of event.Records) {
    const bucketName = record.s3.bucket.name;
    const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // e.g. s3://my-bucket/videos/file.mp4
    const mediaFileUri = `s3://${bucketName}/${objectKey}`;

    console.log(`Invoking Durable Orchestrator ${durableOrchestratorArn} for ${mediaFileUri}`);

    try {
      const command = new InvokeCommand({
        FunctionName: durableOrchestratorArn,
        InvocationType: "Event", // Asynchronous invocation
        Payload: Buffer.from(
          JSON.stringify({
            mediaFileUri: mediaFileUri,
          })
        ),
      });

      const response = await lambdaClient.send(command);
      console.log("Successfully invoked Durable Orchestrator:", response.StatusCode);
    } catch (error) {
      console.error("Error invoking Durable Orchestrator:", error);
      throw error;
    }
  }
};


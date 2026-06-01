import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { S3Event } from "aws-lambda";

const sfnClient = new SFNClient({});
const stateMachineArn = process.env.STATE_MACHINE_ARN!;
const sourceBucketName = process.env.SOURCE_BUCKET_NAME!;

export const handler = async (event: S3Event) => {
  console.log("Received S3 event:", JSON.stringify(event));

  for (const record of event.Records) {
    const bucketName = record.s3.bucket.name;
    const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    // e.g. s3://my-bucket/videos/file.mp4
    const mediaFileUri = `s3://${bucketName}/${objectKey}`;
    // Save Bedrock output files under embeddings/ in the same bucket
    const mediaBucket = `s3://${bucketName}/embeddings/`;

    console.log(`Starting step functions for ${mediaFileUri} in bucket ${mediaBucket}`);

    try {
      const command = new StartExecutionCommand({
        stateMachineArn: stateMachineArn,
        input: JSON.stringify({
          mediaFileUri: mediaFileUri,
          mediaBucket: mediaBucket,
        }),
      });

      const response = await sfnClient.send(command);
      console.log("Successfully started Step Functions execution:", response.executionArn);
    } catch (error) {
      console.error("Error starting execution:", error);
      throw error;
    }
  }
};

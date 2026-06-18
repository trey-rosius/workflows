import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3Client = new S3Client({ useAccelerateEndpoint: true });
const bucketName = process.env.BUCKET_NAME!;

export const handler = async (event: any) => {
  console.log("Received event:", JSON.stringify(event));
  
  const fieldName = event.info?.fieldName;
  
  if (fieldName === "getUploadUrl") {
    const fileName = event.arguments?.fileName || `video-${Date.now()}.mp4`;
    const contentType = event.arguments?.contentType || "video/mp4";
    const key = `videos/${fileName}`;

    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      return {
        url: uploadUrl,
        fileName: fileName,
      };
    } catch (error: any) {
      console.error("Error generating presigned upload URL:", error);
      throw error;
    }
  } else if (fieldName === "getDiagramUploadUrl") {
    // Student-uploaded architecture diagrams reviewed by the chatbot.
    const fileName = event.arguments?.fileName || `diagram-${Date.now()}.png`;
    const contentType = event.arguments?.contentType || "image/png";
    const key = `diagrams/${fileName}`;

    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      return {
        url: uploadUrl,
        fileName: key,  // Return the full key so the client can pass it to askCourseChatbot.
      };
    } catch (error: any) {
      console.error("Error generating presigned diagram upload URL:", error);
      throw error;
    }
  } else if (fieldName === "getVideoUrl") {
    const videoUri = event.arguments?.videoUri;
    if (!videoUri) throw new Error("videoUri argument is required");
    
    // Parse key from videoUri (e.g. s3://bucket-name/videos/filename.mp4)
    let key = videoUri;
    if (videoUri.startsWith("s3://")) {
      const s3Path = videoUri.replace("s3://", "");
      const parts = s3Path.split("/");
      parts.shift(); // Remove the bucket name part
      key = parts.join("/");
    }
    
    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      return downloadUrl;
    } catch (error: any) {
      console.error("Error generating presigned download URL:", error);
      throw error;
    }
  } else if (fieldName === "initiateMultipartUpload") {
    const fileName = event.arguments?.fileName || `video-${Date.now()}.mp4`;
    const contentType = event.arguments?.contentType || "video/mp4";
    const key = `videos/${fileName}`;

    try {
      const command = new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        ContentType: contentType,
      });
      const response = await s3Client.send(command);
      return {
        uploadId: response.UploadId,
        key: key,
      };
    } catch (error: any) {
      console.error("Error initiating multipart upload:", error);
      throw error;
    }
  } else if (fieldName === "getMultipartUploadPartUrls") {
    const uploadId = event.arguments?.uploadId;
    const key = event.arguments?.key;
    const partCount = event.arguments?.partCount;

    if (!uploadId || !key || !partCount) {
      throw new Error("Missing required arguments for getMultipartUploadPartUrls");
    }

    try {
      const partUrls = [];
      for (let i = 1; i <= partCount; i++) {
        const command = new UploadPartCommand({
          Bucket: bucketName,
          Key: key,
          UploadId: uploadId,
          PartNumber: i,
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        partUrls.push({
          partNumber: i,
          url: url,
        });
      }
      return partUrls;
    } catch (error: any) {
      console.error("Error generating multipart upload part URLs:", error);
      throw error;
    }
  } else if (fieldName === "completeMultipartUpload") {
    const uploadId = event.arguments?.uploadId;
    const key = event.arguments?.key;
    const parts = event.arguments?.parts;

    if (!uploadId || !key || !parts) {
      throw new Error("Missing required arguments for completeMultipartUpload");
    }

    try {
      const command = new CompleteMultipartUploadCommand({
        Bucket: bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p: any) => ({
            PartNumber: p.partNumber,
            ETag: p.eTag,
          })),
        },
      });
      await s3Client.send(command);
      return true;
    } catch (error: any) {
      console.error("Error completing multipart upload:", error);
      throw error;
    }
  }
  
  throw new Error(`Unsupported query/mutation: ${fieldName}`);
};

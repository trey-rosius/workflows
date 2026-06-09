import json
import boto3
import os

target_region = os.environ.get('AWS_REGION', 'us-east-1')
lambda_client = boto3.client('lambda', region_name=target_region)
DURABLE_COURSE_INGESTION_ARN = os.environ.get('DURABLE_COURSE_INGESTION_ARN')

def handler(event, context):
    print(f"Received trigger course ingestion event: {json.dumps(event)}")
    
    s3_zip_key = event.get('arguments', {}).get('s3ZipKey')
    if not s3_zip_key:
        print("Missing s3ZipKey argument")
        return False

    try:
        payload = json.dumps({"s3ZipKey": s3_zip_key})
        
        response = lambda_client.invoke(
            FunctionName=DURABLE_COURSE_INGESTION_ARN,
            InvocationType='Event',
            Payload=payload
        )
        
        print(f"Invoked Durable Ingestion Orchestrator: {response}")
        return True
    
    except Exception as e:
        print(f"Error invoking Durable Ingestion Orchestrator: {e}")
        return False

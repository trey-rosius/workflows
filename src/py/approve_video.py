import json
import boto3
import os
from botocore.exceptions import ClientError

# Initialize Lambda Client
lambda_client = boto3.client('lambda')

def handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    
    # AppSync invokes the lambda with "arguments"
    arguments = event.get('arguments', {})
    callback_id = arguments.get('callbackId') or arguments.get('requestId')
    approved = arguments.get('approved', False)
    
    if not callback_id:
        print("No callbackId/requestId provided")
        return {
            "success": False,
            "message": "Missing callbackId or requestId"
        }

    try:
        if approved:
            response = lambda_client.send_durable_execution_callback_success(
                CallbackId=callback_id,
                Result=json.dumps({"status": "Approved"}).encode('utf-8')
            )
        else:
            response = lambda_client.send_durable_execution_callback_failure(
                CallbackId=callback_id,
                Error="Rejected",
                Cause="User rejected the video"
            )
        
        print(f"Durable execution callback sent successfully: {response}")
        return True
    
    except Exception as e:
        print(f"Error sending callback: {e}")
        return False

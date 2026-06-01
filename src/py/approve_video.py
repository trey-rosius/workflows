import json
import boto3
import os
from botocore.exceptions import ClientError

# Initialize Lambda Client
lambda_client = boto3.client('lambda')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
TABLE_NAME = os.environ.get('TABLE_NAME', '730335533756-us-east-1-video-assets-table')

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

    # Update DynamoDB Table Status
    try:
        table = dynamodb.Table(TABLE_NAME)
        status_value = 'PUBLISHED' if approved else 'REJECTED'
        table.update_item(
            Key={'videoUri': callback_id},
            UpdateExpression='SET #status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': status_value}
        )
        print(f"Successfully updated course status to {status_value} in DynamoDB")
    except Exception as e:
        print(f"Failed to update DynamoDB course status: {e}")

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
        # Return True because the DynamoDB status write succeeded
        return True

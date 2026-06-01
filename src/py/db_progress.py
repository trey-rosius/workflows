import boto3
import os

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
TABLE_NAME = os.environ.get('TABLE_NAME')
table = dynamodb.Table(TABLE_NAME) if TABLE_NAME else None

def update_progress(video_uri: str, status: str, message: str):
    """
    Updates the status and progress message in the DynamoDB table.
    If the item does not exist, DynamoDB will create it (upsert).
    """
    if not table:
        print("DynamoDB Table not initialized.")
        return
    try:
        table.update_item(
            Key={'videoUri': video_uri},
            UpdateExpression='SET #status = :status, #msg = :msg',
            ExpressionAttributeNames={'#status': 'status', '#msg': 'message'},
            ExpressionAttributeValues={':status': status, ':msg': message}
        )
        print(f"DynamoDB status updated: {status} - {message}")
    except Exception as e:
        print(f"Failed to update DynamoDB status: {e}")

import boto3
import json
import os

events_client = boto3.client('events', region_name='us-east-1')
EVENT_BUS_NAME = "VideoAgentEventBus"

def publish_status(request_id: str, status: str, message: str, video_url: str = ""):
    """
    Publishes a status update event to the EventBridge EventBus.
    This triggers AppSync subscription updates to the frontend.
    """
    try:
        events_client.put_events(
            Entries=[
                {
                    'Source': 'video.pipeline',
                    'DetailType': 'video.processing.status',
                    'Detail': json.dumps({
                        'requestId': request_id,
                        'status': status,
                        'message': message,
                        'videoUrl': video_url or request_id
                    }),
                    'EventBusName': EVENT_BUS_NAME
                }
            ]
        )
        print(f"Published status event: {status} - {message}")
    except Exception as e:
        print(f"Failed to publish status event: {e}")

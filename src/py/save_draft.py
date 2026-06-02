import boto3
import json
import logging
import os
from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Any
from event_publisher import publish_status

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
TABLE_NAME = os.environ.get('TABLE_NAME')
table = dynamodb.Table(TABLE_NAME) if TABLE_NAME else None

def convert_floats_to_decimals(obj):
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: convert_floats_to_decimals(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [convert_floats_to_decimals(x) for x in obj]
    return obj

def handler(event, context):
    logger.info(f"Save draft event: {json.dumps(event)}")
    
    video_uri = event.get('mediaFileUri')
    title = event.get('title', 'Video Course')
    description = event.get('description', '')
    global_assets = event.get('global_assets', {})
    lessons_raw = event.get('lessons', [])
    
    if not video_uri:
        raise ValueError("Missing mediaFileUri in payload")
        
    publish_status(video_uri, "SAVING_DRAFT", "Compiling course draft and writing to database...")
    
    # Process Map state lesson output list
    lessons_list = []
    for item in lessons_raw:
        lesson = item.get('lesson')
        if lesson:
            lessons_list.append(lesson)
            
    # Sort lessons by startTime
    lessons_list.sort(key=lambda x: float(x.get('startTime', 0)))
    
    # Prepare DynamoDB item
    course_item = {
        'videoUri': video_uri,
        'title': title,
        'description': description,
        'status': 'DRAFT', # Saved as draft for tutor-in-the-loop approval
        'summary': global_assets.get('summary', ''),
        'qa': global_assets.get('qa', ''),
        'flashcards': global_assets.get('flashcards', ''),
        'keyTakeaways': global_assets.get('keyTakeaways', ''),
        'translations': global_assets.get('translations', []),
        'localized': global_assets.get('localized', []),
        'lessons': lessons_list,
        'createdAt': datetime.utcnow().isoformat()
    }
    
    # DynamoDB does not support floats. Recursively convert float values to Decimal.
    course_item = convert_floats_to_decimals(course_item)
    
    if not table:
        raise ValueError("DynamoDB Table is not initialized. Check TABLE_NAME env var.")
        
    try:
        table.put_item(Item=course_item)
        logger.info(f"Successfully saved draft syllabus for videoUri {video_uri} to DynamoDB!")
        publish_status(video_uri, "DRAFT_READY", "Course syllabus draft generated and ready for tutor review.", video_url=video_uri)
        return {
            "statusCode": 200,
            "videoUri": video_uri,
            "title": title,
            "status": "DRAFT",
            "lessonsCount": len(lessons_list)
        }
    except Exception as e:
        logger.error(f"Failed to save item to DynamoDB: {e}")
        publish_status(video_uri, "FAILED", f"Failed to save course draft: {str(e)}")
        raise e

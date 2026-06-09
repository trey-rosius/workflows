import os
import json
import random
import time
import re
import logging
import boto3
from boto3.dynamodb.types import TypeSerializer, TypeDeserializer

# Setup Logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
bedrock_runtime_client = boto3.client('bedrock-runtime', region_name='us-east-1')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')

serializer = TypeSerializer()
deserializer = TypeDeserializer()

COURSES_TABLE_NAME = os.environ.get('COURSES_TABLE_NAME')

def deserialize_item(item):
    return {k: deserializer.deserialize(v) for k, v in item.items()}

def serialize_item(item):
    return {k: serializer.serialize(v) for k, v in item.items()}

def execute_with_retry(func, max_retries: int = 5, initial_backoff: float = 1.0):
    """Executes a Bedrock or DynamoDB request with exponential backoff and jitter for throttling."""
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            error_name = type(e).__name__
            is_retryable = "Throttling" in error_name or "LimitExceeded" in error_name or "ProvisionedThroughputExceeded" in error_name or "500" in str(e)
            if not is_retryable or attempt == max_retries - 1:
                logger.error(f"Call failed on final attempt/non-retryable error: {e}")
                raise e
            backoff = initial_backoff * (2 ** attempt)
            sleep_time = random.uniform(0, backoff)
            logger.warning(f"Request failed due to {error_name}. Retrying in {sleep_time:.2f} seconds...")
            time.sleep(sleep_time)

def clean_json_string(text: str) -> str:
    """Removes code block markers and trims whitespace to isolate clean JSON."""
    cleaned = text.strip()
    if cleaned.startswith("```json"):
        cleaned = cleaned[7:]
    elif cleaned.startswith("```"):
        cleaned = cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    return cleaned.strip()

def handler(event, context):
    logger.info(f"Received generate content event: {json.dumps(event)}")
    
    # Identify which mutation was triggered
    field_name = event.get('info', {}).get('fieldName')
    arguments = event.get('arguments', {})
    
    course_id = arguments.get('courseId')
    module_id = arguments.get('moduleId')
    lesson_id = arguments.get('lessonId')
    
    if not all([course_id, module_id, lesson_id]):
        raise ValueError("Missing courseId, moduleId, or lessonId in arguments")
        
    logger.info(f"Action: {field_name}, Course: {course_id}, Module: {module_id}, Lesson: {lesson_id}")
    
    # 1. Fetch the course item from DynamoDB
    def fetch_course():
        return dynamodb_client.get_item(
            TableName=COURSES_TABLE_NAME,
            Key={'courseId': {'S': course_id}}
        )
        
    res = execute_with_retry(fetch_course)
    if 'Item' not in res:
        raise ValueError(f"Course {course_id} not found in DynamoDB")
        
    course_data = deserialize_item(res['Item'])
    
    # 2. Find the module and lesson
    target_lesson = None
    for module in course_data.get('modules', []):
        if module.get('moduleId') == module_id:
            for lesson in module.get('lessons', []):
                if lesson.get('lessonId') == lesson_id:
                    target_lesson = lesson
                    break
        if target_lesson:
            break
            
    if not target_lesson:
        raise ValueError(f"Lesson {lesson_id} in module {module_id} not found in course {course_id}")
        
    lesson_content = target_lesson.get('content', '')
    lesson_title = target_lesson.get('title', '')
    
    if not lesson_content:
        logger.warning(f"Lesson content is empty for {lesson_title} ({lesson_id}). Using title/description.")
        lesson_content = f"Title: {lesson_title}\nDescription: {target_lesson.get('description', '')}"

    # 3. Call Bedrock to generate content
    if field_name == "generateQuizForLesson":
        prompt = f"""You are an expert educator. Create a challenging multiple-choice quiz based on the lesson content provided below.
The quiz must contain exactly 5 questions.
Return your output ONLY as a valid JSON array of objects. Do not wrap the JSON in code block formatting (do not include ```json or ```). No introductory or concluding text.

Each object in the array must have exactly these keys:
- "question": The text of the question (string).
- "options": An array of exactly 4 choices (strings).
- "answer": The correct choice (string, must exactly match one of the choices in "options").
- "explanation": A brief explanation of why this answer is correct (string).

Lesson Content:
{lesson_content}"""

    elif field_name == "generateFlashcardsForLesson":
        prompt = f"""You are an expert educator. Create a set of 5 to 8 useful study flashcards based on the lesson content provided below.
Each flashcard should cover a key term, concept, configuration, or API mentioned in the lesson.
Return your output ONLY as a valid JSON array of objects. Do not wrap the JSON in code block formatting (do not include ```json or ```). No introductory or concluding text.

Each object in the array must have exactly these keys:
- "front": The front side of the card (the term, question, or fill-in-the-blank prompt).
- "back": The back side of the card (the definition, answer, or explanation).

Lesson Content:
{lesson_content}"""
    else:
        raise ValueError(f"Unsupported action / fieldName: {field_name}")

    request_body = {
        "messages": [
            {
                "role": "user",
                "content": [{"text": prompt}]
            }
        ]
    }
    
    def generate_ai_content():
        response = bedrock_runtime_client.invoke_model(
            modelId="amazon.nova-pro-v1:0",
            contentType="application/json",
            body=json.dumps(request_body)
        )
        return json.loads(response.get("body").read())
        
    logger.info(f"Invoking Bedrock model amazon.nova-pro-v1:0 for prompt...")
    response_payload = execute_with_retry(generate_ai_content)
    
    try:
        raw_text = response_payload['output']['message']['content'][0]['text']
        generated_json_str = clean_json_string(raw_text)
        
        # Verify it parses as valid JSON
        parsed_json = json.loads(generated_json_str)
        logger.info(f"Generated content parsed successfully as JSON. Count: {len(parsed_json)}")
    except Exception as e:
        logger.error(f"Failed to generate valid JSON content: {e}. Raw response: {response_payload}")
        raise ValueError(f"AI model did not return a valid JSON response: {e}")
        
    # 4. Save generated content back to DynamoDB
    if field_name == "generateQuizForLesson":
        target_lesson["qa"] = generated_json_str
    else:
        target_lesson["flashcards"] = generated_json_str
        
    # Write the entire updated course structure back to DynamoDB
    serialized_course = serialize_item(course_data)
    
    def update_course():
        dynamodb_client.put_item(
            TableName=COURSES_TABLE_NAME,
            Item=serialized_course
        )
        
    logger.info(f"Saving updated course {course_id} to DynamoDB...")
    execute_with_retry(update_course)
    logger.info("Course updated successfully.")
    
    # Return the generated JSON string
    return generated_json_str

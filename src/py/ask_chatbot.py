import os
import json
import random
import time
import logging
import boto3
from boto3.dynamodb.types import TypeDeserializer

# Setup Logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
bedrock_runtime_client = boto3.client('bedrock-runtime', region_name='us-east-1')
s3_vectors_client = boto3.client('s3vectors')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
deserializer = TypeDeserializer()

# Env Configuration
COURSES_TABLE_NAME = os.environ.get('COURSES_TABLE_NAME')
VECTOR_BUCKET_NAME = os.environ.get('VECTOR_BUCKET_NAME')
VECTOR_INDEX_NAME = os.environ.get('VECTOR_INDEX_NAME')

def deserialize_item(item):
    """Deserializes DynamoDB low-level JSON into standard Python types."""
    return {k: deserializer.deserialize(v) for k, v in item.items()}

def execute_with_retry(func, max_retries: int = 5, initial_backoff: float = 1.0):
    """Executes a Bedrock or S3 request with exponential backoff and jitter for throttling."""
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

def fetch_course_catalog():
    """Scans CoursesTable to retrieve a compact list of all available courses."""
    try:
        response = dynamodb_client.scan(
            TableName=COURSES_TABLE_NAME,
            ProjectionExpression="courseId, title, description, difficulty, frameworks, aws_services"
        )
        catalog = []
        for item in response.get('Items', []):
            course = deserialize_item(item)
            catalog.append({
                "title": course.get("title", ""),
                "description": course.get("description", ""),
                "difficulty": course.get("difficulty", "Intermediate"),
                "frameworks": course.get("frameworks", []),
                "aws_services": course.get("aws_services", [])
            })
        return catalog
    except Exception as e:
        logger.error(f"Error scanning course catalog from DynamoDB: {e}")
        return []

def handler(event, context):
    logger.info(f"Received chatbot query event: {json.dumps(event)}")
    
    # AppSync sends arguments under event['arguments']
    arguments = event.get('arguments', {})
    course_id = arguments.get('courseId')
    message = arguments.get('message')
    
    if not message:
        raise ValueError("Missing 'message' argument")
        
    logger.info(f"Message: {message}, CourseId: {course_id}")
    
    # 1. Embed the query message using Bedrock Titan
    def embed_message():
        body = json.dumps({
            "inputText": message,
            "dimensions": 1024,
            "normalize": True
        })
        response = bedrock_runtime_client.invoke_model(
            modelId="amazon.titan-embed-text-v2:0",
            contentType="application/json",
            accept="application/json",
            body=body
        )
        response_body = json.loads(response.get('body').read())
        return response_body.get('embedding')
        
    query_vector = execute_with_retry(embed_message)
    if not query_vector:
        raise ValueError("Failed to generate embedding for the user message")
        
    # 2. Query S3 Vector Index
    query_params = {
        "vectorBucketName": VECTOR_BUCKET_NAME,
        "indexName": VECTOR_INDEX_NAME,
        "topK": 5,
        "queryVector": {"float32": query_vector},
        "returnMetadata": True,
        "returnDistance": True
    }
    
    if course_id:
        query_params["filter"] = {
            "course_id": { "$eq": course_id }
        }
        
    logger.info(f"Querying S3 Vector Index with params: {json.dumps({k: v for k, v in query_params.items() if k != 'queryVector'})}")
    
    def query_vectors():
        return s3_vectors_client.query_vectors(**query_params)
        
    vector_response = execute_with_retry(query_vectors)
    vectors = vector_response.get('vectors', [])
    logger.info(f"Retrieved {len(vectors)} matches from S3 Vector Index.")
    
    # 3. Retrieve lesson contents from DynamoDB
    courses_cache = {}
    context_chunks = []
    
    for v in vectors:
        metadata = v.get('metadata', {})
        c_id = metadata.get('course_id')
        l_id = metadata.get('lesson_id')
        distance = v.get('distance', 1.0)
        
        # S3 Vectors distance of cosine is typical, filter out poor matches if needed (optional)
        if not c_id or not l_id:
            continue
            
        if c_id not in courses_cache:
            try:
                res = dynamodb_client.get_item(
                    TableName=COURSES_TABLE_NAME,
                    Key={'courseId': {'S': c_id}}
                )
                if 'Item' in res:
                    courses_cache[c_id] = deserialize_item(res['Item'])
                else:
                    courses_cache[c_id] = None
            except Exception as e:
                logger.error(f"Error fetching course {c_id} from DynamoDB: {e}")
                courses_cache[c_id] = None
                
        course_data = courses_cache.get(c_id)
        if not course_data:
            continue
            
        # Find matching lesson in course structure
        lesson_found = None
        module_title = ""
        for m in course_data.get('modules', []):
            for l in m.get('lessons', []):
                if l.get('lessonId') == l_id:
                    lesson_found = l
                    module_title = m.get('title', '')
                    break
            if lesson_found:
                break
                
        if lesson_found:
            content = lesson_found.get('content', '')
            title = lesson_found.get('title', '')
            course_title = course_data.get('title', '')
            
            chunk_context = f"Course: {course_title}\nModule: {module_title}\nLesson: {title} (Similarity distance: {distance:.4f})\nContent:\n{content}"
            context_chunks.append(chunk_context)
            
    # 4. Fetch the entire course catalog to support global recommendations and path building
    catalog = fetch_course_catalog()
    catalog_str = ""
    if catalog:
        catalog_lines = []
        for c in catalog:
            fms = ", ".join(c['frameworks']) if c['frameworks'] else "None"
            svcs = ", ".join(c['aws_services']) if c['aws_services'] else "None"
            catalog_lines.append(f"- **{c['title']}** (Difficulty: {c['difficulty']} | Frameworks: {fms} | Services: {svcs})\n  Description: {c['description']}")
        catalog_str = "\n".join(catalog_lines)
    else:
        catalog_str = "No catalog available."

    # 5. Invoke Bedrock Nova Lite to generate the answer
    formatted_context = "\n\n---\n\n".join(context_chunks) if context_chunks else "No relevant context found."
    
    prompt = f"""You are an expert educational tutor and virtual teaching assistant for Educloud Academy.
Your role is to answer student questions clearly, comprehensively, and contextually based on the course catalog and materials provided below.

Rules:
1. Use the "Available Course Catalog" to answer questions about course recommendations, learning paths, list of courses, or overall curriculum queries.
2. Use the "Course Lesson Context" (which contains detailed content of matching lessons) to answer detailed, technical, code-level, or lesson-specific questions.
3. If the user asks for a learning path, design a cohesive, step-by-step curriculum starting from beginner courses, moving to intermediate, and ending with advanced courses, explaining why each course fits in that order.
4. If the context does not contain the answer, answer the question accurately based on your broad technical knowledge, but start by mentioning that this topic is not directly covered in the course material.
5. Be professional, clear, encouraging, and use markdown formatting where appropriate (code blocks, bullet points, bold text).

Available Course Catalog:
{catalog_str}

Course Lesson Context:
{formatted_context}

User Question: {message}

Answer:"""

    request_body = {
        "messages": [
            {
                "role": "user",
                "content": [{"text": prompt}]
            }
        ]
    }
    
    def generate_response():
        response = bedrock_runtime_client.invoke_model(
            modelId="amazon.nova-lite-v1:0",
            contentType="application/json",
            body=json.dumps(request_body)
        )
        return json.loads(response.get("body").read())
        
    logger.info("Invoking Bedrock model amazon.nova-lite-v1:0...")
    response_payload = execute_with_retry(generate_response)
    
    try:
        answer = response_payload['output']['message']['content'][0]['text']
        logger.info("Response generated successfully.")
        return answer
    except Exception as e:
        logger.error(f"Failed to parse Bedrock response: {e}. Payload: {response_payload}")
        raise e

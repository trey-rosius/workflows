import os
import sys
import json
import zipfile
import shutil
import hashlib
import time
import random
import logging
from urllib.parse import urlparse
from typing import Dict, List, Any

import boto3

# Import AWS Lambda Durable Execution SDK
from aws_durable_execution_sdk_python import (
    durable_execution,
    durable_step,
    DurableContext,
    StepContext
)
from aws_durable_execution_sdk_python.config import Duration

# Patch DurableContext to add is_replaying property
from aws_durable_execution_sdk_python.context import DurableContext
DurableContext.is_replaying = property(lambda self: self.state.is_replaying())

# --- LOGGING SETUP ---
logger = logging.getLogger()
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)

# --- GLOBAL CLIENTS ---
s3_client = boto3.client('s3', region_name='us-east-1')
bedrock_runtime_client = boto3.client('bedrock-runtime', region_name='us-east-1')
s3_vectors_client = boto3.client('s3vectors')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')

def activity_log(execution_id: str, level: str, message: str, **kwargs):
    """Structured JSON logs for CloudWatch Logs Insights indexing."""
    log_payload = {
        "execution_id": execution_id,
        "level": level.upper(),
        "message": message,
        **kwargs
    }
    logger.info(json.dumps(log_payload))

def execute_with_retry(func, execution_id: str, max_retries: int = 5, initial_backoff: float = 1.0):
    """Executes a Bedrock or S3 request with exponential backoff and full jitter for throttling/server errors."""
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            error_name = type(e).__name__
            is_retryable = "Throttling" in error_name or "LimitExceeded" in error_name or "ProvisionedThroughputExceeded" in error_name or "500" in str(e)
            if not is_retryable or attempt == max_retries - 1:
                activity_log(execution_id, "error", f"Call failed on final attempt/non-retryable error: {e}")
                raise e
            backoff = initial_backoff * (2 ** attempt)
            sleep_time = random.uniform(0, backoff)
            activity_log(
                execution_id, 
                "warning", 
                f"Request failed due to {error_name}. Retrying in {sleep_time:.2f} seconds (attempt {attempt + 1}/{max_retries})..."
            )
            time.sleep(sleep_time)

# --- HELPER PARSING FUNCTION ---
def parse_frontmatter(content: str) -> Dict[str, Any]:
    """Parses frontmatter metadata block at the start of a markdown file."""
    metadata = {}
    lines = content.split('\n')
    if len(lines) > 0 and lines[0].strip() == '---':
        fm_lines = []
        for line in lines[1:]:
            if line.strip() == '---':
                break
            fm_lines.append(line)
        
        last_key = None
        for line in fm_lines:
            stripped = line.strip()
            if not stripped:
                continue
            
            # Check if it's a list item under the last key
            if (stripped.startswith('- ') or stripped == '-') and last_key is not None:
                item_val = stripped[2:].strip().strip('"').strip("'") if len(stripped) > 2 else ""
                if last_key not in metadata or not isinstance(metadata[last_key], list):
                    metadata[last_key] = []
                metadata[last_key].append(item_val)
                continue
                
            if ':' in line:
                key, val = line.split(':', 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                
                # Parse simple lists or booleans
                if not val:
                    metadata[key] = []
                elif val.lower() == 'true':
                    metadata[key] = True
                elif val.lower() == 'false':
                    metadata[key] = False
                elif val.startswith('[') and val.endswith(']'):
                    metadata[key] = [item.strip().strip('"').strip("'") for item in val[1:-1].split(',') if item.strip()]
                else:
                    metadata[key] = val
                last_key = key
    return metadata

# --- STATED DURABLE STEPS (ACTIVITIES) ---

@durable_step
def parse_zip_structure_step(step_ctx: StepContext, s3_zip_key: str, bucket_name: str, execution_id: str) -> str:
    """Downloads zip, parses directory structure, uploads manifest JSON to S3, returns S3 URI."""
    local_zip = "/tmp/courses.zip"
    extract_dir = "/tmp/courses_extracted"
    manifest_file = "/tmp/courses_manifest.json"
    s3_manifest_key = f"manifests/{execution_id}-courses.json"
    
    activity_log(execution_id, "info", f"Downloading zip from s3://{bucket_name}/{s3_zip_key}...")
    s3_client.download_file(bucket_name, s3_zip_key, local_zip)
    
    if os.path.exists(extract_dir):
        shutil.rmtree(extract_dir)
    os.makedirs(extract_dir, exist_ok=True)
    
    activity_log(execution_id, "info", "Extracting course files...")
    with zipfile.ZipFile(local_zip, 'r') as zip_ref:
        zip_ref.extractall(extract_dir)
        
    courses = []
    # Walk the directory
    # Structure: extract_dir/courses/<course_slug>/[course.md, course.md.metadata.json, <module_slug>/[module.md, module.md.metadata.json, <lesson_slug>/[lesson.md, lesson.md.metadata.json]]]
    courses_root = os.path.join(extract_dir, "courses")
    if not os.path.exists(courses_root):
        courses_root = extract_dir # Zip might not have nested "courses" root
        
    for course_slug in sorted(os.listdir(courses_root)):
        course_path = os.path.join(courses_root, course_slug)
        if not os.path.isdir(course_path) or course_slug.startswith('.'):
            continue
            
        course_md_path = os.path.join(course_path, "course.md")
        if not os.path.exists(course_md_path):
            continue
            
        activity_log(execution_id, "info", f"Parsing course: {course_slug}...")
        with open(course_md_path, 'r', encoding='utf-8') as f:
            course_content = f.read()
        course_fm = parse_frontmatter(course_content)
        
        course_id = course_fm.get("id") or hashlib.md5(course_slug.encode()).hexdigest()
        course_title = course_fm.get("name") or course_slug.replace('-', ' ').title()
        
        modules = []
        for module_slug in sorted(os.listdir(course_path)):
            module_path = os.path.join(course_path, module_slug)
            if not os.path.isdir(module_path) or module_slug.startswith('.') or not module_slug[0].isdigit():
                continue
                
            module_md_path = os.path.join(module_path, "module.md")
            module_title = module_slug.split('-', 1)[-1].replace('-', ' ').title()
            module_order = int(module_slug.split('-', 1)[0])
            module_id = hashlib.md5(f"{course_id}-{module_slug}".encode()).hexdigest()
            
            lessons = []
            for lesson_slug in sorted(os.listdir(module_path)):
                lesson_path = os.path.join(module_path, lesson_slug)
                if not os.path.isdir(lesson_path) or lesson_slug.startswith('.') or not lesson_slug[0].isdigit():
                    continue
                    
                lesson_md_path = os.path.join(lesson_path, "lesson.md")
                if not os.path.exists(lesson_md_path):
                    continue
                    
                with open(lesson_md_path, 'r', encoding='utf-8') as f:
                    lesson_content = f.read()
                lesson_fm = parse_frontmatter(lesson_content)
                
                lesson_id = lesson_fm.get("id") or hashlib.md5(f"{module_id}-{lesson_slug}".encode()).hexdigest()
                lesson_title = lesson_fm.get("title") or lesson_slug.split('-', 1)[-1].replace('-', ' ').title()
                lesson_order = int(lesson_slug.split('-', 1)[0])
                
                # Strip frontmatter from content to make it clean for embedding and rendering
                clean_content = lesson_content
                if lesson_content.startswith('---'):
                    parts = lesson_content.split('---', 2)
                    if len(parts) >= 3:
                        clean_content = parts[2].strip()
                
                # Extract S3 videoUri from <video> source link if present
                video_uri = ""
                if "<source src=" in clean_content:
                    try:
                        start_idx = clean_content.find('<source src="') + len('<source src="')
                        end_idx = clean_content.find('"', start_idx)
                        video_uri = clean_content[start_idx:end_idx]
                    except Exception:
                        pass
                
                lessons.append({
                    "lessonId": lesson_id,
                    "title": lesson_title,
                    "description": lesson_fm.get("description", ""),
                    "order": lesson_order,
                    "videoUri": video_uri,
                    "content": clean_content
                })
                
            modules.append({
                "moduleId": module_id,
                "title": module_title,
                "order": module_order,
                "lessons": sorted(lessons, key=lambda x: x["order"])
            })
            
        def get_list_field(fm, plural_key, singular_key):
            val = fm.get(plural_key) or fm.get(singular_key) or []
            if isinstance(val, list):
                return val
            if isinstance(val, str):
                return [val] if val.strip() else []
            return []

        courses.append({
            "courseId": course_id,
            "title": course_title,
            "description": course_fm.get("description", course_title),
            "image": course_fm.get("image", ""),
            "difficulty": course_fm.get("difficulty", "Intermediate"),
            "frameworks": get_list_field(course_fm, "frameworks", "framework"),
            "aws_services": get_list_field(course_fm, "aws_services", "aws_service"),
            "publish": course_fm.get("publish", True),
            "featured": course_fm.get("featured", False),
            "modules": sorted(modules, key=lambda x: x["order"])
        })
        
    activity_log(execution_id, "info", f"Extracted {len(courses)} courses structure. Writing manifest...")
    with open(manifest_file, 'w', encoding='utf-8') as f:
        json.dump(courses, f)
        
    s3_client.upload_file(manifest_file, bucket_name, s3_manifest_key)
    
    # Cleanup tmp folders
    shutil.rmtree(extract_dir)
    os.remove(local_zip)
    os.remove(manifest_file)
    
    return f"s3://{bucket_name}/{s3_manifest_key}"


_manifest_cache = {}

def get_manifest(s3_uri: str) -> List[Dict[str, Any]]:
    global _manifest_cache
    if s3_uri in _manifest_cache:
        return _manifest_cache[s3_uri]
    parsed = urlparse(s3_uri)
    bucket = parsed.netloc
    key = parsed.path.lstrip('/')
    response = s3_client.get_object(Bucket=bucket, Key=key)
    manifest = json.loads(response['Body'].read().decode('utf-8'))
    _manifest_cache[s3_uri] = manifest
    return manifest

def find_lesson_in_manifest(manifest: List[Dict[str, Any]], course_id: str, lesson_id: str):
    for course in manifest:
        if course.get("courseId") == course_id:
            for module in course.get("modules", []):
                for lesson in module.get("lessons", []):
                    if lesson.get("lessonId") == lesson_id:
                        return course, module, lesson
    return None, None, None

@durable_step
def save_all_courses_metadata_step(step_ctx: StepContext, s3_manifest_uri: str, table_name: str, execution_id: str) -> int:
    """Downloads the manifest and saves all courses metadata to DynamoDB in parallel."""
    activity_log(execution_id, "info", f"save_all_courses_metadata_step: downloading {s3_manifest_uri}...")
    manifest = get_manifest(s3_manifest_uri)
    activity_log(execution_id, "info", f"save_all_courses_metadata_step: saving {len(manifest)} courses to DynamoDB...")
    
    def serialize_val(val):
        if isinstance(val, bool):
            return {"BOOL": val}
        if isinstance(val, (int, float)):
            return {"N": str(val)}
        if isinstance(val, str):
            return {"S": val}
        if isinstance(val, list):
            return {"L": [serialize_val(x) for x in val]}
        if isinstance(val, dict):
            return {"M": {k: serialize_val(v) for k, v in val.items()}}
        return {"NULL": True}

    import concurrent.futures
    
    def save_single_course(course_data):
        course_id = course_data["courseId"]
        dynamo_item = {k: serialize_val(v) for k, v in course_data.items()}
        execute_with_retry(
            lambda: dynamodb_client.put_item(
                TableName=table_name,
                Item=dynamo_item
            ),
            execution_id=execution_id
        )
        return course_id

    # Using concurrent.futures to upload to DynamoDB in parallel
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(save_single_course, course) for course in manifest]
        for future in concurrent.futures.as_completed(futures):
            try:
                c_id = future.result()
                activity_log(execution_id, "info", f"Saved course {c_id} metadata to DynamoDB.")
            except Exception as e:
                activity_log(execution_id, "error", f"Failed to save course: {e}")
                raise e
                
    return len(manifest)


@durable_step
def load_lightweight_lessons_step(step_ctx: StepContext, s3_manifest_uri: str, execution_id: str) -> List[Dict[str, str]]:
    """Downloads manifest and extracts list of lesson references (IDs) to process."""
    activity_log(execution_id, "info", f"load_lightweight_lessons_step: downloading {s3_manifest_uri}...")
    manifest = get_manifest(s3_manifest_uri)
    
    lightweight_lessons = []
    for course in manifest:
        course_id = course["courseId"]
        for module in course.get("modules", []):
            for lesson in module.get("lessons", []):
                lightweight_lessons.append({
                    "course_id": course_id,
                    "lesson_id": lesson["lessonId"]
                })
                
    activity_log(execution_id, "info", f"Found {len(lightweight_lessons)} lessons for embedding.")
    return lightweight_lessons


@durable_step
def embed_and_save_lessons_batch_step(
    step_ctx: StepContext,
    s3_manifest_uri: str,
    batch_items: List[Dict[str, str]],
    vector_bucket: str,
    vector_index: str,
    execution_id: str
) -> bool:
    """Generates embeddings for a batch of lessons and saves them to S3Vectors in a single call."""
    manifest = get_manifest(s3_manifest_uri)
    
    vector_entries = []
    
    # Process the embeddings in parallel within this step
    import concurrent.futures
    
    def process_single_item(item):
        course_id = item["course_id"]
        lesson_id = item["lesson_id"]
        course, module, lesson = find_lesson_in_manifest(manifest, course_id, lesson_id)
        if not lesson:
            activity_log(execution_id, "warning", f"Lesson {lesson_id} not found in course {course_id}")
            return None
            
        course_title = course["title"]
        module_id = module["moduleId"]
        module_title = module["title"]
        lesson_title = lesson["title"]
        lesson_content = lesson["content"]
        
        # Prepend titles/context to lesson content
        embedding_text = f"Course: {course_title}\nModule: {module_title}\nLesson: {lesson_title}\nContent:\n{lesson_content}"
        
        if len(embedding_text) > 25000:
            embedding_text = embedding_text[:25000]
            
        def call_titan():
            body = json.dumps({
                "inputText": embedding_text,
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

        embedding = execute_with_retry(call_titan, execution_id=execution_id)
        if not embedding:
            raise ValueError(f"Failed to generate embedding for {lesson_title}")
            
        unique_key = f"course-{course_id}-{lesson_id}"
        return {
            'key': unique_key,
            'data': {"float32": embedding},
            'metadata': {
                'course_id': course_id,
                'course_title': course_title,
                'module_id': module_id,
                'module_title': module_title,
                'lesson_id': lesson_id,
                'lesson_title': lesson_title,
                'source': 'course_file'
            }
        }

    # Generate embeddings in parallel inside this activity
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(process_single_item, item) for item in batch_items]
        for future in concurrent.futures.as_completed(futures):
            try:
                res = future.result()
                if res:
                    vector_entries.append(res)
            except Exception as e:
                activity_log(execution_id, "error", f"Error generating embedding in batch: {e}")
                raise e
                
    if not vector_entries:
        return True
        
    activity_log(execution_id, "info", f"Ingesting {len(vector_entries)} vectors to S3 Vector Index {vector_index}...")
    
    execute_with_retry(
        lambda: s3_vectors_client.put_vectors(
            vectorBucketName=vector_bucket,
            indexName=vector_index,
            vectors=vector_entries
        ),
        execution_id=execution_id
    )
    
    return True


# --- CORE DURABLE ORCHESTRATOR HANDLER ---

@durable_execution
def lambda_handler(event: Dict[str, Any], context: DurableContext) -> Dict[str, Any]:
    """Purely deterministic Durable Course Ingestion Orchestrator."""
    arn = context.execution_context.durable_execution_arn
    execution_id = arn.split("/")[0] if "/" in arn else (arn or "course-ingestion-local")
    
    if not context.is_replaying:
        logger.info(f"Received Ingestion Event: {json.dumps(event)}")
        
    s3_zip_key = event.get('s3ZipKey')
    if not s3_zip_key:
        raise ValueError("Missing s3ZipKey in event payload")
        
    bucket_name = os.environ.get('VECTOR_BUCKET_NAME').replace('-video-agent-vector-bucket', '-video-media-bucket')
    vector_bucket = os.environ.get('VECTOR_BUCKET_NAME')
    vector_index = os.environ.get('VECTOR_INDEX_NAME')
    courses_table = os.environ.get('COURSES_TABLE_NAME')
    
    # 1. Parse Zip structure and upload manifest to S3
    manifest_uri = context.step(
        parse_zip_structure_step(s3_zip_key, bucket_name, execution_id), 
        name="ParseZipStructure"
    )
    
    # 2. Save all courses metadata to DynamoDB
    courses_count = context.step(
        save_all_courses_metadata_step(manifest_uri, courses_table, execution_id),
        name="SaveAllCoursesMetadata"
    )
    
    # 3. Load lightweight lessons list
    lightweight_lessons = context.step(
        load_lightweight_lessons_step(manifest_uri, execution_id),
        name="LoadLightweightLessons"
    )
    
    # 4. Batch process lesson embeddings in sequential batches of 20
    batch_size = 20
    if not context.is_replaying:
        logger.info(f"Embedding {len(lightweight_lessons)} lessons in batches of {batch_size}...")
        
    for batch_idx in range(0, len(lightweight_lessons), batch_size):
        batch_items = lightweight_lessons[batch_idx:batch_idx + batch_size]
        
        if not context.is_replaying:
            logger.info(f"Processing lessons batch {batch_idx // batch_size + 1}...")
            
        context.step(
            embed_and_save_lessons_batch_step(
                manifest_uri,
                batch_items,
                vector_bucket,
                vector_index,
                execution_id
            ),
            name=f"EmbedLessonsBatch_{batch_idx // batch_size}"
        )
        
    return {
        "status": "SUCCESS",
        "coursesCount": courses_count,
        "lessonsCount": len(lightweight_lessons)
    }

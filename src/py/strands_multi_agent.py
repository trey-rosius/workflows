import os
import sys
import json
import base64
import time
import shutil
import hashlib
import logging
import subprocess
import random
from datetime import datetime
from decimal import Decimal
from urllib.parse import urlparse, quote
import urllib.request
import urllib.error
from typing import Dict, List, Any, Optional

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# Import AWS Lambda Durable Execution SDK
from aws_durable_execution_sdk_python import (
    durable_execution,
    durable_step,
    DurableContext,
    StepContext
)
from aws_durable_execution_sdk_python.config import Duration

# Patch DurableContext to add is_replaying property as requested by Rule 5
from aws_durable_execution_sdk_python.context import DurableContext
DurableContext.is_replaying = property(lambda self: self.state.is_replaying())

# --- LOGGING SETUP ---
logger = logging.getLogger()
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)


# --- GLOBAL CLIENTS (Rule 4) ---
# Initialize boto3 clients globally outside step functions to benefit from container reuse
s3_client = boto3.client('s3', region_name='us-east-1')
transcribe_client = boto3.client('transcribe', region_name='us-east-1')
bedrock_runtime_client = boto3.client('bedrock-runtime', region_name='us-east-1')
agentcore_control_client = boto3.client('bedrock-agentcore-control', region_name='us-east-1')
events_client = boto3.client('events', region_name='us-east-1')



# --- LOGGING & NETWORK UTILITIES (Rule 4 & 5) ---

def activity_log(execution_id: str, level: str, message: str, **kwargs):
    """Outputs log events exclusively using flat JSON string formatting."""
    log_payload = {
        "execution_id": execution_id,
        "level": level.upper(),
        "message": message,
        **kwargs
    }
    json_str = json.dumps(log_payload)
    if level.lower() == "error":
        logger.error(json_str)
    elif level.lower() == "warning":
        logger.warning(json_str)
    else:
        logger.info(json_str)


def execute_http_request_with_retry(req, execution_id: str, max_retries: int = 5, initial_backoff: float = 1.0) -> bytes:
    """Executes an HTTP request with exponential backoff and full jitter for 429 and 5xx errors."""
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            status_code = e.code
            is_retryable = (status_code == 429) or (500 <= status_code < 600)
            if not is_retryable or attempt == max_retries - 1:
                error_body = ""
                try:
                    if e.fp:
                        error_body = e.fp.read().decode("utf-8")
                except Exception:
                    pass
                activity_log(
                    execution_id, 
                    "error", 
                    f"HTTP call failed on final attempt/non-retryable status: {status_code} {e.reason}", 
                    error_body=error_body
                )
                raise e
            
            backoff = initial_backoff * (2 ** attempt)
            sleep_time = random.uniform(0, backoff)
            activity_log(
                execution_id, 
                "warning", 
                f"HTTP request returned status {status_code}. Retrying in {sleep_time:.2f} seconds (attempt {attempt + 1}/{max_retries})..."
            )
            time.sleep(sleep_time)
        except urllib.error.URLError as e:
            if attempt == max_retries - 1:
                activity_log(execution_id, "error", f"HTTP connection failed: {e.reason}")
                raise e
            backoff = initial_backoff * (2 ** attempt)
            sleep_time = random.uniform(0, backoff)
            activity_log(
                execution_id, 
                "warning", 
                f"Connection error: {e.reason}. Retrying in {sleep_time:.2f} seconds (attempt {attempt + 1}/{max_retries})..."
            )
            time.sleep(sleep_time)


# --- UTILITY & HELPER FUNCTIONS ---

def parse_time_to_seconds(val: Any) -> float:
    if val is None:
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    val_str = str(val).strip()
    if ':' in val_str:
        parts = val_str.split(':')
        try:
            if len(parts) == 2:
                return float(int(parts[0]) * 60 + int(parts[1]))
            elif len(parts) >= 3:
                return float(int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2]))
        except ValueError:
            pass
    try:
        return float(val_str)
    except ValueError:
        return 0.0


class TranscriptProcessor:
    """Helper to slice AWS Transcribe JSON outputs into segment-specific transcripts."""

    @staticmethod
    def get_transcript_segment(transcribe_data: Dict[str, Any], start_sec: float, end_sec: float) -> str:
        """Filters words in the transcript that fall within the given start/end window."""
        words = []
        items = transcribe_data.get('results', {}).get('items', [])
        for item in items:
            s_time = item.get('start_time')
            if s_time is not None:
                try:
                    s_val = float(s_time)
                    if start_sec <= s_val <= end_sec:
                        content = item['alternatives'][0]['content']
                        if item.get('type') == 'punctuation':
                            if words:
                                words[-1] = words[-1] + content
                            else:
                                words.append(content)
                        else:
                            words.append(content)
                except ValueError:
                    pass
        return " ".join(words)

    @staticmethod
    def get_transcript_with_timestamps(transcribe_data: Dict[str, Any], interval_seconds: float = 30.0) -> str:
        """Constructs a transcript string with periodic [MM:SS] timestamp markers inserted."""
        items = transcribe_data.get('results', {}).get('items', [])
        words_with_markers = []
        next_marker_time = 0.0

        for item in items:
            s_time = item.get('start_time')
            if s_time is not None:
                try:
                    s_val = float(s_time)
                    if s_val >= next_marker_time:
                        minutes = int(s_val // 60)
                        seconds = int(s_val % 60)
                        words_with_markers.append(f" [{minutes:02d}:{seconds:02d}] ")
                        next_marker_time = s_val + interval_seconds
                except ValueError:
                    pass

            content = item['alternatives'][0]['content']
            if item.get('type') == 'punctuation':
                if words_with_markers and not words_with_markers[-1].endswith("] "):
                    words_with_markers[-1] = words_with_markers[-1] + content
                else:
                    words_with_markers.append(content)
            else:
                words_with_markers.append(content)

        return " ".join(words_with_markers)


# --- LEGACY SERVICE WRAPPERS (STILL USED BY ACTIVITIES) ---

class VideoProcessor:
    """Handles video segmentation, cutting using FFmpeg, and S3 uploads."""

    def __init__(self, s3_client_input: Any = None):
        self.s3_client = s3_client_input or s3_client

    def get_ffmpeg_path(self) -> Optional[str]:
        """Locates the FFmpeg binary in path, Lambda layers, or local package."""
        path_env = shutil.which("ffmpeg")
        if path_env:
            return path_env
        for path_opt in ["/opt/bin/ffmpeg", "/opt/ffmpeg"]:
            if os.path.exists(path_opt):
                return path_opt
        path_local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg")
        if os.path.exists(path_local):
            return path_local
        return None

    def cut_and_upload_segment(
        self,
        index: int,
        lesson: Dict[str, Any],
        src_bucket: str,
        src_key: str,
        local_input: str,
        execution_id: str
    ) -> str:
        """Cuts a video file into segments using FFmpeg and uploads the sliced file to S3."""
        start_time = float(lesson.get('start_time', 0))
        end_time = float(lesson.get('end_time', 0))
        duration = max(0.1, end_time - start_time)

        original_filename = os.path.basename(src_key)
        dest_key = f"lessons/{original_filename}/lesson_{index}.mp4"
        local_output = f"/tmp/output_{index}.mp4"

        ffmpeg_path = self.get_ffmpeg_path()
        if not ffmpeg_path:
            activity_log(execution_id, "warning", "FFmpeg binary not found. Skipping video cutting.")
            return ""

        activity_log(execution_id, "info", f"Cutting segment {index}: {start_time} to {end_time} (duration: {duration}s)...")
        try:
            command = [
                ffmpeg_path,
                "-ss", str(start_time),
                "-i", local_input,
                "-t", str(duration),
                "-c", "copy",
                "-y",
                local_output
            ]
            subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            activity_log(execution_id, "info", f"Uploading segment to s3://{src_bucket}/{dest_key}...")
            self.s3_client.upload_file(local_output, src_bucket, dest_key)

            if os.path.exists(local_output):
                os.remove(local_output)

            return f"s3://{src_bucket}/{dest_key}"
        except Exception as e:
            activity_log(execution_id, "error", f"Failed to cut/upload segment {index}: {e}")
            if os.path.exists(local_output):
                try:
                    os.remove(local_output)
                except Exception:
                    pass
            return ""


class AgentCoreService:
    """Interacts with AWS Bedrock AgentCore Runtimes using SigV4 HTTP requests."""

    def __init__(self, region: str = "us-east-1", control_client: Any = None):
        self.region = region
        self.control_client = control_client or agentcore_control_client
        self._session = boto3.Session()

    def get_runtime_arn_by_name(self, runtime_name: str, execution_id: str) -> str:
        """Finds the ARN of an AgentCore runtime by its name."""
        activity_log(execution_id, "info", f"Locating Bedrock AgentCore runtime '{runtime_name}'...")
        try:
            runtimes = self.control_client.list_agent_runtimes()['agentRuntimes']
            app_runtime = next((r for r in runtimes if r.get('agentRuntimeName') == runtime_name), None)
            if not app_runtime:
                raise ValueError(f"Could not find Bedrock AgentCore runtime named '{runtime_name}'")
            return app_runtime['agentRuntimeArn']
        except Exception as e:
            activity_log(execution_id, "error", f"Failed to locate AgentCore runtime: {e}")
            raise e

    def _extract_text(self, field_val: Any) -> str:
        """Robustly extracts text fields from Bedrock AgentCore wrapper structures."""
        if not field_val:
            return ""
        if isinstance(field_val, str):
            return field_val
        if isinstance(field_val, dict):
            content = field_val.get("content")
            if isinstance(content, list) and len(content) > 0:
                first_item = content[0]
                if isinstance(first_item, dict):
                    return first_item.get("text", "")
            if "text" in field_val:
                return field_val["text"]
        return str(field_val)

    def invoke_agent(self, agent_runtime_arn: str, payload: Dict[str, Any], execution_id: str) -> Dict[str, Any]:
        """Performs a signed SigV4 request to invoke the AgentCore HTTP endpoint with retry-on-throttle."""
        encoded_arn = quote(agent_runtime_arn, safe="")
        url = f"https://bedrock-agentcore.{self.region}.amazonaws.com/runtimes/{encoded_arn}/invocations"
        activity_log(execution_id, "info", f"HTTP Endpoint URL: {url}")

        payload_bytes = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Host": f"bedrock-agentcore.{self.region}.amazonaws.com"
        }

        aws_request = AWSRequest(
            method="POST",
            url=url,
            data=payload_bytes,
            headers=headers
        )

        credentials = self._session.get_credentials()
        frozen_credentials = credentials.get_frozen_credentials()

        signer = SigV4Auth(frozen_credentials, "bedrock-agentcore", self.region)
        signer.add_auth(aws_request)

        req = urllib.request.Request(
            url=url,
            data=payload_bytes,
            headers=dict(aws_request.headers),
            method="POST"
        )

        try:
            response_body = execute_http_request_with_retry(req, execution_id=execution_id)
            result = json.loads(response_body.decode("utf-8"))
            if isinstance(result, dict) and "error" in result:
                raise Exception(f"AgentCore execution error: {result['error']}")
            return {
                "summary": self._extract_text(result.get('summary', '')),
                "qa": self._extract_text(result.get('qa', '')),
                "flashcards": self._extract_text(result.get('flashcards', '')),
                "keyTakeaways": self._extract_text(result.get('keyTakeaways', ''))
            }
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else ""
            activity_log(execution_id, "error", f"HTTPError invoking AgentCore: {e.code} - {e.reason}. Body: {error_body}")
            raise Exception(f"SigV4 AgentCore HTTP call failed: {e.code} {e.reason} - {error_body}")
        except Exception as e:
            activity_log(execution_id, "error", f"Error during HTTP agent invocation: {e}")
            raise e


# --- ASYNCHRONOUS STATELESS ACTIVITIES (DURABLE STEPS) ---

@durable_step
def get_or_start_transcription_step(step_ctx: StepContext, video_uri: str, execution_id: str) -> dict:
    """Initiates AWS Transcribe job or queries existing status."""
    uri_hash = hashlib.md5(video_uri.encode('utf-8')).hexdigest()
    job_name = f"educloud-transcribe-{uri_hash}"

    try:
        job = transcribe_client.get_transcription_job(TranscriptionJobName=job_name)['TranscriptionJob']
        status = job['TranscriptionJobStatus']
        if status == 'COMPLETED':
            return {"status": "COMPLETED", "transcriptFileUri": job['Transcript']['TranscriptFileUri']}
        elif status == 'FAILED':
            try:
                transcribe_client.delete_transcription_job(TranscriptionJobName=job_name)
            except Exception:
                pass
        elif status in ('IN_PROGRESS', 'QUEUED'):
            return {"status": "IN_PROGRESS", "jobName": job_name}
    except transcribe_client.exceptions.BadRequestException:
        pass
    except Exception as e:
        activity_log(execution_id, "warning", f"Error checking transcribe job: {e}")

    # Start new job
    file_extension = video_uri.split('.')[-1].lower()
    transcribe_client.start_transcription_job(
        TranscriptionJobName=job_name,
        Media={'MediaFileUri': video_uri},
        MediaFormat=file_extension,
        LanguageCode='en-US'
    )
    return {"status": "IN_PROGRESS", "jobName": job_name}


@durable_step
def check_transcription_status_step(step_ctx: StepContext, job_name: str, execution_id: str) -> dict:
    """Checks the status of a Transcribe job (polled during orchestrator wait)."""
    try:
        status_response = transcribe_client.get_transcription_job(TranscriptionJobName=job_name)
        job = status_response['TranscriptionJob']
        status = job['TranscriptionJobStatus']
        if status == 'COMPLETED':
            return {"status": "COMPLETED", "transcriptFileUri": job['Transcript']['TranscriptFileUri']}
        elif status == 'FAILED':
            return {"status": "FAILED", "reason": job.get('FailureReason')}
        else:
            return {"status": "IN_PROGRESS", "jobName": job_name}
    except Exception as e:
        activity_log(execution_id, "error", f"Error checking Transcribe status: {e}")
        raise e


@durable_step
def generate_syllabus_curriculum_step(step_ctx: StepContext, transcript_file_uri: str, execution_id: str) -> List[Dict[str, Any]]:
    """Segment the transcription into modules and lessons using Bedrock Nova Pro."""
    def extract_json_array(text: str) -> List[Dict[str, Any]]:
        cleaned = text.strip()
        try:
            val = json.loads(cleaned)
            if isinstance(val, list):
                return val
        except Exception:
            pass

        if "```" in cleaned:
            parts = cleaned.split("```")
            for part in parts:
                part_clean = part.strip()
                if part_clean.startswith("json"):
                    part_clean = part_clean[4:].strip()
                try:
                    val = json.loads(part_clean)
                    if isinstance(val, list):
                        return val
                except Exception:
                    pass

        start = cleaned.find('[')
        end = cleaned.rfind(']')
        if start != -1 and end != -1 and end > start:
            try:
                val = json.loads(cleaned[start:end+1])
                if isinstance(val, list):
                    return val
            except Exception:
                pass

        raise ValueError(f"Could not extract a valid JSON array of lessons from model response: {text}")

    activity_log(execution_id, "info", f"Fetching transcript JSON from S3: {transcript_file_uri}")
    req = urllib.request.Request(transcript_file_uri)
    response_body = execute_http_request_with_retry(req, execution_id=execution_id)
    transcribe_data = json.loads(response_body.decode('utf-8'))
    
    marked_transcript = TranscriptProcessor.get_transcript_with_timestamps(transcribe_data, interval_seconds=30.0)
    activity_log(execution_id, "info", "Segmenting transcription into modules and lessons...")
    prompt = f"""You are an educational syllabus designer. Analyze the following video transcription.
The transcript has timestamp markers in the format [MM:SS] (minutes:seconds) periodically inserted.
Break this transcription down into logical educational modules and lessons. Each module can contain multiple lessons.
For each lesson, identify the exact start and end times in "MM:SS" format based on the closest [MM:SS] markers in the transcript (e.g. "01:30" or "10:15").
Return ONLY a valid JSON array of objects, with no markdown formatting tags (no ```json, no explanation), representing the syllabus. Each object MUST have these fields:
- "module": name of the module
- "title": name of the lesson
- "description": description of what is covered in this lesson
- "start_time": string representing starting timestamp of this lesson in "MM:SS" format (e.g. "01:30")
- "end_time": string representing ending timestamp of this lesson in "MM:SS" format (e.g. "10:15")

Here is the transcript:
{marked_transcript}"""

    request = {
        "messages": [
            {
                "role": "user",
                "content": [{"text": prompt}]
            }
        ]
    }

    response = bedrock_runtime_client.invoke_model(
        modelId="amazon.nova-pro-v1:0",
        body=json.dumps(request),
        contentType="application/json"
    )
    response_body = json.loads(response.get("body").read())
    text_response = response_body['output']['message']['content'][0]['text']
    lessons_raw = extract_json_array(text_response)

    processed_lessons = []
    for lesson in lessons_raw:
        start_raw = lesson.get('start_time')
        end_raw = lesson.get('end_time')
        lesson['start_time'] = parse_time_to_seconds(start_raw)
        lesson['end_time'] = parse_time_to_seconds(end_raw)
        processed_lessons.append(lesson)
    return processed_lessons


@durable_step
def generate_global_insights_step(step_ctx: StepContext, video_uri: str, transcript_file_uri: str, execution_id: str) -> Dict[str, Any]:
    """Generates global learning insights by analyzing the video content with Nova Pro and AgentCore."""
    agent_service = AgentCoreService(region='us-east-1')
    agent_runtime_arn = agent_service.get_runtime_arn_by_name("app", execution_id=execution_id)

    parsed = urlparse(video_uri)
    video_key = parsed.path.lstrip('/')
    video_format = video_key.split('.')[-1].lower()
    supported_formats = {'mp4', 'mov', 'webm', 'mkv'}
    fmt = video_format if video_format in supported_formats else 'mp4'

    req = urllib.request.Request(transcript_file_uri)
    response_body = execute_http_request_with_retry(req, execution_id=execution_id)
    transcribe_data = json.loads(response_body.decode('utf-8'))
    transcript_text = transcribe_data.get('results', {}).get('transcripts', [{}])[0].get('transcript', '')

    try:
        activity_log(execution_id, "info", f"Invoking Bedrock Nova Pro to analyze video content: {video_uri}")
        native_request = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "video": {
                                "format": fmt,
                                "source": {
                                    "s3Location": {
                                        "uri": video_uri
                                    }
                                }
                            }
                        },
                        {
                            "text": "Analyze this video in detail. List the sequence of events, visual descriptions of key scenes, speech/audio transcription, and any educational concepts explained in the video."
                        }
                    ]
                }
            ]
        }
        response = bedrock_runtime_client.invoke_model(
            modelId="amazon.nova-pro-v1:0",
            body=json.dumps(native_request),
            contentType="application/json"
        )
        response_body = json.loads(response.get("body").read())
        video_analysis = response_body['output']['message']['content'][0]['text']
    except Exception as e:
        activity_log(execution_id, "warning", f"Nova Pro analysis failed: {e}. Falling back to audio transcript text.")
        video_analysis = transcript_text

    activity_log(execution_id, "info", "Generating overall video learning insights...")
    global_result = agent_service.invoke_agent(agent_runtime_arn, {"video_analysis": video_analysis}, execution_id=execution_id)
    return {
        "summary": global_result.get("summary", ""),
        "qa": global_result.get("qa", ""),
        "flashcards": global_result.get("flashcards", ""),
        "keyTakeaways": global_result.get("keyTakeaways", "")
    }


@durable_step
def slice_video_segment_step(step_ctx: StepContext, index: int, lesson: Dict[str, Any], video_uri: str, execution_id: str) -> str:
    """Invokes FFmpeg to slice the video file segment and uploads to S3."""
    video_processor = VideoProcessor(s3_client_input=s3_client)

    parsed = urlparse(video_uri)
    src_bucket = parsed.netloc
    src_key = parsed.path.lstrip('/')

    input_uri = ""
    if video_processor.get_ffmpeg_path():
        try:
            activity_log(execution_id, "info", "Generating presigned GET URL for S3 streaming...")
            input_uri = s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': src_bucket, 'Key': src_key},
                ExpiresIn=3600
            )
        except Exception as e:
            activity_log(execution_id, "error", f"Failed to generate presigned GET URL: {e}")

    if input_uri:
        video_segment_uri = video_processor.cut_and_upload_segment(
            index, lesson, src_bucket, src_key, input_uri, execution_id
        )
        if video_segment_uri:
            return video_segment_uri
    return video_uri


@durable_step
def invoke_lesson_agents_step(step_ctx: StepContext, lesson: Dict[str, Any], transcript_file_uri: str, execution_id: str) -> Dict[str, Any]:
    """Invokes Strands agents via Bedrock AgentCore for a single lesson transcript segment."""
    agent_service = AgentCoreService(region='us-east-1')
    agent_runtime_arn = agent_service.get_runtime_arn_by_name("app", execution_id=execution_id)

    start_time = float(lesson.get('start_time', 0))
    end_time = float(lesson.get('end_time', 0))

    req = urllib.request.Request(transcript_file_uri)
    response_body = execute_http_request_with_retry(req, execution_id=execution_id)
    transcribe_data = json.loads(response_body.decode('utf-8'))

    lesson_transcript = TranscriptProcessor.get_transcript_segment(transcribe_data, start_time, end_time)
    if not lesson_transcript.strip():
        lesson_transcript = f"Lesson covering start time {start_time} to {end_time} seconds: {lesson.get('title')}."

    activity_log(execution_id, "info", f"Invoking Strands agents for lesson: {lesson.get('title')}...")
    payload = {
        "video_analysis": f"Segment Transcript:\n{lesson_transcript}\n\nLesson Title: {lesson.get('title')}\nDescription: {lesson.get('description')}"
    }
    
    agent_result = agent_service.invoke_agent(agent_runtime_arn, payload, execution_id=execution_id)
    # Rule 2: Keep numerical values moving between steps strictly as standard floats or integers. No Decimals.
    return {
        'title': lesson.get('title', 'Lesson'),
        'module': lesson.get('module', 'General'),
        'description': lesson.get('description', ''),
        'startTime': float(start_time),
        'endTime': float(end_time),
        'summary': agent_result.get('summary', ''),
        'qa': agent_result.get('qa', ''),
        'flashcards': agent_result.get('flashcards', ''),
        'keyTakeaways': agent_result.get('keyTakeaways', '')
    }


@durable_step
def save_course_draft_step(step_ctx: StepContext, video_uri: str, global_assets: Dict[str, Any], lessons_list: List[Dict[str, Any]], execution_id: str, tracking_id: str) -> Dict[str, Any]:
    """Saves course draft and metadata to DynamoDB via the AgentCore Gateway tool call with retry handlers."""
    gateway_url = os.environ.get('GATEWAY_URL', "https://educloudgateway-14np87xcya.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp")
    cognito_token_url = os.environ.get('COGNITO_TOKEN_URL', "https://agentcore-989424d4.auth.us-east-1.amazoncognito.com/oauth2/token")
    gateway_client_id = os.environ.get('GATEWAY_CLIENT_ID', "677r3hbjq5i8oue7p694deuu8b")
    gateway_client_secret = os.environ.get('GATEWAY_CLIENT_SECRET', "14lp2prrrbqa5epcmairjqe88tg204u1fa78ajai1qsf6e2k1677")
    gateway_oauth_scope = os.environ.get('GATEWAY_OAUTH_SCOPE', "EducloudGateway/invoke")

    activity_log(execution_id, "info", "Fetching access token from Cognito for AgentCore Gateway...")
    auth_str = f"{gateway_client_id}:{gateway_client_secret}"
    auth_b64 = base64.b64encode(auth_str.encode('utf-8')).decode('utf-8')
    
    headers = {
        'Authorization': f'Basic {auth_b64}',
        'Content-Type': 'application/x-www-form-urlencoded'
    }
    data = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'scope': gateway_oauth_scope
    }).encode('utf-8')
    
    token_req = urllib.request.Request(cognito_token_url, data=data, headers=headers, method='POST')
    token_response_body = execute_http_request_with_retry(token_req, execution_id=execution_id)
    res_body = json.loads(token_response_body.decode('utf-8'))
    token = res_body['access_token']

    activity_log(execution_id, "info", f"Saving learning syllabus assets via AgentCore Gateway for videoUri {video_uri}")
    url = gateway_url
    if not url.endswith('/mcp'):
        url = url.rstrip('/') + '/mcp'
        
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }
    
    arguments = {
        'mediaFileUri': video_uri,
        'title': 'Video Course',
        'description': 'Generated by Educloud Workflow',
        'global_assets': {
            'summary': global_assets.get('summary', ''),
            'qa': global_assets.get('qa', ''),
            'flashcards': global_assets.get('flashcards', ''),
            'keyTakeaways': global_assets.get('keyTakeaways', '')
        },
        'lessons': [{'lesson': l} for l in lessons_list]
    }

    # Rule 3: Use deterministic tracking ID fed by the orchestrator instead of random UUIDs/timestamps
    payload = {
        "jsonrpc": "2.0",
        "id": tracking_id,
        "method": "tools/call",
        "params": {
            "name": "save-course-draft-target___save_course_draft",
            "arguments": arguments
        }
    }
    
    payload_bytes = json.dumps(payload).encode('utf-8')
    rpc_req = urllib.request.Request(url, data=payload_bytes, headers=headers, method='POST')
    rpc_response_body = execute_http_request_with_retry(rpc_req, execution_id=execution_id)
    res_body = json.loads(rpc_response_body.decode('utf-8'))
    if 'error' in res_body:
        raise Exception(f"Gateway tool RPC error: {res_body['error']}")
    result = res_body.get('result', {})
    if result.get('isError', False):
        raise Exception(f"Gateway tool execution error: {result.get('content', '')}")
    return result


@durable_step
def publish_status_step(step_ctx: StepContext, request_id: str, status: str, message: str, video_url: str = "") -> bool:
    """Publishes a status update event to the EventBridge EventBus for live frontend updates."""
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
                    'EventBusName': 'VideoAgentEventBus'
                }
            ]
        )
        return True
    except Exception as e:
        activity_log(request_id, "warning", f"Failed to publish status event: {e}")
        return False


# --- CORE DURABLE ORCHESTRATOR HANDLER (SYLLABUS WORKFLOW ORCHESTRATOR) ---


@durable_execution
def lambda_handler(event: Dict[str, Any], context: DurableContext) -> Dict[str, Any]:
    """Purely deterministic Durable Orchestrator entry point handler."""
    # Retrieve execution_id using the helper (Rule 5)
    arn = context.execution_context.durable_execution_arn
    execution_id = arn.split("/")[0] if "/" in arn else (arn or "local-execution")

    if not context.is_replaying:
        logger.info(f"Received event: {json.dumps(event)}")

    video_uri = event.get('mediaFileUri')
    if not video_uri:
        raise ValueError("Missing mediaFileUri in event payload")

    # Publish initial status
    context.step(publish_status_step(video_uri, "TRANSCRIBING", "Extracting audio and starting transcription..."), name="PublishTranscribing")

    # 1. Submit/Start Transcription and await completion (Yielding compute)
    tx_state = context.step(get_or_start_transcription_step(video_uri, execution_id), name="StartTranscription")
    while tx_state["status"] == "IN_PROGRESS":
        context.wait(Duration.from_seconds(15), name="WaitTranscription")
        tx_state = context.step(check_transcription_status_step(tx_state["jobName"], execution_id), name="CheckTranscription")

    if tx_state["status"] == "FAILED":
        raise Exception(f"Transcription failed: {tx_state.get('reason')}")

    transcript_file_uri = tx_state["transcriptFileUri"]

    # Publish segmenting status
    context.step(publish_status_step(video_uri, "SEGMENTING", "Generating global insights and lesson segments..."), name="PublishSegmenting")

    # 2. Parallel fan-out: Generate Global Insights + Curriculum Segmentation
    def run_global_insights(child_ctx: DurableContext):
        return child_ctx.step(generate_global_insights_step(video_uri, transcript_file_uri, execution_id), name="GlobalInsights")

    def run_syllabus_curriculum(child_ctx: DurableContext):
        return child_ctx.step(generate_syllabus_curriculum_step(transcript_file_uri, execution_id), name="CurriculumSegmentation")

    batch_result = context.parallel([run_global_insights, run_syllabus_curriculum], name="GlobalAndCurriculum")
    global_assets = batch_result.get_results()[0]
    lessons_raw = batch_result.get_results()[1]

    # 3. Process each lesson slice in parallel using concurrent Durable Futures (Rule 2/3)
    # Wrap each in try/except internally to isolate crashes
    def process_lesson_branch(index: int, lesson: Dict[str, Any]):
        def run_branch(child_ctx: DurableContext):
            try:
                # Slices segment (FFmpeg worker step)
                video_segment_uri = child_ctx.step(
                    slice_video_segment_step(index, lesson, video_uri, execution_id),
                    name=f"SliceVideoSegment_{index}"
                )
                
                # Invokes Strands multi-agent analytics step
                lesson_result = child_ctx.step(
                    invoke_lesson_agents_step(lesson, transcript_file_uri, execution_id),
                    name=f"InvokeLessonAgents_{index}"
                )
                
                lesson_result['videoUri'] = video_segment_uri
                return lesson_result
            except Exception as e:
                if not child_ctx.is_replaying:
                    logger.error(f"Failed to process lesson {index} ({lesson.get('title')}): {e}")
                # Graceful local fallback to preserve overall pipeline progress (Rule 3)
                return {
                    'title': lesson.get('title', f"Lesson {index+1}"),
                    'module': lesson.get('module', 'General'),
                    'description': lesson.get('description', ''),
                    'startTime': float(lesson.get('start_time', 0)),
                    'endTime': float(lesson.get('end_time', 0)),
                    'videoUri': video_uri,
                    'summary': "(Lesson summary temporarily unavailable due to processing error)",
                    'qa': "",
                    'flashcards': "",
                    'keyTakeaways': ""
                }
        return run_branch

    # Publish generating status
    context.step(publish_status_step(video_uri, "GENERATING", "Generating summaries, flashcards, and quizzes for lessons..."), name="PublishGenerating")

    # Rule 3: Group parallel activity payloads into fixed batches (maximum execution groups of 3)
    # and process batches sequentially to respect model TPS limits.
    batch_size = 3
    lessons_list = []
    
    if not context.is_replaying:
        logger.info(f"Processing {len(lessons_raw)} lessons concurrently in batches of {batch_size}")
        
    for batch_idx in range(0, len(lessons_raw), batch_size):
        batch_lessons = lessons_raw[batch_idx:batch_idx + batch_size]
        batch_branches = [
            process_lesson_branch(batch_idx + i, lesson) 
            for i, lesson in enumerate(batch_lessons)
        ]
        
        if not context.is_replaying:
            logger.info(f"Executing batch {batch_idx // batch_size + 1} of lessons processing...")
            
        batch_results = context.parallel(
            batch_branches, 
            name=f"ProcessLessonsBatch_{batch_idx // batch_size}"
        ).get_results()
        lessons_list.extend(batch_results)

    # 4. Save Draft via Cognito-Authenticated AgentCore Gateway tool call
    # Rule 1: Use deterministic tracking ID derived from the context execution ARN and suffix
    h = hashlib.md5(f"{arn}-save_course_draft".encode("utf-8")).hexdigest()
    tracking_id = f"tx-save_course_draft-{h[:16]}"
    
    context.step(
        save_course_draft_step(video_uri, global_assets, lessons_list, execution_id, tracking_id), 
        name="SaveCourseDraft"
    )

    return {
        "videoUri": video_uri,
        "lessonsCount": len(lessons_list)
    }

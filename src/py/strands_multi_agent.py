import os
import sys
import json
import time
import shutil
import hashlib
import logging
import subprocess
from datetime import datetime
from decimal import Decimal
from urllib.parse import urlparse, quote
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Any, Optional

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# --- LOGGING SETUP ---
logger = logging.getLogger()
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
    logger.addHandler(handler)


class TranscriptionService:
    """Manages AWS Transcribe jobs and fetches results."""

    def __init__(self, client: Any = None):
        self.client = client or boto3.client('transcribe', region_name='us-east-1')

    def _generate_job_name(self, video_uri: str) -> str:
        uri_hash = hashlib.md5(video_uri.encode('utf-8')).hexdigest()
        return f"educloud-transcribe-{uri_hash}"

    def get_or_start_transcription(self, video_uri: str) -> str:
        """Finds an existing completed or in-progress transcription job, or starts a new one."""
        job_name = self._generate_job_name(video_uri)
        try:
            job = self.client.get_transcription_job(TranscriptionJobName=job_name)['TranscriptionJob']
            status = job['TranscriptionJobStatus']
            if status == 'COMPLETED':
                logger.info(f"Found completed Transcribe job: {job_name}")
                return job['Transcript']['TranscriptFileUri']
            elif status in ('IN_PROGRESS', 'QUEUED'):
                logger.info(f"Found existing Transcribe job in progress: {job_name}. Polling...")
                return self._poll_transcription_job(job_name)
            elif status == 'FAILED':
                logger.warning(f"Found failed Transcribe job: {job_name}. Deleting and restarting...")
                self.client.delete_transcription_job(TranscriptionJobName=job_name)
        except self.client.exceptions.BadRequestException:
            pass
        except Exception as e:
            logger.warning(f"Error checking existing transcribe job: {e}")

        logger.info(f"Starting new Transcribe job: {job_name}")
        file_extension = video_uri.split('.')[-1].lower()
        self.client.start_transcription_job(
            TranscriptionJobName=job_name,
            Media={'MediaFileUri': video_uri},
            MediaFormat=file_extension,
            LanguageCode='en-US'
        )
        return self._poll_transcription_job(job_name)

    def _poll_transcription_job(self, job_name: str, poll_interval: int = 10) -> str:
        """Polls the status of the transcription job until completion or failure."""
        logger.info(f"Polling Transcribe job: {job_name}")
        while True:
            try:
                status_response = self.client.get_transcription_job(TranscriptionJobName=job_name)
                job = status_response['TranscriptionJob']
                status = job['TranscriptionJobStatus']
                if status == 'COMPLETED':
                    logger.info("Transcribe job completed!")
                    return job['Transcript']['TranscriptFileUri']
                elif status == 'FAILED':
                    raise Exception(f"Transcription job failed: {job.get('FailureReason')}")
                else:
                    logger.info(f"Transcription job status: {status}. Waiting {poll_interval}s...")
                    time.sleep(poll_interval)
            except Exception as e:
                logger.error(f"Error polling transcribe job: {e}")
                raise e


class AgentCoreService:
    """Interacts with AWS Bedrock AgentCore Runtimes using SigV4 HTTP requests."""

    def __init__(self, region: str = "us-east-1", control_client: Any = None):
        self.region = region
        self.control_client = control_client or boto3.client('bedrock-agentcore-control', region_name=region)
        self._session = boto3.Session()

    def get_runtime_arn_by_name(self, runtime_name: str) -> str:
        """Finds the ARN of an AgentCore runtime by its name."""
        logger.info(f"Locating Bedrock AgentCore runtime '{runtime_name}'...")
        try:
            runtimes = self.control_client.list_agent_runtimes()['agentRuntimes']
            app_runtime = next((r for r in runtimes if r.get('agentRuntimeName') == runtime_name), None)
            if not app_runtime:
                raise ValueError(f"Could not find Bedrock AgentCore runtime named '{runtime_name}'")
            return app_runtime['agentRuntimeArn']
        except Exception as e:
            logger.error(f"Failed to locate AgentCore runtime: {e}")
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

    def invoke_agent(self, agent_runtime_arn: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Performs a signed SigV4 request to invoke the AgentCore HTTP endpoint."""
        encoded_arn = quote(agent_runtime_arn, safe="")
        url = f"https://bedrock-agentcore.{self.region}.amazonaws.com/runtimes/{encoded_arn}/invocations"
        logger.info(f"HTTP Endpoint URL: {url}")

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
            with urllib.request.urlopen(req) as response:
                response_body = response.read().decode("utf-8")
                result = json.loads(response_body)
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
            logger.error(f"HTTPError invoking AgentCore: {e.code} - {e.reason}. Body: {error_body}")
            raise Exception(f"SigV4 AgentCore HTTP call failed: {e.code} {e.reason} - {error_body}")
        except Exception as e:
            logger.error(f"Error during HTTP agent invocation: {e}")
            raise e


class VideoProcessor:
    """Handles video segmentation, cutting using FFmpeg, and S3 uploads."""

    def __init__(self, s3_client: Any = None):
        self.s3_client = s3_client or boto3.client('s3', region_name='us-east-1')

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
        local_input: str
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
            logger.warning("FFmpeg binary not found. Skipping video cutting.")
            return ""

        logger.info(f"Cutting segment {index}: {start_time} to {end_time} (duration: {duration}s)...")
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

            logger.info(f"Uploading segment to s3://{src_bucket}/{dest_key}...")
            self.s3_client.upload_file(local_output, src_bucket, dest_key)

            if os.path.exists(local_output):
                os.remove(local_output)

            return f"s3://{src_bucket}/{dest_key}"
        except Exception as e:
            logger.error(f"Failed to cut/upload segment {index}: {e}")
            if os.path.exists(local_output):
                try:
                    os.remove(local_output)
                except Exception:
                    pass
            return ""


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


class SyllabusOrchestrator:
    """Orchestrates the entire educational syllabus generation pipeline."""

    def __init__(self, region: str = "us-east-1"):
        self.region = region
        self.transcribe_service = TranscriptionService()
        self.agent_service = AgentCoreService(region=region)
        self.video_processor = VideoProcessor()
        self.bedrock_runtime = boto3.client('bedrock-runtime', region_name=region)
        self.dynamodb = boto3.resource('dynamodb', region_name=region)

        self.table_name = os.environ.get('TABLE_NAME')
        self.table = self.dynamodb.Table(self.table_name) if self.table_name else None

    def _fetch_json(self, url: str) -> Dict[str, Any]:
        logger.info(f"Fetching JSON from URL: {url}")
        with urllib.request.urlopen(url) as response:
            return json.loads(response.read().decode('utf-8'))

    def _invoke_nova_pro_video_analysis(self, video_uri: str, fmt: str) -> str:
        logger.info(f"Invoking Bedrock Nova Pro to analyze video content: {video_uri}")
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
        try:
            response = self.bedrock_runtime.invoke_model(
                modelId="amazon.nova-pro-v1:0",
                body=json.dumps(native_request),
                contentType="application/json"
            )
            response_body = json.loads(response.get("body").read())
            return response_body['output']['message']['content'][0]['text']
        except Exception as e:
            logger.error(f"Failed to analyze video with Bedrock Nova Pro: {e}")
            raise e

    def _segment_syllabus(self, transcript_text: str) -> List[Dict[str, Any]]:
        logger.info("Segmenting transcription into modules and lessons...")
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
{transcript_text}"""

        request = {
            "messages": [
                {
                    "role": "user",
                    "content": [{"text": prompt}]
                }
            ]
        }

        try:
            response = self.bedrock_runtime.invoke_model(
                modelId="amazon.nova-pro-v1:0",
                body=json.dumps(request),
                contentType="application/json"
            )
            response_body = json.loads(response.get("body").read())
            text_response = response_body['output']['message']['content'][0]['text']
            return self._extract_json_array(text_response)
        except Exception as e:
            logger.error(f"Failed to segment syllabus with Bedrock: {e}")
            raise e

    @staticmethod
    def _extract_json_array(text: str) -> List[Dict[str, Any]]:
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

    def run_pipeline(self, video_uri: str) -> Dict[str, Any]:
        """Runs the entire multi-stage syllabus parsing and video slicing pipeline."""
        parsed = urlparse(video_uri)
        video_key = parsed.path.lstrip('/')
        video_format = video_key.split('.')[-1].lower()
        supported_formats = {'mp4', 'mov', 'webm', 'mkv'}
        fmt = video_format if video_format in supported_formats else 'mp4'

        # 1. AWS Transcribe
        transcript_url = self.transcribe_service.get_or_start_transcription(video_uri)
        transcribe_data = self._fetch_json(transcript_url)
        transcript_text = transcribe_data.get('results', {}).get('transcripts', [{}])[0].get('transcript', '')
        # Get timestamp-marked transcript for curriculum segmentation
        marked_transcript = TranscriptProcessor.get_transcript_with_timestamps(transcribe_data, interval_seconds=30.0)

        # 2. Bedrock Nova Pro Video Analysis (with fallback)
        try:
            video_analysis = self._invoke_nova_pro_video_analysis(video_uri, fmt)
        except Exception:
            logger.warning("Nova Pro analysis failed. Falling back to audio transcript text.")
            video_analysis = transcript_text

        # 3. Locate AgentCore runtime named 'app'
        agent_runtime_arn = self.agent_service.get_runtime_arn_by_name("app")

        # 4. Generate Global Video Insights
        logger.info("Generating overall video learning insights...")
        global_summary = ""
        global_qa = ""
        global_flashcards = ""
        global_takeaways = ""
        try:
            global_result = self.agent_service.invoke_agent(agent_runtime_arn, {"video_analysis": video_analysis})
            global_summary = global_result.get("summary", "")
            global_qa = global_result.get("qa", "")
            global_flashcards = global_result.get("flashcards", "")
            global_takeaways = global_result.get("keyTakeaways", "")
        except Exception as e:
            logger.error(f"Failed to generate global learning insights: {e}")

        # 5. Syllabus Segmentation
        lessons_raw = []
        try:
            raw_parsed = self._segment_syllabus(marked_transcript)
            logger.info(f"Successfully segmented syllabus into {len(raw_parsed)} lessons.")
            for lesson in raw_parsed:
                start_raw = lesson.get('start_time')
                end_raw = lesson.get('end_time')
                lesson['start_time'] = parse_time_to_seconds(start_raw)
                lesson['end_time'] = parse_time_to_seconds(end_raw)
                lessons_raw.append(lesson)
        except Exception as e:
            logger.error(f"Curriculum segmentation failed: {e}")

        # 6. Slicing and Lesson Insight Generation
        lessons_list = []
        if lessons_raw:
            src_bucket = parsed.netloc
            src_key = parsed.path.lstrip('/')

            # Generate a presigned GET URL for FFmpeg to stream from S3 directly
            input_uri = ""
            if self.video_processor.get_ffmpeg_path():
                try:
                    logger.info("Generating presigned GET URL for S3 streaming...")
                    input_uri = self.video_processor.s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': src_bucket, 'Key': src_key},
                        ExpiresIn=3600
                    )
                except Exception as e:
                    logger.error(f"Failed to generate presigned GET URL: {e}")

            def process_lesson(index: int, lesson: Dict[str, Any]) -> Dict[str, Any]:
                start_time = float(lesson.get('start_time', 0))
                end_time = float(lesson.get('end_time', 0))

                # Cut segment using streaming input if available
                video_segment_uri = ""
                if input_uri:
                    video_segment_uri = self.video_processor.cut_and_upload_segment(
                        index, lesson, src_bucket, src_key, input_uri
                    )
                if not video_segment_uri:
                    video_segment_uri = video_uri

                # Slice transcript
                lesson_transcript = TranscriptProcessor.get_transcript_segment(transcribe_data, start_time, end_time)
                if not lesson_transcript.strip():
                    lesson_transcript = f"Lesson covering start time {start_time} to {end_time} seconds: {lesson.get('title')}."

                # Invoke Strands Multi-Agent (including the new Claude 3.5 Sonnet QA/Reviewer Agent)
                summary_text = ""
                qa_text = ""
                flashcards_text = ""
                takeaways_text = ""
                try:
                    payload = {
                        "video_analysis": f"Segment Transcript:\n{lesson_transcript}\n\nLesson Title: {lesson.get('title')}\nDescription: {lesson.get('description')}"
                    }
                    agent_result = self.agent_service.invoke_agent(agent_runtime_arn, payload)
                    summary_text = agent_result.get('summary', '')
                    qa_text = agent_result.get('qa', '')
                    flashcards_text = agent_result.get('flashcards', '')
                    takeaways_text = agent_result.get('keyTakeaways', '')
                except Exception as e:
                    logger.error(f"Failed to run Strands agents for lesson {index}: {e}")

                return {
                    'title': lesson.get('title', f"Lesson {index+1}"),
                    'module': lesson.get('module', 'General'),
                    'description': lesson.get('description', ''),
                    'startTime': Decimal(str(start_time)),
                    'endTime': Decimal(str(end_time)),
                    'videoUri': video_segment_uri,
                    'summary': summary_text,
                    'qa': qa_text,
                    'flashcards': flashcards_text,
                    'keyTakeaways': takeaways_text
                }

            # Execute parallel cutting and analysis
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = [executor.submit(process_lesson, i, l) for i, l in enumerate(lessons_raw)]
                lessons_list = [f.result() for f in futures]

        # 7. Persist to DynamoDB
        if self.table:
            logger.info(f"Saving learning syllabus assets to DynamoDB for videoUri {video_uri}")
            item = {
                'videoUri': video_uri,
                'summary': global_summary,
                'qa': global_qa,
                'flashcards': global_flashcards,
                'keyTakeaways': global_takeaways,
                'lessons': lessons_list,
                'createdAt': datetime.utcnow().isoformat()
            }
            try:
                self.table.put_item(Item=item)
                logger.info("Successfully saved syllabus to DynamoDB!")
            except Exception as e:
                logger.error(f"Failed to save item to DynamoDB: {e}")
                raise e
        else:
            logger.error("DynamoDB Table is not initialized. Skipping database save.")

        return {
            "videoUri": video_uri,
            "lessonsCount": len(lessons_list)
        }


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """Lambda entry point handler."""
    logger.info(f"Received event: {json.dumps(event)}")

    video_uri = event.get('mediaFileUri')
    if not video_uri:
        raise ValueError("Missing mediaFileUri in event payload")

    orchestrator = SyllabusOrchestrator()
    result = orchestrator.run_pipeline(video_uri)

    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "AI Syllabus Segmentation and Video Cutting completed successfully",
            "videoUri": result["videoUri"],
            "lessonsCount": result["lessonsCount"]
        })
    }

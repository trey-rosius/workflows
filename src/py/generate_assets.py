import boto3
import json
import logging
import urllib.request
import urllib.error
from urllib.parse import quote
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from typing import Dict, Any

logger = logging.getLogger()
logger.setLevel(logging.INFO)

translate_client = boto3.client('translate', region_name='us-east-1')

def safe_translate(text: str, target_lang: str) -> str:
    if not text or not text.strip():
        return ""
    try:
        max_chunk_size = 9000
        chunks = [text[i:i + max_chunk_size] for i in range(0, len(text), max_chunk_size)]
        translated_chunks = []
        for chunk in chunks:
            response = translate_client.translate_text(
                Text=chunk,
                SourceLanguageCode='auto',
                TargetLanguageCode=target_lang
            )
            translated_chunks.append(response['TranslatedText'])
        return " ".join(translated_chunks)
    except Exception as e:
        logger.error(f"Error translating text to {target_lang}: {e}")
        return text  # fallback to original

class TranscriptProcessor:
    @staticmethod
    def get_transcript_segment(transcribe_data: Dict[str, Any], start_sec: float, end_sec: float) -> str:
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

class AgentCoreService:
    def __init__(self, region: str = "us-east-1"):
        self.region = region
        self.control_client = boto3.client('bedrock-agentcore-control', region_name=region)
        self._session = boto3.Session()

    def get_runtime_arn_by_name(self, runtime_name: str) -> str:
        runtimes = self.control_client.list_agent_runtimes()['agentRuntimes']
        app_runtime = next((r for r in runtimes if r.get('agentRuntimeName') == runtime_name), None)
        if not app_runtime:
            raise ValueError(f"Could not find Bedrock AgentCore runtime named '{runtime_name}'")
        return app_runtime['agentRuntimeArn']

    def _extract_text(self, field_val: Any) -> str:
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
        encoded_arn = quote(agent_runtime_arn, safe="")
        url = f"https://bedrock-agentcore.{self.region}.amazonaws.com/runtimes/{encoded_arn}/invocations"
        
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
            logger.error(f"HTTPError: {e.code} - {e.reason}. Body: {error_body}")
            raise Exception(f"AgentCore call failed: {error_body}")

def handler(event, context):
    logger.info(f"Generate assets event: {json.dumps(event)}")
    
    video_uri = event.get('mediaFileUri')
    transcribe_data = event.get('transcribeData')
    lesson = event.get('lesson')
    
    if not transcribe_data:
        raise ValueError("Missing transcribeData in payload")
        
    start_time = 0.0
    end_time = 0.0
    is_global = True
    
    if lesson:
        start_time = float(lesson.get('startTime', 0))
        end_time = float(lesson.get('endTime', 0))
        is_global = False
        
    # Get transcript segment
    if is_global:
        lesson_transcript = transcribe_data.get('results', {}).get('transcripts', [{}])[0].get('transcript', '')
        logger.info("Generating global assets...")
    else:
        lesson_transcript = TranscriptProcessor.get_transcript_segment(transcribe_data, start_time, end_time)
        if not lesson_transcript.strip():
            lesson_transcript = f"Lesson covering {lesson.get('title')}"
        logger.info(f"Generating assets for lesson: {lesson.get('title')}...")

    agent_service = AgentCoreService()
    agent_runtime_arn = agent_service.get_runtime_arn_by_name("app")
    
    payload = {
        "video_analysis": f"Segment Transcript:\n{lesson_transcript}\n\nTitle: {lesson.get('title') if lesson else 'Global Video Summary'}"
    }
    
    try:
        agent_result = agent_service.invoke_agent(agent_runtime_arn, payload)
        
        # Translate generated assets to French and Spanish
        target_langs = ['fr', 'es']
        localized_list = []
        for lang in target_langs:
            logger.info(f"Translating assets to {lang}...")
            loc_summary = safe_translate(agent_result.get('summary', ''), lang)
            loc_qa = safe_translate(agent_result.get('qa', ''), lang)
            loc_flashcards = safe_translate(agent_result.get('flashcards', ''), lang)
            loc_key_takeaways = safe_translate(agent_result.get('keyTakeaways', ''), lang)
            localized_list.append({
                'summary': loc_summary,
                'qa': loc_qa,
                'flashcards': loc_flashcards,
                'keyTakeaways': loc_key_takeaways
            })

        if is_global:
            return {
                "mediaFileUri": video_uri,
                "summary": agent_result.get('summary', ''),
                "qa": agent_result.get('qa', ''),
                "flashcards": agent_result.get('flashcards', ''),
                "keyTakeaways": agent_result.get('keyTakeaways', ''),
                "translations": target_langs,
                "localized": localized_list
            }
        else:
            lesson['summary'] = agent_result.get('summary', '')
            lesson['qa'] = agent_result.get('qa', '')
            lesson['flashcards'] = agent_result.get('flashcards', '')
            lesson['keyTakeaways'] = agent_result.get('keyTakeaways', '')
            lesson['translations'] = target_langs
            lesson['localized'] = localized_list
            return {"lesson": lesson}
            
    except Exception as e:
        logger.error(f"Failed to generate assets: {e}")
        raise e

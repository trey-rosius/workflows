import boto3
import json
import logging
import os
from typing import Dict, List, Any
from event_publisher import publish_status
from db_progress import update_progress

logger = logging.getLogger()
logger.setLevel(logging.INFO)

bedrock_runtime = boto3.client('bedrock-runtime', region_name='us-east-1')

def get_transcript_with_timestamps(transcribe_data: Dict[str, Any], interval_seconds: float = 30.0) -> str:
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

def extract_json_object(text: str) -> Dict[str, Any]:
    cleaned = text.strip()
    try:
        val = json.loads(cleaned)
        if isinstance(val, dict):
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
                if isinstance(val, dict):
                    return val
            except Exception:
                pass

    start = cleaned.find('{')
    end = cleaned.rfind('}')
    if start != -1 and end != -1 and end > start:
        try:
            val = json.loads(cleaned[start:end+1])
            if isinstance(val, dict):
                return val
        except Exception:
            pass

    raise ValueError(f"Could not extract a valid JSON object from model response: {text}")

def handler(event, context):
    logger.info(f"Segment syllabus event: {json.dumps(event)}")
    
    video_uri = event.get('mediaFileUri')
    transcribe_data = event.get('transcribeData')
    transcript_file_uri = event.get('transcriptFileUri')
    
    if not transcribe_data and transcript_file_uri:
        logger.info(f"Fetching transcript JSON from S3: {transcript_file_uri}")
        try:
            import urllib.request
            req = urllib.request.Request(transcript_file_uri)
            with urllib.request.urlopen(req) as response:
                transcribe_data = json.loads(response.read().decode('utf-8'))
        except Exception as e:
            logger.error(f"Failed to fetch transcript file: {e}")
            raise e
            
    if not transcribe_data:
        raise ValueError("Missing transcribeData or transcriptFileUri in payload")
        
    publish_status(video_uri, "SEGMENTING", "Analyzing transcript content and segmenting syllabus...")
    update_progress(video_uri, "SEGMENTING", "Analyzing transcript content and segmenting syllabus...")
    
    marked_transcript = get_transcript_with_timestamps(transcribe_data, interval_seconds=30.0)
    
    prompt = f"""You are an educational syllabus designer and curriculum expert.
Analyze the following video transcript. The transcript has timestamp markers in the format [MM:SS] (minutes:seconds) periodically inserted.

Your task is to:
1. Design a professional, semantic course title (maximum 6 words, e.g. "AWS CDK: Setting up Your IDE") and a brief course description.
2. Break the transcript down into logical educational modules and lessons. Each module can contain multiple lessons.
3. For each lesson, identify the exact start and end times in "MM:SS" format based on the closest [MM:SS] markers in the transcript (e.g. "01:30" or "10:15").

Return ONLY a valid JSON object, with no markdown formatting tags (no ```json, no explanation), containing the syllabus.
The JSON object must have exactly these keys:
- "title": A short, professional, semantic course title (max 6 words).
- "description": A brief summary of what the course covers.
- "lessons": A list of lesson objects, where each object has these fields:
  - "module": Name of the module
  - "title": Name of the lesson
  - "description": Description of what is covered in this lesson
  - "start_time": Starting timestamp of this lesson in "MM:SS" format (e.g. "01:30")
  - "end_time": Ending timestamp of this lesson in "MM:SS" format (e.g. "10:15")

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
    
    try:
        response = bedrock_runtime.invoke_model(
            modelId="amazon.nova-pro-v1:0",
            body=json.dumps(request),
            contentType="application/json"
        )
        response_body = json.loads(response.get("body").read())
        text_response = response_body['output']['message']['content'][0]['text']
        
        syllabus = extract_json_object(text_response)
        
        # Convert start/end times to float seconds
        lessons = []
        for index, lesson in enumerate(syllabus.get('lessons', [])):
            start_raw = lesson.get('start_time')
            end_raw = lesson.get('end_time')
            lesson['startTime'] = parse_time_to_seconds(start_raw)
            lesson['endTime'] = parse_time_to_seconds(end_raw)
            lesson['index'] = index
            lessons.append(lesson)
            
        syllabus['lessons'] = lessons
        
        logger.info(f"Syllabus segmented successfully into {len(lessons)} lessons.")
        publish_status(video_uri, "SEGMENTING", f"Syllabus segmented into {len(lessons)} lessons. Course Title: {syllabus.get('title')}")
        update_progress(video_uri, "SEGMENTING", f"Syllabus segmented into {len(lessons)} lessons. Course Title: {syllabus.get('title')}")
        update_progress(video_uri, "GENERATING", "Generating video segments, summaries, quizzes, and flashcards...")
        
        return {
            "mediaFileUri": video_uri,
            "title": syllabus.get('title', 'Video Course'),
            "description": syllabus.get('description', 'Course generated from video.'),
            "lessons": lessons,
            "transcriptText": event.get("transcriptText"),
            "translatedTranscripts": event.get("translatedTranscripts"),
            "transcriptFileUri": transcript_file_uri
        }
    except Exception as e:
        logger.error(f"Failed to segment syllabus: {e}")
        publish_status(video_uri, "FAILED", f"Syllabus segmentation failed: {str(e)}")
        raise e

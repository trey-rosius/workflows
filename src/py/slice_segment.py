import boto3
import json
import logging
import os
import shutil
import subprocess
from urllib.parse import urlparse
from event_publisher import publish_status

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3_client = boto3.client('s3', region_name='us-east-1')

def get_ffmpeg_path() -> str:
    path_env = shutil.which("ffmpeg")
    if path_env:
        return path_env
    for path_opt in ["/opt/bin/ffmpeg", "/opt/ffmpeg"]:
        if os.path.exists(path_opt):
            return path_opt
    path_local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg")
    if os.path.exists(path_local):
        return path_local
    return ""

def handler(event, context):
    logger.info(f"Slice segment event: {json.dumps(event)}")
    
    video_uri = event.get('mediaFileUri')
    lesson = event.get('lesson')
    index = event.get('index', 0)
    
    if not video_uri or not lesson:
        raise ValueError("Missing mediaFileUri or lesson in payload")
        
    start_time = float(lesson.get('startTime', 0))
    end_time = float(lesson.get('endTime', 0))
    duration = max(0.1, end_time - start_time)
    
    parsed = urlparse(video_uri)
    src_bucket = parsed.netloc
    src_key = parsed.path.lstrip('/')
    
    original_filename = os.path.basename(src_key)
    dest_key = f"lessons/{original_filename}/lesson_{index}.mp4"
    local_output = f"/tmp/output_{index}.mp4"
    
    ffmpeg_path = get_ffmpeg_path()
    if not ffmpeg_path:
        logger.warning("FFmpeg binary not found. Skipping video cutting.")
        lesson['videoUri'] = video_uri
        return {"lesson": lesson}
        
    try:
        # Generate presigned GET URL for FFmpeg to stream from S3 directly
        logger.info("Generating presigned GET URL for S3 streaming...")
        input_uri = s3_client.generate_presigned_url(
            'get_object',
            Params={'Bucket': src_bucket, 'Key': src_key},
            ExpiresIn=3600
        )
        
        logger.info(f"Cutting segment {index}: {start_time} to {end_time}...")
        command = [
            ffmpeg_path,
            "-ss", str(start_time),
            "-i", input_uri,
            "-t", str(duration),
            "-c", "copy",
            "-y",
            local_output
        ]
        
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        
        logger.info(f"Uploading segment to s3://{src_bucket}/{dest_key}...")
        s3_client.upload_file(local_output, src_bucket, dest_key)
        
        if os.path.exists(local_output):
            os.remove(local_output)
            
        lesson['videoUri'] = f"s3://{src_bucket}/{dest_key}"
        return {"lesson": lesson}
        
    except Exception as e:
        logger.error(f"Failed to slice video: {e}")
        if os.path.exists(local_output):
            try:
                os.remove(local_output)
            except Exception:
                pass
        # Fallback to original video
        lesson['videoUri'] = video_uri
        return {"lesson": lesson}

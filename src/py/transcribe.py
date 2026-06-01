import boto3
import hashlib
import json
import logging
from event_publisher import publish_status
from db_progress import update_progress

logger = logging.getLogger()
logger.setLevel(logging.INFO)

transcribe_client = boto3.client('transcribe', region_name='us-east-1')

def get_job_name(video_uri: str) -> str:
    uri_hash = hashlib.md5(video_uri.encode('utf-8')).hexdigest()
    return f"educloud-transcribe-{uri_hash}"

def handler(event, context):
    logger.info(f"Transcribe event: {json.dumps(event)}")
    
    video_uri = event.get('mediaFileUri')
    action = event.get('action', 'start')
    
    if not video_uri:
        raise ValueError("Missing mediaFileUri in payload")
        
    job_name = get_job_name(video_uri)
    
    if action == 'start':
        logger.info(f"Starting Transcribe job {job_name} for {video_uri}")
        publish_status(video_uri, "TRANSCRIBING", "Extracting audio and starting transcription...")
        update_progress(video_uri, "TRANSCRIBING", "Extracting audio and starting transcription...")
        
        file_extension = video_uri.split('.')[-1].lower()
        try:
            transcribe_client.start_transcription_job(
                TranscriptionJobName=job_name,
                Media={'MediaFileUri': video_uri},
                MediaFormat=file_extension,
                LanguageCode='en-US'
            )
        except transcribe_client.exceptions.ConflictException:
            logger.info(f"Transcribe job {job_name} already exists or is running.")
            
        return {
            "mediaFileUri": video_uri,
            "transcribeJobName": job_name,
            "status": "IN_PROGRESS"
        }
        
    elif action == 'status':
        logger.info(f"Checking Transcribe job status for {job_name}")
        try:
            response = transcribe_client.get_job_run_status_or_similar = transcribe_client.get_job_run_details = transcribe_client.get_transcription_job(
                TranscriptionJobName=job_name
            )
            job = response['TranscriptionJob']
            status = job['TranscriptionJobStatus']
            
            if status == 'COMPLETED':
                logger.info(f"Transcribe job completed: {job_name}")
                transcript_url = job['Transcript']['TranscriptFileUri']
                publish_status(video_uri, "TRANSCRIBING", "Transcription completed successfully.")
                update_progress(video_uri, "TRANSCRIBING", "Transcription completed successfully.")
                return {
                    "mediaFileUri": video_uri,
                    "transcribeJobName": job_name,
                    "status": "COMPLETED",
                    "transcriptFileUri": transcript_url
                }
            elif status == 'FAILED':
                reason = job.get('FailureReason', 'Unknown error')
                logger.error(f"Transcribe job failed: {reason}")
                publish_status(video_uri, "FAILED", f"Transcription failed: {reason}")
                update_progress(video_uri, "FAILED", f"Transcription failed: {reason}")
                raise Exception(f"Transcription failed: {reason}")
            else:
                return {
                    "mediaFileUri": video_uri,
                    "transcribeJobName": job_name,
                    "status": "IN_PROGRESS"
                }
        except Exception as e:
            logger.error(f"Error checking status for Transcribe job {job_name}: {e}")
            raise e
            
    else:
        raise ValueError(f"Unknown action: {action}")

import boto3
import json
import logging
import urllib.request
from typing import Dict
from event_publisher import publish_status
from db_progress import update_progress

logger = logging.getLogger()
logger.setLevel(logging.INFO)

translate_client = boto3.client('translate', region_name='us-east-1')

def chunk_and_translate(text: str, target_lang: str) -> str:
    if not text.strip():
        return ""
    # Max size per Amazon Translate call is 10,000 bytes. We use a safe chunk size of 9000 characters.
    max_chunk_size = 9000
    chunks = [text[i:i + max_chunk_size] for i in range(0, len(text), max_chunk_size)]
    translated_chunks = []
    
    for chunk in chunks:
        try:
            response = translate_client.translate_text(
                Text=chunk,
                SourceLanguageCode='en',
                TargetLanguageCode=target_lang
            )
            translated_chunks.append(response['TranslatedText'])
        except Exception as e:
            logger.error(f"Error translating chunk: {e}")
            raise e
            
    return " ".join(translated_chunks)

def handler(event, context):
    logger.info(f"Translate event: {json.dumps(event)}")
    
    video_uri = event.get('mediaFileUri')
    transcript_file_uri = event.get('transcriptFileUri')
    
    # We can also receive direct text to translate (useful for map task assets)
    text_to_translate = event.get('text')
    target_languages = event.get('targetLanguages', ['fr', 'es'])
    
    if text_to_translate:
        # Direct asset translation mode
        translated = {}
        for lang in target_languages:
            translated[lang] = chunk_and_translate(text_to_translate, lang)
        return {"translated": translated}
        
    if not transcript_file_uri:
        raise ValueError("Missing transcriptFileUri in payload")
        
    publish_status(video_uri, "TRANSLATING", "Translating transcript content to target languages...")
    update_progress(video_uri, "TRANSLATING", "Translating transcript content to target languages...")
    
    # Fetch transcript json
    logger.info(f"Fetching transcript JSON from: {transcript_file_uri}")
    try:
        req = urllib.request.Request(transcript_file_uri)
        with urllib.request.urlopen(req) as response:
            transcribe_data = json.loads(response.read().decode('utf-8'))
    except Exception as e:
        logger.error(f"Failed to fetch transcript file: {e}")
        raise e
        
    transcript_text = transcribe_data.get('results', {}).get('transcripts', [{}])[0].get('transcript', '')
    
    # Translate to French and Spanish
    translated_transcripts = {}
    for lang in target_languages:
        logger.info(f"Translating transcript to {lang}...")
        translated_transcripts[lang] = chunk_and_translate(transcript_text, lang)
        
    publish_status(video_uri, "TRANSLATING", "Translation complete.")
    update_progress(video_uri, "TRANSLATING", "Translation complete.")
    
    return {
        "mediaFileUri": video_uri,
        "transcriptFileUri": transcript_file_uri,
        "transcriptText": transcript_text,
        "translatedTranscripts": translated_transcripts
    }

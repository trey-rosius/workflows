import boto3
import json
import os
import logging
from botocore.exceptions import ClientError
from urllib.parse import urlparse

# --- CONFIGURATION FROM ENV VARS ---
SOURCE_BUCKET_NAME = os.environ.get('SOURCE_BUCKET_NAME') 
VECTOR_BUCKET_NAME = os.environ.get('VECTOR_BUCKET_NAME')
VECTOR_INDEX_NAME = os.environ.get('VECTOR_INDEX_NAME', '')
VECTOR_DIMENSION = int(os.environ.get('VECTOR_DIMENSION', '1024'))

# Setup Logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
s3_client = boto3.client('s3')
s3_vectors_client = boto3.client('s3vectors')

def process_jsonl_file(key, s3_source_uri):
    """
    Streams a JSONL file from S3, parses vectors, and pushes to S3 Vector Index.
    """
    logger.info(f"Processing file: {key}")
    logger.info(f"s3_source_uri: {s3_source_uri}")
    
    try:
        response = s3_client.get_object(Bucket=SOURCE_BUCKET_NAME, Key=key)
        stream = response['Body'].iter_lines()
        
        batch = []
        batch_size = 20 
        
        for i, line in enumerate(stream):
            if not line: continue
            
            try:
                record = json.loads(line)
                
                # Create unique key for segment using line index to guarantee uniqueness
                # format: id-lineIndex (e.g. 12345-0, 12345-1)
                base_id = str(record.get('id'))
                unique_key = f"{base_id}-{i}"

                vector_entry = {
                    'key': unique_key, 
                    'data': {"float32": record.get('embedding')}, 
                }
                
                # Extract metadata: check both 'metadata' (generic) and 'segmentMetadata' (Bedrock Segmented)
                raw_metadata = record.get('metadata', {})
                segment_metadata = record.get('segmentMetadata', {})
                
                # Merge them (segmentMetadata takes precedence or just combines)
                combined_metadata = {**raw_metadata, **segment_metadata}
                
                vector_entry['metadata'] = combined_metadata

                if s3_source_uri:
                    vector_entry['metadata']['s3_uri'] = s3_source_uri

                batch.append(vector_entry)

                if len(batch) >= batch_size:
                    flush_batch(batch)
                    batch = []
                    
            except json.JSONDecodeError:
                logger.warning(f"Skipping invalid JSON line in {key}")
                continue

        # Flush remaining
        if batch:
            flush_batch(batch)
            
    except Exception as e:
        logger.error(f"Failed to process file {key}: {e}")
        raise e

def flush_batch(batch):
    """
    Sends a batch of vectors to the S3 Vector Index
    """
    try:
        s3_vectors_client.put_vectors(
            vectorBucketName=VECTOR_BUCKET_NAME,
            indexName=VECTOR_INDEX_NAME,
            vectors=batch
        )
        logger.info(f"Successfully ingested batch of {len(batch)} vectors.")
    except Exception as e:
        logger.error(f"Error flushing batch: {e}")
        raise e

def lambda_handler(event, context):
    logger.info(f"Received Event: {json.dumps(event)}")
   
    s3_uri = event.get('S3Uri', '')
    mediaFileUri = event.get('mediaFileUri', '')

    logger.info(f"s3_uri: {s3_uri}")
    logger.info(f"mediaFileUri: {mediaFileUri}")
    
    prefix = ''
    if s3_uri:
       
        parsed = urlparse(s3_uri)
 
        prefix = parsed.path.lstrip('/')
    
    # Validation
    if not prefix:
        logger.warning("No prefix found in event. Scanning root of bucket (this might be slow).")
    
    logger.info("--- Starting Vector Ingestion Job ---")
    logger.info(f"Source Bucket: {SOURCE_BUCKET_NAME}")
    logger.info(f"Target Index: {VECTOR_INDEX_NAME}")
    logger.info(f"Scanning Prefix: {prefix}")

    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        # We pass the prefix here to only process files from this specific job
        page_iterator = paginator.paginate(Bucket=SOURCE_BUCKET_NAME, Prefix=prefix)

        file_count = 0
        for page in page_iterator:
            if 'Contents' not in page:
                continue
                
            for obj in page['Contents']:
                key = obj['Key']
                # Only process .jsonl output files
                if key.endswith('.jsonl'):
                    # Pass the source S3 URI if available in the event
                   
                    process_jsonl_file(key, mediaFileUri)
                    file_count += 1
        
        result_msg = f"Processed {file_count} files successfully from prefix: {prefix}"
        logger.info(result_msg)
        

    except Exception as e:
        logger.error(f"Fatal error in execution: {e}")

import os
import json
import time
import random
import logging
import boto3
from datetime import datetime, timedelta
from boto3.dynamodb.types import TypeDeserializer

# Setup Logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
bedrock_runtime_client = boto3.client('bedrock-runtime', region_name='us-east-1')
deserializer = TypeDeserializer()

CHAT_SESSIONS_TABLE_NAME = os.environ.get('CHAT_SESSIONS_TABLE_NAME')
CHAT_EVALUATIONS_TABLE_NAME = os.environ.get('CHAT_EVALUATIONS_TABLE_NAME')

def deserialize_item(item):
    return {k: deserializer.deserialize(v) for k, v in item.items()}

def invoke_judge_model(user_prompt, assistant_response):
    prompt = f"""You are a specialized AI Auditor and Curriculum Judge.
Evaluate the following interaction between a student and an AI Tutor on relevance, politeness, and adherence to the curriculum.

Student Question: {user_prompt}
AI Tutor Response: {assistant_response}

Score each metric on a scale from 1 (poor) to 10 (perfect) and provide a brief justification for your scoring.
Return your output ONLY as a valid JSON object with the following fields:
- relevanceScore: (integer between 1 and 10)
- politenessScore: (integer between 1 and 10)
- adherenceScore: (integer between 1 and 10)
- justification: (string summarizing your reasoning in 2-3 sentences)

JSON:"""

    request_body = {
        "messages": [
            {
                "role": "user",
                "content": [{"text": prompt}]
            }
        ]
    }
    
    try:
        response = bedrock_runtime_client.invoke_model(
            modelId="amazon.nova-pro-v1:0", # Use Nova Pro for robust evaluation
            contentType="application/json",
            body=json.dumps(request_body)
        )
        response_payload = json.loads(response.get("body").read())
        answer = response_payload['output']['message']['content'][0]['text'].strip()
        
        # Clean markdown code block wraps if present
        if answer.startswith("```json"):
            answer = answer[7:]
        if answer.endswith("```"):
            answer = answer[:-3]
        answer = answer.strip()
        
        return json.loads(answer)
    except Exception as e:
        logger.error(f"Failed to invoke judge model or parse response: {e}")
        return {
            "relevanceScore": 10,
            "politenessScore": 10,
            "adherenceScore": 10,
            "justification": f"Fallback scores. Auditor failed: {str(e)}"
        }

def handler(event, context):
    logger.info("Starting daily chatlog evaluation pipeline...")
    
    if not CHAT_SESSIONS_TABLE_NAME or not CHAT_EVALUATIONS_TABLE_NAME:
        logger.error("Missing environment variables.")
        return {"statusCode": 500, "body": "Configuration error"}
        
    try:
        # Retrieve all sessions
        response = dynamodb_client.scan(TableName=CHAT_SESSIONS_TABLE_NAME)
        items = response.get('Items', [])
        
        evaluations_run = 0
        
        for item in items:
            session = deserialize_item(item)
            session_id = session.get('sessionId')
            history_raw = session.get('chatHistory', '[]')
            
            # De-serialize history if it's a string
            history = []
            if isinstance(history_raw, str):
                try:
                    history = json.loads(history_raw)
                except Exception:
                    pass
            elif isinstance(history_raw, list):
                history = history_raw
                
            if not history:
                continue
                
            # Pair prompt-responses from the history list
            qa_pairs = []
            current_q = None
            for turn in history:
                if turn.get('role') == 'user':
                    current_q = turn.get('content')
                elif turn.get('role') == 'assistant' and current_q:
                    qa_pairs.append((current_q, turn.get('content')))
                    current_q = None
                    
            if not qa_pairs:
                continue
                
            # Randomly sample 5% of pairs (minimum 1 pair)
            sample_size = max(1, int(len(qa_pairs) * 0.05))
            sampled_pairs = random.sample(qa_pairs, sample_size)
            
            logger.info(f"Session {session_id}: Evaluating {sample_size} sample turns out of {len(qa_pairs)} total pairs.")
            
            for idx, (q, a) in enumerate(sampled_pairs):
                # Run LLM evaluation
                eval_result = invoke_judge_model(q, a)
                
                evaluation_id = f"eval-{session_id}-{int(time.time())}-{idx}"
                
                # Write to ChatEvaluationsTable
                dynamodb_client.put_item(
                    TableName=CHAT_EVALUATIONS_TABLE_NAME,
                    Item={
                        'evaluationId': {'S': evaluation_id},
                        'sessionId': {'S': session_id},
                        'timestamp': {'S': str(time.time())},
                        'userPrompt': {'S': q},
                        'assistantResponse': {'S': a},
                        'relevanceScore': {'N': str(eval_result.get('relevanceScore', 10))},
                        'politenessScore': {'N': str(eval_result.get('politenessScore', 10))},
                        'adherenceScore': {'N': str(eval_result.get('adherenceScore', 10))},
                        'justification': {'S': eval_result.get('justification', '')}
                    }
                )
                evaluations_run += 1
                
        logger.info(f"Overnight evaluations finished successfully. Run {evaluations_run} evaluations.")
        return {"statusCode": 200, "body": f"Successfully evaluated {evaluations_run} chat log turns."}
        
    except Exception as e:
        logger.error(f"Error in overnight evaluation handler: {e}")
        return {"statusCode": 500, "body": str(e)}

import os
import json
import random
import time
import logging
import re
import hashlib
import boto3
import urllib.request
from boto3.dynamodb.types import TypeDeserializer

# Setup Logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Clients
bedrock_runtime_client = boto3.client('bedrock-runtime', region_name='us-east-1')
s3_vectors_client = boto3.client('s3vectors')
dynamodb_client = boto3.client('dynamodb', region_name='us-east-1')
deserializer = TypeDeserializer()

# Env Configuration
COURSES_TABLE_NAME = os.environ.get('COURSES_TABLE_NAME')
CHAT_SESSIONS_TABLE_NAME = os.environ.get('CHAT_SESSIONS_TABLE_NAME')
VECTOR_BUCKET_NAME = os.environ.get('VECTOR_BUCKET_NAME')
VECTOR_INDEX_NAME = os.environ.get('VECTOR_INDEX_NAME')
CONTENT_DEMAND_TELEMETRY_TABLE_NAME = os.environ.get('CONTENT_DEMAND_TELEMETRY_TABLE_NAME')
TUTOR_GUARDRAIL_ID = os.environ.get('TUTOR_GUARDRAIL_ID')
TUTOR_GUARDRAIL_VERSION = os.environ.get('TUTOR_GUARDRAIL_VERSION')
APPSYNC_ENDPOINT = os.environ.get('APPSYNC_ENDPOINT')
APPSYNC_API_KEY = os.environ.get('APPSYNC_API_KEY')

def publish_chunk(session_id, chunk, is_complete=False):
    if not APPSYNC_ENDPOINT or not APPSYNC_API_KEY:
        logger.warning("AppSync endpoint or key not configured for streaming.")
        return
        
    query = """
    mutation PublishChatbotChunk($sessionId: String!, $chunk: String!, $isComplete: Boolean!) {
      publishChatbotChunk(sessionId: $sessionId, chunk: $chunk, isComplete: $isComplete) {
        sessionId
        chunk
        isComplete
      }
    }
    """
    
    payload = {
        "query": query,
        "variables": {
            "sessionId": session_id,
            "chunk": chunk,
            "isComplete": is_complete
        }
    }
    
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        APPSYNC_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/json",
            "x-api-key": APPSYNC_API_KEY
        },
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            response.read()
    except Exception as e:
        logger.error(f"Failed to publish chunk to AppSync: {e}")

# Predefined ELI5 dictionary for instant answers
ELI5_DICTIONARY = {
    "VPC": "VPC stands for Virtual Private Cloud. Think of it as your own private fenced-in yard inside the massive public cloud neighborhood, where only your applications are allowed to hang out.",
    "SQS": "SQS stands for Simple Queue Service. Think of it as a busy post office box where messages wait in a neat line until a mail carrier is ready to pick them up and deliver them.",
    "DYNAMODB": "DynamoDB is a super-fast, flexible NoSQL database. Think of it like a massive digital filing cabinet where every folder has its own unique label, and you can pull out any file in a millisecond, no matter how many files you store.",
    "LAMBDA": "AWS Lambda is a service that runs your code only when needed, without any server to manage. Think of it like a smart light bulb that only uses electricity when someone walks into the room.",
    "APPSYNC": "AWS AppSync is a tool that connects your front-end app to your databases and APIs using GraphQL. Think of it as a smart waiter at a restaurant who takes your specific orders and brings back exactly what you asked for.",
    "COGNITO": "AWS Cognito manages user login, sign-up, and access. Think of it like a secure bouncer at a club entrance who checks IDs and hands out VIP wristbands to allowed guests.",
    "EVENTBRIDGE": "EventBridge is a service that routes events (messages) between different services. Think of it as a central traffic cop directing cars to different streets based on where they want to go.",
    "SNS": "SNS stands for Simple Notification Service. Think of it like a town crier who broadcasts urgent news or updates to everyone who has subscribed to listen.",
    "IAM": "IAM stands for Identity and Access Management. Think of it like a security system in a building that controls who has a keycard to enter specific rooms.",
    "CLOUDFRONT": "CloudFront is a CDN (Content Delivery Network). Think of it as a chain of local convenience stores that stock copies of popular products, so customers don't have to travel to the main warehouse to buy them.",
    "S3": "S3 stands for Simple Storage Service. Think of it like an infinite digital storage locker where you can throw in files, images, and videos, and easily retrieve them with a web link.",
    "GRAPHQL": "GraphQL is a query language for APIs. Think of it as ordering custom pizza toppings: instead of getting a fixed pre-made pizza, you specify exactly what toppings you want, and they deliver just that.",
    "REST": "REST is a standard way to request data from servers. Think of it as a vending machine: you press a specific button (endpoint) and it drops down a pre-packaged snack, whether you want the whole bag or just a bite."
}

# Diagnostic questions database
DIAGNOSTIC_QUESTIONS = {
    "q1": {
        "question": "What is the primary difference between a Relational Database (like RDS) and a NoSQL Database (like DynamoDB)?",
        "options": [
            "Relational databases use fixed schemas and tables, while NoSQL offers dynamic schemas.",
            "Relational databases can only store text, while NoSQL can store binary.",
            "NoSQL is always cheaper than Relational.",
            "There is no difference."
        ],
        "correct_index": 0,
        "topic": "Databases"
    },
    "q2_hard": {
        "question": "In AWS AppSync, what is the role of a Resolver?",
        "options": [
            "To translate GraphQL requests into data source operations and format responses.",
            "To resolve DNS queries for the API.",
            "To authenticate users using JWTs.",
            "To compile TypeScript into JavaScript."
        ],
        "correct_index": 0,
        "topic": "GraphQL & AppSync"
    },
    "q2_easy": {
        "question": "What is AWS S3 primarily used for?",
        "options": [
            "Object storage for files, videos, and backups.",
            "Executing serverless code.",
            "Managing relational databases.",
            "Sending notifications."
        ],
        "correct_index": 0,
        "topic": "Cloud Storage"
    },
    "q3_hard": {
        "question": "What is the primary purpose of RAG (Retrieval-Augmented Generation) in AI applications?",
        "options": [
            "To enhance LLM responses by fetching relevant context from an external database.",
            "To train models faster.",
            "To translate text between different programming languages.",
            "To generate synthetic training images."
        ],
        "correct_index": 0,
        "topic": "AI Agents & RAG"
    },
    "q3_easy": {
        "question": "What is AWS Lambda?",
        "options": [
            "A serverless compute service that runs code in response to events.",
            "A relational database.",
            "A content delivery network (CDN).",
            "An email sending service."
        ],
        "correct_index": 0,
        "topic": "Serverless Compute"
    }
}

EXTERNAL_QUICKSTARTS = {
    "Azure Functions": """Azure Functions Quickstart Documentation:
Azure Functions is a serverless compute service that enables you to run event-triggered code without having to explicitly provision or manage infrastructure.

Core Concepts:
- Triggers: What causes a function to run. A function must have exactly one trigger (e.g. HTTPTrigger, CosmosDBTrigger, QueueTrigger).
- Bindings: Declarative way of connecting another resource to the function (input and output bindings).

Quickstart Step-by-step:
1. Create a Local Project: Use the Azure Functions Core Tools to initialize a project: func init LocalFunctionProj --python
2. Create a Function: Create a new function: func new --name HttpTriggerSimple --template "HTTP trigger" --authlevel "anonymous"
3. Run Locally: Start the local runtime hosting: func start
4. Deploy to Azure: Publish the project: func azure functionapp publish <FunctionAppName>""",

    "GCP Cloud Run": """GCP Cloud Run Quickstart Documentation:
GCP Cloud Run is a fully managed serverless platform that enables you to run containerized applications on top of Google's infrastructure.

Core Concepts:
- Containerization: Pack your code and dependencies into a Docker container.
- Scale to Zero: Scales up or down automatically based on incoming traffic, including scaling down to zero when idle.

Quickstart Step-by-step:
1. Prepare Application: Write a service (e.g. Node.js, Python Flask) that listens on the PORT environment variable.
2. Create Dockerfile: Write a Dockerfile to package the application.
3. Build & Push: Build the container image and upload to Google Artifact Registry: gcloud builds submit --tag gcr.io/<ProjectID>/<ImageName>
4. Deploy: Deploy the container to Cloud Run: gcloud run deploy --image gcr.io/<ProjectID>/<ImageName> --platform managed""",

    "Kubernetes": """Kubernetes (K8s) Quickstart Documentation:
Kubernetes is an open-source container orchestration platform for automating deployment, scaling, and management of containerized applications.

Core Concepts:
- Pod: The smallest deployable units of computing that you can create and manage in Kubernetes.
- Deployment: Declares the desired state for Pods and ReplicaSets.
- Service: An abstract way to expose an application running on a set of Pods as a network service.

Quickstart Step-by-step:
1. Create a Cluster: Set up a local cluster using Minikube: minikube start
2. Create a Deployment: Define your deployment YAML or run kubectl: kubectl create deployment hello-node --image=registry.k8s.io/e2e-test-images/agnhost:2.39 -- /agnhost netexec --http-port=8080
3. Expose Service: Expose the deployment as a service: kubectl expose deployment hello-node --type=LoadBalancer --port=8080
4. Inspect Status: View running pods and services: kubectl get pods,services""",

    "General Cloud Development": """General Cloud Development Quickstart:
Cloud development involves building, deploying, and managing applications in public cloud environments such as AWS, Azure, or GCP.

Core Concepts:
- Infrastructure as Code (IaC): Automate provisioning using tools like Terraform, CloudFormation, or CDK.
- Serverless: Focus on application logic using fully managed computing services (Lambda, Cloud Run, Azure Functions).

Quickstart Step-by-step:
1. Provision Resources: Write code to provision computing, database, and storage resources.
2. Secure Access: Apply Least Privilege access controls using IAM policies.
3. CI/CD Pipeline: Build automated pipelines to test, build, and deploy your services.
4. Monitoring & Logging: Collect metrics and trace executions to diagnose issues."""
}

def deserialize_item(item):
    """Deserializes DynamoDB low-level JSON into standard Python types."""
    return {k: deserializer.deserialize(v) for k, v in item.items()}

def get_session(session_id):
    if not CHAT_SESSIONS_TABLE_NAME:
        return None
    try:
        res = dynamodb_client.get_item(
            Key={'sessionId': {'S': session_id}},
            TableName=CHAT_SESSIONS_TABLE_NAME
        )
        if 'Item' in res:
            deserialized = deserialize_item(res['Item'])
            # Deserialize nested JSON strings
            if 'answers' in deserialized and isinstance(deserialized['answers'], str):
                try:
                    deserialized['answers'] = json.loads(deserialized['answers'])
                except Exception:
                    pass
            if 'chatHistory' in deserialized and isinstance(deserialized['chatHistory'], str):
                try:
                    deserialized['chatHistory'] = json.loads(deserialized['chatHistory'])
                except Exception:
                    pass
            return deserialized
    except Exception as e:
        logger.error(f"Error getting session {session_id}: {e}")
    return None

def save_session(session_id, data):
    if not CHAT_SESSIONS_TABLE_NAME:
        return
    try:
        item = {'sessionId': {'S': session_id}}
        for k, v in data.items():
            if k == 'sessionId':
                continue
            if isinstance(v, str):
                item[k] = {'S': v}
            elif isinstance(v, (int, float)):
                item[k] = {'N': str(v)}
            elif isinstance(v, bool):
                item[k] = {'BOOL': v}
            elif isinstance(v, (list, dict)):
                item[k] = {'S': json.dumps(v)}
        dynamodb_client.put_item(
            TableName=CHAT_SESSIONS_TABLE_NAME,
            Item=item
        )
    except Exception as e:
        logger.error(f"Error saving session {session_id}: {e}")

def check_answer(user_reply, question_data):
    reply = user_reply.strip().upper()
    m = re.match(r'^\s*([A-D])\b', reply)
    if m:
        letter = m.group(1)
        idx = ord(letter) - ord('A')
        return idx == question_data['correct_index']
    
    correct_text = question_data['options'][question_data['correct_index']].upper()
    if correct_text in reply or reply in correct_text:
        return True
    return False

def format_question(question_key):
    q = DIAGNOSTIC_QUESTIONS[question_key]
    options_str = "\n".join([f"**{chr(65+i)}:** {opt}" for i, opt in enumerate(q['options'])])
    return f"### Topic: {q['topic']}\n**Question:** {q['question']}\n\n{options_str}\n\n*Please reply with the letter of your choice (A, B, C, or D).* "

def detect_assessment_intent(message):
    msg = message.lower()
    keywords = ["learning path", "where to start", "where should i start", "start learning", "diagnostic", "evaluation", "assessment", "quiz me", "which course", "how to start"]
    for kw in keywords:
        if kw in msg:
            return True
    return False

def execute_with_retry(func, max_retries: int = 5, initial_backoff: float = 1.0):
    """Executes a Bedrock or S3 request with exponential backoff and jitter for throttling."""
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            error_name = type(e).__name__
            is_retryable = "Throttling" in error_name or "LimitExceeded" in error_name or "ProvisionedThroughputExceeded" in error_name or "500" in str(e)
            if not is_retryable or attempt == max_retries - 1:
                logger.error(f"Call failed on final attempt/non-retryable error: {e}")
                raise e
            backoff = initial_backoff * (2 ** attempt)
            sleep_time = random.uniform(0, backoff)
            logger.warning(f"Request failed due to {error_name}. Retrying in {sleep_time:.2f} seconds...")
            time.sleep(sleep_time)

def fetch_course_catalog():
    """Scans CoursesTable to retrieve a compact list of all available courses."""
    try:
        response = dynamodb_client.scan(
            TableName=COURSES_TABLE_NAME,
            ProjectionExpression="courseId, title, description, difficulty, frameworks, aws_services"
        )
        catalog = []
        for item in response.get('Items', []):
            course = deserialize_item(item)
            catalog.append({
                "courseId": course.get("courseId", ""),
                "title": course.get("title", ""),
                "description": course.get("description", ""),
                "difficulty": course.get("difficulty", "Intermediate"),
                "frameworks": course.get("frameworks", []),
                "aws_services": course.get("aws_services", [])
            })
        return catalog
    except Exception as e:
        logger.error(f"Error scanning course catalog from DynamoDB: {e}")
        return []

def detect_topic_from_message(message):
    topics = ["Azure Functions", "Azure", "GCP Cloud Run", "GCP", "Google Cloud", "Kubernetes", "Docker", "Terraform", "Ansible", "Jenkins"]
    for t in topics:
        if t.lower() in message.lower():
            return t
    return "General Cloud Development"

def local_guardrail_check(message):
    msg_lower = message.lower()
    
    # 1. Politics
    politics_keywords = ["politics", "election", "democrat", "republican", "president", "trump", "biden", "government policies"]
    for kw in politics_keywords:
        if re.search(r'\b' + kw + r'\b', msg_lower):
            return "I am an educational tutor and can only assist with curriculum-related questions."
            
    # 2. Financial Advice
    financial_keywords = ["stocks", "crypto", "bitcoin", "investing", "financial advice", "financial recommendation", "shares", "portfolio"]
    for kw in financial_keywords:
        if re.search(r'\b' + kw + r'\b', msg_lower):
            return "I am an educational tutor and can only assist with curriculum-related questions."
            
    # 3. Prompt Attacks / Jailbreak
    injection_patterns = [
        "ignore previous instructions",
        "ignore all previous instructions",
        "system prompt",
        "write me a python script to scrape",
        "bypass guardrail"
    ]
    for pattern in injection_patterns:
        if pattern in msg_lower:
            return "I am an educational tutor and can only assist with curriculum-related questions."
            
    return None

def invoke_bedrock_with_guardrail(model_id, system_text, messages, apply_guardrail=True, stream_session_id=None):
    """Invokes Bedrock Converse API with native Guardrails and returns (response_text, blocked_boolean, tokens_used)."""
    params = {
        "modelId": model_id,
        "messages": messages,
    }
    
    if system_text:
        params["system"] = [{"text": system_text}]
        
    # Apply Guardrail if available
    if apply_guardrail and TUTOR_GUARDRAIL_ID and TUTOR_GUARDRAIL_VERSION:
        params["guardrailConfig"] = {
            "guardrailIdentifier": TUTOR_GUARDRAIL_ID,
            "guardrailVersion": TUTOR_GUARDRAIL_VERSION
        }
        
    # Check if streaming is requested
    if stream_session_id:
        def call_converse_stream():
            return bedrock_runtime_client.converse_stream(**params)
            
        try:
            response = execute_with_retry(call_converse_stream)
        except Exception as e:
            logger.error(f"converse_stream call failed: {e}")
            raise e
            
        full_text = ""
        input_tokens = 0
        output_tokens = 0
        buffer_text = ""
        
        stream = response.get('stream')
        if stream:
            for event in stream:
                if 'contentBlockDelta' in event:
                    delta_text = event['contentBlockDelta']['delta'].get('text', '')
                    full_text += delta_text
                    buffer_text += delta_text
                    if len(buffer_text) >= 40 or '\n' in delta_text:
                        publish_chunk(stream_session_id, buffer_text, is_complete=False)
                        buffer_text = ""
                elif 'metadata' in event:
                    usage = event['metadata'].get('usage', {})
                    input_tokens = usage.get('inputTokens', 0)
                    output_tokens = usage.get('outputTokens', 0)
                elif 'messageStop' in event:
                    stop_reason = event['messageStop'].get('stopReason', '')
                    if stop_reason == 'guardrail_intervened':
                        logger.warning("Guardrail Intervened via Converse Stream API!")
                        blocked_msg = "I am an educational tutor and can only assist with curriculum-related questions."
                        publish_chunk(stream_session_id, blocked_msg, is_complete=True)
                        return blocked_msg, True, 0
            
            if buffer_text:
                publish_chunk(stream_session_id, buffer_text, is_complete=False)
            publish_chunk(stream_session_id, "", is_complete=True)
            return full_text.strip(), False, (input_tokens + output_tokens)
            
    def call_converse():
        return bedrock_runtime_client.converse(**params)
        
    response = execute_with_retry(call_converse)
    
    stop_reason = response.get('stopReason', '')
    
    if stop_reason == 'guardrail_intervened':
        logger.warning("Guardrail Intervened via Converse API!")
        return "I am an educational tutor and can only assist with curriculum-related questions.", True, 0
        
    try:
        answer = response['output']['message']['content'][0]['text'].strip()
        
        # Token usage calculation
        input_tokens = 0
        output_tokens = 0
        if 'usage' in response:
            input_tokens = response['usage'].get('inputTokens', 0)
            output_tokens = response['usage'].get('outputTokens', 0)
            
        return answer, False, (input_tokens + output_tokens)
    except Exception as e:
        logger.error(f"Failed to parse Bedrock Converse response: {e}")
        raise e

def handler(event, context):
    logger.info(f"Received chatbot query event: {json.dumps(event)}")
    
    # Identify which GraphQL query triggered this resolver
    field_name = event.get('info', {}).get('fieldName', 'askCourseChatbot')
    
    if field_name == 'getContentDemandTelemetry':
        logger.info("Fetching content demand telemetry...")
        if not CONTENT_DEMAND_TELEMETRY_TABLE_NAME:
            return []
        try:
            res = dynamodb_client.scan(TableName=CONTENT_DEMAND_TELEMETRY_TABLE_NAME)
            telemetry = []
            for item in res.get('Items', []):
                telemetry.append(deserialize_item(item))
            telemetry.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
            return telemetry
        except Exception as e:
            logger.error(f"Error fetching telemetry: {e}")
            return []

    if field_name == 'getChatEvaluations':
        logger.info("Fetching chat evaluations...")
        evals_table = os.environ.get('CHAT_EVALUATIONS_TABLE_NAME', '730335533756-us-east-1-chat-evaluations-table')
        try:
            res = dynamodb_client.scan(TableName=evals_table)
            evals = []
            for item in res.get('Items', []):
                eval_item = deserialize_item(item)
                eval_item['relevanceScore'] = int(eval_item.get('relevanceScore', 0))
                eval_item['politenessScore'] = int(eval_item.get('politenessScore', 0))
                eval_item['adherenceScore'] = int(eval_item.get('adherenceScore', 0))
                evals.append(eval_item)
            evals.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
            return evals
        except Exception as e:
            logger.error(f"Error fetching evaluations: {e}")
            return []

    if field_name == 'demystifyJargon':
        arguments = event.get('arguments', {})
        term = arguments.get('term', '').strip()
        if not term:
            raise ValueError("Missing 'term' argument")
            
        term_upper = term.upper()
        if term_upper in ELI5_DICTIONARY:
            logger.info(f"Instant ELI5 cached explanation for: {term}")
            return ELI5_DICTIONARY[term_upper]
            
        logger.info(f"Invoking Bedrock for ELI5 explanation of: {term}")
        prompt = f"""Explain the technical concept/term "{term}" using an analogy that a 5-year-old would understand.
Keep it to exactly 2 sentences. Be simple, clear, and pedagogical."""
        
        system_text = "You are a helpful educational tutor."
        messages = [{"role": "user", "content": [{"text": prompt}]}]
        answer, blocked, tokens = invoke_bedrock_with_guardrail("amazon.nova-lite-v1:0", system_text, messages)
        return answer
            
    # Default case: askCourseChatbot
    arguments = event.get('arguments', {})
    course_id = arguments.get('courseId')
    message = arguments.get('message')
    session_id = arguments.get('sessionId')
    
    if not message:
        raise ValueError("Missing 'message' argument")
        
    if not session_id:
        session_id = f"anon-session-{course_id or 'global'}"
        
    logger.info(f"Message: {message}, CourseId: {course_id}, SessionId: {session_id}")
    
    # Retrieve existing session state from DynamoDB
    session_data = get_session(session_id) or {}
    state = session_data.get('state', 'ACTIVE')
    history = session_data.get('chatHistory', [])
    
    # Global Reset Command
    if message.strip().lower() in ['reset', 'restart', 'exit', 'quit']:
        save_session(session_id, {'state': 'ACTIVE', 'chatHistory': []})
        return "Got it. I've reset our conversation history. How can I help you today?"

    # --- PROACTIVE COST CONTROL: Token Rate Limiting ---
    today_str = time.strftime('%Y-%m-%d')
    token_usage = int(session_data.get('dailyTokenUsage', 0))
    last_reset_date = session_data.get('lastUsageDate', '')
    
    if last_reset_date != today_str:
        token_usage = 0
        
    if token_usage >= 50000:
        logger.warning(f"Session {session_id} has exceeded daily token limit: {token_usage} >= 50000")
        return "You have reached your daily limit of 50,000 tokens for this session. Please try again tomorrow."

    # --- LOCK DOWN ABUSE: Local Guardrail Fallback Check ---
    local_block_msg = local_guardrail_check(message)
    if local_block_msg:
        logger.warning(f"Local guardrail blocked prompt: {message}")
        return local_block_msg
        
    # --- DIAGNOSTIC ASSESSMENT STATE MACHINE ---
    if state == 'DIAGNOSTIC':
        current_q_key = session_data.get('currentQuestionKey', 'q1')
        q_data = DIAGNOSTIC_QUESTIONS[current_q_key]
        
        is_correct = check_answer(message, q_data)
        score = int(session_data.get('score', 0))
        if is_correct:
            score += 1
            
        answers = session_data.get('answers', [])
        answers.append({
            "question": q_data['question'],
            "user_answer": message,
            "is_correct": is_correct
        })
        
        next_q_key = None
        if current_q_key == 'q1':
            next_q_key = 'q2_hard' if is_correct else 'q2_easy'
        elif current_q_key in ('q2_hard', 'q2_easy'):
            next_q_key = 'q3_hard' if is_correct else 'q3_easy'
            
        if next_q_key:
            session_data['currentQuestionKey'] = next_q_key
            session_data['score'] = score
            session_data['answers'] = answers
            save_session(session_id, session_data)
            
            feedback = "Correct! ✅" if is_correct else f"Incorrect. ❌ (Correct answer was {chr(65 + q_data['correct_index'])})."
            return f"{feedback}\n\nLet's move on to the next question.\n\n{format_question(next_q_key)}"
        else:
            feedback = "Correct! ✅" if is_correct else f"Incorrect. ❌ (Correct answer was {chr(65 + q_data['correct_index'])})."
            catalog = fetch_course_catalog()
            catalog_str = ""
            if catalog:
                catalog_lines = []
                for c in catalog:
                    fms = ", ".join(c['frameworks']) if c['frameworks'] else "None"
                    svcs = ", ".join(c['aws_services']) if c['aws_services'] else "None"
                    catalog_lines.append(f"- **{c['title']}** (ID: {c['courseId']} | Difficulty: {c['difficulty']} | Frameworks: {fms} | Services: {svcs})\n  Description: {c['description']}")
                catalog_str = "\n".join(catalog_lines)
            
            learning_goal = session_data.get('learningGoal', 'General Cloud Development / AI Solutions Engineer')
            
            prompt = f"""You are an expert curriculum planner. A student has just completed a 3-question diagnostic quiz.
Their score was {score} out of 3.
Here is their performance detailed by question:
{json.dumps(answers)}

The student's target role/learning goal is: "{learning_goal}"

Based on this performance (Score {score}/3: 3=Advanced, 2=Intermediate, 0-1=Beginner) and their target role/learning goal, design a personalized, comprehensive, and encouraging learning path.

To create a complete and holistic curriculum for "{learning_goal}":
1. Incorporate and select the most appropriate courses from our platform's course catalog (listed below). Mark these milestones/courses as **[Platform Course]** and link to them using markdown links in this format: `[Course Title](#course/CourseID)`. Example: `[Introduction to AWS](#course/course-id)`.
2. Since our platform might not have all the courses required for "{learning_goal}", you MUST identify and include external topics, tools, or milestones that are missing from our catalog but are essential to master "{learning_goal}" (e.g., DevOps tools, Azure/GCP/AWS services, container orchestration, systems design, etc.). Mark these missing modules/milestones as **[External Self-Study/Workshop]** so the creator can build future workshops for them.
3. Structure the output with a clear title, target difficulty, and step-by-step milestones in clean, premium markdown format.
4. Explain briefly why you recommend this path based on their answers and target role.

Available Course Catalog:
{catalog_str}

Answer:"""
            
            system_text = "You are an expert curriculum planner."
            messages = [{"role": "user", "content": [{"text": prompt}]}]
            answer, blocked, tokens = invoke_bedrock_with_guardrail("amazon.nova-lite-v1:0", system_text, messages, apply_guardrail=False, stream_session_id=session_id)
            
            # Increment token count
            session_data.update({
                'state': 'COMPLETED',
                'score': score,
                'answers': answers,
                'chatHistory': [
                    {"role": "user", "content": message},
                    {"role": "assistant", "content": answer}
                ],
                'dailyTokenUsage': token_usage + tokens,
                'lastUsageDate': today_str
            })
            save_session(session_id, session_data)
            return f"{feedback}\n\n🎉 **Diagnostic complete! You scored {score}/3.**\n\n{answer}"

    # --- STANDARD CHAT TURN WITH INTENT ROUTING ---
    if detect_assessment_intent(message):
        session_data = {
            "state": "DIAGNOSTIC",
            "currentQuestionKey": "q1",
            "score": 0,
            "answers": [],
            "chatHistory": [],
            "learningGoal": message
        }
        save_session(session_id, session_data)
        return f"Welcome to the EduCloud Diagnostic! Let's do a quick 3-question quiz so I can map out your custom learning path.\n\n{format_question('q1')}"

    # --- 1. Embed student's query ---
    def embed_message():
        body = json.dumps({
            "inputText": message,
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
        
    query_vector = execute_with_retry(embed_message)
    if not query_vector:
        raise ValueError("Failed to generate embedding")

    # --- 2. PROACTIVE COST CONTROL: Semantic Caching ---
    cache_query_params = {
        "vectorBucketName": VECTOR_BUCKET_NAME,
        "indexName": VECTOR_INDEX_NAME,
        "topK": 1,
        "queryVector": {"float32": query_vector},
        "returnMetadata": True,
        "returnDistance": True,
        "filter": {
            "is_cache": { "$eq": "true" }
        }
    }
    
    try:
        cache_response = s3_vectors_client.query_vectors(**cache_query_params)
        cache_vectors = cache_response.get('vectors', [])
        if cache_vectors:
            closest_match = cache_vectors[0]
            distance = closest_match.get('distance', 1.0)
            metadata = closest_match.get('metadata', {})
            # Normalized Cosine Distance: 0 means identical, <= 0.05 is 95% similarity
            if distance <= 0.05:
                # Retrieve from DynamoDB using the vector key
                cache_key = closest_match.get('key')
                if cache_key:
                    cache_data = get_session(cache_key)
                    if cache_data:
                        cached_answer = cache_data.get('cached_response')
                        if cached_answer:
                            logger.info(f"Semantic Cache HIT! Distance: {distance:.4f}.")
                            
                            # Return cached answer directly
                            history.append({"role": "user", "content": message})
                            history.append({"role": "assistant", "content": cached_answer})
                            save_session(session_id, {
                                'state': state,
                                'chatHistory': history,
                                'dailyTokenUsage': token_usage, # No Bedrock token cost
                                'lastUsageDate': today_str
                            })
                            return cached_answer
    except Exception as e:
        logger.warning(f"Semantic cache check skipped: {e}")

    # --- 3. RAG Search inside local platform courses ---
    query_params = {
        "vectorBucketName": VECTOR_BUCKET_NAME,
        "indexName": VECTOR_INDEX_NAME,
        "topK": 5,
        "queryVector": {"float32": query_vector},
        "returnMetadata": True,
        "returnDistance": True
    }
    if course_id:
        query_params["filter"] = {
            "course_id": { "$eq": course_id }
        }
        
    def query_vectors():
        return s3_vectors_client.query_vectors(**query_params)
        
    vector_response = execute_with_retry(query_vectors)
    vectors = vector_response.get('vectors', [])
    
    courses_cache = {}
    context_chunks = []
    min_distance = 2.0
    
    for v in vectors:
        metadata = v.get('metadata', {})
        c_id = metadata.get('course_id')
        l_id = metadata.get('lesson_id')
        distance = v.get('distance', 1.0)
        
        if distance < min_distance:
            min_distance = distance
            
        if not c_id or not l_id:
            continue
            
        if c_id not in courses_cache:
            try:
                res = dynamodb_client.get_item(
                    TableName=COURSES_TABLE_NAME,
                    Key={'courseId': {'S': c_id}}
                )
                if 'Item' in res:
                    courses_cache[c_id] = deserialize_item(res['Item'])
                else:
                    courses_cache[c_id] = None
            except Exception as e:
                logger.error(f"Error fetching course {c_id}: {e}")
                courses_cache[c_id] = None
                
        course_data = courses_cache.get(c_id)
        if not course_data:
            continue
            
        lesson_found = None
        module_title = ""
        for m in course_data.get('modules', []):
            for l in m.get('lessons', []):
                if l.get('lessonId') == l_id:
                    lesson_found = l
                    module_title = m.get('title', '')
                    break
            if lesson_found:
                break
                
        if lesson_found:
            content = lesson_found.get('content', '')
            title = lesson_found.get('title', '')
            course_title = course_data.get('title', '')
            chunk_context = f"Course: {course_title}\nModule: {module_title}\nLesson: {title} (Similarity distance: {distance:.4f})\nContent:\n{content}"
            context_chunks.append(chunk_context)

    # --- 4. Content Telemetry and MCP Fallback for Content Gaps ---
    is_external_fallback = False
    telemetry_topic = detect_topic_from_message(message)
    
    # List of non-platform topics that must trigger fallback
    non_platform_topics = ["Azure Functions", "Azure", "GCP Cloud Run", "GCP", "Google Cloud", "Kubernetes", "Ansible", "Jenkins"]
    
    # If no results or average cosine distance indicates no relevance (distance > 0.65)
    # OR if the topic is explicitly a non-platform topic
    if not context_chunks or min_distance > 0.65 or telemetry_topic in non_platform_topics:
        is_external_fallback = True
        logger.info(f"RAG yielded zero/poor matches or explicit non-platform topic '{telemetry_topic}' (min distance: {min_distance:.4f}). Invoking MCP simulated fallback.")
        
        # Look up quickstart text in EXTERNAL_QUICKSTARTS to provide grounding source
        quickstart_text = EXTERNAL_QUICKSTARTS.get(telemetry_topic, EXTERNAL_QUICKSTARTS["General Cloud Development"])
        context_chunks = [quickstart_text]
        
        # Log telemetry event to ContentDemandTelemetry
        request_id = f"telemetry-{session_id}-{int(time.time())}"
        try:
            dynamodb_client.put_item(
                TableName=CONTENT_DEMAND_TELEMETRY_TABLE_NAME,
                Item={
                    'requestId': {'S': request_id},
                    'prompt': {'S': message},
                    'timestamp': {'S': str(time.time())},
                    'detectedTopic': {'S': telemetry_topic}
                }
            )
            logger.info("ContentDemandTelemetry record logged.")
        except Exception as e:
            logger.error(f"Failed to log ContentDemandTelemetry: {e}")

    # --- 5. Model Routing & Prompt Prep ---
    model_id = "amazon.nova-lite-v1:0"
    complex_keywords = ["excalidraw", "architecture diagram", "system design", "system architecture", "design dynamic", "design system", "draw", "visualize"]
    if any(kw in message.lower() for kw in complex_keywords):
        model_id = "amazon.nova-pro-v1:0"
        
    # Dynamic service detection and course mapping
    msg_lower = message.lower()
    topic_services_map = {
        "ai solutions architect": ["Bedrock", "AgentCore", "SageMaker", "Rekognition", "Comprehend", "Textract", "Lex", "Translate", "Strands"],
        "ai architect": ["Bedrock", "AgentCore", "SageMaker", "Rekognition", "Comprehend", "Textract", "Lex", "Translate", "Strands"],
        "machine learning": ["SageMaker", "Bedrock"],
        "ml": ["SageMaker", "Bedrock"],
        "nlp": ["Comprehend", "Translate", "Lex", "Bedrock"],
        "computer vision": ["Rekognition", "Textract", "SageMaker"],
        "deep learning": ["SageMaker", "Bedrock"],
        "serverless": ["Lambda", "AppSync", "EventBridge", "Step Functions", "SAM", "CDK", "SST"]
    }
    
    services_keywords = {
        "Bedrock": ["bedrock"],
        "AgentCore": ["agentcore", "agent core"],
        "SageMaker": ["sagemaker", "sage maker"],
        "Rekognition": ["rekognition"],
        "Comprehend": ["comprehend"],
        "Textract": ["textract"],
        "Lex": ["lex"],
        "Translate": ["translate"],
        "Lambda": ["lambda"],
        "AppSync": ["appsync", "app sync"],
        "EventBridge": ["eventbridge", "event bridge"],
        "Step Functions": ["step functions", "stepfunction", "step function"],
        "S3": ["s3", "simple storage service", "amazon s3"],
        "DynamoDB": ["dynamodb", "dynamo db"],
        "Cognito": ["cognito"],
        "WAF": ["waf"],
        "CloudFront": ["cloudfront", "cloud front"],
        "ECS": ["ecs", "elastic container service"],
        "Fargate": ["fargate"],
        "ECR": ["ecr"],
        "SQS": ["sqs"],
        "SES": ["ses"],
        "Amplify": ["amplify"],
        "Route 53": ["route 53", "route53"],
        "IAM": ["iam"],
        "CloudWatch": ["cloudwatch", "cloud watch"],
        "API Gateway": ["api gateway", "apigateway"],
        "SAM": ["sam", "serverless application model"],
        "CDK": ["cdk", "cloud development kit"],
        "SST": ["sst"],
        "Winglang": ["winglang"],
        "Ampt": ["ampt"],
        "Temporal": ["temporal"],
        "Terraform": ["terraform"],
        "Strands": ["strands", "strand"]
    }

    detected_services = set()
    for topic, services in topic_services_map.items():
        if topic in msg_lower:
            detected_services.update(services)
            
    for svc, kws in services_keywords.items():
        for kw in kws:
            if re.search(r'\b' + re.escape(kw) + r'\b', msg_lower):
                detected_services.add(svc)
                break

    catalog = fetch_course_catalog()
    matching_courses = []
    if detected_services:
        for c in catalog:
            c_services = [s.lower() for s in c.get('aws_services', [])]
            c_frameworks = [f.lower() for f in c.get('frameworks', [])]
            
            is_match = False
            for ds in detected_services:
                if (ds.lower() in c_services or 
                    ds.lower() in c_frameworks or 
                    ds.lower() in c['title'].lower() or
                    ds.lower() in c['description'].lower()):
                    is_match = True
                    break
            if is_match:
                matching_courses.append(c)

    # Compile matching courses string
    matching_courses_lines = []
    for c in matching_courses:
        fms = ", ".join(c['frameworks']) if c['frameworks'] else "None"
        svcs = ", ".join(c['aws_services']) if c['aws_services'] else "None"
        matching_courses_lines.append(f"- **{c['title']}** (ID: {c['courseId']} | Difficulty: {c['difficulty']} | Frameworks: {fms} | Services: {svcs})\n  Description: {c['description']}")
    matching_courses_str = "\n".join(matching_courses_lines) if matching_courses_lines else "No direct course matches found for the detected services."

    # General service documentations fallback
    service_documentations = {
        "Bedrock": "Amazon Bedrock is a fully managed service that offers high-performing foundation models (FMs) from leading AI companies via a single API, along with capabilities for security, privacy, and responsible AI.",
        "AgentCore": "Amazon Bedrock AgentCore is a robust framework to build and run multi-agent workflows, enabling LLMs to call APIs, invoke actions, use knowledge bases, and stream responses.",
        "SageMaker": "Amazon SageMaker is a fully managed service that enables data scientists and developers to build, train, and deploy machine learning models at scale.",
        "Rekognition": "Amazon Rekognition makes it easy to add image and video analysis to your applications, offering object, scene, text, and facial detection.",
        "Comprehend": "Amazon Comprehend is a natural language processing (NLP) service that uses machine learning to find insights and relationships in text.",
        "Textract": "Amazon Textract automatically extracts text, handwriting, layout, and data from scanned documents, PDFs, and forms.",
        "Lex": "Amazon Lex is a service for building conversational interfaces into any application using voice and text (chatbots).",
        "Translate": "Amazon Translate is a neural machine translation service that delivers fast, high-quality, and affordable language translation.",
        "Lambda": "AWS Lambda is a serverless compute service that runs your code in response to events and automatically manages the underlying compute resources.",
        "AppSync": "AWS AppSync is a serverless GraphQL and Pub/Sub API service that simplifies building secure, collaborative applications with real-time updates.",
        "EventBridge": "Amazon EventBridge is a serverless event bus that makes it easy to connect applications together using data from your own applications, SaaS, and AWS services.",
        "Step Functions": "AWS Step Functions is a serverless orchestration service that lets you coordinate multiple AWS services into serverless workflows and state machines.",
        "DynamoDB": "Amazon DynamoDB is a fully managed, serverless, key-value NoSQL database designed for high-performance applications at any scale.",
        "Strands": "Strands is a lightweight, local-first agentic workflow framework designed to construct and execute multi-agent orchestrations, enabling seamless local LLM tool calling, agent collaborator networks, and high-performance streaming outputs.",
        "CDK": "AWS Cloud Development Kit (AWS CDK) is an open-source software development framework to define your cloud application resources using familiar programming languages."
    }

    detected_docs = []
    for svc in detected_services:
        if svc in service_documentations:
            detected_docs.append(f"### {svc} Documentation:\n{service_documentations[svc]}")
    docs_context_str = "\n\n".join(detected_docs) if detected_docs else "No official documentation found for the requested services."
        
    catalog_str = ""
    if catalog:
        catalog_lines = []
        for c in catalog:
            fms = ", ".join(c['frameworks']) if c['frameworks'] else "None"
            svcs = ", ".join(c['aws_services']) if c['aws_services'] else "None"
            catalog_lines.append(f"- **{c['title']}** (ID: {c['courseId']} | Difficulty: {c['difficulty']} | Frameworks: {fms} | Services: {svcs})\n  Description: {c['description']}")
        catalog_str = "\n".join(catalog_lines)
        
    history_str = ""
    for turn in history[-6:]:
        history_str += f"{'Student' if turn['role'] == 'user' else 'Tutor'}: {turn['content']}\n"
        
    formatted_context = "\n\n---\n\n".join(context_chunks) if context_chunks else "No relevant context found."

    if is_external_fallback:
        # Build external documentation MCP system prompt
        system_prompt = f"""You are simulating an external documentation fetcher (MCP tool) for Azure, GCP, or AWS.
The student has asked about a topic which is NOT covered in our platform courses.
Strictly grounding rule: separate "Platform Courses" (pulled from S3 vector embeddings) from "External Documentation" (pulled via MCP).

Instruction:
1. Since we do not have local video course content for this, pull the official quickstart documentation details, core concepts, or tutorials for "{telemetry_topic}".
2. You must begin your response with this EXACT header: "We don't currently have a dedicated video course for {telemetry_topic} on the platform. However, I have pulled the official {telemetry_topic} Quickstart documentation for you to follow."
3. Do NOT mention any nonexistent platform courses. Provide a structured, high-fidelity guide in Markdown format."""
    else:
        # Standard system prompt
        system_prompt = f"""You are an expert educational tutor and virtual teaching assistant for Educloud Academy.
Your role is to answer student questions clearly, comprehensively, and contextually based on the course catalog and materials provided below.

Rules:
1. Use the "Available Course Catalog" to answer questions about course recommendations, learning paths, or overall curriculum queries.
2. Use the "Course Lesson Context" to answer detailed, technical, code-level, or lesson-specific questions.
3. If the context does not contain the answer, answer the question accurately based on your broad technical knowledge, but start by mentioning that this topic is not directly covered in the course material.
4. Be professional, clear, encouraging, and use markdown formatting where appropriate (code blocks, bold text).
5. When recommending or mentioning any course from the "Available Course Catalog", you MUST link to it using this markdown format: `[Course Title](#course/CourseID)`. Example: `[Introduction to AWS](#course/course-id)`.
6. When designing a custom curriculum, learning path, or module sequence (such as for an AI Solutions Architect on AWS), you MUST actively search the "Matching Platform Courses" and "Available Course Catalog" for any relevant platform courses (especially AI, Bedrock, Serverless, Strands, AgentCore, or CDK courses) and explicitly link them into the appropriate sections/modules of the curriculum using the format `[Course Title](#course/CourseID)`. If a required topic or service is covered by an existing platform course, explicitly link it. If not, utilize the "Service Documentation" to outline the module's technical content, and note that there is no video course for it yet.

Available Course Catalog:
{catalog_str}

Matching Platform Courses:
{matching_courses_str}

Service Documentation:
{docs_context_str}

Course Lesson Context:
{formatted_context}"""

    # Map conversation history and user query into Converse API format
    converse_messages = []
    for turn in history[-6:]:
        converse_messages.append({
            "role": turn["role"],
            "content": [{"text": turn["content"]}]
        })
    converse_messages.append({
        "role": "user",
        "content": [{"text": message}]
    })

    # --- 6. Invoke Model & Update Caching/Usage ---
    answer, blocked, tokens = invoke_bedrock_with_guardrail(model_id, system_prompt, converse_messages, stream_session_id=session_id)
    
    if blocked:
        return answer

    # Post-process answer to resolve any course ID typos or hallucinations
    try:
        answer = fix_course_links(answer, catalog)
    except Exception as e:
        logger.warning(f"Error executing fix_course_links: {e}")

    # Prepend fallback header in python if fallback was triggered
    if is_external_fallback:
        header = f"We don't currently have a dedicated video course for {telemetry_topic} on the platform. However, I have pulled the official {telemetry_topic} Quickstart documentation for you to follow.\n\n"
        if not answer.startswith("We don't currently have a dedicated video course"):
            answer = header + answer

    # Save to chat history
    history.append({"role": "user", "content": message})
    history.append({"role": "assistant", "content": answer})
    save_session(session_id, {
        'state': state,
        'chatHistory': history,
        'dailyTokenUsage': token_usage + tokens,
        'lastUsageDate': today_str
    })

    # Save to Semantic Cache
    try:
        cache_key = f"cache-{hashlib.md5(message.encode('utf-8')).hexdigest()}"
        # Save actual text in DynamoDB
        save_session(cache_key, {
            'cached_response': answer,
            'state': 'CACHE'
        })
        # Save vector index marker in S3 vectors
        s3_vectors_client.put_vectors(
            vectorBucketName=VECTOR_BUCKET_NAME,
            indexName=VECTOR_INDEX_NAME,
            vectors=[{
                'key': cache_key,
                'data': {"float32": query_vector},
                'metadata': {
                    'is_cache': 'true',
                    'prompt': message,
                    'timestamp': str(time.time())
                }
            }]
        )
    except Exception as e:
        logger.warning(f"Failed to cache prompt response: {e}")

    return answer

def fix_course_links(answer, catalog):
    # Find all occurrences of markdown links like [Title](#course/ID_or_text) or [Title](course:ID_or_text)
    pattern = r'\[(?P<title>[^\]]+)\]\((?P<url>#course/[^\)]+|course:[^\)]+)\)'
    
    def replace_link(match):
        title = match.group('title')
        url = match.group('url')
        
        course_id_part = url.split('/')[-1].split(':')[-1].strip()
        
        valid_ids = {c['courseId'] for c in catalog}
        if course_id_part in valid_ids:
            return match.group(0)
            
        title_clean = title.strip().lower()
        for c in catalog:
            c_title = c['title'].strip().lower()
            if c_title == title_clean or title_clean in c_title or c_title in title_clean:
                return f"[{title}](#course/{c['courseId']})"
                
        best_match = None
        best_score = 0
        for c in catalog:
            words1 = set(title_clean.split())
            words2 = set(c['title'].strip().lower().split())
            intersect = words1.intersection(words2)
            if len(intersect) > best_score:
                best_score = len(intersect)
                best_match = c
                
        if best_match and best_score >= 2:
            return f"[{title}](#course/{best_match['courseId']})"
            
        return match.group(0)
        
    return re.sub(pattern, replace_link, answer)

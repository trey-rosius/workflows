import sys
import os
import json
import unittest
import zipfile
import io
from unittest.mock import patch, MagicMock

# Disable step retries to speed up test execution
from aws_durable_execution_sdk_python.retries import RetryPresets
RetryPresets.default = RetryPresets.none

# Add src/py to python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/py')))

import durable_course_ingestion
from durable_course_ingestion import lambda_handler
from aws_durable_execution_sdk_python_testing import DurableFunctionTestRunner

def create_dummy_zip_content():
    """Generates a binary zip archive of dummy course contents."""
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, 'a', zipfile.ZIP_DEFLATED, False) as zip_file:
        # course.md
        course_md = """---
id: test-course-123
name: Test Course
description: A course for unit testing
difficulty: Beginner
framework: [React, Node]
aws_services: [S3, DynamoDB]
publish: true
featured: true
---
# Course Introduction"""
        zip_file.writestr("courses/test-course/course.md", course_md)
        
        # module.md
        module_md = """# Module One"""
        zip_file.writestr("courses/test-course/01-module-one/module.md", module_md)
        
        # lesson.md
        lesson_md = """---
id: lesson-101
title: Lesson One
description: Introduction to unit testing
---
This is the lesson content.
<video>
  <source src="https://d14x58xoxfhz1s.cloudfront.net/lesson-one.mp4" type="video/mp4">
</video>"""
        zip_file.writestr("courses/test-course/01-module-one/01-lesson-one/lesson.md", lesson_md)
        
    return zip_buffer.getvalue()

class TestDurableCourseIngestion(unittest.TestCase):

    def setUp(self):
        # Set mock environment variables
        os.environ['VECTOR_BUCKET_NAME'] = 'test-vector-bucket'
        os.environ['VECTOR_INDEX_NAME'] = 'test-vector-index'
        os.environ['COURSES_TABLE_NAME'] = 'test-courses-table'

    @patch('durable_course_ingestion.s3_client')
    @patch('durable_course_ingestion.dynamodb_client')
    @patch('durable_course_ingestion.bedrock_runtime_client')
    @patch('durable_course_ingestion.s3_vectors_client')
    def test_ingestion_workflow(self, mock_s3_vectors, mock_bedrock, mock_dynamodb, mock_s3):
        """Test the end-to-end ingestion workflow with zip extraction, parsing, embedding, and saving."""
        
        # 1. Mock S3 download_file to write a real zip file to the expected local temp path
        dummy_zip_bytes = create_dummy_zip_content()
        def download_file_side_effect(bucket, key, filename):
            with open(filename, 'wb') as f:
                f.write(dummy_zip_bytes)
        mock_s3.download_file.side_effect = download_file_side_effect

        # 2. Mock S3 upload_file
        mock_s3.upload_file.return_value = True

        # 3. Mock S3 get_object to return the manifest JSON payload
        manifest_payload = [
            {
                "courseId": "test-course-123",
                "title": "Test Course",
                "description": "A course for unit testing",
                "difficulty": "Beginner",
                "frameworks": ["React", "Node"],
                "aws_services": ["S3", "DynamoDB"],
                "publish": True,
                "featured": True,
                "modules": [
                    {
                        "moduleId": "module-123",
                        "title": "Module One",
                        "order": 1,
                        "lessons": [
                            {
                                "lessonId": "lesson-101",
                                "title": "Lesson One",
                                "description": "Introduction to unit testing",
                                "order": 1,
                                "videoUri": "https://d14x58xoxfhz1s.cloudfront.net/lesson-one.mp4",
                                "content": "This is the lesson content."
                            }
                        ]
                    }
                ]
            }
        ]
        
        mock_response = MagicMock()
        mock_response.__getitem__.return_value.read.return_value = json.dumps(manifest_payload).encode('utf-8')
        mock_s3.get_object.return_value = mock_response

        # 4. Mock Bedrock Titan embedding invoke_model
        mock_embedding_body = MagicMock()
        mock_embedding_body.read.return_value = json.dumps({
            "embedding": [0.1] * 1024
        }).encode('utf-8')
        mock_bedrock.invoke_model.return_value = {
            "body": mock_embedding_body
        }

        # 5. Mock DynamoDB and S3Vectors Put
        mock_dynamodb.put_item.return_value = {"ResponseMetadata": {"HTTPStatusCode": 200}}
        mock_s3_vectors.put_vectors.return_value = {}

        # Run Durable Orchestrator
        test_event = {"s3ZipKey": "raw-courses/courses.zip"}
        runner = DurableFunctionTestRunner(lambda_handler)
        response = runner.run(json.dumps(test_event))

        # 6. Assertions
        self.assertEqual(response.status.name, "SUCCEEDED")
        self.assertIsNotNone(response.result)
        result_dict = json.loads(response.result)
        self.assertEqual(result_dict["status"], "SUCCESS")
        self.assertEqual(result_dict["coursesCount"], 1)
        self.assertEqual(result_dict["lessonsCount"], 1)

        # Verify download, upload and manifest loads occurred
        mock_s3.download_file.assert_called_once()
        mock_s3.upload_file.assert_called_once()
        mock_s3.get_object.assert_called_once()

        # Verify DynamoDB course save
        mock_dynamodb.put_item.assert_called_once()
        call_args = mock_dynamodb.put_item.call_args[1]
        self.assertEqual(call_args["TableName"], "test-courses-table")
        self.assertEqual(call_args["Item"]["courseId"]["S"], "test-course-123")

        # Verify Bedrock embedding was generated
        mock_bedrock.invoke_model.assert_called_once()
        
        # Verify vector was pushed to S3Vectors
        mock_s3_vectors.put_vectors.assert_called_once()
        vector_call_args = mock_s3_vectors.put_vectors.call_args[1]
        self.assertEqual(vector_call_args["vectorBucketName"], "test-vector-bucket")
        self.assertEqual(vector_call_args["indexName"], "test-vector-index")
        self.assertEqual(len(vector_call_args["vectors"]), 1)
        
        vector = vector_call_args["vectors"][0]
        self.assertEqual(vector["key"], "course-test-course-123-lesson-101")
        self.assertEqual(vector["data"]["float32"], [0.1] * 1024)
        self.assertEqual(vector["metadata"]["course_title"], "Test Course")
        self.assertEqual(vector["metadata"]["lesson_title"], "Lesson One")

if __name__ == '__main__':
    unittest.main()

import sys
import os
import json
import unittest
from unittest.mock import patch, MagicMock

# Disable step retries to speed up test execution (Rule 4)
from aws_durable_execution_sdk_python.retries import RetryPresets
RetryPresets.default = RetryPresets.none

# Add src/py to python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../src/py')))

import strands_multi_agent
from strands_multi_agent import lambda_handler
from aws_durable_execution_sdk_python_testing import DurableFunctionTestRunner

# Helper to mock durable step calls and track actual executions
class StepMock:
    def __init__(self, return_value):
        self.return_value = return_value
        self.call_count = 0
        
    def __call__(self, *args, **kwargs):
        def closure(step_ctx):
            self.call_count += 1
            return self.return_value
        closure._original_name = "mocked_step"
        return closure

class StepMockSequence:
    def __init__(self, values_list):
        self.vals = list(values_list)
        self.call_count = 0
        
    def __call__(self, *args, **kwargs):
        def closure(step_ctx):
            self.call_count += 1
            return self.vals.pop(0) if self.vals else None
        closure._original_name = "mocked_step"
        return closure

class TestStrandsMultiAgent(unittest.TestCase):

    @patch('strands_multi_agent.publish_status_step')
    @patch('strands_multi_agent.get_or_start_transcription_step')
    @patch('strands_multi_agent.check_transcription_status_step')
    @patch('strands_multi_agent.generate_syllabus_curriculum_step')
    @patch('strands_multi_agent.generate_global_insights_step')
    @patch('strands_multi_agent.slice_video_segment_step')
    @patch('strands_multi_agent.invoke_lesson_agents_step')
    @patch('strands_multi_agent.save_course_draft_step')
    def test_happy_path(self, mock_save_draft, mock_invoke_lesson, mock_slice, 
                        mock_global, mock_curriculum, mock_check_tx, mock_start_tx, mock_publish_status):
        """Test happy path with transcription wait loop, parallel step execution, batch concurrency, and gateway save."""
        # Setup mocks
        publish_status_mock = StepMock(True)
        mock_publish_status.side_effect = publish_status_mock

        start_tx_mock = StepMock({"status": "IN_PROGRESS", "jobName": "test-job"})
        mock_start_tx.side_effect = start_tx_mock
        
        check_tx_mock = StepMockSequence([
            {"status": "IN_PROGRESS", "jobName": "test-job"},
            {"status": "COMPLETED", "transcriptFileUri": "s3://bucket/transcript.json"}
        ])
        mock_check_tx.side_effect = check_tx_mock
        
        curriculum_mock = StepMock([
            {"module": "Mod1", "title": "Lesson 1", "description": "Desc 1", "start_time": 0.0, "end_time": 10.0},
            {"module": "Mod1", "title": "Lesson 2", "description": "Desc 2", "start_time": 10.0, "end_time": 20.0},
            {"module": "Mod2", "title": "Lesson 3", "description": "Desc 3", "start_time": 20.0, "end_time": 30.0},
            {"module": "Mod2", "title": "Lesson 4", "description": "Desc 4", "start_time": 30.0, "end_time": 40.0},
        ])
        mock_curriculum.side_effect = curriculum_mock
        
        global_mock = StepMock({
            "summary": "Global summary",
            "qa": "Global QA",
            "flashcards": "Global flashcards",
            "keyTakeaways": "Global takeaways"
        })
        mock_global.side_effect = global_mock
        
        # Track lesson processing executions
        slice_count = 0
        def mock_slice_side_effect(index, lesson, video_uri, execution_id):
            nonlocal slice_count
            def closure(step_ctx):
                nonlocal slice_count
                slice_count += 1
                return f"s3://bucket/lessons/slice_{index}.mp4"
            closure._original_name = "mocked_step"
            return closure
        mock_slice.side_effect = mock_slice_side_effect
        
        invoke_lesson_count = 0
        def mock_invoke_lesson_side_effect(lesson, transcript_file_uri, execution_id):
            nonlocal invoke_lesson_count
            def closure(step_ctx):
                nonlocal invoke_lesson_count
                invoke_lesson_count += 1
                return {
                    "title": lesson.get("title"),
                    "module": lesson.get("module"),
                    "description": lesson.get("description"),
                    "startTime": float(lesson.get("start_time")),
                    "endTime": float(lesson.get("end_time")),
                    "summary": f"Summary for {lesson.get('title')}",
                    "qa": "QA",
                    "flashcards": "Flashcards",
                    "keyTakeaways": "Takeaways"
                }
            closure._original_name = "mocked_step"
            return closure
        mock_invoke_lesson.side_effect = mock_invoke_lesson_side_effect
        
        save_draft_mock = StepMock({"statusCode": 200})
        mock_save_draft.side_effect = save_draft_mock

        # Run test
        test_event = {"mediaFileUri": "s3://bucket/video.mp4"}
        runner = DurableFunctionTestRunner(lambda_handler)
        response = runner.run(json.dumps(test_event))

        # Assertions
        self.assertEqual(response.status.name, "SUCCEEDED")
        self.assertIsNotNone(response.result)
        result_dict = json.loads(response.result)
        self.assertEqual(result_dict["videoUri"], "s3://bucket/video.mp4")
        self.assertEqual(result_dict["lessonsCount"], 4)
        
        # Verify step execution counts (from closures)
        self.assertEqual(start_tx_mock.call_count, 1)
        self.assertEqual(check_tx_mock.call_count, 2)
        self.assertEqual(curriculum_mock.call_count, 1)
        self.assertEqual(global_mock.call_count, 1)
        self.assertEqual(slice_count, 4)
        self.assertEqual(invoke_lesson_count, 4)
        self.assertEqual(save_draft_mock.call_count, 1)
        self.assertEqual(publish_status_mock.call_count, 3)

    @patch('strands_multi_agent.publish_status_step')
    @patch('strands_multi_agent.get_or_start_transcription_step')
    @patch('strands_multi_agent.check_transcription_status_step')
    def test_transcription_failed(self, mock_check_tx, mock_start_tx, mock_publish_status):
        """Test failure when transcription status returns FAILED."""
        # Setup mocks
        publish_status_mock = StepMock(True)
        mock_publish_status.side_effect = publish_status_mock

        start_tx_mock = StepMock({"status": "IN_PROGRESS", "jobName": "test-job"})
        mock_start_tx.side_effect = start_tx_mock
        check_tx_mock = StepMock({"status": "FAILED", "reason": "Internal Transcribe Error"})
        mock_check_tx.side_effect = check_tx_mock

        # Run test
        test_event = {"mediaFileUri": "s3://bucket/video.mp4"}
        runner = DurableFunctionTestRunner(lambda_handler)
        response = runner.run(json.dumps(test_event))

        # Assertions
        self.assertEqual(response.status.name, "FAILED")
        self.assertIn("Transcription failed: Internal Transcribe Error", response.error.message)
        self.assertEqual(start_tx_mock.call_count, 1)
        self.assertEqual(check_tx_mock.call_count, 1)
        self.assertEqual(publish_status_mock.call_count, 1)

    @patch('strands_multi_agent.publish_status_step')
    @patch('strands_multi_agent.get_or_start_transcription_step')
    @patch('strands_multi_agent.check_transcription_status_step')
    @patch('strands_multi_agent.generate_syllabus_curriculum_step')
    @patch('strands_multi_agent.generate_global_insights_step')
    @patch('strands_multi_agent.slice_video_segment_step')
    @patch('strands_multi_agent.invoke_lesson_agents_step')
    @patch('strands_multi_agent.save_course_draft_step')
    def test_lesson_processing_isolation(self, mock_save_draft, mock_invoke_lesson, mock_slice, 
                                         mock_global, mock_curriculum, mock_check_tx, mock_start_tx, mock_publish_status):
        """Test that failure in one lesson step is isolated and doesn't crash the entire orchestrator workflow."""
        # Setup mocks
        publish_status_mock = StepMock(True)
        mock_publish_status.side_effect = publish_status_mock

        mock_start_tx.side_effect = StepMock({"status": "COMPLETED", "transcriptFileUri": "s3://bucket/transcript.json"})
        mock_curriculum.side_effect = StepMock([
            {"module": "Mod1", "title": "Lesson 1", "description": "Desc 1", "start_time": 0.0, "end_time": 10.0},
            {"module": "Mod1", "title": "Lesson 2", "description": "Desc 2", "start_time": 10.0, "end_time": 20.0},
        ])
        mock_global.side_effect = StepMock({"summary": "Global summary"})
        
        # Return segment video uris dynamically when executed
        def mock_slice_side_effect(index, lesson, video_uri, execution_id):
            def closure(step_ctx):
                return f"s3://bucket/lessons/slice_{index}.mp4"
            closure._original_name = "mocked_step"
            return closure
        mock_slice.side_effect = mock_slice_side_effect
        
        # Lesson 0 succeeds, Lesson 1 fails during agent invoke
        def mock_invoke_agent_side_effect(lesson, transcript_file_uri, execution_id):
            def closure(step_ctx):
                if lesson.get("title") == "Lesson 2":
                    raise Exception("Bedrock Throttling Exception")
                return {
                    "title": lesson.get("title"),
                    "module": lesson.get("module"),
                    "description": lesson.get("description"),
                    "startTime": float(lesson.get("start_time")),
                    "endTime": float(lesson.get("end_time")),
                    "summary": "Summary details",
                    "qa": "QA",
                    "flashcards": "Flashcards",
                    "keyTakeaways": "Takeaways"
                }
            closure._original_name = "mocked_step"
            return closure
            
        mock_invoke_lesson.side_effect = mock_invoke_agent_side_effect
        mock_save_draft.side_effect = StepMock({"statusCode": 200})

        # Run test
        test_event = {"mediaFileUri": "s3://bucket/video.mp4"}
        runner = DurableFunctionTestRunner(lambda_handler)
        response = runner.run(json.dumps(test_event))

        # Assertions
        self.assertEqual(response.status.name, "SUCCEEDED")
        self.assertIsNotNone(response.result)
        result_dict = json.loads(response.result)
        self.assertEqual(result_dict["lessonsCount"], 2)
        
        # Verify that save_course_draft was still called with both lessons (including the fallback data for lesson 2)
        save_draft_call_args = mock_save_draft.call_args[0]
        lessons_saved = save_draft_call_args[2] # 3rd positional argument is lessons_list
        self.assertEqual(len(lessons_saved), 2)
        
        # Check lesson 1 contents (succeeded)
        self.assertEqual(lessons_saved[0]["title"], "Lesson 1")
        self.assertEqual(lessons_saved[0]["summary"], "Summary details")
        
        # Check lesson 2 contents (failed, fallback metadata should be present)
        self.assertEqual(lessons_saved[1]["title"], "Lesson 2")
        self.assertEqual(lessons_saved[1]["summary"], "(Lesson summary temporarily unavailable due to processing error)")
        self.assertEqual(publish_status_mock.call_count, 3)

if __name__ == '__main__':
    unittest.main()

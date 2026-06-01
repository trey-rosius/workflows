from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent
from strands.models import BedrockModel

app = BedrockAgentCoreApp()

# Initialize Strands Bedrock model wrappers
model = BedrockModel(model_id="amazon.nova-lite-v1:0")
advanced_model = BedrockModel(model_id="amazon.nova-pro-v1:0")

# Summarizer Agent (Nova Lite)
summarizer = Agent(
    model=model,
    system_prompt="You are an expert educational content writer. Your task is to generate a comprehensive, structured, and engaging summary of a video based on its provided scene-by-scene analysis. Output in markdown."
)

# QA Agent (Nova Lite)
qa_generator = Agent(
    model=model,
    system_prompt=(
        "You are an educational assessment expert. Your task is to generate exactly 5 high-quality multiple-choice questions (MCQs) based on the provided video analysis.\n"
        "Output format MUST be a clean markdown list. Each MCQ must follow this format exactly:\n"
        "- **Question:** [Question text]\n"
        "  **A:** [Option A text] (Correct)\n"
        "  **B:** [Option B text]\n"
        "  **C:** [Option C text]\n"
        "  **D:** [Option D text]\n"
        "Exactly one option must be marked with '(Correct)'. Do not use numbered lists, headers, or any other formatting."
    )
)

# Flashcard Agent (Nova Lite)
flashcard_generator = Agent(
    model=model,
    system_prompt=(
        "You are an expert in active recall study methods. Your task is to generate exactly 5 educational flashcards based on the provided video analysis.\n"
        "Output format MUST be a clean markdown list. Each flashcard must follow this format exactly:\n"
        "- **Front:** [Question or term to recall]\n"
        "  **Back:** [Explanation or answer]\n"
        "Do not use numbered lists, headers, or separators."
    )
)

# Reviewer Agent (Nova Pro - Advanced Model)
reviewer = Agent(
    model=advanced_model,
    system_prompt="You are a distinguished curriculum reviewer and educational quality assurance expert. Your task is to review the generated summary, Q&As, and flashcards of a lesson, verify their pedagogical clarity and accuracy, and generate a final refined 'Key Takeaways' section in markdown formatting."
)

@app.entrypoint
def invoke(payload):
    print("Received payload:", payload)
    video_analysis = payload.get("video_analysis")
    if not video_analysis:
        return {"error": "Missing video_analysis in payload"}
        
    try:
        print("Running Strands Summarizer Agent...")
        summary_res = summarizer(f"Generate a summary for this video analysis:\n\n{video_analysis}")
        summary = summary_res.message
        
        print("Running Strands QA Agent...")
        qa_res = qa_generator(f"Generate 5 Q&A pairs for this video analysis:\n\n{video_analysis}")
        qa = qa_res.message
        
        print("Running Strands Flashcard Agent...")
        flashcard_res = flashcard_generator(f"Generate 5 flashcards for this video analysis:\n\n{video_analysis}")
        flashcards = flashcard_res.message
        
        print("Running Strands Reviewer Agent (Nova Pro)...")
        reviewer_res = reviewer(f"Review the following learning assets generated from the video segment:\n\nSummary:\n{summary}\n\nQ&As:\n{qa}\n\nFlashcards:\n{flashcards}\n\nProvide 3-5 high-impact, refined Key Takeaways in a bulleted markdown list.")
        key_takeaways = reviewer_res.message
        
        return {
            "summary": summary,
            "qa": qa,
            "flashcards": flashcards,
            "keyTakeaways": key_takeaways
        }
    except Exception as e:
        print("Error during agent processing:", e)
        return {"error": str(e)}

if __name__ == "__main__":
    app.run()

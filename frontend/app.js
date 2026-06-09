// Fetch configurations
const API_URL = window.ENV.GRAPHQL_API_ENDPOINT;
const API_KEY = window.ENV.API_KEY;
const BUCKET_NAME = window.ENV.BUCKET_NAME;
const REGION = window.ENV.REGION;

// Global App State
let videos = [];
let activeLanguage = "en";
let activeVideoUri = null;
let activeLessonIndex = null; // null represents the full original video
let flashcards = [];
let currentCardIndex = 0;
const pollingIntervals = new Map();

// Course Portal State
let courses = [];
let activeCourse = null;
let activeCourseLesson = null;
let activeCourseModule = null;
let courseFlashcards = [];
let courseCurrentCardIndex = 0;
let courseQuizQuestions = [];
let courseQuizCurrentIndex = 0;
let courseQuizScore = 0;
let courseQuizAnswersSelected = [];

// Interactive Quiz State
let quizQuestions = [];
let quizCurrentIndex = 0;
let quizScore = 0;
let quizAnswersSelected = [];

// Elements References
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const uploadProgressContainer = document.getElementById("upload-progress-container");
const uploadProgressBar = document.getElementById("upload-progress-bar");
const uploadPercentage = document.getElementById("upload-percentage");
const uploadFileName = document.getElementById("upload-file-name");
const videoList = document.getElementById("video-list");
const welcomeScreen = document.getElementById("welcome-screen");
const workspace = document.getElementById("workspace");
const activeVideoTitle = document.getElementById("active-video-title");
const activeVideoStatus = document.getElementById("active-video-status");
const videoPlayer = document.getElementById("video-player");
const processingBanner = document.getElementById("processing-banner");
const btnRefresh = document.getElementById("btn-refresh");
const btnWelcomeBrowse = document.getElementById("btn-welcome-browse");
const videoCountBadge = document.getElementById("video-count-badge");
const syllabusContent = document.getElementById("syllabus-content");

// Markdown Parser Helper
function parseMarkdown(mdText) {
  if (!mdText) return "<p class='text-muted'>No content available.</p>";
  
  try {
    if (window.marked) {
      // Use marked package to parse markdown cleanly
      return `<div class="markdown-body">${window.marked.parse(mdText)}</div>`;
    }
  } catch (e) {
    console.error("Failed to parse markdown with marked library:", e);
  }
  
  // Basic fallback parsing if marked isn't loaded yet
  let html = mdText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^\s*&gt;\s*(.*$)/gim, '<blockquote>$1</blockquote>');
  
  let lines = html.split('\n');
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      let content = line.substring(2);
      if (!inList) {
        lines[i] = '<ul><li>' + content + '</li>';
        inList = true;
      } else {
        lines[i] = '<li>' + content + '</li>';
      }
    } else {
      if (inList) {
        lines[i] = '</ul>' + lines[i];
        inList = false;
      }
    }
  }
  if (inList) lines.push('</ul>');
  html = lines.join('\n').replace(/\n/g, '<br>');
  
  return `<div class="markdown-body">${html}</div>`;
}

// Q&A Parser Helper
function parseQA(qaText) {
  if (!qaText) return [];
  const qas = [];
  const lines = qaText.split('\n');

  const qRegex = /^\s*(?:\d+\.|\*|-)?\s*\*\*?(?:Q|Question)(?:\s*\d+)?(?::\*\*?|\*\*?\s*:)/i;
  const aRegex = /^\s*(?:\d+\.|\*|-)?\s*\*\*?(?:A|Answer)(?:\s*\d+)?(?::\*\*?|\*\*?\s*:)/i;
  const optRegex = /^\s*(?:\d+\.|\*|-)?\s*\*\*?([A-D])(?::\*\*?|\*\*?\s*:)/i;

  let currentItem = null;

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (qRegex.test(trimmed)) {
      if (currentItem) {
        qas.push(currentItem);
      }
      const qText = trimmed
        .replace(/^\s*(?:\d+\.|\*|-)\s*/, '')
        .replace(/^\*\*?(?:Q|Question)(?:\s*\d+)?(?::\*\*?|\*\*?\s*:)\s*/i, '')
        .replace(/\*\*+\s*$/, '')
        .trim();
      currentItem = {
        question: qText,
        options: [],
        correctIndex: null,
        answer: ""
      };
    } else if (optRegex.test(trimmed) && currentItem) {
      const match = trimmed.match(optRegex);
      const optionLetter = match[1].toUpperCase();
      let optionText = trimmed.replace(optRegex, '').trim();
      
      const isCorrect = optionText.toLowerCase().includes('(correct)') || optionText.toLowerCase().includes('[correct]');
      optionText = optionText
        .replace(/\s*[\(\[]correct[\)\]]\s*/i, '')
        .replace(/\*\*+\s*$/, '')
        .trim();

      const optionIndex = optionLetter.charCodeAt(0) - 65; // A=0, B=1, etc.
      currentItem.options[optionIndex] = optionText;
      if (isCorrect) {
        currentItem.correctIndex = optionIndex;
        currentItem.answer = optionText;
      }
    } else if (aRegex.test(trimmed) && currentItem) {
      currentItem.answer = trimmed
        .replace(/^\s*(?:\d+\.|\*|-)\s*/, '')
        .replace(/^\*\*?(?:A|Answer)(?:\s*\d+)?(?::\*\*?|\*\*?\s*:)\s*/i, '')
        .replace(/\*\*+\s*$/, '')
        .trim();
    } else if (currentItem) {
      if (currentItem.answer) {
        currentItem.answer += "\n" + trimmed;
      } else {
        currentItem.question += "\n" + trimmed;
      }
    }
  }

  if (currentItem) {
    qas.push(currentItem);
  }

  return qas.map(item => {
    if (item.options.length > 0) {
      item.options = item.options.filter(opt => opt !== undefined);
      if (item.options.length === 1) {
        item.answer = item.options[0];
        item.options = [];
      } else if (item.correctIndex === null) {
        item.correctIndex = 0;
      }
    }
    return item;
  });
}

// Flashcard Parser Helper
function parseFlashcards(fcText) {
  if (!fcText) return [];
  const cards = [];
  const lines = fcText.split('\n');

  const frontRegex = /^\s*(?:\d+\.|\*|-)?\s*\*\*?(?:Front)(?:\s*\d+)?\*\*?\s*:/i;
  const backRegex = /^\s*(?:\d+\.|\*|-)?\s*\*\*?(?:Back)(?:\s*\d+)?\*\*?\s*:/i;

  let currentFront = "";
  let currentBack = "";

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const isHeaderOrSeparator = trimmed.startsWith('#') || trimmed.startsWith('---');

    if (frontRegex.test(trimmed)) {
      if (currentFront && currentBack) {
        cards.push({ 
          front: currentFront.replace(/\*\*+\s*$/, '').trim(), 
          back: currentBack.replace(/\*\*+\s*$/, '').trim() 
        });
      }
      currentFront = trimmed
        .replace(/^\s*(?:\d+\.|\*|-)\s*/, '')
        .replace(/^\*\*?(?:Front)(?:\s*\d+)?\*\*?\s*:\s*\*\*?/i, '')
        .replace(/\*\*+\s*$/, '')
        .trim();
      currentBack = "";
    } else if (backRegex.test(trimmed)) {
      currentBack = trimmed
        .replace(/^\s*(?:\d+\.|\*|-)\s*/, '')
        .replace(/^\*\*?(?:Back)(?:\s*\d+)?\*\*?\s*:\s*\*\*?/i, '')
        .replace(/\*\*+\s*$/, '')
        .trim();
    } else if (!isHeaderOrSeparator) {
      if (currentBack) {
        currentBack += "\n" + trimmed;
      } else if (currentFront) {
        currentFront += "\n" + trimmed;
      }
    }
  }

  if (currentFront && currentBack) {
    cards.push({ 
      front: currentFront.replace(/\*\*+\s*$/, '').trim(), 
      back: currentBack.replace(/\*\*+\s*$/, '').trim() 
    });
  }

  return cards;
}

// AppSync API Call Helper
async function queryGraphQL(query, variables = {}) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({ query, variables }),
    });
    const result = await response.json();
    if (result.errors) {
      console.error("AppSync errors:", result.errors);
      throw new Error(result.errors[0].message);
    }
    return result.data;
  } catch (error) {
    console.error("GraphQL Query Failed:", error);
    throw error;
  }
}

// Load Video Library
async function loadLibrary() {
  videoList.innerHTML = `<div class="loading-spinner-small">Loading library...</div>`;
  try {
    const data = await queryGraphQL(`
      query ListVideoAssets {
        listVideoAssets {
          videoUri
          title
          status
          summary
          qa
          flashcards
          keyTakeaways
          translations
          localized {
            summary
            qa
            flashcards
            keyTakeaways
          }
          lessons {
            title
            module
            description
            startTime
            endTime
            videoUri
            summary
            qa
            flashcards
            keyTakeaways
            translations
            localized {
              summary
              qa
              flashcards
              keyTakeaways
            }
          }
          createdAt
        }
      }
    `);
    
    const apiVideos = data.listVideoAssets || [];
    
    videos = apiVideos.map(v => ({
      ...v,
      status: v.status || (v.summary ? "COMPLETED" : "PROCESSING"),
      fileName: v.videoUri.split("/").pop(),
      title: v.title || v.videoUri.split("/").pop()
    }));

    videos.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    const localProcessing = getLocalProcessingVideos();
    for (const local of localProcessing) {
      if (!videos.find(v => v.videoUri === local.videoUri)) {
        videos.unshift(local);
      }
    }

    // Automatically start polling for any in-progress videos
    for (const video of videos) {
      const isReady = video.status === 'COMPLETED' || video.status === 'DRAFT' || video.status === 'PUBLISHED';
      if (!isReady) {
        startPolling(video.videoUri);
      }
    }

    renderVideoList();
    
    if (activeVideoUri) {
      const currentActive = videos.find(v => v.videoUri === activeVideoUri);
      if (currentActive) {
        selectVideo(activeVideoUri);
      }
    }
  } catch (error) {
    videoList.innerHTML = `<div class="loading-spinner-small" style="color: var(--status-failed)">Failed to load library.</div>`;
  }
}

// Local Storage Processing Helper
function getLocalProcessingVideos() {
  try {
    return JSON.parse(localStorage.getItem("educloud_processing_videos") || "[]");
  } catch (e) {
    return [];
  }
}

function saveLocalProcessingVideo(video) {
  const list = getLocalProcessingVideos();
  if (!list.find(v => v.videoUri === video.videoUri)) {
    list.push(video);
    localStorage.setItem("educloud_processing_videos", JSON.stringify(list));
  }
}

function removeLocalProcessingVideo(videoUri) {
  let list = getLocalProcessingVideos();
  list = list.filter(v => v.videoUri !== videoUri);
  localStorage.setItem("educloud_processing_videos", JSON.stringify(list));
}

// Progress Stepper Helper
function getProgressStepperHTML(status, message) {
  const steps = [
    { key: "TRANSCRIBING", label: "Transcribing audio content", icon: "✍️" },
    { key: "TRANSLATING", label: "Translating to target languages", icon: "🌐" },
    { key: "SEGMENTING", label: "Segmenting syllabus & modules", icon: "📦" },
    { key: "GENERATING", label: "Drafting summaries, quizzes & flashcards", icon: "🤖" },
    { key: "DRAFT", label: "Ready for Tutor Review", icon: "👥" }
  ];

  // Determine current active step index
  let activeIndex = 0;
  if (status === "TRANSLATING") activeIndex = 1;
  else if (status === "SEGMENTING") activeIndex = 2;
  else if (status === "GENERATING") activeIndex = 3;
  else if (status === "DRAFT" || status === "COMPLETED" || status === "PUBLISHED") activeIndex = 4;

  return `
    <div class="progress-stepper">
      ${steps.map((step, idx) => {
        let stepClass = "";
        if (idx < activeIndex) stepClass = "completed";
        else if (idx === activeIndex) stepClass = "active";
        else stepClass = "pending";
        
        return `
          <div class="step-item ${stepClass}">
            <span class="step-icon">${stepClass === 'completed' ? '✅' : step.icon}</span>
            <span class="step-label">${step.label}</span>
          </div>
        `;
      }).join("")}
    </div>
    <p class="step-message-text" style="margin-top: 1rem; font-style: italic; color: var(--accent-cyan); font-size: 0.8rem;">
      Message: ${message || 'Working on syllabus generation...'}
    </p>
  `;
}

// Render video sidebar
function renderVideoList() {
  videoCountBadge.textContent = videos.length;
  if (videos.length === 0) {
    videoList.innerHTML = `<div class="loading-spinner-small">No videos uploaded yet.</div>`;
    return;
  }

  videoList.innerHTML = videos.map(video => {
    const isSelected = video.videoUri === activeVideoUri;
    const isReady = video.status === "COMPLETED" || video.status === "DRAFT" || video.status === "PUBLISHED";
    const statusText = isReady ? (video.status === "DRAFT" ? "Draft (Review)" : "Completed") : "Processing";
    const statusClass = isReady ? "status-completed" : "status-processing";

    return `
      <div class="video-item ${isSelected ? 'active' : ''}" onclick="selectVideo('${video.videoUri}')">
        <div class="video-item-name">${video.title || video.fileName}</div>
        <div class="video-item-meta">
          <span class="status-indicator ${statusClass}">
            <span class="status-dot"></span>
            ${statusText}
          </span>
          <span>${video.createdAt ? new Date(video.createdAt).toLocaleDateString() : 'Just now'}</span>
        </div>
      </div>
    `;
  }).join("");
}

// Selection handling
async function selectVideo(videoUri) {
  activeVideoUri = videoUri;
  activeLanguage = "en";
  activeLessonIndex = null; // Default to full video
  renderVideoList();
  
  const video = videos.find(v => v.videoUri === videoUri);
  if (!video) return;

  welcomeScreen.classList.add("hidden");
  workspace.classList.remove("hidden");
  
  const isReady = video.status === 'COMPLETED' || video.status === 'DRAFT' || video.status === 'PUBLISHED';
  const displayStatus = video.status === "DRAFT" ? "DRAFT (REVIEW)" : video.status;
  
  activeVideoTitle.textContent = video.title || video.fileName;
  activeVideoStatus.textContent = displayStatus;
  activeVideoStatus.className = `status-badge ${isReady ? 'status-completed' : 'status-processing'}`;

  console.log("selectVideo called for URI:", videoUri, "Status:", video.status);
  renderHeaderActions(video);
  if (!isReady) {
    videoPlayer.closest(".video-column").querySelector(".player-container").classList.add("hidden");
    processingBanner.classList.remove("hidden");
    document.querySelector(".insights-column").classList.add("hidden");
    
    const stepperHTML = getProgressStepperHTML(video.status, video.message);
    processingBanner.innerHTML = `
      <div class="pulse-ring"></div>
      <div class="banner-text">
        <h3>AI Syllabus Generation in Progress...</h3>
        ${stepperHTML}
      </div>
    `;
    syllabusContent.innerHTML = `<p class="text-muted">Analyzing syllabus modules in background... (Step: ${video.status})</p>`;
  } else {
    videoPlayer.closest(".video-column").querySelector(".player-container").classList.remove("hidden");
    processingBanner.classList.add("hidden");
    
    const insightsCol = document.querySelector(".insights-column");
    console.log("Removing hidden class from insights column. Current classes:", insightsCol.className);
    insightsCol.classList.remove("hidden");
    
    try {
      // Set video source & load syllabus
      await playVideoUri(video.videoUri);
      renderSyllabus(video);
      renderLearningAssets(video);
    } catch (err) {
      console.error("Error rendering video/assets in selectVideo:", err);
    }
  }
}

// Play signed video URL
async function playVideoUri(videoUri) {
  videoPlayer.src = "";
  try {
    const data = await queryGraphQL(`
      query GetVideoUrl($videoUri: String!) {
        getVideoUrl(videoUri: $videoUri)
      }
    `, { videoUri });
    
    if (data.getVideoUrl) {
      videoPlayer.src = data.getVideoUrl;
    }
  } catch (error) {
    console.error("Failed to load video player URL:", error);
  }
}

// Render syllabus breakdown
function renderSyllabus(video) {
  const lessons = video.lessons || [];
  
  let html = `
    <button class="lesson-item-btn ${activeLessonIndex === null ? 'active' : ''}" onclick="selectLesson(null)">
      <div class="lesson-info">
        <div class="lesson-title-text">📺 Full Original Video</div>
        <div class="lesson-desc-text">View full insights, summaries, and flashcards.</div>
      </div>
      <span class="lesson-time-badge">Full</span>
    </button>
  `;

  if (lessons.length === 0) {
    syllabusContent.innerHTML = html + `<p class="text-muted" style="margin-top: 1rem;">No lessons segmented.</p>`;
    return;
  }

  // Group by Module
  const modules = {};
  lessons.forEach((lesson, index) => {
    const mod = lesson.module || "General";
    if (!modules[mod]) modules[mod] = [];
    modules[mod].push({ ...lesson, originalIndex: index });
  });

  // Render Modules & Lessons
  for (const [moduleTitle, moduleLessons] of Object.entries(modules)) {
    html += `
      <div class="module-group" style="margin-top: 1rem;">
        <div class="module-header">📦 Module: ${moduleTitle}</div>
        ${moduleLessons.map(lesson => {
          const isActive = activeLessonIndex === lesson.originalIndex;
          const formatTime = (secs) => {
            const m = Math.floor(secs / 60);
            const s = Math.floor(secs % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
          };
          return `
            <button class="lesson-item-btn ${isActive ? 'active' : ''}" onclick="selectLesson(${lesson.originalIndex})">
              <div class="lesson-info">
                <div class="lesson-title-text">📖 ${lesson.title}</div>
                <div class="lesson-desc-text">${lesson.description || 'No description.'}</div>
              </div>
              <span class="lesson-time-badge">${formatTime(lesson.startTime)} - ${formatTime(lesson.endTime)}</span>
            </button>
          `;
        }).join("")}
      </div>
    `;
  }

  syllabusContent.innerHTML = html;
}

// Select a lesson
window.selectLesson = async function(lessonIndex) {
  activeLessonIndex = lessonIndex;
  
  const video = videos.find(v => v.videoUri === activeVideoUri);
  if (!video) return;

  // Refresh syllabus styling
  renderSyllabus(video);

  if (lessonIndex === null) {
    // Full Video
    activeVideoTitle.textContent = video.fileName;
    await playVideoUri(video.videoUri);
    renderLearningAssets(video);
  } else {
    // Specific Lesson
    const lesson = video.lessons[lessonIndex];
    activeVideoTitle.textContent = `Lesson: ${lesson.title}`;
    
    // Play cut lesson video
    if (lesson.videoUri) {
      await playVideoUri(lesson.videoUri);
    } else {
      await playVideoUri(video.videoUri); // Fallback to main video
    }
    renderLearningAssets(lesson);
  }
};

// Render learning assets (Summary, Key Takeaways, Q&As, Flashcards)
function renderLearningAssets(source) {
  console.log("renderLearningAssets called for source:", source);
  try {
    const localizedSource = getLocalizedSource(source);
    // Summary
    const summaryHTML = parseMarkdown(localizedSource.summary);
    document.getElementById("summary-text").innerHTML = summaryHTML;

    // Key Takeaways
    const takeawaysHTML = parseMarkdown(localizedSource.keyTakeaways || "No key takeaways generated for this selection.");
    document.getElementById("takeaways-text").innerHTML = takeawaysHTML;

    // Q&A / Quiz Init
    quizQuestions = parseQA(localizedSource.qa);
    quizCurrentIndex = 0;
    quizScore = 0;
    quizAnswersSelected = new Array(quizQuestions.length).fill(null);
    renderQuiz();

    // Flashcards
    flashcards = parseFlashcards(source.flashcards);
    currentCardIndex = 0;
    updateFlashcardView();
    
    switchTab('summary');
    
    // Highlight code blocks inside summary and takeaways
    if (window.hljs) {
      document.querySelectorAll('#summary-text pre code, #takeaways-text pre code').forEach((block) => {
        window.hljs.highlightElement(block);
      });
    }
  } catch (err) {
    console.error("Error in renderLearningAssets:", err);
  }
}

// Render Interactive Quiz
window.renderQuiz = function() {
  const container = document.getElementById("qa-list");
  if (!container) return;

  if (!quizQuestions || quizQuestions.length === 0) {
    container.innerHTML = `<p class="text-muted">No quiz questions generated for this selection.</p>`;
    return;
  }

  if (quizCurrentIndex >= quizQuestions.length) {
    // Render Results Screen
    const percent = Math.round((quizScore / quizQuestions.length) * 100);
    let gradeMsg = "Excellent job! 🎉";
    if (percent < 50) gradeMsg = "Keep practicing! 📚";
    else if (percent < 80) gradeMsg = "Great effort! 👍";

    container.innerHTML = `
      <div class="quiz-results-card">
        <h3>🏆 Quiz Completed!</h3>
        <div class="quiz-score-circle">
          <div class="score-number">${quizScore} / ${quizQuestions.length}</div>
          <div class="score-percent">${percent}%</div>
        </div>
        <p class="quiz-grade-msg">${gradeMsg}</p>
        
        <div class="quiz-summary-list">
          ${quizQuestions.map((q, idx) => {
            const isCorrect = quizAnswersSelected[idx] === q.correctIndex;
            const selectedText = q.options.length > 0 ? (q.options[quizAnswersSelected[idx]] || "No answer") : "Answered";
            return `
              <div class="quiz-summary-item ${isCorrect ? 'correct' : 'incorrect'}">
                <div class="summary-q-header">
                  <span class="summary-status-icon">${isCorrect ? '✅' : '❌'}</span>
                  <strong>Q${idx + 1}: ${q.question}</strong>
                </div>
                <div class="summary-q-body">
                  ${q.options.length > 0 ? `
                    <div class="summary-text">Your answer: <span class="selected-ans">${selectedText}</span></div>
                    ${!isCorrect ? `<div class="summary-text">Correct answer: <span class="correct-ans">${q.options[q.correctIndex]}</span></div>` : ''}
                  ` : `
                    <div class="summary-text">Answer: <span class="correct-ans">${q.answer}</span></div>
                  `}
                </div>
              </div>
            `;
          }).join("")}
        </div>
        
        <button class="btn-quiz-retry" onclick="restartQuiz()">🔄 Restart Quiz</button>
      </div>
    `;
    return;
  }

  const currentQ = quizQuestions[quizCurrentIndex];
  const progressPercent = Math.round((quizCurrentIndex / quizQuestions.length) * 100);
  const selectedOption = quizAnswersSelected[quizCurrentIndex];
  const hasAnswered = selectedOption !== null;

  // Check if it's MCQ
  const isMCQ = currentQ.options && currentQ.options.length > 0;

  if (isMCQ) {
    container.innerHTML = `
      <div class="quiz-card">
        <div class="quiz-progress-container">
          <div class="quiz-progress-bar" style="width: ${progressPercent}%"></div>
        </div>
        <div class="quiz-card-header">
          <span class="quiz-question-num">Question ${quizCurrentIndex + 1} of ${quizQuestions.length}</span>
          <span class="quiz-score-badge">Score: ${quizScore}</span>
        </div>
        <h3 class="quiz-question-text">${currentQ.question}</h3>
        
        <div class="quiz-options-list">
          ${currentQ.options.map((opt, idx) => {
            const letter = String.fromCharCode(65 + idx); // A, B, C, D
            let optClass = "";
            let statusIcon = "";
            
            if (hasAnswered) {
              if (idx === currentQ.correctIndex) {
                optClass = "correct";
                statusIcon = "✅";
              } else if (idx === selectedOption) {
                optClass = "incorrect";
                statusIcon = "❌";
              } else {
                optClass = "disabled";
              }
            }
            
            return `
              <button class="quiz-option-btn ${optClass}" onclick="selectQuizOption(${idx})" ${hasAnswered ? 'disabled' : ''}>
                <span class="option-letter">${letter}</span>
                <span class="option-text">${opt}</span>
                <span class="option-status-icon">${statusIcon}</span>
              </button>
            `;
          }).join("")}
        </div>
        
        ${hasAnswered ? `
          <div class="quiz-actions">
            <button class="quiz-next-btn" onclick="nextQuizQuestion()">
              ${quizCurrentIndex === quizQuestions.length - 1 ? '🏁 Finish Quiz' : '➡️ Next Question'}
            </button>
          </div>
        ` : ''}
      </div>
    `;
  } else {
    // Open-ended Q&A fallback
    container.innerHTML = `
      <div class="quiz-card open-ended">
        <div class="quiz-progress-container">
          <div class="quiz-progress-bar" style="width: ${progressPercent}%"></div>
        </div>
        <div class="quiz-card-header">
          <span class="quiz-question-num">Question ${quizCurrentIndex + 1} of ${quizQuestions.length}</span>
          <span class="quiz-score-badge">Score: ${quizScore}</span>
        </div>
        <h3 class="quiz-question-text">${currentQ.question}</h3>
        
        <div class="quiz-actions">
          ${!hasAnswered ? `
            <button class="quiz-reveal-btn" onclick="revealOpenEndedAnswer()">👁️ Reveal Answer</button>
          ` : `
            <div class="open-ended-answer-box">
              <strong>Answer:</strong>
              <p>${currentQ.answer}</p>
            </div>
            <div class="self-grade-buttons">
              <p>Self-grade your answer:</p>
              <button class="btn-grade-correct" onclick="gradeOpenEnded(true)">✅ Correct</button>
              <button class="btn-grade-incorrect" onclick="gradeOpenEnded(false)">❌ Incorrect</button>
            </div>
          `}
        </div>
      </div>
    `;
  }
};

window.selectQuizOption = function(optionIndex) {
  if (quizAnswersSelected[quizCurrentIndex] !== null) return;
  
  quizAnswersSelected[quizCurrentIndex] = optionIndex;
  const isCorrect = optionIndex === quizQuestions[quizCurrentIndex].correctIndex;
  if (isCorrect) {
    quizScore++;
  }
  
  renderQuiz();
};

window.nextQuizQuestion = function() {
  quizCurrentIndex++;
  renderQuiz();
};

window.restartQuiz = function() {
  quizCurrentIndex = 0;
  quizScore = 0;
  quizAnswersSelected = new Array(quizQuestions.length).fill(null);
  renderQuiz();
};

window.revealOpenEndedAnswer = function() {
  quizAnswersSelected[quizCurrentIndex] = true;
  renderQuiz();
};

window.gradeOpenEnded = function(isCorrect) {
  if (isCorrect) {
    quizScore++;
  }
  quizCurrentIndex++;
  renderQuiz();
};

// Flashcard Carousel Actions
window.flipCard = function() {
  const card = document.getElementById("current-flashcard");
  card.classList.toggle("flipped");
};

window.prevCard = function() {
  if (flashcards.length === 0) return;
  currentCardIndex = (currentCardIndex - 1 + flashcards.length) % flashcards.length;
  updateFlashcardView();
};

window.nextCard = function() {
  if (flashcards.length === 0) return;
  currentCardIndex = (currentCardIndex + 1) % flashcards.length;
  updateFlashcardView();
};

function updateFlashcardView() {
  const cardContainer = document.getElementById("current-flashcard");
  const frontText = document.getElementById("card-front-text");
  const backText = document.getElementById("card-back-text");
  const counterText = document.getElementById("card-counter");

  cardContainer.classList.remove("flipped");

  if (flashcards.length === 0) {
    frontText.textContent = "No flashcards generated for this selection.";
    backText.textContent = "No flashcards generated for this selection.";
    counterText.textContent = "0 / 0";
    return;
  }

  const activeCard = flashcards[currentCardIndex];
  frontText.textContent = activeCard.front;
  backText.textContent = activeCard.back;
  counterText.textContent = `${currentCardIndex + 1} / ${flashcards.length}`;
}

// Tab Switching
window.switchTab = function(tabId) {
  document.querySelectorAll(".tab-button").forEach(btn => btn.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
  
  document.getElementById(`tab-${tabId}`).classList.add("active");
  document.getElementById(`content-${tabId}`).classList.add("active");
};

// Polling for processing state
function startPolling(videoUri) {
  if (pollingIntervals.has(videoUri)) return;

  const intervalId = setInterval(async () => {
    try {
      const data = await queryGraphQL(`
        query GetVideoAssets($videoUri: String!) {
          getVideoAssets(videoUri: $videoUri) {
            videoUri
            title
            status
            message
            summary
            qa
            flashcards
            keyTakeaways
            translations
            localized {
              summary
              qa
              flashcards
              keyTakeaways
            }
            lessons {
              title
              module
              description
              startTime
              endTime
              videoUri
              summary
              qa
              flashcards
              keyTakeaways
              translations
              localized {
                summary
                qa
                flashcards
                keyTakeaways
              }
            }
            createdAt
          }
        }
      `, { videoUri });
      
      const asset = data.getVideoAssets;
      if (asset) {
        const idx = videos.findIndex(v => v.videoUri === videoUri);
        if (idx !== -1) {
          const isFinished = asset.summary || asset.status === "COMPLETED" || asset.status === "DRAFT" || asset.status === "PUBLISHED";
          
          if (isFinished) {
            clearInterval(intervalId);
            pollingIntervals.delete(videoUri);
            removeLocalProcessingVideo(videoUri);
            
            videos[idx] = {
              ...asset,
              status: asset.status || "COMPLETED",
              fileName: videoUri.split("/").pop(),
              title: asset.title || videoUri.split("/").pop()
            };
          } else {
            // Update intermediate progress state
            videos[idx].status = asset.status || "PROCESSING";
            videos[idx].message = asset.message || "";
            videos[idx].title = asset.title || videos[idx].title;
          }
          
          renderVideoList();
          
          if (activeVideoUri === videoUri) {
            selectVideo(videoUri);
          }
        }
      }
    } catch (err) {
      console.error("Error polling video assets:", err);
    }
  }, 8000);

  pollingIntervals.set(videoUri, intervalId);
}

// S3 File Upload Direct using S3 Multipart Upload
async function uploadVideoFile(file) {
  const fileName = `${Date.now()}-${file.name.replace(/\s+/g, "_")}`;
  const videoUri = `s3://${BUCKET_NAME}/videos/${fileName}`;

  uploadFileName.textContent = file.name;
  uploadPercentage.textContent = "0% (Initiating...)";
  uploadProgressBar.style.width = "0%";
  uploadProgressContainer.classList.remove("hidden");

  try {
    const contentType = file.type || "video/mp4";

    // Step 1: Initiate Multipart Upload
    const initData = await queryGraphQL(`
      mutation InitiateMultipartUpload($fileName: String!, $contentType: String!) {
        initiateMultipartUpload(fileName: $fileName, contentType: $contentType) {
          uploadId
          key
        }
      }
    `, { fileName, contentType });

    const uploadId = initData.initiateMultipartUpload.uploadId;
    const key = initData.initiateMultipartUpload.key;

    if (!uploadId || !key) throw new Error("Could not initiate multipart upload.");

    // Step 2: Define Chunk size (10 MB)
    const chunkSize = 10 * 1024 * 1024; // 10MB
    const totalParts = Math.ceil(file.size / chunkSize);

    // Step 3: Get Presigned URLs for each part
    uploadPercentage.textContent = "0% (Generating URLs...)";
    const partUrlsData = await queryGraphQL(`
      mutation GetMultipartUploadPartUrls($uploadId: String!, $key: String!, $partCount: Int!) {
        getMultipartUploadPartUrls(uploadId: $uploadId, key: $key, partCount: $partCount) {
          partNumber
          url
        }
      }
    `, { uploadId, key, partCount: totalParts });

    const partUrls = partUrlsData.getMultipartUploadPartUrls;
    if (!partUrls || partUrls.length !== totalParts) {
      throw new Error("Mismatch in generated presigned part URLs.");
    }

    // Sort by partNumber
    partUrls.sort((a, b) => a.partNumber - b.partNumber);

    // Step 4: Upload chunks in parallel (max concurrency of 3)
    const completedParts = [];
    let uploadedBytes = 0;
    
    // Concurrency orchestrator
    const maxConcurrency = 3;
    let nextPartIndex = 0;

    const runUpload = async (partIndex) => {
      const part = partUrls[partIndex];
      const startByte = (part.partNumber - 1) * chunkSize;
      const endByte = Math.min(file.size, startByte + chunkSize);
      const blob = file.slice(startByte, endByte);

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", part.url, true);
        xhr.setRequestHeader("Content-Type", contentType);

        let lastUploadedForPart = 0;

        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const chunkDelta = event.loaded - lastUploadedForPart;
            lastUploadedForPart = event.loaded;
            uploadedBytes += chunkDelta;
            const percent = Math.min(99, Math.round((uploadedBytes / file.size) * 100));
            uploadPercentage.textContent = `${percent}% (${completedParts.length}/${totalParts} parts completed)`;
            uploadProgressBar.style.width = `${percent}%`;
          }
        };

        xhr.onload = () => {
          if (xhr.status === 200) {
            const eTag = xhr.getResponseHeader("ETag");
            if (!eTag) {
              reject(new Error(`Missing ETag header in part ${part.partNumber} response.`));
              return;
            }
            completedParts.push({
              partNumber: part.partNumber,
              eTag: eTag.replace(/"/g, "") // Clean quotes from ETag
            });
            resolve();
          } else {
            reject(new Error(`Part ${part.partNumber} upload failed with status ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error(`Connection error during part ${part.partNumber} upload.`));
        xhr.send(blob);
      });
    };

    const worker = async () => {
      while (nextPartIndex < totalParts) {
        const currentIdx = nextPartIndex++;
        await runUpload(currentIdx);
      }
    };

    // Spawn workers
    const workers = [];
    for (let i = 0; i < Math.min(maxConcurrency, totalParts); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Step 5: Complete Multipart Upload
    uploadPercentage.textContent = "99% (Assembling file...)";
    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    await queryGraphQL(`
      mutation CompleteMultipartUpload($uploadId: String!, $key: String!, $parts: [CompletedPartInput]!) {
        completeMultipartUpload(uploadId: $uploadId, key: $key, parts: $parts)
      }
    `, { uploadId, key, parts: completedParts });

    // Success! Hide progress and load library
    uploadProgressContainer.classList.add("hidden");
    
    const newVideo = {
      videoUri,
      fileName: fileName,
      status: "PROCESSING",
      summary: "",
      qa: "",
      flashcards: "",
      keyTakeaways: "",
      lessons: [],
      createdAt: new Date().toISOString(),
    };

    videos.unshift(newVideo);
    saveLocalProcessingVideo(newVideo);
    renderVideoList();
    
    selectVideo(videoUri);
    startPolling(videoUri);

  } catch (error) {
    console.error("Multipart upload failed:", error);
    alert(`Multipart Upload Failed: ${error.message}`);
    uploadProgressContainer.classList.add("hidden");
  }
}

// Drag & Drop Setup
function setupDragAndDrop() {
  ["dragenter", "dragover"].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    }, false);
  });

  ["dragleave", "drop"].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    }, false);
  });

  dropzone.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      uploadVideoFile(files[0]);
    }
  }, false);

  dropzone.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      uploadVideoFile(fileInput.files[0]);
    }
  });

  btnWelcomeBrowse.addEventListener("click", () => {
    fileInput.click();
  });
}

// Event Listeners
btnRefresh.addEventListener("click", loadLibrary);

// Init App
document.addEventListener("DOMContentLoaded", () => {
  setupDragAndDrop();
  loadLibrary();
});

// Localization helper to return translated strings if active language is not English
function getLocalizedSource(source) {
  if (activeLanguage === "en") {
    return source;
  }
  const translations = source.translations || [];
  const localized = source.localized || [];
  const langIndex = translations.indexOf(activeLanguage);
  
  if (langIndex !== -1 && localized[langIndex]) {
    const loc = localized[langIndex];
    return {
      ...source,
      summary: loc.summary || source.summary,
      qa: loc.qa || source.qa,
      flashcards: loc.flashcards || source.flashcards,
      keyTakeaways: loc.keyTakeaways || source.keyTakeaways
    };
  }
  return source;
}

// Handler for language dropdown changes
function changeLanguage(langCode) {
  activeLanguage = langCode;
  const video = videos.find(v => v.videoUri === activeVideoUri);
  if (!video) return;

  if (activeLessonIndex === null) {
    renderLearningAssets(video);
  } else {
    const lesson = video.lessons[activeLessonIndex];
    renderLearningAssets(lesson);
  }
}
window.changeLanguage = changeLanguage;

// Approve & Publish Course Draft Action
async function approveCourseDraft(videoUri) {
  const btnApprove = document.getElementById("btn-approve-video");
  if (btnApprove) {
    btnApprove.disabled = true;
    btnApprove.innerHTML = "Publishing... 🚀";
  }
  try {
    const data = await queryGraphQL(`
      mutation ApproveVideo($requestId: String!, $approved: Boolean!, $message: String, $callbackId: String!) {
        approveVideo(requestId: $requestId, approved: $approved, message: $message, callbackId: $callbackId)
      }
    `, {
      requestId: videoUri,
      approved: true,
      message: "Approved and published by tutor",
      callbackId: videoUri
    });
    
    if (data && data.approveVideo) {
      const idx = videos.findIndex(v => v.videoUri === videoUri);
      if (idx !== -1) {
        videos[idx].status = "PUBLISHED";
      }
      if (activeVideoUri === videoUri) {
        selectVideo(videoUri);
      }
      alert("Syllabus draft has been approved and published!");
    } else {
      alert("Failed to approve video syllabus.");
      if (btnApprove) {
        btnApprove.disabled = false;
        btnApprove.innerHTML = "Approve & Publish";
      }
    }
  } catch (error) {
    console.error("Failed to approve video syllabus:", error);
    alert(`Failed to approve: ${error.message}`);
    if (btnApprove) {
      btnApprove.disabled = false;
      btnApprove.innerHTML = "Approve & Publish";
    }
  }
}
window.approveCourseDraft = approveCourseDraft;

// Render course header action buttons and dropdowns
function renderHeaderActions(video) {
  const container = document.getElementById("header-actions");
  if (!container) return;

  const isReady = video.status === "COMPLETED" || video.status === "DRAFT" || video.status === "PUBLISHED";
  if (!isReady) {
    container.innerHTML = "";
    return;
  }

  let html = "";
  if (video.status === "DRAFT") {
    html += `
      <button id="btn-approve-video" class="btn-approve" onclick="approveCourseDraft('${video.videoUri}')">
        🚀 Approve & Publish
      </button>
    `;
  }

  html += `
    <div class="language-selector-container">
      <span class="lang-icon">🌐</span>
      <select class="language-select" id="language-select" onchange="changeLanguage(this.value)">
        <option value="en" ${activeLanguage === 'en' ? 'selected' : ''}>English</option>
        <option value="fr" ${activeLanguage === 'fr' ? 'selected' : ''}>Français (French)</option>
        <option value="es" ${activeLanguage === 'es' ? 'selected' : ''}>Español (Spanish)</option>
      </select>
    </div>
  `;
  container.innerHTML = html;
}
window.renderHeaderActions = renderHeaderActions;

// ========================================
// MOBILE SIDEBAR TOGGLE
// ========================================
(function setupMobileSidebar() {
  const toggleBtn = document.getElementById("mobile-menu-toggle");
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");

  if (!toggleBtn || !sidebar || !overlay) return;

  function openSidebar() {
    sidebar.classList.add("open");
    overlay.classList.add("visible");
    toggleBtn.classList.add("active");
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    overlay.classList.remove("visible");
    toggleBtn.classList.remove("active");
  }

  toggleBtn.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  overlay.addEventListener("click", closeSidebar);

  // Auto-close sidebar on mobile when a video is selected
  const origSelectVideo = window.selectVideo || selectVideo;
  const wrappedSelectVideo = async function(videoUri) {
    if (window.innerWidth <= 768) {
      closeSidebar();
    }
    // selectVideo is declared with async function, call it directly
    return origSelectVideo(videoUri);
  };
  // Expose wrapped version for onclick handlers
  window.selectVideoMobile = wrappedSelectVideo;
})();

// Override selectVideo on global scope so onclick="selectVideo(...)" in sidebar auto-closes on mobile
const _origSelectVideoForMobile = selectVideo;
window.selectVideo = async function(videoUri) {
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    const toggleBtn = document.getElementById("mobile-menu-toggle");
    if (sidebar) sidebar.classList.remove("open");
    if (overlay) overlay.classList.remove("visible");
    if (toggleBtn) toggleBtn.classList.remove("active");
  }
  return _origSelectVideoForMobile(videoUri);
};

// ==========================================================
// COURSE PORTAL IMPLEMENTATION
// ==========================================================

const navBtnAnalyzer = document.getElementById("nav-btn-analyzer");
const navBtnCourses = document.getElementById("nav-btn-courses");
const analyzerSidebarContents = document.getElementById("analyzer-sidebar-contents");
const coursesSidebarContents = document.getElementById("courses-sidebar-contents");
const analyzerWorkspaceContainer = document.getElementById("analyzer-workspace-container");
const coursesWorkspaceContainer = document.getElementById("courses-workspace-container");

function switchToAnalyzer() {
  navBtnAnalyzer.classList.add("active");
  navBtnCourses.classList.remove("active");
  
  analyzerSidebarContents.classList.remove("hidden");
  coursesSidebarContents.classList.add("hidden");
  analyzerWorkspaceContainer.classList.remove("hidden");
  coursesWorkspaceContainer.classList.add("hidden");
}

function switchToCourses() {
  navBtnCourses.classList.add("active");
  navBtnAnalyzer.classList.remove("active");
  
  coursesSidebarContents.classList.remove("hidden");
  analyzerSidebarContents.classList.add("hidden");
  coursesWorkspaceContainer.classList.remove("hidden");
  analyzerWorkspaceContainer.classList.add("hidden");
  
  loadCourses();
}

navBtnAnalyzer.addEventListener("click", switchToAnalyzer);
navBtnCourses.addEventListener("click", switchToCourses);

async function loadCourses() {
  const coursesGrid = document.getElementById("courses-grid");
  const coursesSidebarList = document.getElementById("courses-sidebar-list");
  const courseCountBadge = document.getElementById("course-count-badge");
  
  coursesGrid.innerHTML = `<div class="loading-spinner-small">Loading courses...</div>`;
  coursesSidebarList.innerHTML = `<div class="loading-spinner-small">Loading navigator...</div>`;
  
  try {
    const data = await queryGraphQL(`
      query ListCourses {
        listCourses {
          courseId
          title
          description
          image
          difficulty
          frameworks
          aws_services
          publish
          featured
          modules {
            moduleId
            title
            order
            lessons {
              lessonId
              title
              description
              order
              videoUri
              summary
              qa
              flashcards
              content
            }
          }
        }
      }
    `);
    
    courses = data.listCourses || [];
    courseCountBadge.textContent = courses.length;
    
    renderCourses();
  } catch (err) {
    console.error("Error loading courses:", err);
    coursesGrid.innerHTML = `<div class="loading-spinner-small" style="color: var(--status-failed)">Failed to load courses.</div>`;
    coursesSidebarList.innerHTML = `<div class="loading-spinner-small" style="color: var(--status-failed)">Failed to load.</div>`;
  }
}

function renderCourses() {
  const coursesGrid = document.getElementById("courses-grid");
  const coursesSidebarList = document.getElementById("courses-sidebar-list");
  
  if (courses.length === 0) {
    coursesGrid.innerHTML = `<p class="text-muted">No courses found. Please run ingestion to index your curriculum.</p>`;
    coursesSidebarList.innerHTML = `<p class="text-muted">No courses indexed.</p>`;
    return;
  }
  
  // 1. Render Grid
  coursesGrid.innerHTML = courses.map(course => {
    const difficultyClass = `difficulty-${course.difficulty?.toLowerCase() || 'intermediate'}`;
    const frameworkTag = course.frameworks && course.frameworks.length > 0 ? course.frameworks[0] : "AWS";
    
    return `
      <div class="course-card" onclick="selectCourse('${course.courseId}')">
        <div class="course-card-body">
          <h3>${course.title}</h3>
          <p>${course.description || 'No description available.'}</p>
        </div>
        <div class="course-card-footer">
          <span class="course-tag">${frameworkTag}</span>
          <span class="course-difficulty-badge ${difficultyClass}">${course.difficulty || 'Intermediate'}</span>
        </div>
      </div>
    `;
  }).join("");
  
  // 2. Render Sidebar list
  coursesSidebarList.innerHTML = courses.map(course => {
    const isActive = activeCourse && activeCourse.courseId === course.courseId;
    return `
      <div class="video-item ${isActive ? 'active' : ''}" onclick="selectCourse('${course.courseId}')">
        <div class="video-item-name">${course.title}</div>
        <div class="video-item-meta">
          <span>${course.modules?.length || 0} Modules</span>
          <span>${course.difficulty || 'Intermediate'}</span>
        </div>
      </div>
    `;
  }).join("");
}

window.selectCourse = function(courseId) {
  const course = courses.find(c => c.courseId === courseId);
  if (!course) return;
  
  activeCourse = course;
  activeCourseLesson = null;
  activeCourseModule = null;
  
  // Toggle details view
  document.getElementById("course-library-view").classList.add("hidden");
  document.getElementById("course-detail-view").classList.remove("hidden");
  
  // Update Header Info
  document.getElementById("active-course-title").textContent = course.title;
  document.getElementById("active-course-desc").textContent = course.description || '';
  
  const diffBadge = document.getElementById("active-course-difficulty");
  diffBadge.textContent = course.difficulty || 'Intermediate';
  diffBadge.className = `status-badge difficulty-${course.difficulty?.toLowerCase() || 'intermediate'}`;
  
  // Render Sidebar Highlight
  renderCourses();
  
  // Render Course Syllabus
  renderCourseSyllabus();
  
  // Render Default Lesson View (Overview)
  renderLessonDetails(null);
};

function renderCourseSyllabus() {
  const container = document.getElementById("course-syllabus-content");
  if (!activeCourse || !activeCourse.modules) {
    container.innerHTML = `<p class="text-muted">No modules in this course.</p>`;
    return;
  }
  
  let html = `
    <button class="lesson-item-btn ${activeCourseLesson === null ? 'active' : ''}" onclick="selectCourseLesson(null, null)">
      <div class="lesson-info">
        <div class="lesson-title-text">📚 Course Overview</div>
        <div class="lesson-desc-text">Read course introduction and overview.</div>
      </div>
      <span class="lesson-time-badge">Overview</span>
    </button>
  `;
  
  activeCourse.modules.forEach(mod => {
    html += `
      <div class="module-group" style="margin-top: 1rem;">
        <div class="module-header" style="font-weight:700; color:var(--text-bright); font-size:0.8rem; margin-bottom:0.5rem; text-transform:uppercase; letter-spacing:0.5px;">📦 Module: ${mod.title}</div>
        ${(mod.lessons || []).map(lesson => {
          const isActive = activeCourseLesson && activeCourseLesson.lessonId === lesson.lessonId;
          return `
            <button class="lesson-item-btn ${isActive ? 'active' : ''}" onclick="selectCourseLesson('${mod.moduleId}', '${lesson.lessonId}')">
              <div class="lesson-info">
                <div class="lesson-title-text">📖 ${lesson.title}</div>
                <div class="lesson-desc-text">${lesson.description || 'No description available.'}</div>
              </div>
              <span class="lesson-time-badge">Lesson</span>
            </button>
          `;
        }).join("")}
      </div>
    `;
  });
  
  container.innerHTML = html;
}

window.selectCourseLesson = function(moduleId, lessonId) {
  if (!activeCourse) return;
  
  if (!moduleId || !lessonId) {
    activeCourseLesson = null;
    activeCourseModule = null;
  } else {
    const mod = activeCourse.modules.find(m => m.moduleId === moduleId);
    const lesson = mod ? mod.lessons.find(l => l.lessonId === lessonId) : null;
    
    activeCourseLesson = lesson;
    activeCourseModule = mod;
  }
  
  // Update active button classes in DOM
  renderCourseSyllabus();
  
  // Render lesson content
  renderLessonDetails(activeCourseLesson);
};

let activeLessonTabName = "content";

function renderLessonDetails(lesson) {
  const contentTab = document.getElementById("tab-lesson-content");
  const quizTab = document.getElementById("tab-lesson-quiz");
  const fsTab = document.getElementById("tab-lesson-flashcards");
  
  // Reset tabs selection to Content
  switchLessonTab("content");
  
  const videoContainer = document.getElementById("lesson-video-container");
  const videoPlayer = document.getElementById("lesson-video-player");
  const mdBody = document.getElementById("lesson-body-markdown");
  
  if (!lesson) {
    // Render course overview
    videoContainer.classList.add("hidden");
    videoPlayer.src = "";
    
    mdBody.innerHTML = `
      <h1>${activeCourse.title}</h1>
      <blockquote>${activeCourse.description || 'No overview description.'}</blockquote>
      <h2>Course Outline</h2>
      <p>This course consists of ${activeCourse.modules?.length || 0} modules. Navigate through the curriculum on the left panel to begin reading lessons and testing your knowledge.</p>
      <h3>AI Tutor Chat</h3>
      <p>You can chat with our AI Course Tutor at any time. Simply click the <strong>"💬 Ask Tutor"</strong> button in the header. S3Vectors RAG chatbot is fully indexed with the contents of this course.</p>
    `;
    
    // Hide Quiz & Flashcard tabs for course level
    quizTab.classList.add("hidden");
    fsTab.classList.add("hidden");
    return;
  }
  
  // Render specific lesson
  quizTab.classList.remove("hidden");
  fsTab.classList.remove("hidden");
  
  // 1. Play Lesson video if exists
  if (lesson.videoUri) {
    videoContainer.classList.remove("hidden");
    videoPlayer.src = lesson.videoUri;
  } else {
    videoContainer.classList.add("hidden");
    videoPlayer.src = "";
  }
  
  // 2. Render Markdown content
  mdBody.innerHTML = `
    <h1>${lesson.title}</h1>
    <div style="margin-bottom: 1.5rem;">${parseMarkdown(lesson.content)}</div>
  `;
  
  // 3. Render Quiz
  renderCourseLessonQuiz(lesson);
  
  // 4. Render Flashcards
  renderCourseLessonFlashcards(lesson);
  
  // Highlight code blocks inside lesson body
  if (window.hljs) {
    mdBody.querySelectorAll('pre code').forEach((block) => {
      window.hljs.highlightElement(block);
    });
  }
}

window.switchLessonTab = function(tabName) {
  activeLessonTabName = tabName;
  document.querySelectorAll("#course-detail-view .tabs-nav .tab-button").forEach(btn => {
    btn.classList.remove("active");
  });
  document.querySelectorAll("#course-detail-view .tab-contents .tab-pane").forEach(pane => {
    pane.classList.remove("active");
  });
  
  document.getElementById(`tab-lesson-${tabName}`).classList.add("active");
  document.getElementById(`content-lesson-${tabName}`).classList.add("active");
};

function renderCourseLessonQuiz(lesson) {
  const generatorSection = document.getElementById("lesson-quiz-generator-section");
  const quizContainer = document.getElementById("lesson-quiz-container");
  
  if (!lesson.qa) {
    generatorSection.classList.remove("hidden");
    quizContainer.classList.add("hidden");
    return;
  }
  
  generatorSection.classList.add("hidden");
  quizContainer.classList.remove("hidden");
  
  // Initialize Quiz state
  try {
    courseQuizQuestions = JSON.parse(lesson.qa);
  } catch (e) {
    courseQuizQuestions = parseQA(lesson.qa);
  }
  
  courseQuizCurrentIndex = 0;
  courseQuizScore = 0;
  courseQuizAnswersSelected = new Array(courseQuizQuestions.length).fill(null);
  
  renderCourseQuizPage();
}

function renderCourseQuizPage() {
  const container = document.getElementById("lesson-quiz-container");
  if (!container) return;
  
  if (courseQuizCurrentIndex >= courseQuizQuestions.length) {
    // Result screen
    const percent = Math.round((courseQuizScore / courseQuizQuestions.length) * 100);
    let gradeMsg = "Excellent job! 🎉";
    if (percent < 50) gradeMsg = "Keep practicing! 📚";
    else if (percent < 80) gradeMsg = "Great effort! 👍";
    
    container.innerHTML = `
      <div class="quiz-results-card">
        <h3>🏆 Quiz Completed!</h3>
        <div class="quiz-score-circle">
          <div class="score-number">${courseQuizScore} / ${courseQuizQuestions.length}</div>
          <div class="score-percent">${percent}%</div>
        </div>
        <p class="quiz-grade-msg">${gradeMsg}</p>
        
        <div class="quiz-summary-list">
          ${courseQuizQuestions.map((q, idx) => {
            const isCorrect = courseQuizAnswersSelected[idx] === q.correctIndex;
            const selectedText = q.options ? (q.options[courseQuizAnswersSelected[idx]] || "No answer") : "Answered";
            return `
              <div class="quiz-summary-item ${isCorrect ? 'correct' : 'incorrect'}">
                <div class="summary-q-header">
                  <span class="summary-status-icon">${isCorrect ? '✅' : '❌'}</span>
                  <strong>Q${idx + 1}: ${q.question}</strong>
                </div>
                <div class="summary-q-body">
                  <div class="summary-text">Your answer: <span class="selected-ans">${selectedText}</span></div>
                  ${!isCorrect && q.options ? `<div class="summary-text">Correct answer: <span class="correct-ans">${q.options[q.correctIndex]}</span></div>` : ''}
                  ${q.explanation ? `<div style="margin-top: 0.25rem; font-style: italic; color: var(--text-muted);">Explanation: ${q.explanation}</div>` : ''}
                </div>
              </div>
            `;
          }).join("")}
        </div>
        
        <button class="btn-quiz-retry" onclick="restartCourseQuiz()">🔄 Restart Quiz</button>
      </div>
    `;
    return;
  }
  
  const currentQ = courseQuizQuestions[courseQuizCurrentIndex];
  const progressPercent = Math.round((courseQuizCurrentIndex / courseQuizQuestions.length) * 100);
  const selectedOption = courseQuizAnswersSelected[courseQuizCurrentIndex];
  const hasAnswered = selectedOption !== null;
  
  if (!currentQ.options && currentQ.answer) {
    currentQ.options = [currentQ.answer, "Option B", "Option C", "Option D"];
    currentQ.correctIndex = 0;
  }
  
  if (currentQ.correctIndex === undefined) {
    const idx = currentQ.options.findIndex(opt => opt === currentQ.answer);
    currentQ.correctIndex = idx !== -1 ? idx : 0;
  }
  
  container.innerHTML = `
     <div class="quiz-card">
       <div class="quiz-progress-container">
         <div class="quiz-progress-bar" style="width: ${progressPercent}%"></div>
       </div>
       <div class="quiz-card-header">
         <span class="quiz-question-num">Question ${courseQuizCurrentIndex + 1} of ${courseQuizQuestions.length}</span>
         <span class="quiz-score-badge">Score: ${courseQuizScore}</span>
       </div>
       <h3 class="quiz-question-text">${currentQ.question}</h3>
       
       <div class="quiz-options-list">
         ${currentQ.options.map((opt, idx) => {
           const letter = String.fromCharCode(65 + idx);
           let optClass = "";
           let statusIcon = "";
           
           if (hasAnswered) {
             if (idx === currentQ.correctIndex) {
               optClass = "correct";
               statusIcon = "✅";
             } else if (idx === selectedOption) {
               optClass = "incorrect";
               statusIcon = "❌";
             } else {
               optClass = "disabled";
             }
           }
           
           return `
             <button class="quiz-option-btn ${optClass}" onclick="selectCourseQuizOption(${idx})" ${hasAnswered ? 'disabled' : ''}>
               <span class="option-letter">${letter}</span>
               <span class="option-text">${opt}</span>
               <span class="option-status-icon">${statusIcon}</span>
             </button>
           `;
         }).join("")}
       </div>
       
       ${hasAnswered ? `
         <div class="quiz-actions" style="margin-top: 1rem;">
           <button class="quiz-next-btn" onclick="nextCourseQuizQuestion()" style="width: 100%; padding: 0.75rem; border-radius: 8px; font-weight: 600; cursor: pointer; background: var(--accent-gradient); color: var(--text-bright); border: none;">
             ${courseQuizCurrentIndex === courseQuizQuestions.length - 1 ? '🏁 Finish Quiz' : '➡️ Next Question'}
           </button>
         </div>
       ` : ''}
     </div>
  `;
}

window.selectCourseQuizOption = function(optionIndex) {
  if (courseQuizAnswersSelected[courseQuizCurrentIndex] !== null) return;
  courseQuizAnswersSelected[courseQuizCurrentIndex] = optionIndex;
  if (optionIndex === courseQuizQuestions[courseQuizCurrentIndex].correctIndex) {
    courseQuizScore++;
  }
  renderCourseQuizPage();
};

window.nextCourseQuizQuestion = function() {
  courseQuizCurrentIndex++;
  renderCourseQuizPage();
};

window.restartCourseQuiz = function() {
  courseQuizCurrentIndex = 0;
  courseQuizScore = 0;
  courseQuizAnswersSelected = new Array(courseQuizQuestions.length).fill(null);
  renderCourseQuizPage();
};

function renderCourseLessonFlashcards(lesson) {
  const generatorSection = document.getElementById("lesson-fc-generator-section");
  const fcContainer = document.getElementById("lesson-flashcards-container");
  
  if (!lesson.flashcards) {
    generatorSection.classList.remove("hidden");
    fcContainer.classList.add("hidden");
    return;
  }
  
  generatorSection.classList.add("hidden");
  fcContainer.classList.remove("hidden");
  
  try {
    courseFlashcards = JSON.parse(lesson.flashcards);
  } catch (e) {
    courseFlashcards = parseFlashcards(lesson.flashcards);
  }
  
  courseCurrentCardIndex = 0;
  updateCourseFlashcardView();
}

function updateCourseFlashcardView() {
  const cardContainer = document.getElementById("lesson-current-card");
  const frontText = document.getElementById("lesson-card-front-text");
  const backText = document.getElementById("lesson-card-back-text");
  const counterText = document.getElementById("lesson-card-counter");
  
  cardContainer.classList.remove("flipped");
  
  if (courseFlashcards.length === 0) {
    frontText.textContent = "No flashcards generated.";
    backText.textContent = "No flashcards generated.";
    counterText.textContent = "0 / 0";
    return;
  }
  
  const activeCard = courseFlashcards[courseCurrentCardIndex];
  frontText.textContent = activeCard.front;
  backText.textContent = activeCard.back;
  counterText.textContent = `${courseCurrentCardIndex + 1} / ${courseFlashcards.length}`;
}

window.flipLessonCard = function() {
  document.getElementById("lesson-current-card").classList.toggle("flipped");
};

window.prevLessonCard = function() {
  if (courseFlashcards.length === 0) return;
  courseCurrentCardIndex = (courseCurrentCardIndex - 1 + courseFlashcards.length) % courseFlashcards.length;
  updateCourseFlashcardView();
};

window.nextLessonCard = function() {
  if (courseFlashcards.length === 0) return;
  courseCurrentCardIndex = (courseCurrentCardIndex + 1) % courseFlashcards.length;
  updateCourseFlashcardView();
};

// Generate Quiz Trigger
document.getElementById("btn-generate-quiz").addEventListener("click", async () => {
  if (!activeCourse || !activeCourseLesson) return;
  const btn = document.getElementById("btn-generate-quiz");
  btn.disabled = true;
  btn.textContent = "Generating Quiz with AI... ⏳";
  
  try {
    const res = await queryGraphQL(`
      mutation GenerateQuizForLesson($courseId: String!, $moduleId: String!, $lessonId: String!) {
        generateQuizForLesson(courseId: $courseId, moduleId: $moduleId, lessonId: $lessonId)
      }
    `, {
      courseId: activeCourse.courseId,
      moduleId: activeCourseModule.moduleId,
      lessonId: activeCourseLesson.lessonId
    });
    
    if (res.generateQuizForLesson) {
      activeCourseLesson.qa = res.generateQuizForLesson;
      renderCourseLessonQuiz(activeCourseLesson);
    }
  } catch (err) {
    alert("Failed to generate quiz: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate Quiz with Nova";
  }
});

// Generate Flashcards Trigger
document.getElementById("btn-generate-flashcards").addEventListener("click", async () => {
  if (!activeCourse || !activeCourseLesson) return;
  const btn = document.getElementById("btn-generate-flashcards");
  btn.disabled = true;
  btn.textContent = "Generating Flashcards with AI... ⏳";
  
  try {
    const res = await queryGraphQL(`
      mutation GenerateFlashcardsForLesson($courseId: String!, $moduleId: String!, $lessonId: String!) {
        generateFlashcardsForLesson(courseId: $courseId, moduleId: $moduleId, lessonId: $lessonId)
      }
    `, {
      courseId: activeCourse.courseId,
      moduleId: activeCourseModule.moduleId,
      lessonId: activeCourseLesson.lessonId
    });
    
    if (res.generateFlashcardsForLesson) {
      activeCourseLesson.flashcards = res.generateFlashcardsForLesson;
      renderCourseLessonFlashcards(activeCourseLesson);
    }
  } catch (err) {
    alert("Failed to generate flashcards: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate Flashcards with Nova";
  }
});

// Chatbot Toggle Drawer Panel
const btnToggleChatbot = document.getElementById("btn-toggle-chatbot");
const btnCloseChatbot = document.getElementById("btn-close-chatbot");
const chatbotDrawer = document.getElementById("course-chatbot-drawer");
const btnSendChatbot = document.getElementById("btn-send-chatbot");
const chatbotInput = document.getElementById("chatbot-input");
const chatbotMessages = document.getElementById("chatbot-messages");

btnToggleChatbot.addEventListener("click", () => {
  chatbotDrawer.classList.toggle("chatbot-drawer-open");
});

btnCloseChatbot.addEventListener("click", () => {
  chatbotDrawer.classList.remove("chatbot-drawer-open");
});

btnSendChatbot.addEventListener("click", sendChatbotMessage);
chatbotInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    sendChatbotMessage();
  }
});

async function sendChatbotMessage() {
  const text = chatbotInput.value.trim();
  if (!text) return;
  
  chatbotInput.value = "";
  
  chatbotMessages.innerHTML += `
    <div class="chat-msg chat-msg-user">
      ${text}
    </div>
  `;
  chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
  
  const typingId = "typing-" + Date.now();
  chatbotMessages.innerHTML += `
    <div class="chat-msg chat-msg-bot chat-msg-typing" id="${typingId}">
      <span class="chat-dot"></span>
      <span class="chat-dot"></span>
      <span class="chat-dot"></span>
    </div>
  `;
  chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
  
  try {
    const data = await queryGraphQL(`
      query AskCourseChatbot($courseId: String, $message: String!) {
        askCourseChatbot(courseId: $courseId, message: $message)
      }
    `, {
      courseId: activeCourse ? activeCourse.courseId : null,
      message: text
    });
    
    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();
    
    const answer = data.askCourseChatbot || "No response received.";
    const responseId = "bot-msg-" + Date.now();
    chatbotMessages.innerHTML += `
      <div class="chat-msg chat-msg-bot" id="${responseId}">
        ${parseMarkdown(answer)}
      </div>
    `;
    chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
    
    // Highlight code blocks inside the new chatbot response
    if (window.hljs) {
      const msgEl = document.getElementById(responseId);
      if (msgEl) {
        msgEl.querySelectorAll('pre code').forEach((block) => {
          window.hljs.highlightElement(block);
        });
      }
    }
  } catch (err) {
    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();
    chatbotMessages.innerHTML += `
      <div class="chat-msg chat-msg-error">
        Failed to connect to Course Tutor: ${err.message}
      </div>
    `;
    chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
  }
}

// Course Back Button
document.getElementById("btn-course-back").addEventListener("click", () => {
  document.getElementById("course-library-view").classList.remove("hidden");
  document.getElementById("course-detail-view").classList.add("hidden");
  activeCourse = null;
  activeCourseLesson = null;
  activeCourseModule = null;
  chatbotDrawer.classList.remove("chatbot-drawer-open");
  renderCourses();
});

// Admin Ingest trigger
document.getElementById("btn-admin-ingest").addEventListener("click", async () => {
  const ok = confirm("Are you sure you want to trigger course curriculum ingestion?\nThis will parse all courses from the local zip file, generate Titan embeddings for lessons, index S3Vectors, and write metadata to DynamoDB. This runs as a background Durable Function.");
  if (!ok) return;
  
  const btn = document.getElementById("btn-admin-ingest");
  btn.disabled = true;
  btn.textContent = "Triggering Ingestion... ⏳";
  
  try {
    const res = await queryGraphQL(`
      mutation TriggerCourseIngestion($s3ZipKey: String!) {
        triggerCourseIngestion(s3ZipKey: $s3ZipKey)
      }
    `, {
      s3ZipKey: "raw-courses/courses.zip"
    });
    
    if (res.triggerCourseIngestion) {
      alert("Ingestion triggered successfully! The Durable Ingestion Orchestrator is running. Please check S3 / DynamoDB and the Durable function Lambda logs in a few minutes.");
    } else {
      alert("GraphQL returned failure for triggerCourseIngestion.");
    }
  } catch (err) {
    alert("Failed to trigger ingestion: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚙️ Ingest Courses";
  }
});

// Initialize switcher hook
document.addEventListener("DOMContentLoaded", () => {
  switchToAnalyzer();
});


// Fetch configurations
const API_URL = window.ENV.GRAPHQL_API_ENDPOINT;
const API_KEY = window.ENV.API_KEY;
const BUCKET_NAME = window.ENV.BUCKET_NAME;
const REGION = window.ENV.REGION;

// Global App State
let videos = [];
let activeVideoUri = null;
let activeLessonIndex = null; // null represents the full original video
let flashcards = [];
let currentCardIndex = 0;
const pollingIntervals = new Map();

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
  if (!mdText) return "<p class='text-muted'>No summary generated yet.</p>";
  
  let html = mdText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Headings
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  
  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Blockquotes
  html = html.replace(/^\s*&gt;\s*(.*$)/gim, '<blockquote>$1</blockquote>');
  
  // Bullet points
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
  if (inList) {
    lines.push('</ul>');
  }
  html = lines.join('\n');
  
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

// Q&A Parser Helper
function parseQA(qaText) {
  if (!qaText) return [];
  const qas = [];
  const parts = qaText.split(/(?=- \*\*Q)/);
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    
    const lines = part.split('\n');
    let question = "";
    let answer = "";
    for (let line of lines) {
      line = line.trim();
      if (line.includes('**Q') || line.startsWith('- **Q')) {
        question = line.replace(/^-?\s*\*\*Q\d+:\s*/i, '').replace(/\*\*+/g, '').replace(/^-?\s*/, '').trim();
      } else if (line.includes('**A') || line.includes('- **A')) {
        answer = line.replace(/^\s*-?\s*\*\*A\d+:\s*/i, '').replace(/\*\*+/g, '').replace(/^\s*-?\s*/, '').trim();
      }
    }
    if (question && answer) {
      qas.push({ question, answer });
    }
  }
  return qas;
}

// Flashcard Parser Helper
function parseFlashcards(fcText) {
  if (!fcText) return [];
  const cards = [];
  const parts = fcText.split(/(?=- \*\*Front)/i);
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    
    const lines = part.split('\n');
    let front = "";
    let back = "";
    for (let line of lines) {
      line = line.trim();
      if (line.toLowerCase().includes('front')) {
        front = line.replace(/^-?\s*\*\*Front:\s*\*\*/i, '').replace(/^-?\s*\*\*Front:\s*/i, '').replace(/\*\*+/g, '').trim();
      } else if (line.toLowerCase().includes('back')) {
        back = line.replace(/^\s*-?\s*\*\*Back:\s*\*\*/i, '').replace(/^\s*-?\s*\*\*Back:\s*/i, '').replace(/\*\*+/g, '').trim();
      }
    }
    if (front && back) {
      cards.push({ front, back });
    }
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
          summary
          qa
          flashcards
          keyTakeaways
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
          }
          createdAt
        }
      }
    `);
    
    const apiVideos = data.listVideoAssets || [];
    
    videos = apiVideos.map(v => ({
      ...v,
      status: v.summary ? "COMPLETED" : "PROCESSING",
      fileName: v.videoUri.split("/").pop(),
    }));

    videos.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    const localProcessing = getLocalProcessingVideos();
    for (const local of localProcessing) {
      if (!videos.find(v => v.videoUri === local.videoUri)) {
        videos.unshift(local);
        startPolling(local.videoUri);
      }
    }

    renderVideoList();
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

// Render video sidebar
function renderVideoList() {
  videoCountBadge.textContent = videos.length;
  if (videos.length === 0) {
    videoList.innerHTML = `<div class="loading-spinner-small">No videos uploaded yet.</div>`;
    return;
  }

  videoList.innerHTML = videos.map(video => {
    const isSelected = video.videoUri === activeVideoUri;
    const isCompleted = video.status === "COMPLETED";
    const statusText = isCompleted ? "Completed" : "Processing";
    const statusClass = isCompleted ? "status-completed" : "status-processing";

    return `
      <div class="video-item ${isSelected ? 'active' : ''}" onclick="selectVideo('${video.videoUri}')">
        <div class="video-item-name">${video.fileName}</div>
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
  activeLessonIndex = null; // Default to full video
  renderVideoList();
  
  const video = videos.find(v => v.videoUri === videoUri);
  if (!video) return;

  welcomeScreen.classList.add("hidden");
  workspace.classList.remove("hidden");
  
  activeVideoTitle.textContent = video.fileName;
  activeVideoStatus.textContent = video.status;
  activeVideoStatus.className = `status-badge ${video.status === 'COMPLETED' ? 'status-completed' : 'status-processing'}`;

  console.log("selectVideo called for URI:", videoUri, "Status:", video.status);
  if (video.status === "PROCESSING") {
    videoPlayer.closest(".video-column").querySelector(".player-container").classList.add("hidden");
    processingBanner.classList.remove("hidden");
    document.querySelector(".insights-column").classList.add("hidden");
    syllabusContent.innerHTML = `<p class="text-muted">Analyzing syllabus modules in background...</p>`;
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
    // Summary
    const summaryHTML = parseMarkdown(source.summary);
    document.getElementById("summary-text").innerHTML = summaryHTML;

    // Key Takeaways
    const takeawaysHTML = parseMarkdown(source.keyTakeaways || "No key takeaways generated for this selection.");
    document.getElementById("takeaways-text").innerHTML = takeawaysHTML;

    // Q&A
    const qas = parseQA(source.qa);
    const qaListContainer = document.getElementById("qa-list");
    if (qas.length === 0) {
      qaListContainer.innerHTML = `<p class="text-muted">No Q&As generated for this selection.</p>`;
    } else {
      qaListContainer.innerHTML = qas.map((qa, index) => `
        <div class="qa-card" id="qa-card-${index}">
          <header class="qa-header" onclick="toggleQA(${index})">
            <span class="qa-question">Q${index+1}: ${qa.question}</span>
            <span class="qa-toggle">▼</span>
          </header>
          <div class="qa-body">
            <div class="qa-answer">${qa.answer}</div>
          </div>
        </div>
      `).join("");
    }

    // Flashcards
    flashcards = parseFlashcards(source.flashcards);
    currentCardIndex = 0;
    updateFlashcardView();
    
    switchTab('summary');
  } catch (err) {
    console.error("Error in renderLearningAssets:", err);
  }
}

// Accordion toggle
window.toggleQA = function(index) {
  const card = document.getElementById(`qa-card-${index}`);
  const body = card.querySelector(".qa-body");
  
  if (card.classList.contains("open")) {
    card.classList.remove("open");
    body.style.maxHeight = "0px";
  } else {
    card.classList.add("open");
    body.style.maxHeight = body.scrollHeight + "px";
  }
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
            summary
            qa
            flashcards
            keyTakeaways
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
            }
            createdAt
          }
        }
      `, { videoUri });
      
      const asset = data.getVideoAssets;
      if (asset && asset.summary) {
        clearInterval(intervalId);
        pollingIntervals.delete(videoUri);
        removeLocalProcessingVideo(videoUri);

        const idx = videos.findIndex(v => v.videoUri === videoUri);
        if (idx !== -1) {
          videos[idx] = {
            ...asset,
            status: "COMPLETED",
            fileName: videoUri.split("/").pop(),
          };
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

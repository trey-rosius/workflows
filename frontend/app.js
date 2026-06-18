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

// Jargon wrapping helper for DOM elements (avoids matching inside <pre>, <code> or formatting tags)
function wrapJargonInElement(element) {
  if (!element) return;
  const terms = ["VPC", "SQS", "DynamoDB", "Lambda", "AppSync", "Cognito", "EventBridge", "SNS", "IAM", "CloudFront", "S3", "GraphQL", "REST"];
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        let parent = node.parentNode;
        while (parent && parent !== element) {
          const tagName = parent.tagName.toLowerCase();
          if (tagName === 'pre' || tagName === 'code' || parent.classList.contains('jargon-term')) {
            return NodeFilter.FILTER_REJECT;
          }
          parent = parent.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  textNodes.forEach(node => {
    let text = node.nodeValue;
    let hasMatch = false;
    let newText = text;
    terms.forEach(term => {
      const regex = new RegExp(`\\b(${term})\\b`, "gi");
      if (regex.test(newText)) {
        hasMatch = true;
        newText = newText.replace(regex, `<span class="jargon-term" data-term="$1">$1</span>`);
      }
    });

    if (hasMatch) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = newText;
      const parent = node.parentNode;
      while (tempDiv.firstChild) {
        parent.insertBefore(tempDiv.firstChild, node);
      }
      parent.removeChild(node);
    }
  });
}

// Jargon wrapping helper
function wrapJargonTerms(html) {
  const terms = ["VPC", "SQS", "DynamoDB", "Lambda", "AppSync", "Cognito", "EventBridge", "SNS", "IAM", "CloudFront", "S3", "GraphQL", "REST"];
  let result = html;
  terms.forEach(term => {
    const regex = new RegExp(`\\b(${term})\\b(?![^<>]*>)`, "gi");
    result = result.replace(regex, `<span class="jargon-term" data-term="$1">$1</span>`);
  });
  return result;
}

// Markdown Parser Helper
function parseMarkdown(mdText) {
  if (!mdText) return "<p class='text-muted'>No content available.</p>";
  
  try {
    if (window.marked) {
      const parsed = typeof window.marked.parse === 'function' ? window.marked.parse(mdText) : window.marked(mdText);
      return `<div class="markdown-body">${parsed}</div>`;
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

// ─────────────────────────────────────────────────────────────────────────────
// A2UI renderer (v0.9.1, scope: choice surfaces)
// ─────────────────────────────────────────────────────────────────────────────
// The Lambda emits multiple-choice questions as ```a2ui fenced JSON blocks.
// After parseMarkdown runs, scan the rendered HTML for those blocks and swap
// each in for a row of native buttons. Clicking a button submits the option's
// full text as the next chat message via the supplied `sendFn`.
function renderA2UIBlocks(rootEl, sendFn) {
  if (!rootEl || typeof sendFn !== "function") return;
  const codeBlocks = rootEl.querySelectorAll('code.language-a2ui');
  codeBlocks.forEach((codeEl) => {
    const container = codeEl.closest('pre') || codeEl;
    let msg;
    try {
      msg = JSON.parse(codeEl.textContent);
    } catch (e) {
      console.warn("Failed to parse A2UI block:", e);
      return;
    }
    const surface = buildA2UIChoiceSurface(msg, sendFn);
    if (surface) container.replaceWith(surface);
  });
}

// Enhance chat replies that reference platform courses: every `<a href="#course/ID">`
// link that sits inside an `<li>` is swapped for a rich card with the course's
// image, title, description, and the rationale the model wrote next to the
// link. Inline links (in prose) are left untouched so the global click handler
// still routes them.
function renderCourseCards(rootEl) {
  if (!rootEl) return;
  const anchors = rootEl.querySelectorAll('a[href^="#course/"]');
  if (anchors.length === 0) return;

  // Need the catalog loaded to know image/description for each course.
  if (!Array.isArray(courses) || courses.length === 0) {
    if (typeof loadCourses === 'function') {
      loadCourses().then(() => renderCourseCards(rootEl)).catch(() => {});
    }
    return;
  }

  const replacements = [];
  anchors.forEach((anchor) => {
    const li = anchor.closest('li');
    if (!li) return;
    const href = anchor.getAttribute('href');
    const courseId = href.split('/').pop();
    const course = courses.find((c) => c.courseId === courseId);
    if (!course) return;

    // The rationale is whatever text the model wrote after the link inside
    // the same <li>. Strip the link text + any leading dash/em-dash.
    const linkText = anchor.textContent || '';
    let rationale = li.textContent.replace(linkText, '').trim();
    rationale = rationale.replace(/^[—–\-:]\s*/, '').trim();

    // The card is an <a href="#course/ID"> so the existing global click
    // handler (anchors with href #course/...) handles the workspace switch
    // and course selection. No bespoke click logic needed here.
    const card = document.createElement('a');
    card.className = 'a2ui-course-card';
    card.href = `#course/${courseId}`;
    card.dataset.courseId = courseId;
    card.innerHTML = `
      ${course.image ? `<div class="a2ui-course-card-image" style="background-image: url('${course.image}')"></div>` : '<div class="a2ui-course-card-image a2ui-course-card-image-placeholder"></div>'}
      <div class="a2ui-course-card-body">
        <h4 class="a2ui-course-card-title"></h4>
        <p class="a2ui-course-card-desc"></p>
        ${rationale ? '<p class="a2ui-course-card-rationale"></p>' : ''}
      </div>
      <div class="a2ui-course-card-footer">
        <span class="a2ui-course-card-cta">View course →</span>
      </div>
    `;
    // textContent assignments avoid HTML injection from course data.
    card.querySelector('.a2ui-course-card-title').textContent = course.title || '';
    card.querySelector('.a2ui-course-card-desc').textContent = course.description || '';
    const ratEl = card.querySelector('.a2ui-course-card-rationale');
    if (ratEl) ratEl.textContent = rationale;

    replacements.push({ li, card });
  });

  // Apply replacements after the loop so we don't mutate the NodeList while
  // iterating.
  replacements.forEach(({ li, card }) => {
    const parent = li.parentElement;
    li.replaceWith(card);
    // If the parent <ul> now only contains course cards, convert it into a
    // grid container so the cards lay out side-by-side instead of stacked.
    if (parent && parent.tagName === 'UL') {
      const allCards = Array.from(parent.children).every(
        (c) => c.classList && c.classList.contains('a2ui-course-card')
      );
      if (allCards) {
        const grid = document.createElement('div');
        grid.className = 'a2ui-course-card-grid';
        while (parent.firstChild) grid.appendChild(parent.firstChild);
        parent.replaceWith(grid);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagram findings — click-to-focus zoom (no Konva; CSS positioning only)
// ─────────────────────────────────────────────────────────────────────────────
// The Lambda emits a fenced `a2ui-findings` JSON block at the end of an
// architecture review. This renderer swaps the block for an interactive panel:
// the diagram sits in an overflow:hidden viewport above a list of severity-
// coloured finding cards. Clicking a card pans/zooms the diagram to that bbox
// with a smooth CSS transition; only one finding is highlighted at a time, so
// imprecise model coords don't pile up the way Phase 2's stacked rectangles did.

const diagramDataUrlsByResponseId = {};

function severityColor(s) {
  if (s === 'working') return '#22c55e';
  if (s === 'suggestion') return '#3b82f6';
  return '#ef4444';
}

function renderDiagramFindings(rootEl) {
  if (!rootEl) return;
  const codeBlocks = rootEl.querySelectorAll('code.language-a2ui-findings');
  if (codeBlocks.length === 0) return;

  const diagramDataUrl = diagramDataUrlsByResponseId[rootEl.id];
  if (!diagramDataUrl) return;

  codeBlocks.forEach((codeEl) => {
    const container = codeEl.closest('pre') || codeEl;
    let payload;
    try {
      payload = JSON.parse(codeEl.textContent);
    } catch (e) {
      return; // Block may still be streaming — let a later pass handle it.
    }
    const findings = (payload && payload.findings) || [];
    if (findings.length === 0) return;

    const review = document.createElement('div');
    review.className = 'diag-review';
    review.innerHTML = `
      <div class="diag-canvas-toolbar">
        <span class="diag-canvas-title">Diagram review</span>
        <button type="button" class="diag-show-full-btn">Show full diagram</button>
      </div>
      <div class="diag-canvas-wrap">
        <img class="diag-canvas-img" alt="">
        <div class="diag-canvas-highlight"></div>
      </div>
      <div class="diag-findings-list"></div>
    `;
    const wrap = review.querySelector('.diag-canvas-wrap');
    const img = review.querySelector('.diag-canvas-img');
    const highlight = review.querySelector('.diag-canvas-highlight');
    const list = review.querySelector('.diag-findings-list');
    const fullBtn = review.querySelector('.diag-show-full-btn');

    container.replaceWith(review);

    let activeFindingId = null;

    function resetZoom() {
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh) return;
      const scale = Math.min(cw / nw, ch / nh);
      const dw = nw * scale;
      const dh = nh * scale;
      img.style.width = `${dw}px`;
      img.style.height = `${dh}px`;
      img.style.left = `${(cw - dw) / 2}px`;
      img.style.top = `${(ch - dh) / 2}px`;
      highlight.style.display = 'none';
    }

    function zoomTo(bbox, color) {
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh) return;
      const bx = Math.max(0, Math.min(1, Number(bbox[0]) || 0));
      const by = Math.max(0, Math.min(1, Number(bbox[1]) || 0));
      const bw = Math.max(0.01, Math.min(1 - bx, Number(bbox[2]) || 0.05));
      const bh = Math.max(0.01, Math.min(1 - by, Number(bbox[3]) || 0.05));

      // Pad the bbox by 40% on each side so the student sees surrounding context.
      const padX = bw * 0.4;
      const padY = bh * 0.4;
      const fx = Math.max(0, bx - padX);
      const fy = Math.max(0, by - padY);
      const fw = Math.min(1 - fx, bw + 2 * padX);
      const fh = Math.min(1 - fy, bh + 2 * padY);

      // Scale so the padded bbox fits the viewport. Clamp the scale so we
      // never zoom in further than 3.5× the fit-to-container baseline.
      const baseScale = Math.min(cw / nw, ch / nh);
      const desiredScale = Math.min(cw / (fw * nw), ch / (fh * nh));
      const scale = Math.min(desiredScale, baseScale * 3.5);
      const dw = nw * scale;
      const dh = nh * scale;

      // Centre the bbox in the viewport.
      const bcxDisp = (bx + bw / 2) * dw;
      const bcyDisp = (by + bh / 2) * dh;
      img.style.width = `${dw}px`;
      img.style.height = `${dh}px`;
      img.style.left = `${cw / 2 - bcxDisp}px`;
      img.style.top = `${ch / 2 - bcyDisp}px`;

      // Position the highlight box on top of the image at the bbox.
      highlight.style.display = 'block';
      highlight.style.left = `${cw / 2 - bcxDisp + bx * dw}px`;
      highlight.style.top = `${ch / 2 - bcyDisp + by * dh}px`;
      highlight.style.width = `${bw * dw}px`;
      highlight.style.height = `${bh * dh}px`;
      highlight.style.borderColor = color;
      highlight.style.boxShadow = `0 0 0 9999px rgba(0, 0, 0, 0.45)`;
    }

    img.addEventListener('load', () => {
      resetZoom();
      // Run again on resize so the diagram stays fit-to-container.
      const ro = new ResizeObserver(() => {
        if (activeFindingId === null) resetZoom();
      });
      ro.observe(wrap);
    });
    img.src = diagramDataUrl;

    fullBtn.addEventListener('click', () => {
      activeFindingId = null;
      list.querySelectorAll('.diag-finding-card').forEach((el) => {
        el.classList.remove('diag-finding-card-active');
      });
      resetZoom();
    });

    findings.forEach((f, idx) => {
      const num = idx + 1;
      const color = severityColor(f.severity);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `diag-finding-card diag-finding-${f.severity || 'issue'}`;
      card.innerHTML = `
        <span class="diag-finding-num"></span>
        <div class="diag-finding-body">
          <div class="diag-finding-title"></div>
          <div class="diag-finding-detail"></div>
        </div>
      `;
      card.querySelector('.diag-finding-num').textContent = String(num);
      card.querySelector('.diag-finding-num').style.background = color;
      const titleText = (f.service ? `${f.service} — ` : '') + (f.title || '');
      card.querySelector('.diag-finding-title').textContent = titleText;
      card.querySelector('.diag-finding-detail').textContent = f.detail || '';

      card.addEventListener('click', () => {
        activeFindingId = f.id || `idx-${idx}`;
        list.querySelectorAll('.diag-finding-card').forEach((el) => {
          el.classList.remove('diag-finding-card-active');
        });
        card.classList.add('diag-finding-card-active');
        zoomTo(f.bbox || [0, 0, 0.1, 0.1], color);
      });
      list.appendChild(card);
    });
  });
}

function buildA2UIChoiceSurface(msg, sendFn) {
  const components = (msg && msg.updateComponents && msg.updateComponents.components) || [];
  if (components.length === 0) return null;

  const surface = document.createElement('div');
  surface.className = 'a2ui-surface a2ui-choice-grid';
  let rendered = 0;
  for (const c of components) {
    if (c.component !== 'Button') continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'a2ui-choice-btn';
    btn.textContent = c.label || '';
    btn.addEventListener('click', () => {
      // Disable every button in this surface so the student can't double-pick.
      surface.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      btn.classList.add('a2ui-choice-btn-selected');
      sendFn(c.actionValue || c.label || '');
    });
    surface.appendChild(btn);
    rendered++;
  }
  return rendered > 0 ? surface : null;
}

// AppSync WebSocket connection configuration and helpers
function getAppSyncWebSocketUrl() {
  const url = new URL(ENV.GRAPHQL_API_ENDPOINT);
  const host = url.host;
  const wsHost = host.replace("appsync-api", "appsync-realtime-api");
  const wsUrl = `wss://${wsHost}/graphql`;
  
  // Build header object
  const header = {
    host: host,
    "x-api-key": ENV.API_KEY
  };
  
  const headerBase64 = btoa(JSON.stringify(header));
    
  return `${wsUrl}?header=${headerBase64}&payload=e30=`;
}

function subscribeToChatbot(sessionId, onChunk, onComplete) {
  return new Promise((resolve) => {
    const wsUrl = getAppSyncWebSocketUrl();
    const ws = new WebSocket(wsUrl, ["graphql-ws"]);
    let resolved = false;

    // Reorder buffer — AppSync subscriptions can deliver mutation events out
    // of order under rapid bursts. The Lambda tags every chunk with a
    // monotonically increasing sequence so we can render strictly in order.
    let nextSeq = 0;
    let finalSeq = null;
    let completed = false;
    const pending = {};
    const drain = () => {
      while (pending[nextSeq] !== undefined) {
        const { chunk, isComplete } = pending[nextSeq];
        delete pending[nextSeq];
        nextSeq++;
        if (chunk) onChunk(chunk);
        if (isComplete && !completed) {
          completed = true;
          onComplete();
          try { ws.close(); } catch (e) {}
          return;
        }
      }
      if (finalSeq !== null && nextSeq > finalSeq && !completed) {
        completed = true;
        onComplete();
        try { ws.close(); } catch (e) {}
      }
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        console.warn("WebSocket subscription handshake timed out. Proceeding without stream.");
        resolved = true;
        resolve(ws);
      }
    }, 2000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "connection_ack") {
        const subscriptionId = "sub-" + Math.random().toString(36).substr(2, 9);
        const query = `
          subscription OnChatbotChunk($sessionId: String!) {
            onChatbotChunk(sessionId: $sessionId) {
              sessionId
              chunk
              isComplete
              sequence
            }
          }
        `;
        const host = new URL(ENV.GRAPHQL_API_ENDPOINT).host;
        const authorization = {
          host: host,
          "x-api-key": ENV.API_KEY
        };
        ws.send(JSON.stringify({
          id: subscriptionId,
          type: "start",
          payload: {
            data: JSON.stringify({
              query: query,
              variables: { sessionId: sessionId }
            }),
            extensions: {
              authorization: authorization
            }
          }
        }));
      } else if (msg.type === "start_ack") {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve(ws);
        }
      } else if (msg.type === "data") {
        const chunkData = msg.payload.data?.onChatbotChunk;
        if (chunkData && typeof chunkData.sequence === "number") {
          pending[chunkData.sequence] = {
            chunk: chunkData.chunk,
            isComplete: chunkData.isComplete,
          };
          if (chunkData.isComplete) finalSeq = chunkData.sequence;
          drain();
        }
      } else if (msg.type === "error") {
        console.error("AppSync Subscription error:", msg.payload);
        ws.close();
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          resolve(ws);
        }
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        resolve(ws);
      }
    };
  });
}

// Global click listener to intercept clicking on courses within the chat UI
document.addEventListener("click", function(e) {
  const anchor = e.target.closest("a");
  if (anchor) {
    const href = anchor.getAttribute("href");
    if (href && (href.startsWith("#course/") || href.startsWith("course:"))) {
      e.preventDefault();
      const courseId = href.split("/").pop().split(":").pop();
      if (typeof window.selectCourse === "function") {
        const sideNavChat = document.getElementById("side-nav-chat");
        const sideNavLibrary = document.getElementById("side-nav-library");
        const chatWorkspaceContainer = document.getElementById("chat-workspace-container");
        const coursesWorkspaceContainer = document.getElementById("courses-workspace-container");
        const analyzerSidebarContents = document.getElementById("analyzer-sidebar-contents");
        const coursesSidebarContents = document.getElementById("courses-sidebar-contents");

        if (sideNavChat) sideNavChat.classList.remove("active");
        if (sideNavLibrary) sideNavLibrary.classList.add("active");
        if (chatWorkspaceContainer) chatWorkspaceContainer.classList.add("hidden");
        if (coursesWorkspaceContainer) coursesWorkspaceContainer.classList.remove("hidden");
        if (analyzerSidebarContents) analyzerSidebarContents.classList.add("hidden");
        if (coursesSidebarContents) coursesSidebarContents.classList.remove("hidden");

        const select = () => {
          if (!courses || courses.length === 0) {
            loadCourses().then(() => {
              doSelect();
            });
          } else {
            doSelect();
          }
        };

        const doSelect = () => {
          let course = courses.find(c => c.courseId === courseId);
          if (!course) {
            // Title-matching fallback if ID is missing/hallucinated
            const linkText = anchor.textContent.trim().toLowerCase();
            course = courses.find(c => {
              const cTitle = c.title.toLowerCase();
              return cTitle === linkText || cTitle.includes(linkText) || linkText.includes(cTitle);
            });
          }
          if (course) {
            window.selectCourse(course.courseId);
          } else {
            console.warn("Course not found for ID or Title matching:", courseId);
          }
        };

        select();
      }
    }
  }
});


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
  switchToAnalyzer(false);
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
    const summaryEl = document.getElementById("summary-text");
    summaryEl.innerHTML = summaryHTML;
    wrapJargonInElement(summaryEl);

    // Key Takeaways
    const takeawaysHTML = parseMarkdown(localizedSource.keyTakeaways || "No key takeaways generated for this selection.");
    const takeawaysEl = document.getElementById("takeaways-text");
    takeawaysEl.innerHTML = takeawaysHTML;
    wrapJargonInElement(takeawaysEl);

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

  // Expose globally for navigation and selection auto-closing
  window.closeMobileSidebar = closeSidebar;
})();

// Override selectVideo on global scope so onclick="selectVideo(...)" in sidebar auto-closes on mobile
const _origSelectVideoForMobile = selectVideo;
window.selectVideo = async function(videoUri) {
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
  return _origSelectVideoForMobile(videoUri);
};

// ==========================================================
// COURSE PORTAL IMPLEMENTATION
// ==========================================================

// Old redundant elements and switcher functions removed to resolve SyntaxError and redeclaration conflicts

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
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
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
    
    // Check prerequisites warning gate
    const prereq = checkPrerequisites(lesson);
    if (prereq) {
      showPrereqModal(prereq, mod, lesson);
      return;
    }
    
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
  
  // Wrap jargon terms, avoiding code blocks
  wrapJargonInElement(mdBody);
  
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

// Send-helper invoked by A2UI button clicks inside the drawer chat.
function drawerChatSend(text) {
  if (!chatbotInput) return;
  chatbotInput.value = text;
  sendChatbotMessage();
}

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
  
  const responseId = "bot-msg-" + Date.now();
  let accumulatedText = "";
  let subscription = null;
  let isStreamFinished = false;

  try {
    subscription = await subscribeToChatbot(chatSessionId, (chunk) => {
      const typingIndicator = document.getElementById(typingId);
      if (typingIndicator) typingIndicator.remove();
      
      let responseEl = document.getElementById(responseId);
      if (!responseEl) {
        chatbotMessages.innerHTML += `
          <div class="chat-msg chat-msg-bot" id="${responseId}"></div>
        `;
        responseEl = document.getElementById(responseId);
      }
      
      accumulatedText += chunk;
      responseEl.innerHTML = parseMarkdown(accumulatedText);
      renderA2UIBlocks(responseEl, drawerChatSend);
      renderCourseCards(responseEl);
      renderDiagramFindings(responseEl);
      chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
    }, () => {
      isStreamFinished = true;
      const typingIndicator = document.getElementById(typingId);
      if (typingIndicator) typingIndicator.remove();

      let responseEl = document.getElementById(responseId);
      if (responseEl) {
        wrapJargonInElement(responseEl);
        renderA2UIBlocks(responseEl, drawerChatSend);
        renderCourseCards(responseEl);
        renderDiagramFindings(responseEl);
        if (window.hljs) {
          responseEl.querySelectorAll('pre code').forEach((block) => {
            window.hljs.highlightElement(block);
          });
        }
      }
      chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
    });
  } catch (subErr) {
    console.error("Failed to establish chatbot subscription:", subErr);
  }

  try {
    const data = await queryGraphQL(`
      query AskCourseChatbot($courseId: String, $message: String!, $sessionId: String) {
        askCourseChatbot(courseId: $courseId, message: $message, sessionId: $sessionId)
      }
    `, {
      courseId: activeCourse ? activeCourse.courseId : null,
      message: text,
      sessionId: chatSessionId
    });
    
    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();
    
    const answer = data.askCourseChatbot || "No response received.";
    if (!isStreamFinished || !accumulatedText) {
      let responseEl = document.getElementById(responseId);
      if (!responseEl) {
        chatbotMessages.innerHTML += `
          <div class="chat-msg chat-msg-bot" id="${responseId}"></div>
        `;
        responseEl = document.getElementById(responseId);
      }
      responseEl.innerHTML = parseMarkdown(answer);
      wrapJargonInElement(responseEl);
      if (window.hljs) {
        responseEl.querySelectorAll('pre code').forEach((block) => {
          window.hljs.highlightElement(block);
        });
      }
      chatbotMessages.scrollTop = chatbotMessages.scrollHeight;
    }
  } catch (err) {
    if (subscription && typeof subscription.close === "function") {
      try { subscription.close(); } catch(e) {}
    }
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

// Chat Session Management
let chatSessionId = localStorage.getItem("chatSessionId");
if (!chatSessionId) {
  chatSessionId = "session-" + Math.random().toString(36).substring(2, 15);
  localStorage.setItem("chatSessionId", chatSessionId);
}

// Prerequisite & Refresher Quiz Gateways Logic
const COURSE_PREREQS = {
  "observability": "GraphQL / AppSync Observability",
  "appsync": "GraphQL Resolver Basics",
  "stripe": "REST Stripe Integrations",
  "neo4j": "Graph Database & Neo4j",
  "agentcore": "AI Agent Orchestration & AgentCore"
};

const REFRESHER_QUIZZES = {
  "appsync": {
    "question": "What is the primary difference between a GraphQL query and a GraphQL mutation?",
    "options": [
      "Queries read data (GET), while mutations write/modify data (POST/PUT).",
      "Queries are run on the client, mutations are run on the server.",
      "Queries use databases, mutations use file systems.",
      "There is no difference."
    ],
    "correct_index": 0
  },
  "observability": {
    "question": "Why is structured logging preferred over unstructured console prints in cloud applications?",
    "options": [
      "It allows logs to be easily queried and filtered using automated tools like CloudWatch Logs Insights.",
      "It makes the application run faster.",
      "It compresses the size of log files.",
      "It is required by TypeScript compiler."
    ],
    "correct_index": 0
  },
  "stripe": {
    "question": "What is a Stripe Webhook used for?",
    "options": [
      "To asynchronously notify your backend of event updates (like payment completed).",
      "To redirect customers to the checkout page.",
      "To securely encrypt credit card information on the client.",
      "To refund payments automatically."
    ],
    "correct_index": 0
  },
  "neo4j": {
    "question": "What is the primary traversal benefit of a Graph Database (like Neo4j) over a Relational Database?",
    "options": [
      "Fast relationship lookups without complex, high-latency multi-table JOIN operations.",
      "It takes up less storage space.",
      "It can only run on local machines.",
      "It is always cheaper to deploy."
    ],
    "correct_index": 0
  },
  "agentcore": {
    "question": "What is the core role of the Agent Orchestrator in an AI Agent system?",
    "options": [
      "To coordinate multiple model calls, plan task execution steps, and manage memory.",
      "To compile python code into binary.",
      "To host the database index.",
      "To secure the Cognito authentication credentials."
    ],
    "correct_index": 0
  }
};

let completedRefresherQuizzes = JSON.parse(localStorage.getItem("completedRefresherQuizzes") || "[]");
let pendingLessonToLoad = null;
let pendingModuleToLoad = null;
let activeRefresherPrereq = null;
let selectedRefresherOption = null;

function checkPrerequisites(lesson) {
  if (!lesson) return null;
  const title = lesson.title.toLowerCase();
  
  for (const [key, prereq] of Object.entries(COURSE_PREREQS)) {
    if (title.includes(key)) {
      if (!completedRefresherQuizzes.includes(key)) {
        return { key: key, name: prereq };
      }
    }
  }
  return null;
}

function showPrereqModal(prereq, mod, lesson) {
  pendingModuleToLoad = mod;
  pendingLessonToLoad = lesson;
  activeRefresherPrereq = prereq;
  
  const modal = document.getElementById("prereq-modal");
  const text = document.getElementById("prereq-text");
  text.innerHTML = `The lesson <strong>"${lesson.title}"</strong> covers advanced cloud concepts and recommends some prerequisite knowledge of <strong>${prereq.name}</strong>.<br><br>Would you like to take a 2-minute interactive refresher quiz first?`;
  modal.classList.remove("hidden");
}

function startRefresherQuiz(prereq) {
  const quiz = REFRESHER_QUIZZES[prereq.key];
  if (!quiz) {
    // Bypass if quiz isn't defined
    completedRefresherQuizzes.push(prereq.key);
    localStorage.setItem("completedRefresherQuizzes", JSON.stringify(completedRefresherQuizzes));
    activeCourseLesson = pendingLessonToLoad;
    activeCourseModule = pendingModuleToLoad;
    renderCourseSyllabus();
    renderLessonDetails(activeCourseLesson);
    return;
  }
  
  const modal = document.getElementById("refresher-quiz-modal");
  const questionEl = document.getElementById("refresher-question");
  const optionsEl = document.getElementById("refresher-options");
  const feedbackEl = document.getElementById("refresher-feedback");
  const actionBtn = document.getElementById("btn-refresher-action");
  
  document.getElementById("refresher-title").textContent = `${prereq.name} Refresher`;
  questionEl.textContent = quiz.question;
  feedbackEl.classList.add("hidden");
  selectedRefresherOption = null;
  
  actionBtn.textContent = "Submit Answer";
  actionBtn.disabled = true;
  
  optionsEl.innerHTML = quiz.options.map((opt, idx) => {
    return `
      <button class="quiz-option-btn" onclick="selectRefresherOption(${idx})" id="ref-opt-${idx}">
        <span class="option-letter">${String.fromCharCode(65 + idx)}</span>
        <span class="option-text">${opt}</span>
      </button>
    `;
  }).join("");
  
  modal.classList.remove("hidden");
}

window.selectRefresherOption = function(idx) {
  const quiz = REFRESHER_QUIZZES[activeRefresherPrereq.key];
  for (let i = 0; i < quiz.options.length; i++) {
    const el = document.getElementById(`ref-opt-${i}`);
    if (el) el.classList.remove("correct", "incorrect");
  }
  
  selectedRefresherOption = idx;
  const selectedEl = document.getElementById(`ref-opt-${idx}`);
  if (selectedEl) {
    selectedEl.style.borderColor = "var(--accent-purple)";
  }
  
  const actionBtn = document.getElementById("btn-refresher-action");
  actionBtn.disabled = false;
};

// Global click event for jargon term popovers
document.addEventListener("click", async (e) => {
  const target = e.target.closest(".jargon-term");
  const existingTooltip = document.querySelector(".jargon-tooltip");
  
  if (existingTooltip && (!target || !existingTooltip.contains(e.target))) {
    existingTooltip.remove();
  }
  
  if (!target) return;
  
  e.preventDefault();
  e.stopPropagation();
  
  const term = target.getAttribute("data-term");
  if (!term) return;
  
  // Show tooltip with loading state
  const tooltip = document.createElement("div");
  tooltip.className = "jargon-tooltip";
  tooltip.innerHTML = `<strong>${term}</strong>: Loading analogy... ⏳`;
  document.body.appendChild(tooltip);
  
  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  
  const top = window.scrollY + rect.top - tooltipRect.height - 10;
  const left = window.scrollX + rect.left + (rect.width - tooltipRect.width) / 2;
  
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${Math.max(10, left)}px`;
  
  try {
    const res = await queryGraphQL(`
      query DemystifyJargon($term: String!) {
        demystifyJargon(term: $term)
      }
    `, { term: term });
    
    if (res.demystifyJargon) {
      tooltip.innerHTML = `<strong>${term}</strong>: ${res.demystifyJargon}`;
      const newTooltipRect = tooltip.getBoundingClientRect();
      const newTop = window.scrollY + rect.top - newTooltipRect.height - 10;
      tooltip.style.top = `${newTop}px`;
    }
  } catch (err) {
    tooltip.innerHTML = `<strong>${term}</strong>: Failed to load analogy.`;
  }
});

// Setup prerequisite event listeners
document.getElementById("btn-close-prereq").addEventListener("click", () => {
  document.getElementById("prereq-modal").classList.add("hidden");
});

document.getElementById("btn-prereq-skip").addEventListener("click", () => {
  if (activeRefresherPrereq) {
    completedRefresherQuizzes.push(activeRefresherPrereq.key);
    localStorage.setItem("completedRefresherQuizzes", JSON.stringify(completedRefresherQuizzes));
  }
  document.getElementById("prereq-modal").classList.add("hidden");
  activeCourseLesson = pendingLessonToLoad;
  activeCourseModule = pendingModuleToLoad;
  renderCourseSyllabus();
  renderLessonDetails(activeCourseLesson);
});

document.getElementById("btn-prereq-quiz").addEventListener("click", () => {
  document.getElementById("prereq-modal").classList.add("hidden");
  startRefresherQuiz(activeRefresherPrereq);
});

document.getElementById("btn-close-refresher").addEventListener("click", () => {
  document.getElementById("refresher-quiz-modal").classList.add("hidden");
});

document.getElementById("btn-refresher-action").addEventListener("click", () => {
  const quiz = REFRESHER_QUIZZES[activeRefresherPrereq.key];
  const feedbackEl = document.getElementById("refresher-feedback");
  const actionBtn = document.getElementById("btn-refresher-action");
  
  if (actionBtn.textContent === "Continue to Lesson") {
    completedRefresherQuizzes.push(activeRefresherPrereq.key);
    localStorage.setItem("completedRefresherQuizzes", JSON.stringify(completedRefresherQuizzes));
    document.getElementById("refresher-quiz-modal").classList.add("hidden");
    
    activeCourseLesson = pendingLessonToLoad;
    activeCourseModule = pendingModuleToLoad;
    renderCourseSyllabus();
    renderLessonDetails(activeCourseLesson);
    return;
  }
  
  if (selectedRefresherOption === quiz.correctIndex) {
    feedbackEl.innerHTML = "<strong>Correct! 🎉</strong> Excellent job. You have completed the refresher.";
    feedbackEl.style.backgroundColor = "rgba(34, 197, 94, 0.1)";
    feedbackEl.style.color = "var(--status-completed)";
    feedbackEl.style.border = "1px solid var(--status-completed)";
    feedbackEl.classList.remove("hidden");
    
    const optEl = document.getElementById(`ref-opt-${quiz.correctIndex}`);
    if (optEl) optEl.classList.add("correct");
    actionBtn.textContent = "Continue to Lesson";
  } else {
    feedbackEl.innerHTML = "<strong>Not quite. ❌</strong> Please review the question and try again.";
    feedbackEl.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
    feedbackEl.style.color = "var(--status-failed)";
    feedbackEl.style.border = "1px solid var(--status-failed)";
    feedbackEl.classList.remove("hidden");
    
    const optEl = document.getElementById(`ref-opt-${selectedRefresherOption}`);
    if (optEl) optEl.classList.add("incorrect");
    
    actionBtn.textContent = "Try Again";
    actionBtn.disabled = true;
    selectedRefresherOption = null;
  }
});

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

// ==========================================================
// ZYRICON SLEEK DASHBOARD & TELEMETRY CONTROLLERS
// ==========================================================

const sideNavChat = document.getElementById("side-nav-chat");
const sideNavAnalyzer = document.getElementById("side-nav-analyzer");
const sideNavLibrary = document.getElementById("side-nav-library");
const sideNavTelemetry = document.getElementById("side-nav-telemetry");
const sideNavDemand = document.getElementById("side-nav-demand");

const chatWorkspaceContainer = document.getElementById("chat-workspace-container");
const analyzerWorkspaceContainer = document.getElementById("analyzer-workspace-container");
const coursesWorkspaceContainer = document.getElementById("courses-workspace-container");
const telemetryWorkspaceContainer = document.getElementById("telemetry-workspace-container");
const demandWorkspaceContainer = document.getElementById("demand-workspace-container");

const analyzerSidebarContents = document.getElementById("analyzer-sidebar-contents");
const coursesSidebarContents = document.getElementById("courses-sidebar-contents");

const sideBtnNewChat = document.getElementById("btn-new-chat-sidebar");
const btnCollapseSidebar = document.getElementById("btn-collapse-sidebar");
const sidebarEl = document.getElementById("sidebar");

const selectModel = document.getElementById("select-model");
const btnChatConfig = document.getElementById("btn-chat-config");
const btnChatExport = document.getElementById("btn-chat-export");

const mainChatWelcome = document.getElementById("main-chat-welcome");
const mainChatStream = document.getElementById("main-chat-stream");
const mainChatInput = document.getElementById("main-chat-input");
const btnChatSend = document.getElementById("btn-chat-send");
const btnChatMic = document.getElementById("btn-chat-mic");
const mainChatFeatureCards = document.getElementById("main-chat-feature-cards");

const cardVideoAi = document.getElementById("card-video-ai");
const cardLibrary = document.getElementById("card-library");
const cardDiagnostic = document.getElementById("card-diagnostic");

const btnRefreshTelemetry = document.getElementById("btn-refresh-telemetry");
const telemetryList = document.getElementById("telemetry-list");
const telemetryCountBadge = document.getElementById("telemetry-count-badge");
const evaluationsList = document.getElementById("evaluations-list");
const evaluationsCountBadge = document.getElementById("evaluations-count-badge");

const btnRefreshDemand = document.getElementById("btn-refresh-demand");
const demandList = document.getElementById("demand-list");
const demandSearch = document.getElementById("demand-search");

function clearActiveSideNav() {
  [
    sideNavChat, sideNavAnalyzer, sideNavLibrary, sideNavTelemetry, sideNavDemand
  ].forEach(btn => {
    if (btn) btn.classList.remove("active");
  });
}

function hideAllWorkspaceContainers() {
  [chatWorkspaceContainer, analyzerWorkspaceContainer, coursesWorkspaceContainer, telemetryWorkspaceContainer, demandWorkspaceContainer].forEach(container => {
    if (container) container.classList.add("hidden");
  });
}

window.switchToChat = function() {
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
  clearActiveSideNav();
  if (sideNavChat) sideNavChat.classList.add("active");
  hideAllWorkspaceContainers();
  if (chatWorkspaceContainer) chatWorkspaceContainer.classList.remove("hidden");
  
  if (analyzerSidebarContents) analyzerSidebarContents.classList.remove("hidden");
  if (coursesSidebarContents) coursesSidebarContents.classList.add("hidden");
};

window.switchToAnalyzer = function(showUpload = true) {
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
  clearActiveSideNav();
  if (sideNavAnalyzer) sideNavAnalyzer.classList.add("active");
  hideAllWorkspaceContainers();
  if (analyzerWorkspaceContainer) analyzerWorkspaceContainer.classList.remove("hidden");
  
  if (showUpload) {
    if (welcomeScreen) welcomeScreen.classList.remove("hidden");
    if (workspace) workspace.classList.add("hidden");
    activeVideoUri = null;
  }
  
  if (analyzerSidebarContents) analyzerSidebarContents.classList.remove("hidden");
  if (coursesSidebarContents) coursesSidebarContents.classList.add("hidden");
};

window.switchToLibrary = function() {
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
  clearActiveSideNav();
  if (sideNavLibrary) sideNavLibrary.classList.add("active");
  hideAllWorkspaceContainers();
  if (coursesWorkspaceContainer) coursesWorkspaceContainer.classList.remove("hidden");
  
  // Reset course views to show the library list
  const libView = document.getElementById("course-library-view");
  const detailView = document.getElementById("course-detail-view");
  if (libView) libView.classList.remove("hidden");
  if (detailView) detailView.classList.add("hidden");
  
  if (analyzerSidebarContents) analyzerSidebarContents.classList.remove("hidden");
  if (coursesSidebarContents) coursesSidebarContents.classList.add("hidden");
  
  loadCourses();
};

window.switchToTelemetry = function() {
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
  clearActiveSideNav();
  if (sideNavTelemetry) sideNavTelemetry.classList.add("active");
  hideAllWorkspaceContainers();
  if (telemetryWorkspaceContainer) telemetryWorkspaceContainer.classList.remove("hidden");
  
  if (analyzerSidebarContents) analyzerSidebarContents.classList.remove("hidden");
  if (coursesSidebarContents) coursesSidebarContents.classList.add("hidden");
  
  loadTelemetryLogs();
};

window.switchToDemand = function() {
  if (window.innerWidth <= 768 && typeof window.closeMobileSidebar === "function") {
    window.closeMobileSidebar();
  }
  clearActiveSideNav();
  if (sideNavDemand) sideNavDemand.classList.add("active");
  hideAllWorkspaceContainers();
  if (demandWorkspaceContainer) demandWorkspaceContainer.classList.remove("hidden");
  
  if (analyzerSidebarContents) analyzerSidebarContents.classList.remove("hidden");
  if (coursesSidebarContents) coursesSidebarContents.classList.add("hidden");
  
  loadDemandLogs();
};

// Sidebar Collapse Handler
if (btnCollapseSidebar && sidebarEl) {
  btnCollapseSidebar.addEventListener("click", () => {
    sidebarEl.classList.toggle("collapsed");
  });
}

// Send-helper invoked by A2UI button clicks inside the main chat workspace.
function mainChatSend(text) {
  if (!mainChatInput) return;
  mainChatInput.value = text;
  sendMainChatMsg();
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagram attachment (architecture review intent)
// ─────────────────────────────────────────────────────────────────────────────
// Student attaches a PNG/JPG architecture diagram. We PUT it to S3 via the
// `getDiagramUploadUrl` presigned URL, then pass the resulting key as
// `imageS3Key` on the next `askCourseChatbot` mutation. The Lambda detects the
// key and routes to the multimodal review handler.
let pendingDiagramKey = null;
let pendingDiagramDataUrl = null;
let pendingDiagramFilename = null;

const btnAttachDiagram = document.getElementById("btn-chat-attach-diagram");
const diagramFileInput = document.getElementById("diagram-file-input");
const diagramAttachmentChip = document.getElementById("diagram-attachment-chip");

function renderDiagramChip() {
  if (!diagramAttachmentChip) return;
  if (!pendingDiagramKey) {
    diagramAttachmentChip.style.display = "none";
    diagramAttachmentChip.innerHTML = "";
    return;
  }
  diagramAttachmentChip.style.display = "flex";
  diagramAttachmentChip.innerHTML = `
    <img class="diagram-attachment-chip-thumb" alt="">
    <div class="diagram-attachment-chip-meta">
      <span class="diagram-attachment-chip-label">Diagram ready for review</span>
      <span class="diagram-attachment-chip-filename"></span>
    </div>
    <button type="button" class="diagram-attachment-chip-remove" aria-label="Remove attachment">×</button>
  `;
  diagramAttachmentChip.querySelector(".diagram-attachment-chip-thumb").src = pendingDiagramDataUrl || "";
  diagramAttachmentChip.querySelector(".diagram-attachment-chip-filename").textContent = pendingDiagramFilename || "";
  diagramAttachmentChip
    .querySelector(".diagram-attachment-chip-remove")
    .addEventListener("click", clearPendingDiagram);
}

function clearPendingDiagram() {
  pendingDiagramKey = null;
  pendingDiagramDataUrl = null;
  pendingDiagramFilename = null;
  if (diagramFileInput) diagramFileInput.value = "";
  renderDiagramChip();
}

function setAttachBtnBusy(busy) {
  if (!btnAttachDiagram) return;
  btnAttachDiagram.disabled = busy;
  btnAttachDiagram.style.opacity = busy ? "0.5" : "1";
  const label = btnAttachDiagram.querySelector("span");
  if (label) label.textContent = busy ? "Uploading…" : "Review diagram";
}

if (btnAttachDiagram && diagramFileInput) {
  btnAttachDiagram.addEventListener("click", () => diagramFileInput.click());

  diagramFileInput.addEventListener("change", async () => {
    const file = diagramFileInput.files && diagramFileInput.files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
      alert("Please attach a PNG or JPG diagram.");
      diagramFileInput.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      alert("Diagram is too large (max 5 MB).");
      diagramFileInput.value = "";
      return;
    }

    setAttachBtnBusy(true);
    try {
      // 1. Get a presigned S3 URL.
      const data = await queryGraphQL(
        `mutation GetDiagramUploadUrl($fileName: String!, $contentType: String!) {
          getDiagramUploadUrl(fileName: $fileName, contentType: $contentType) {
            url
            fileName
          }
        }`,
        {
          fileName: `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
          contentType: file.type,
        }
      );

      const uploadInfo = data.getDiagramUploadUrl;
      if (!uploadInfo || !uploadInfo.url) throw new Error("Missing upload URL");

      // 2. PUT the bytes to S3.
      const putResponse = await fetch(uploadInfo.url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putResponse.ok) throw new Error(`S3 upload failed (${putResponse.status})`);

      // 3. Stash the S3 key + a local data URL so we can preview the chip and
      // render the image inside the user's bubble when they send the message.
      pendingDiagramKey = uploadInfo.fileName;
      pendingDiagramFilename = file.name;
      pendingDiagramDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      renderDiagramChip();
    } catch (err) {
      console.error("Diagram upload failed:", err);
      alert(`Couldn't upload diagram: ${err.message || err}`);
    } finally {
      setAttachBtnBusy(false);
    }
  });
}

// Main Chat Message Submission
async function sendMainChatMsg() {
  if (!mainChatInput) return;
  const text = mainChatInput.value.trim();
  // Capture and clear the diagram attachment BEFORE async work so a quick
  // second click can't double-send the same upload.
  const diagramKey = pendingDiagramKey;
  const diagramDataUrl = pendingDiagramDataUrl;
  if (!text && !diagramKey) return;
  if (diagramKey) clearPendingDiagram();

  mainChatInput.value = "";

  // Update state to active chat stream
  if (mainChatWelcome) mainChatWelcome.classList.add("hidden");
  if (mainChatFeatureCards) mainChatFeatureCards.classList.add("hidden");
  if (mainChatStream) mainChatStream.classList.remove("hidden");

  // Append user message — include the diagram thumbnail when attached so the
  // student can see what they sent.
  const userBubble = document.createElement("div");
  userBubble.className = "chat-msg-user";
  userBubble.style.marginBottom = "0.5rem";
  if (diagramDataUrl) {
    const img = document.createElement("img");
    img.src = diagramDataUrl;
    img.className = "chat-msg-user-diagram";
    img.alt = "Uploaded architecture diagram";
    userBubble.appendChild(img);
  }
  if (text) {
    const textNode = document.createElement("div");
    textNode.className = "chat-msg-user-text";
    textNode.textContent = text;
    userBubble.appendChild(textNode);
  } else if (diagramDataUrl) {
    const textNode = document.createElement("div");
    textNode.className = "chat-msg-user-text";
    textNode.textContent = "Please review this architecture.";
    userBubble.appendChild(textNode);
  }
  mainChatStream.appendChild(userBubble);
  mainChatStream.scrollTop = mainChatStream.scrollHeight;

  const typingId = "main-typing-" + Date.now();
  mainChatStream.innerHTML += `
    <div class="chat-msg-typing" id="${typingId}" style="margin-bottom: 0.5rem; display: flex; gap: 0.25rem;">
      <span style="animation: pulse 1s infinite alternate; width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); display: inline-block;"></span>
      <span style="animation: pulse 1s infinite alternate 0.2s; width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); display: inline-block;"></span>
      <span style="animation: pulse 1s infinite alternate 0.4s; width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); display: inline-block;"></span>
    </div>
  `;
  mainChatStream.scrollTop = mainChatStream.scrollHeight;

  const responseId = "main-bot-msg-" + Date.now();
  if (diagramDataUrl) {
    // Stash for the click-to-focus renderer that fires after the JSON
    // findings block streams in.
    diagramDataUrlsByResponseId[responseId] = diagramDataUrl;
  }
  let accumulatedText = "";
  let subscription = null;
  let isStreamFinished = false;

  try {
    subscription = await subscribeToChatbot(chatSessionId, (chunk) => {
      const typingIndicator = document.getElementById(typingId);
      if (typingIndicator) typingIndicator.remove();
      
      let responseEl = document.getElementById(responseId);
      if (!responseEl) {
        mainChatStream.innerHTML += `
          <div class="chat-msg-bot markdown-body" id="${responseId}" style="margin-bottom: 0.5rem;"></div>
        `;
        responseEl = document.getElementById(responseId);
      }
      
      accumulatedText += chunk;
      responseEl.innerHTML = parseMarkdown(accumulatedText);
      renderA2UIBlocks(responseEl, mainChatSend);
      renderCourseCards(responseEl);
      renderDiagramFindings(responseEl);
      mainChatStream.scrollTop = mainChatStream.scrollHeight;
    }, () => {
      isStreamFinished = true;
      const typingIndicator = document.getElementById(typingId);
      if (typingIndicator) typingIndicator.remove();

      let responseEl = document.getElementById(responseId);
      if (responseEl) {
        wrapJargonInElement(responseEl);
        renderA2UIBlocks(responseEl, mainChatSend);
        renderCourseCards(responseEl);
        renderDiagramFindings(responseEl);
        if (window.hljs) {
          responseEl.querySelectorAll('pre code').forEach((block) => {
            window.hljs.highlightElement(block);
          });
        }
      }
      mainChatStream.scrollTop = mainChatStream.scrollHeight;
    });
  } catch (subErr) {
    console.error("Failed to establish main chatbot subscription:", subErr);
  }

  try {
    const variables = {
      message: text || "Please review this architecture.",
      sessionId: chatSessionId
    };
    if (activeCourse) {
      variables.courseId = activeCourse.courseId;
    }
    if (diagramKey) {
      variables.imageS3Key = diagramKey;
    }

    const queryStr = `
      query AskCourseChatbot($courseId: String, $message: String!, $sessionId: String, $imageS3Key: String) {
        askCourseChatbot(courseId: $courseId, message: $message, sessionId: $sessionId, imageS3Key: $imageS3Key)
      }
    `;

    const data = await queryGraphQL(queryStr, variables);
    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();

    const answer = data.askCourseChatbot || "No response received.";
    if (!isStreamFinished || !accumulatedText) {
      let responseEl = document.getElementById(responseId);
      if (!responseEl) {
        mainChatStream.innerHTML += `
          <div class="chat-msg-bot markdown-body" id="${responseId}" style="margin-bottom: 0.5rem;"></div>
        `;
        responseEl = document.getElementById(responseId);
      }
      responseEl.innerHTML = parseMarkdown(answer);
      wrapJargonInElement(responseEl);
      if (window.hljs) {
        responseEl.querySelectorAll('pre code').forEach((block) => {
          window.hljs.highlightElement(block);
        });
      }
      mainChatStream.scrollTop = mainChatStream.scrollHeight;
    }
  } catch (err) {
    const typingIndicator = document.getElementById(typingId);
    if (typingIndicator) typingIndicator.remove();
    // If the streaming subscription has already delivered content, the
    // mutation timing out (AppSync's 30s data-source cap) isn't user-visible
    // — the WebSocket keeps streaming chunks. Don't pollute the chat with an
    // error in that case.
    if (accumulatedText) {
      console.warn("Mutation failed but streaming delivered content; suppressing error UI:", err);
    } else {
      if (subscription && typeof subscription.close === "function") {
        try { subscription.close(); } catch(e) {}
      }
      mainChatStream.innerHTML += `
        <div class="chat-msg-error" style="margin-bottom: 0.5rem;">
          Failed to fetch AI response: ${err.message}
        </div>
      `;
    }
    mainChatStream.scrollTop = mainChatStream.scrollHeight;
  }
}

// Start Diagnostic Quiz directly in chat
window.startDiagnosticQuizDirectly = function() {
  if (mainChatInput) {
    mainChatInput.value = "Start Diagnostic Quiz";
    sendMainChatMsg();
  }
};

// Reset chat history / Start new chat
async function resetTutorChat() {
  if (mainChatStream) mainChatStream.innerHTML = "";
  if (mainChatStream) mainChatStream.classList.add("hidden");
  if (mainChatWelcome) mainChatWelcome.classList.remove("hidden");
  if (mainChatFeatureCards) mainChatFeatureCards.classList.remove("hidden");
  
  // Send reset command to clean session in DB
  try {
    await queryGraphQL(`
      query AskCourseChatbot($message: String!, $sessionId: String) {
        askCourseChatbot(message: $message, sessionId: $sessionId)
      }
    `, {
      message: "reset",
      sessionId: chatSessionId
    });
    console.log("Chat history reset successfully on backend.");
  } catch (e) {
    console.warn("Failed to reset backend chat logs:", e);
  }
}

// Fetch and Render Telemetry / Evaluations Logs
async function loadTelemetryLogs() {
  if (!telemetryList || !evaluationsList) return;

  telemetryList.innerHTML = `<div class="loading-spinner-small">Loading telemetry logs...</div>`;
  evaluationsList.innerHTML = `<div class="loading-spinner-small">Loading evaluations...</div>`;

  // 1. Fetch content demand telemetry
  try {
    const data = await queryGraphQL(`
      query GetContentDemandTelemetry {
        getContentDemandTelemetry {
          requestId
          prompt
          timestamp
          detectedTopic
        }
      }
    `);
    const list = data.getContentDemandTelemetry || [];
    telemetryCountBadge.textContent = list.length;
    
    if (list.length === 0) {
      telemetryList.innerHTML = `<div class="text-muted" style="text-align: center; margin-top: 3rem; font-size: 0.85rem;">No telemetry events recorded yet. Try asking for Azure/GCP topics to trigger logging.</div>`;
    } else {
      telemetryList.innerHTML = list.map(item => {
        const dateStr = new Date(parseFloat(item.timestamp) * 1000).toLocaleString();
        return `
          <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.4rem;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="font-size: 0.75rem; background: rgba(147,51,234,0.15); color: #c084fc; padding: 0.2rem 0.6rem; border-radius: 10px; font-weight: 600;">${item.detectedTopic || 'Unknown'}</span>
              <span style="font-size: 0.7rem; color: var(--text-muted);">${dateStr}</span>
            </div>
            <p style="font-size: 0.8rem; font-weight: 500; color: var(--text-bright); margin: 0;">"${item.prompt}"</p>
            <span style="font-size: 0.65rem; color: var(--text-muted);">Request ID: ${item.requestId}</span>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    telemetryList.innerHTML = `<div class="chat-msg-error">Failed to load telemetry logs: ${err.message}</div>`;
  }

  // 2. Fetch log evaluations
  try {
    const data = await queryGraphQL(`
      query GetChatEvaluations {
        getChatEvaluations {
          evaluationId
          sessionId
          userPrompt
          assistantResponse
          relevanceScore
          politenessScore
          adherenceScore
          justification
          timestamp
        }
      }
    `);
    const list = data.getChatEvaluations || [];
    evaluationsCountBadge.textContent = list.length;

    if (list.length === 0) {
      evaluationsList.innerHTML = `<div class="text-muted" style="text-align: center; margin-top: 3rem; font-size: 0.85rem;">No log evaluations available yet. Runs automatically at midnight or via manual trigger.</div>`;
    } else {
      evaluationsList.innerHTML = list.map(item => {
        const dateStr = new Date(parseFloat(item.timestamp) * 1000).toLocaleString();
        
        const getScoreColor = (score) => {
          if (score >= 8) return 'rgba(34,197,94,0.15); color: #86efac;';
          if (score >= 5) return 'rgba(234,179,8,0.15); color: #fef08a;';
          return 'rgba(239,68,68,0.15); color: #fca5a5;';
        };

        return `
          <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.4rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 0.5rem; margin-bottom: 0.25rem;">
              <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: 500;">Session: ${item.sessionId.substring(0, 15)}...</span>
              <span style="font-size: 0.7rem; color: var(--text-muted);">${dateStr}</span>
            </div>
            
            <div style="display: flex; gap: 0.5rem; margin-bottom: 0.25rem;">
              <span style="font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 6px; font-weight: 600; background: ${getScoreColor(item.relevanceScore)}">Relevance: ${item.relevanceScore}/10</span>
              <span style="font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 6px; font-weight: 600; background: ${getScoreColor(item.politenessScore)}">Politeness: ${item.politenessScore}/10</span>
              <span style="font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 6px; font-weight: 600; background: ${getScoreColor(item.adherenceScore)}">Adherence: ${item.adherenceScore}/10</span>
            </div>

            <p style="font-size: 0.75rem; color: var(--text-main); line-height: 1.4; margin: 0;"><strong>Q:</strong> "${item.userPrompt}"</p>
            <p style="font-size: 0.75rem; color: var(--text-muted); line-height: 1.4; margin: 0; background: rgba(0,0,0,0.15); padding: 0.4rem 0.6rem; border-radius: 6px;"><strong>Judge Justification:</strong> ${item.justification}</p>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    evaluationsList.innerHTML = `<div class="chat-msg-error">Failed to load evaluations: ${err.message}</div>`;
  }
}

// Fetch and Render Demand Telemetry
let allDemandLogs = [];

async function loadDemandLogs() {
  if (!demandList) return;

  demandList.innerHTML = `<div class="loading-spinner-small" style="grid-column: 1/-1;">Loading demand logs...</div>`;

  try {
    const data = await queryGraphQL(`
      query GetContentDemandTelemetry {
        getContentDemandTelemetry {
          requestId
          prompt
          timestamp
          detectedTopic
        }
      }
    `);
    allDemandLogs = data.getContentDemandTelemetry || [];
    renderDemandLogs();
  } catch (err) {
    demandList.innerHTML = `<div class="chat-msg-error" style="grid-column: 1/-1;">Failed to load demand logs: ${err.message}</div>`;
  }
}

function renderDemandLogs() {
  if (!demandList) return;
  const searchVal = document.getElementById("demand-search")?.value.trim().toLowerCase() || "";
  const filtered = allDemandLogs.filter(item => {
    if (!searchVal) return true;
    const topic = (item.detectedTopic || "").toLowerCase();
    const prompt = (item.prompt || "").toLowerCase();
    return topic.includes(searchVal) || prompt.includes(searchVal);
  });

  // Calculate stats
  const totalRequests = allDemandLogs.length;
  const uniqueTopics = new Set(allDemandLogs.map(item => item.detectedTopic || 'Unknown'));
  
  // Hottest topic calculation
  const topicCounts = {};
  allDemandLogs.forEach(item => {
    const t = item.detectedTopic || 'Unknown';
    topicCounts[t] = (topicCounts[t] || 0) + 1;
  });
  let hottestTopic = 'N/A';
  let maxCount = 0;
  for (const [t, count] of Object.entries(topicCounts)) {
    if (count > maxCount) {
      maxCount = count;
      hottestTopic = t;
    }
  }

  // Update DOM stats
  const statRequests = document.getElementById("demand-stat-requests");
  const statTopics = document.getElementById("demand-stat-topics");
  const statHottest = document.getElementById("demand-stat-hottest");
  const listBadge = document.getElementById("demand-list-badge");

  if (statRequests) statRequests.textContent = totalRequests;
  if (statTopics) statTopics.textContent = uniqueTopics.size;
  if (statHottest) statHottest.textContent = hottestTopic + (maxCount > 0 ? ` (${maxCount} reqs)` : '');
  if (listBadge) listBadge.textContent = filtered.length;

  if (filtered.length === 0) {
    demandList.innerHTML = `<div class="text-muted" style="grid-column: 1/-1; text-align: center; margin-top: 5rem; font-size: 0.85rem;">No demanded content items match your search.</div>`;
    return;
  }

  demandList.innerHTML = filtered.map(item => {
    const dateStr = new Date(parseFloat(item.timestamp) * 1000).toLocaleString();
    return `
      <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 12px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; transition: var(--transition-smooth); position: relative; overflow: hidden;" class="demand-card">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.75rem; background: rgba(147, 51, 234, 0.15); color: #c084fc; padding: 0.2rem 0.6rem; border-radius: 10px; font-weight: 600;">${item.detectedTopic || 'Unknown'}</span>
          <span style="font-size: 0.7rem; color: var(--text-muted);">${dateStr}</span>
        </div>
        <p style="font-size: 0.85rem; font-weight: 500; color: var(--text-bright); margin: 0; line-height: 1.45;">"${item.prompt}"</p>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 0.75rem; margin-top: 0.25rem;">
          <span style="font-size: 0.65rem; color: var(--text-muted); font-family: monospace;">Ref: ${item.requestId.substring(0, 18)}...</span>
          <span style="font-size: 0.65rem; background: rgba(245, 158, 11, 0.1); color: #f59e0b; padding: 0.15rem 0.4rem; border-radius: 4px; font-weight: 600;">⚠️ Content Gap</span>
        </div>
      </div>
    `;
  }).join('');
}

// Bind event listeners
if (sideNavChat) sideNavChat.addEventListener("click", switchToChat);
if (sideNavAnalyzer) sideNavAnalyzer.addEventListener("click", () => switchToAnalyzer(true));
if (sideNavLibrary) sideNavLibrary.addEventListener("click", switchToLibrary);
if (sideNavTelemetry) sideNavTelemetry.addEventListener("click", switchToTelemetry);
if (sideNavDemand) sideNavDemand.addEventListener("click", switchToDemand);

if (sideBtnNewChat) sideBtnNewChat.addEventListener("click", resetTutorChat);
if (btnRefreshTelemetry) btnRefreshTelemetry.addEventListener("click", loadTelemetryLogs);
if (btnRefreshDemand) btnRefreshDemand.addEventListener("click", loadDemandLogs);
if (demandSearch) {
  demandSearch.addEventListener("input", renderDemandLogs);
}

if (cardVideoAi) cardVideoAi.addEventListener("click", switchToAnalyzer);
if (cardLibrary) cardLibrary.addEventListener("click", switchToLibrary);
if (cardDiagnostic) cardDiagnostic.addEventListener("click", () => {
  switchToChat();
  startDiagnosticQuizDirectly();
});

// Prompt Box Input Event Listeners
if (mainChatInput) {
  mainChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMainChatMsg();
    }
  });
}
if (btnChatSend) btnChatSend.addEventListener("click", sendMainChatMsg);

// Suggestion pills clicks
document.addEventListener("click", (e) => {
  const pill = e.target.closest(".suggestion-pill");
  if (pill) {
    const promptText = pill.getAttribute("data-prompt");
    if (mainChatInput && promptText) {
      mainChatInput.value = promptText;
      sendMainChatMsg();
    }
  }
});

// Initialize switcher hook to Chat by default
document.addEventListener("DOMContentLoaded", () => {
  switchToChat();
  loadCourses();
});

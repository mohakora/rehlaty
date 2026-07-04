// ============================================================
// 🤖 مساعد الطالب الذكي — "سؤالك عن الدرس"
// يرسل سؤال الطالب إلى Edge Function (ask-lesson-ai) التي بدورها
// تستدعي Mistral API وتردّ بإجابة مبنية فقط على محتوى الدرس الحالي
// مع ذكر المصدر (رقم الفقرة / اسم الفيديو).
// ============================================================
import { supabase } from "./supabaseClient.js";
import { el, escapeHtml } from "./utils/sanitize.js";

const fab = document.getElementById("ai-assistant-fab");
const overlay = document.getElementById("ai-assistant-overlay");
const closeBtn = document.getElementById("ai-assistant-close");
const lessonNameEl = document.getElementById("ai-assistant-lesson-name");
const thread = document.getElementById("ai-assistant-thread");
const form = document.getElementById("ai-assistant-form");
const textarea = document.getElementById("ai-assistant-input");
const submitBtn = document.getElementById("ai-assistant-submit");

let activeLessonId = null;
let activeLessonTitle = "";
let isSending = false;

/** يُستدعى من app.js عند فتح درس، لربط المساعد بالدرس الحالي وإظهار الزر العائم */
export function setAssistantLesson(lessonId, lessonTitle) {
  activeLessonId = lessonId;
  activeLessonTitle = lessonTitle || "";
  if (fab) fab.classList.add("visible");
  if (thread) thread.innerHTML = "";
}

/** يُستدعى عند مغادرة صفحة الدرس لإخفاء الزر العائم */
export function hideAssistantFab() {
  if (fab) fab.classList.remove("visible");
}

function openAssistant() {
  if (!overlay) return;
  if (lessonNameEl) lessonNameEl.textContent = activeLessonTitle ? `عن درس: ${activeLessonTitle}` : "";
  overlay.classList.add("open");
  setTimeout(() => textarea?.focus(), 200);
}

function closeAssistant() {
  overlay?.classList.remove("open");
}

fab?.addEventListener("click", openAssistant);
closeBtn?.addEventListener("click", closeAssistant);
overlay?.addEventListener("click", (e) => {
  if (e.target === overlay) closeAssistant();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && overlay?.classList.contains("open")) closeAssistant();
});

function appendQuestion(text) {
  const item = el("div", { className: "ai-qa-item" }, [el("div", { className: "ai-qa-question", text })]);
  thread.appendChild(item);
  thread.scrollTop = thread.scrollHeight;
  return item;
}

function appendLoading() {
  const loading = el("div", { className: "ai-qa-loading" }, [
    el("span"),
    el("span"),
    el("span"),
  ]);
  thread.appendChild(loading);
  thread.scrollTop = thread.scrollHeight;
  return loading;
}

function appendAnswer({ answer, sources, found_in_lesson }) {
  const answerNode = el("div", {
    className: "ai-qa-answer" + (found_in_lesson === false ? " not-found" : ""),
  });
  answerNode.innerHTML = escapeHtml(answer).replace(/\n/g, "<br>");

  if (Array.isArray(sources) && sources.length > 0) {
    const sourcesWrap = el("div", { className: "ai-qa-sources" });
    sources.forEach((s) => sourcesWrap.appendChild(el("span", { className: "ai-source-chip", text: `📖 ${s}` })));
    answerNode.appendChild(sourcesWrap);
  }

  const item = el("div", { className: "ai-qa-item" }, [answerNode]);
  thread.appendChild(item);
  thread.scrollTop = thread.scrollHeight;
}

function appendError(message) {
  const item = el("div", { className: "ai-qa-item" }, [el("div", { className: "ai-qa-error", text: message })]);
  thread.appendChild(item);
  thread.scrollTop = thread.scrollHeight;
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSending) return;

  const question = textarea.value.trim();
  if (!question) return;
  if (!activeLessonId) {
    appendError("تعذّر تحديد الدرس الحالي، أعد فتح الدرس والمحاولة مرة أخرى.");
    return;
  }

  isSending = true;
  submitBtn.disabled = true;
  textarea.value = "";
  appendQuestion(question);
  const loading = appendLoading();

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;

    const { data, error } = await supabase.functions.invoke("ask-lesson-ai", {
      body: { content_id: activeLessonId, question },
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
    });

    loading.remove();

    if (error) {
      // رسالة الخطأ التفصيلية غالباً موجودة داخل استجابة الدالة نفسها
      const detail = error.context?.body ? await tryParseErrorBody(error.context) : null;
      appendError(detail?.error || "تعذّر الحصول على إجابة الآن، حاول مرة أخرى بعد قليل.");
      return;
    }
    if (data?.error) {
      appendError(data.error + (data.debug ? ` (تفاصيل تقنية: ${data.debug})` : ""));
      return;
    }

    appendAnswer(data);
  } catch (err) {
    loading.remove();
    appendError("حدث خطأ في الاتصال، تأكد من الإنترنت وحاول مرة أخرى.");
  } finally {
    isSending = false;
    submitBtn.disabled = false;
  }
});

/** محاولة قراءة رسالة الخطأ التفصيلية من جسم استجابة Edge Function عند الفشل */
async function tryParseErrorBody(context) {
  try {
    if (typeof context.json === "function") return await context.json();
    if (context.body) return JSON.parse(context.body);
  } catch (_) {
    /* تجاهل */
  }
  return null;
}

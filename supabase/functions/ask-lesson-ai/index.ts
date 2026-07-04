// ============================================================
// 🤖 Edge Function: ask-lesson-ai
// تستقبل سؤال الطالب عن درس محدد، تبني سياقاً من محتوى الدرس
// الفعلي (فقرات + عناوين + وسائط) فقط، وتستدعي Mistral API للرد
// ضمن حدود هذا المحتوى مع ذكر المصدر (رقم الفقرة / اسم الفيديو).
//
// النشر:
//   supabase functions deploy ask-lesson-ai
// المفتاح السرّي المطلوب:
//   supabase secrets set MISTRAL_API_KEY=xxxxxxxx
//
// ملاحظة مهمة عن الاستيراد: نستخدم jsr: بدل esm.sh لأنه الأسلوب
// الرسمي الموصى به من Supabase حالياً لـ Edge Functions (أكثر ثباتاً
// من CDN خارجي مثل esm.sh الذي قد يفشل أحياناً في وقت التشغيل).
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MISTRAL_MODEL = "mistral-large-latest";
const MAX_QUESTION_LENGTH = 500;
const RATE_LIMIT_MAX_REQUESTS = 8; // كحد أقصى لكل مستخدم
const RATE_LIMIT_WINDOW_MINUTES = 5;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** إزالة أي وسوم HTML من فقرات الدرس قبل إرسالها كسياق نصي خام للنموذج */
function stripTags(html: string): string {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** يقرأ متغير بيئة بأكثر من اسم محتمل (توافقية مع نظامي مفاتيح Supabase القديم والجديد) */
function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const v = Deno.env.get(name);
    if (v) return v;
  }
  return undefined;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "الطريقة غير مدعومة" }, 405);

  // ---------- 0) قراءة متغيرات البيئة (مع دعم أسماء Supabase الجديدة والقديمة) ----------
  const SUPABASE_URL = readEnv("SUPABASE_URL");
  // النظام القديم: SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
  // النظام الجديد (مشاريع حديثة): SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
  const SUPABASE_ANON_KEY = readEnv("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY");
  const MISTRAL_API_KEY = Deno.env.get("MISTRAL_API_KEY");

  const missing: string[] = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY/SUPABASE_PUBLISHABLE_KEY");
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY");
  if (!MISTRAL_API_KEY) missing.push("MISTRAL_API_KEY");

  if (missing.length > 0) {
    // خطأ إعداد واضح بدل "خطأ غير متوقع" — يظهر في: supabase functions logs ask-lesson-ai
    console.error("ask-lesson-ai: متغيرات بيئة ناقصة:", missing.join(", "));
    return jsonResponse(
      {
        error: "المساعد الذكي غير مُعدّ بشكل صحيح على الخادم بعد. برجاء مراجعة إعدادات Supabase (Secrets).",
        missing_env: missing, // آمن للعرض: أسماء المتغيرات فقط وليست قيمها
      },
      500
    );
  }

  try {
    // عميل يستخدم توكن المستخدم نفسه (يحترم RLS) للتحقق من هويته وقراءة الدرس
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      console.error("ask-lesson-ai: فشل التحقق من هوية المستخدم:", userErr?.message);
      return jsonResponse({ error: "يجب تسجيل الدخول لاستخدام المساعد الذكي." }, 401);
    }
    const userId = userData.user.id;

    // عميل بصلاحية service_role للقراءة الكاملة والكتابة في سجل الأسئلة
    const adminClient = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });

    // ---------- 1) تحقق من المدخلات ----------
    const body = await req.json().catch(() => null);
    const contentId = Number(body?.content_id);
    const question = String(body?.question || "").trim();

    if (!contentId || Number.isNaN(contentId)) {
      return jsonResponse({ error: "معرّف الدرس غير صالح." }, 400);
    }
    if (!question) {
      return jsonResponse({ error: "برجاء كتابة سؤالك أولاً." }, 400);
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return jsonResponse({ error: `السؤال طويل جداً (الحد الأقصى ${MAX_QUESTION_LENGTH} حرف).` }, 400);
    }

    // ---------- 2) حدّ الاستخدام (Rate Limiting) ----------
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { count: recentCount, error: rateErr } = await adminClient
      .from("lesson_ai_questions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", windowStart);

    if (rateErr) {
      // لو الجدول غير موجود مثلاً (schema_ai.sql لم يُنفَّذ بعد) سنعرف السبب فوراً من السجلات
      console.error("ask-lesson-ai: فشل التحقق من حدّ الاستخدام (تأكد من تنفيذ schema_ai.sql):", rateErr.message);
    } else if ((recentCount || 0) >= RATE_LIMIT_MAX_REQUESTS) {
      return jsonResponse(
        { error: `وصلت للحد الأقصى من الأسئلة (${RATE_LIMIT_MAX_REQUESTS} كل ${RATE_LIMIT_WINDOW_MINUTES} دقائق). حاول لاحقاً.` },
        429
      );
    }

    // ---------- 3) جلب محتوى الدرس الفعلي فقط (المصدر الوحيد للإجابة) ----------
    const { data: content, error: contentErr } = await userClient
      .from("contents")
      .select("id, title, body, category")
      .eq("id", contentId)
      .single();

    if (contentErr || !content) {
      console.error("ask-lesson-ai: تعذّر جلب الدرس رقم", contentId, contentErr?.message);
      return jsonResponse({ error: "تعذّر العثور على هذا الدرس." }, 404);
    }

    const [sectionsRes, mediaRes] = await Promise.all([
      userClient.from("content_sections").select("type, body").eq("content_id", contentId).order("order", { ascending: true }),
      userClient.from("content_media").select("type, title, url").eq("content_id", contentId).order("order", { ascending: true }),
    ]);
    if (sectionsRes.error) console.error("ask-lesson-ai: خطأ في جلب content_sections:", sectionsRes.error.message);
    if (mediaRes.error) console.error("ask-lesson-ai: خطأ في جلب content_media:", mediaRes.error.message);

    const sections = sectionsRes.data || [];
    const media = mediaRes.data || [];

    // ---------- 4) بناء سياق نصي مرقّم يستطيع النموذج الاستشهاد منه ----------
    const contextParts: string[] = [];
    contextParts.push(`عنوان الدرس: ${content.title}`);
    if (content.category) contextParts.push(`التصنيف: ${content.category}`);

    if (sections.length > 0) {
      sections.forEach((s: { type: string; body: string }, i: number) => {
        const label = s.type === "header" ? `[عنوان فرعي رقم ${i + 1}]` : `[الفقرة رقم ${i + 1}]`;
        contextParts.push(`${label}: ${stripTags(s.body)}`);
      });
    } else if (content.body) {
      contextParts.push(`[نص الدرس]: ${stripTags(content.body)}`);
    }

    if (media.length > 0) {
      media.forEach((m: { type: string; title: string; url: string }) => {
        const kind = m.type === "youtube" ? "فيديو" : m.type === "pdf" ? "ملف PDF" : "رابط";
        contextParts.push(`[مصدر إضافي - ${kind}]: ${m.title || m.url}`);
      });
    }

    const lessonContext = contextParts.join("\n");

    // ---------- 5) استدعاء Mistral API ----------
    const systemPrompt = `أنت مساعد تعليمي داخل منصة "رحلة الحياة الزوجية". مهمتك مساعدة الطالب على فهم "الدرس الحالي فقط" المرفق نصه أدناه.

قواعد صارمة يجب الالتزام بها دائماً:
1. أجب فقط بالاعتماد على المحتوى المرفق بين علامتي «--- محتوى الدرس ---». لا تستخدم أي معلومة من خارج هذا النص، ولا تفتِ برأيك الشخصي في مسائل شرعية أو نفسية حساسة.
2. إن لم تجد إجابة السؤال ضمن المحتوى المرفق، صرّح بذلك بوضوح واقترح على الطالب التواصل مع المشرف عبر صفحة "الدعم الفني"، ولا تخترع إجابة.
3. اذكر دائماً مصدر إجابتك من داخل المحتوى (مثال: "الفقرة رقم 2" أو "العنوان الفرعي رقم 1" أو اسم الفيديو المذكور).
4. أجب باللغة العربية الفصحى المبسّطة، بإيجاز ووضوح (فقرة أو فقرتين كحد أقصى).
5. أعد الرد بصيغة JSON فقط دون أي نص إضافي قبله أو بعده، وفق الشكل التالي بالضبط:
{"answer": "نص الإجابة هنا", "sources": ["الفقرة رقم 2", "..."], "found_in_lesson": true}
- اجعل "found_in_lesson" قيمته false إذا لم تكن الإجابة موجودة أصلاً في محتوى الدرس.

--- محتوى الدرس ---
${lessonContext}
--- نهاية محتوى الدرس ---`;

    let mistralRes: Response;
    try {
      mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({
          model: MISTRAL_MODEL,
          temperature: 0.2,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
          ],
        }),
      });
    } catch (fetchErr) {
      console.error("ask-lesson-ai: فشل الاتصال الشبكي بـ Mistral API:", fetchErr);
      return jsonResponse({ error: "تعذّر الاتصال بخدمة الذكاء الاصطناعي، تحقق من الاتصال وحاول مرة أخرى." }, 502);
    }

    if (!mistralRes.ok) {
      const errText = await mistralRes.text().catch(() => "");
      console.error("ask-lesson-ai: Mistral API رد بخطأ:", mistralRes.status, errText);
      const hint =
        mistralRes.status === 401
          ? "مفتاح Mistral API غير صحيح أو منتهي — تحقق من قيمة MISTRAL_API_KEY في Secrets."
          : mistralRes.status === 429
          ? "تم تجاوز حد استخدام Mistral API (الرصيد أو معدل الطلبات)."
          : "تعذّر الاتصال بالمساعد الذكي حالياً، حاول بعد قليل.";
      return jsonResponse({ error: hint }, 502);
    }

    const mistralData = await mistralRes.json();
    const rawText: string = mistralData?.choices?.[0]?.message?.content || "";

    let parsed: { answer?: string; sources?: string[]; found_in_lesson?: boolean };
    try {
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      console.error("ask-lesson-ai: تعذّر تفسير رد Mistral كـ JSON. الرد الخام:", rawText.slice(0, 300));
      parsed = { answer: rawText || "تعذّر تفسير رد المساعد، حاول إعادة صياغة سؤالك.", sources: [], found_in_lesson: false };
    }

    const answer = String(parsed.answer || "لم يتمكن المساعد من توليد إجابة، حاول مرة أخرى.").trim();
    const sources = Array.isArray(parsed.sources) ? parsed.sources.filter(Boolean).map(String) : [];
    const foundInLesson = parsed.found_in_lesson !== false;

    // ---------- 6) تسجيل السؤال (best-effort، لا يوقف الاستجابة لو فشل) ----------
    adminClient
      .from("lesson_ai_questions")
      .insert({
        user_id: userId,
        content_id: contentId,
        question,
        answer,
        sources,
        was_answered: foundInLesson,
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.error("ask-lesson-ai: فشل تسجيل السؤال في lesson_ai_questions:", error.message);
      });

    return jsonResponse({ answer, sources, found_in_lesson: foundInLesson });
  } catch (err) {
    console.error("ask-lesson-ai: خطأ غير متوقع:", err instanceof Error ? err.stack || err.message : err);
    return jsonResponse(
      {
        error: "حدث خطأ غير متوقع، برجاء المحاولة لاحقاً.",
        // رسالة تقنية موجزة تساعد في التشخيص من الواجهة مباشرة دون الحاجة لفتح السجلات
        debug: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

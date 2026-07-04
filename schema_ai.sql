-- ============================================================
-- 🤖 ترقية قاعدة البيانات — مساعد الطالب الذكي (AI Lesson Assistant)
-- شغّل هذا الملف بعد schema.sql و schema_admin.sql في Supabase SQL Editor
--
-- ✅ آمن لإعادة التشغيل (Idempotent): لو نفّذته أكثر من مرة بالخطأ
--    لن يظهر خطأ "already exists" — سيتخطى ما هو موجود فعلاً.
-- ============================================================

-- ============================================================
-- 1) جدول سجل أسئلة الطالب للمساعد الذكي (lesson_ai_questions)
-- يُستخدم لِـ: (أ) تحديد معدّل الاستخدام لكل مستخدم (Rate Limiting)
--            (ب) رصد الأسئلة المتكررة لتحسين المحتوى لاحقاً من لوحة الإدارة
-- ============================================================
CREATE TABLE IF NOT EXISTS lesson_ai_questions (
    id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    content_id   INT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    question     TEXT NOT NULL,
    answer       TEXT,
    sources      JSONB,           -- مصفوفة المصادر التي استند إليها الرد (رقم فقرة / فيديو)
    was_answered BOOLEAN DEFAULT TRUE, -- false لو ردّ المساعد بأن الإجابة غير متوفرة بالدرس
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_questions_user_id     ON lesson_ai_questions (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_questions_content_id  ON lesson_ai_questions (content_id);
CREATE INDEX IF NOT EXISTS idx_ai_questions_created_at  ON lesson_ai_questions (created_at);

ALTER TABLE lesson_ai_questions ENABLE ROW LEVEL SECURITY;

-- إعادة إنشاء السياسة بأمان لو كانت موجودة من قبل (تفادي خطأ "policy already exists")
DROP POLICY IF EXISTS "ai_questions_select" ON lesson_ai_questions;
-- كل مستخدم يشوف أسئلته فقط، والمشرف يشوف الكل (لتحليل الأسئلة الشائعة)
CREATE POLICY "ai_questions_select" ON lesson_ai_questions
    FOR SELECT USING (auth.uid() = user_id OR public.is_current_user_supervisor());

-- الإدخال يتم فقط من الخادم (Edge Function) باستخدام service_role،
-- لذلك لا نفتح سياسة INSERT للمستخدم العادي من الواجهة مباشرة.
-- (service_role يتجاوز RLS تلقائياً في Supabase، فلا حاجة لسياسة إضافية هنا)

-- ============================================================
-- ✅ ملاحظات تشغيل
-- ============================================================
-- 1) الجدول لا يُكتب إليه إلا عبر Edge Function (ask-lesson-ai) بمفتاح
--    service_role، لضمان عدم تلاعب المستخدم بسجل أسئلته أو انتحال أسئلة غيره.
-- 2) يمكن للمشرف لاحقاً بناء تقرير "الأسئلة الأكثر تكراراً لكل درس" من
--    هذا الجدول لتحسين نص/فقرات الدرس نفسه.
-- 3) تحقق سريع بعد التنفيذ: نفّذ `select * from lesson_ai_questions limit 1;`
--    في SQL Editor — لو ظهر الجدول فارغاً بدون خطأ، فالإعداد صحيح.
-- ============================================================

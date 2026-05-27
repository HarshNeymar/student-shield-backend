
-- ============== ENUMS ==============
CREATE TYPE public.app_role AS ENUM ('company_admin','school_admin','teacher','student');
CREATE TYPE public.plan_tier AS ENUM ('basic','standard','premium');
CREATE TYPE public.payment_mode AS ENUM ('one_time','installment');
CREATE TYPE public.payment_status AS ENUM ('pending','partial','paid','failed');
CREATE TYPE public.claim_status AS ENUM ('pending','approved','rejected','paid');
CREATE TYPE public.session_status AS ENUM ('scheduled','live','completed','cancelled');

-- ============== SCHOOLS ==============
CREATE TABLE public.schools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT,
  address TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  admin_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

-- ============== PROFILES ==============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  school_id UUID REFERENCES public.schools(id) ON DELETE SET NULL,
  class_assigned TEXT,
  age INT,
  parent_phone TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ============== USER ROLES ==============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- ============== HELPER FUNCTIONS ==============
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.get_user_school(_user_id UUID)
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT school_id FROM public.profiles WHERE id = _user_id LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_company_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = 'company_admin')
$$;

-- ============== AUTO-CREATE PROFILE ==============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============== UPDATED_AT TRIGGER ==============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_schools_updated BEFORE UPDATE ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============== PLANS / ENROLLMENTS ==============
CREATE TABLE public.enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  teacher_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  plan plan_tier NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  payment_mode payment_mode NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'active',
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;

-- ============== PAYMENTS / INSTALLMENTS ==============
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id UUID NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  due_date DATE,
  paid_at TIMESTAMPTZ,
  status payment_status NOT NULL DEFAULT 'pending',
  installment_no INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

-- ============== WELLNESS REPORTS ==============
CREATE TABLE public.wellness_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  behavioral INT NOT NULL CHECK (behavioral BETWEEN 1 AND 10),
  emotional INT NOT NULL CHECK (emotional BETWEEN 1 AND 10),
  academic INT NOT NULL CHECK (academic BETWEEN 1 AND 10),
  participation INT NOT NULL CHECK (participation BETWEEN 1 AND 10),
  health INT NOT NULL CHECK (health BETWEEN 1 AND 10),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wellness_reports ENABLE ROW LEVEL SECURITY;

-- ============== CLAIMS ==============
CREATE TABLE public.claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  school_id UUID NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  amount NUMERIC(10,2) NOT NULL,
  status claim_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;

-- ============== SESSIONS ==============
CREATE TABLE public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  duration_minutes INT DEFAULT 60,
  recording_url TEXT,
  meeting_url TEXT,
  target_school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
  target_class TEXT,
  status session_status NOT NULL DEFAULT 'scheduled',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- ============== RLS POLICIES ==============

-- profiles
CREATE POLICY "users read own profile" ON public.profiles FOR SELECT
  USING (auth.uid() = id);
CREATE POLICY "company admin reads all profiles" ON public.profiles FOR SELECT
  USING (public.has_role(auth.uid(), 'company_admin'));
CREATE POLICY "school admin reads school profiles" ON public.profiles FOR SELECT
  USING (public.has_role(auth.uid(),'school_admin') AND school_id = public.get_user_school(auth.uid()));
CREATE POLICY "teacher reads same-school profiles" ON public.profiles FOR SELECT
  USING (public.has_role(auth.uid(),'teacher') AND school_id = public.get_user_school(auth.uid()));
CREATE POLICY "users update own profile" ON public.profiles FOR UPDATE
  USING (auth.uid() = id);
CREATE POLICY "company admin updates profiles" ON public.profiles FOR UPDATE
  USING (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "school admin updates same-school" ON public.profiles FOR UPDATE
  USING (public.has_role(auth.uid(),'school_admin') AND school_id = public.get_user_school(auth.uid()));
CREATE POLICY "teacher inserts students" ON public.profiles FOR INSERT
  WITH CHECK (public.has_role(auth.uid(),'teacher') OR public.has_role(auth.uid(),'school_admin') OR public.has_role(auth.uid(),'company_admin'));

-- user_roles
CREATE POLICY "users read own roles" ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);
CREATE POLICY "company admin reads all roles" ON public.user_roles FOR SELECT
  USING (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "company admin manages roles" ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(),'company_admin'))
  WITH CHECK (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "school admin assigns teacher/student in school" ON public.user_roles FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(),'school_admin')
    AND school_id = public.get_user_school(auth.uid())
    AND role IN ('teacher','student')
  );
CREATE POLICY "teacher assigns student role same school" ON public.user_roles FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(),'teacher')
    AND school_id = public.get_user_school(auth.uid())
    AND role = 'student'
  );

-- schools
CREATE POLICY "company admin manages schools" ON public.schools FOR ALL
  USING (public.has_role(auth.uid(),'company_admin'))
  WITH CHECK (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "members read their school" ON public.schools FOR SELECT
  USING (id = public.get_user_school(auth.uid()) OR public.has_role(auth.uid(),'company_admin'));

-- enrollments
CREATE POLICY "company reads all enrollments" ON public.enrollments FOR SELECT
  USING (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "school reads its enrollments" ON public.enrollments FOR SELECT
  USING (school_id = public.get_user_school(auth.uid()));
CREATE POLICY "student reads own enrollment" ON public.enrollments FOR SELECT
  USING (student_id = auth.uid());
CREATE POLICY "teacher creates enrollment" ON public.enrollments FOR INSERT
  WITH CHECK (
    (public.has_role(auth.uid(),'teacher') OR public.has_role(auth.uid(),'school_admin') OR public.has_role(auth.uid(),'company_admin'))
    AND school_id = public.get_user_school(auth.uid())
  );
CREATE POLICY "school updates enrollment" ON public.enrollments FOR UPDATE
  USING (school_id = public.get_user_school(auth.uid()) AND (public.has_role(auth.uid(),'teacher') OR public.has_role(auth.uid(),'school_admin')));
CREATE POLICY "company updates enrollment" ON public.enrollments FOR UPDATE
  USING (public.has_role(auth.uid(),'company_admin'));

-- payments
CREATE POLICY "company reads payments" ON public.payments FOR SELECT
  USING (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "school members read payments" ON public.payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.enrollments e WHERE e.id = enrollment_id AND (e.school_id = public.get_user_school(auth.uid()) OR e.student_id = auth.uid())));
CREATE POLICY "school members write payments" ON public.payments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.enrollments e WHERE e.id = enrollment_id AND e.school_id = public.get_user_school(auth.uid())));
CREATE POLICY "school members update payments" ON public.payments FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.enrollments e WHERE e.id = enrollment_id AND e.school_id = public.get_user_school(auth.uid())));

-- wellness_reports
CREATE POLICY "company reads wellness" ON public.wellness_reports FOR SELECT
  USING (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "school reads wellness" ON public.wellness_reports FOR SELECT
  USING (school_id = public.get_user_school(auth.uid()));
CREATE POLICY "student reads own wellness" ON public.wellness_reports FOR SELECT
  USING (student_id = auth.uid());
CREATE POLICY "teacher creates wellness" ON public.wellness_reports FOR INSERT
  WITH CHECK (public.has_role(auth.uid(),'teacher') AND school_id = public.get_user_school(auth.uid()) AND teacher_id = auth.uid());

-- claims
CREATE POLICY "company manages claims" ON public.claims FOR ALL
  USING (public.has_role(auth.uid(),'company_admin'))
  WITH CHECK (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "school reads its claims" ON public.claims FOR SELECT
  USING (school_id = public.get_user_school(auth.uid()));
CREATE POLICY "teacher creates own claim" ON public.claims FOR INSERT
  WITH CHECK (public.has_role(auth.uid(),'teacher') AND teacher_id = auth.uid() AND school_id = public.get_user_school(auth.uid()));
CREATE POLICY "teacher reads own claim" ON public.claims FOR SELECT
  USING (teacher_id = auth.uid());

-- sessions
CREATE POLICY "company manages sessions" ON public.sessions FOR ALL
  USING (public.has_role(auth.uid(),'company_admin'))
  WITH CHECK (public.has_role(auth.uid(),'company_admin'));
CREATE POLICY "members read relevant sessions" ON public.sessions FOR SELECT
  USING (
    target_school_id IS NULL
    OR target_school_id = public.get_user_school(auth.uid())
    OR public.has_role(auth.uid(),'company_admin')
  );

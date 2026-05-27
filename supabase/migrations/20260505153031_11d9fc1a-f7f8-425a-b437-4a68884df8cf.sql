REVOKE ALL ON FUNCTION public.claim_company_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_company_admin() FROM anon;
GRANT EXECUTE ON FUNCTION public.claim_company_admin() TO authenticated;
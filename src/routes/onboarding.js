import { Router } from 'express';
import { asyncHandler } from '../utils.js';

const router = Router();

router.get('/company-admin-exists', asyncHandler(async (req, res) => {
  const { count, error } = await req.supabase.from('user_roles').select('*', { count: 'exact', head: true }).eq('role', 'company_admin');
  if (error) throw new Error(error.message);
  res.json({ exists: (count ?? 0) > 0, count: count ?? 0 });
}));

router.post('/claim-company-admin', asyncHandler(async (req, res) => {
  const { error } = await req.supabase.rpc('claim_company_admin');
  if (error) throw new Error(error.message);
  res.json({ success: true });
}));

export default router;

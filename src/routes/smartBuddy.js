import { Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils.js';
import { requireSmartBuddySession } from '../middleware/smartBuddyAuth.js';
import {
  exchangeSmartBuddyLaunchToken,
  getSmartBuddyProfile,
  getSmartBuddyReportDownload,
  listSmartBuddyReports,
  revokeSmartBuddySession,
  saveSmartBuddyProfile,
  uploadSmartBuddyReport,
} from '../services/smartBuddy.js';

const router = Router();

const reportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
  },
});

router.post(
  '/session',
  asyncHandler(async (req, res) => {
    const result = await exchangeSmartBuddyLaunchToken(req.body?.launch_token);
    res.status(201).json(result);
  })
);

router.use(requireSmartBuddySession);

router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    res.json(await getSmartBuddyProfile(req.smartBuddy.studentId));
  })
);

router.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const saved = await saveSmartBuddyProfile(req.smartBuddy.studentId, req.body);
    res.json({ success: true, saved_profile: saved });
  })
);

router.post(
  '/reports',
  reportUpload.single('file'),
  asyncHandler(async (req, res) => {
    const report = await uploadSmartBuddyReport(
      req.smartBuddy.studentId,
      req.file,
      req.body
    );

    res.status(201).json({ success: true, report });
  })
);

router.get(
  '/reports',
  asyncHandler(async (req, res) => {
    const reports = await listSmartBuddyReports(req.smartBuddy.studentId);
    res.json(reports);
  })
);

router.get(
  '/reports/:reportId/download',
  asyncHandler(async (req, res) => {
    const report = await getSmartBuddyReportDownload(
      req.smartBuddy.studentId,
      req.params.reportId
    );

    res.json(report);
  })
);

router.post(
  '/session/logout',
  asyncHandler(async (req, res) => {
    await revokeSmartBuddySession(req.smartBuddy.token);
    res.json({ success: true });
  })
);

export default router;

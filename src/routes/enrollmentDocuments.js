import { Router } from 'express';
import { asyncHandler } from '../utils.js';
import {
  createEnrollmentPdfBuffer,
  getAuthorizedEnrollmentDocument,
} from '../services/enrollmentDocument.js';

const router = Router();

function createFileName(studentName) {
  const safeName = String(studentName ?? 'student')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  return `student-shield-${safeName || 'student'}-enrollment.pdf`;
}

async function sendEnrollmentPdf(res, documentData) {
  const buffer = await createEnrollmentPdfBuffer(documentData);

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${createFileName(
      documentData.student.full_name
    )}"`,
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Length': String(buffer.length),
  });

  res.status(200).send(buffer);
}

// School admin, assigned teacher or company admin download a student's PDF.
router.get(
  '/enrollment/:studentId/pdf',
  asyncHandler(async (req, res) => {
    const documentData = await getAuthorizedEnrollmentDocument(
      req.user.id,
      req.params.studentId
    );

    await sendEnrollmentPdf(res, documentData);
  })
);

// Logged-in student downloads own PDF.
router.get(
  '/my-enrollment/pdf',
  asyncHandler(async (req, res) => {
    const documentData = await getAuthorizedEnrollmentDocument(
      req.user.id,
      req.user.id
    );

    await sendEnrollmentPdf(res, documentData);
  })
);

export default router;
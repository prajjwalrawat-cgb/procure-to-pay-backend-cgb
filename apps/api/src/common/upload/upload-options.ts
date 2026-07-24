import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

/** Max invoice/document upload size (15 MB) — bounds memory + zip-bomb surface. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Only genuine invoice document types — blocks executables, HTML, archives, etc. */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
]);

/**
 * Slice 11b — hardened Multer options for document uploads. Enforces a size cap
 * and a strict MIME allow-list at the interceptor boundary (before the handler
 * runs), rejecting oversized files, disguised executables, and wrong types.
 */
export const DOCUMENT_UPLOAD_OPTIONS: MulterOptions = {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(
        new BadRequestException(
          `Unsupported file type "${file.mimetype}". Only PDF and image invoices are accepted.`,
        ),
        false,
      );
      return;
    }
    cb(null, true);
  },
};

/** Multer surfaces a size overflow as a MulterError, not our fileFilter — map it. */
export function assertUploadSize(file: { size?: number } | undefined): void {
  if (file?.size && file.size > MAX_UPLOAD_BYTES) {
    throw new PayloadTooLargeException(
      `File exceeds the ${MAX_UPLOAD_BYTES} byte limit.`,
    );
  }
}

/**
 * Sanitise a client-supplied filename before it is used to build an object key:
 * strip path separators / traversal and keep only safe characters, so a
 * malicious `../../etc/passwd` or double-extension name cannot escape the prefix.
 */
export function safeFilename(name: string | undefined): string {
  const base = (name ?? 'upload.pdf').split(/[\\/]/).pop() ?? 'upload.pdf';
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'upload.pdf';
}

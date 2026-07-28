import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

import { MAX_UPLOAD_BYTES } from '../../common/upload/upload-options';

/**
 * Spreadsheet MIME types. Browsers and OSes are inconsistent about CSV in
 * particular (Excel registers it as `application/vnd.ms-excel`), so accept the
 * observed set and fall back to an extension check below.
 */
const ALLOWED_MIME = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
]);

const ALLOWED_EXT = /\.(csv|xlsx|xlsm)$/i;

/**
 * Multer options for bulk-import uploads. Mirrors the Slice 11b document-upload
 * hardening (size cap + allow-list at the interceptor boundary) but for
 * spreadsheets rather than invoice PDFs.
 *
 * `application/octet-stream` is permitted because several clients send it for
 * .xlsx, so the extension check is what actually carries the guarantee here.
 */
export const IMPORT_UPLOAD_OPTIONS: MulterOptions = {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_EXT.test(file.originalname)) {
      cb(
        new BadRequestException(
          `Unsupported file "${file.originalname}". Upload a .csv or .xlsx file.`,
        ),
        false,
      );
      return;
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(
        new BadRequestException(`Unsupported file type "${file.mimetype}".`),
        false,
      );
      return;
    }
    cb(null, true);
  },
};

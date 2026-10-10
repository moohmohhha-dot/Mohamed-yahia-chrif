import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { schema as s, type Database } from '@aruma/db';
import { badRequest, notFound } from '../../shared/errors.js';
import type { Actor } from '../../shared/request-context.js';
import { audit, detectContentType, type FileStorage, type SecretBox } from '../platform/index.js';
import { DOCUMENT_CHECK, type DocumentKind } from './requirements.js';
import { requireMembership, type MerchantRole } from './service.js';
import { invalidateCheck, recomputeStatus } from './verification.js';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Identity and payout documents are the most sensitive: only the owner may upload or download them. */
export const rolesForDocument = (kind: DocumentKind): MerchantRole[] =>
  DOCUMENT_CHECK[kind] === 'business' ? ['owner', 'manager'] : ['owner'];

export async function uploadDocument(
  db: Database,
  storage: FileStorage,
  secrets: SecretBox,
  actor: Actor & { userId: string },
  merchantId: string,
  kind: DocumentKind,
  file: { body: Buffer; fileName: string | null },
) {
  await requireMembership(db, merchantId, actor.userId, rolesForDocument(kind));
  const contentType = detectContentType(file.body);
  if (!contentType) throw badRequest('UNSUPPORTED_FILE_TYPE', 'Upload a PDF, JPEG, PNG or WebP file');

  const id = randomUUID();
  const storageKey = `merchants/${merchantId}/documents/${id}`;
  await storage.put(storageKey, secrets.sealBytes(file.body)); // encrypted at rest

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(s.merchantDocuments)
      .values({
        id,
        merchantId,
        kind,
        storageKey,
        fileName: file.fileName?.slice(0, 200) ?? null,
        contentType,
        sizeBytes: file.body.length,
        sha256: createHash('sha256').update(file.body).digest('hex'),
        uploadedBy: actor.userId,
      })
      .returning();
    await tx
      .update(s.merchantDocuments)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(s.merchantDocuments.merchantId, merchantId),
          eq(s.merchantDocuments.kind, kind),
          ne(s.merchantDocuments.id, id),
          isNull(s.merchantDocuments.archivedAt),
        ),
      );
    await invalidateCheck(tx, merchantId, DOCUMENT_CHECK[kind], 'A document was replaced; please resubmit');
    await audit(tx, actor, {
      action: 'merchants.document.uploaded',
      entityType: 'merchant',
      entityId: merchantId,
      metadata: { documentId: id, kind, sha256: doc!.sha256 },
    });
    await recomputeStatus(tx, merchantId, actor);
    const { storageKey: _key, ...publicDoc } = doc!;
    return publicDoc;
  });
}

/** Loads and decrypts a document. Authorization is the caller's job. */
export async function readDocument(
  db: Database,
  storage: FileStorage,
  secrets: SecretBox,
  merchantId: string,
  documentId: string,
) {
  const [doc] = await db
    .select()
    .from(s.merchantDocuments)
    .where(and(eq(s.merchantDocuments.id, documentId), eq(s.merchantDocuments.merchantId, merchantId)));
  if (!doc) throw notFound('Document');
  return { doc, body: secrets.openBytes(await storage.get(doc.storageKey)) };
}

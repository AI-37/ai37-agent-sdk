export { attachmentScope, hasFileRefs, projectIdFromRefs } from './turn-files'
export type { AttachmentFile, AttachmentTurnInput, AttachmentTurnScope } from './turn-files'
export { attachmentFailureReason, createAttachmentReaders, readStoreWithinBudget } from './readers'
export type {
  AttachmentGrepHit,
  AttachmentReaders,
  AttachmentReadersOptions,
  WindowedRead,
} from './readers'
export { readAttachmentContents } from './contents'
export type {
  AttachmentContent,
  AttachmentContentsResult,
  AttachmentReadFailure,
  ReadAttachmentContentsOptions,
} from './contents'
export { extractFromAttachments, extractionRequest, messageText } from './extract'
export type { ExtractFromAttachmentsOptions } from './extract'
export { artifactScope } from './artifact-scope'
export type { ArtifactScope, ArtifactScopeOptions } from './artifact-scope'

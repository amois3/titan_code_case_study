export type TextContentPart = {
  type: 'text';
  text: string;
};

export type ImageUrlContentPart = {
  type: 'image_url';
  image_url: {
    url: string;
  };
};

export type FileAttachmentContentPart = {
  type: 'file_attachment';
  file_attachment: {
    name: string;
    path: string;
    mime_type: 'application/pdf';
    text: string;
    pages_read: number;
    total_pages: number;
    truncated: boolean;
    /** Full text aged out of active context; the source can be read again. */
    omitted?: boolean;
  };
};

export type MultimodalContentPart = TextContentPart | ImageUrlContentPart | FileAttachmentContentPart;

export type MessageContent = string | MultimodalContentPart[];

const MULTIMODAL_SENTINEL = 'titan-multimodal';

function isTextPart(part: MultimodalContentPart): part is TextContentPart {
  return part.type === 'text';
}

export function isFileAttachmentPart(part: MultimodalContentPart): part is FileAttachmentContentPart {
  return part.type === 'file_attachment';
}

export function isMessageContentParts(content: MessageContent): content is MultimodalContentPart[] {
  return Array.isArray(content);
}

export function serializeMessageContent(content: MessageContent): string {
  if (!isMessageContentParts(content)) {
    return content;
  }

  return JSON.stringify({
    kind: MULTIMODAL_SENTINEL,
    parts: content
  });
}

export function deserializeMessageContent(raw: string): MessageContent {
  try {
    const parsed = JSON.parse(raw) as { kind?: string; parts?: MultimodalContentPart[] };
    if (parsed?.kind === MULTIMODAL_SENTINEL && Array.isArray(parsed.parts)) {
      return parsed.parts;
    }
  } catch {
    // Keep legacy plain-text messages as-is.
  }

  return raw;
}

export function messageContentToText(content: MessageContent): string {
  if (!isMessageContentParts(content)) {
    return content;
  }

  const blocks: string[] = [];
  let imageCount = 0;
  for (const part of content) {
    if (isTextPart(part)) {
      if (part.text.trim()) blocks.push(part.text.trim());
    } else if (isFileAttachmentPart(part)) {
      blocks.push(fileAttachmentToModelText(part));
    } else {
      imageCount++;
    }
  }
  const suffix = imageCount > 0 ? `\n[${imageCount} image attachment${imageCount === 1 ? '' : 's'}]` : '';

  return `${blocks.join('\n\n')}${suffix}`.trim();
}

export function fileAttachmentToModelText(part: FileAttachmentContentPart): string {
  const file = part.file_attachment;
  if (file.omitted) {
    return [
      `[PDF attachment reference: ${file.name}]`,
      `Local path: ${file.path}`,
      'The full extracted text has aged out of active context. Call resume_read with this path only if exact document details are needed again.'
    ].join('\n');
  }
  return [
    `[Attached PDF: ${file.name}]`,
    `Local path: ${file.path}`,
    `Text already extracted from ${file.pages_read}/${file.total_pages} pages${file.truncated ? ' (truncated)' : ''}. Do not call read_file or resume_read merely to load it again.`,
    '',
    file.text,
    '',
    `[End attached PDF: ${file.name}]`
  ].join('\n');
}

function attachmentLabel(part: FileAttachmentContentPart): string {
  const file = part.file_attachment;
  const pages = file.total_pages === 1 ? '1 page' : `${file.total_pages} pages`;
  return `📎 ${file.name} · PDF · ${pages}${file.truncated ? ' · truncated' : ''}`;
}

function legacyPdfName(path: string): string {
  return path.trim().replace(/\\/g, '/').split('/').pop() || 'document.pdf';
}

/** Old builds stored visible PDF streams/full extracted text inside strings. */
function compactLegacyPdfBlocks(text: string): string {
  const raw = /--- File:\s*(.+?\.pdf)\s*---\r?\n%PDF-[\s\S]*?\r?\n---(?=\r?\n|$)/gi;
  const extracted = /--- PDF:\s*(.+?\.pdf)\s*---\r?\nPDF:[\s\S]*?\r?\n---(?=\r?\n|$)/gi;
  return text
    .replace(raw, (_whole, path: string) => `📎 ${legacyPdfName(path)} · PDF`)
    .replace(extracted, (_whole, path: string) => `📎 ${legacyPdfName(path)} · PDF`);
}

/** Human-facing transcript text; attachment payloads stay hidden. */
export function messageContentToDisplayText(content: MessageContent): string {
  if (!isMessageContentParts(content)) return compactLegacyPdfBlocks(content);
  const blocks: string[] = [];
  let imageCount = 0;
  for (const part of content) {
    if (isTextPart(part)) {
      const visible = compactLegacyPdfBlocks(part.text).trim();
      if (visible) blocks.push(visible);
    } else if (isFileAttachmentPart(part)) {
      blocks.push(attachmentLabel(part));
    } else {
      imageCount++;
    }
  }
  if (imageCount > 0) blocks.push(`[${imageCount} image attachment${imageCount === 1 ? '' : 's'}]`);
  return blocks.join('\n\n').trim();
}

export function hasImagePart(content: MessageContent): boolean {
  return isMessageContentParts(content) && content.some((part) => part.type === 'image_url');
}

export function countImageParts(content: MessageContent): number {
  if (!isMessageContentParts(content)) return 0;
  return content.filter((part) => part.type === 'image_url').length;
}

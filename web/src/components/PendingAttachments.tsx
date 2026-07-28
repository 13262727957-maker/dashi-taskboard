import { useLayoutEffect, useState } from "react";
import { LinearIcon } from "./LinearIcon";

export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

export function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function clipboardImages(data: DataTransfer): File[] {
  const images = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  return images.length > 0
    ? images
    : Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

interface PendingAttachmentsProps {
  files: File[];
  disabled: boolean;
  uploadLabel: string;
  ariaLabel: string;
  className?: string;
  onRemove: (index: number) => void;
}

function PendingImage({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useLayoutEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <li>
      {previewUrl && <img src={previewUrl} alt={file.name} />}
      <button type="button" disabled={disabled} aria-label={`移除 ${file.name}`} onClick={onRemove}>
        <LinearIcon name="close" />
      </button>
    </li>
  );
}

export function PendingAttachments({
  files,
  disabled,
  uploadLabel,
  ariaLabel,
  className = "",
  onRemove,
}: PendingAttachmentsProps) {
  if (files.length === 0) return null;

  const images = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => file.type.startsWith("image/"));
  const otherFiles = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => !file.type.startsWith("image/"));

  return (
    <div className={`pending-attachments ${className}`.trim()}>
      {images.length > 0 && (
        <ul className="composer-image-preview-list" aria-label={otherFiles.length > 0 ? `${ariaLabel}中的图片` : ariaLabel}>
          {images.map(({ file, index }) => (
            <PendingImage
              key={fileKey(file)}
              file={file}
              disabled={disabled}
              onRemove={() => onRemove(index)}
            />
          ))}
        </ul>
      )}
      {otherFiles.length > 0 && (
        <ul className="composer-attachment-list" aria-label={images.length > 0 ? `${ariaLabel}中的文件` : ariaLabel}>
          {otherFiles.map(({ file, index }) => (
            <li key={fileKey(file)}>
              <span className="composer-attachment-file-icon" aria-hidden="true"><LinearIcon name="file" /></span>
              <span className="composer-attachment-copy"><strong>{file.name}</strong><span>{fileSize(file.size)} · {uploadLabel}</span></span>
              <button type="button" disabled={disabled} aria-label={`移除 ${file.name}`} onClick={() => onRemove(index)}>
                <LinearIcon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

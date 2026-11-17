import { useCallback, useRef, useState } from 'react';
import { parseFile, MAX_FILE_SIZE } from '../utils/fileParser';
import type { ParsedFile } from '../utils/fileParser';
import { formatFileSize } from '../utils/formatters';

/**
 * Shared upload/parse state for the Proposal and Contract AI builders — both accept
 * PDF/DOCX/TXT reference documents and hand the extracted text to an AI-generate call.
 * Rejects duplicates and isolates a single bad file's parse failure from the rest of
 * the batch, so one corrupt upload doesn't stop the others from parsing.
 */
export function useFileUpload() {
  const [uploadedFiles, setUploadedFiles] = useState<ParsedFile[]>([]);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setFileError(null);
    const fileArray = Array.from(files);

    for (const file of fileArray) {
      if (file.size > MAX_FILE_SIZE) {
        setFileError(`${file.name} exceeds ${formatFileSize(MAX_FILE_SIZE)}`);
        continue;
      }

      if (uploadedFiles.some((f) => f.name === file.name)) {
        setFileError(`${file.name} is already uploaded`);
        continue;
      }

      try {
        setIsParsingFile(true);
        const parsed = await parseFile(file);
        if (!parsed.text) {
          setFileError(`Could not extract text from ${file.name}`);
          continue;
        }
        setUploadedFiles((prev) => [...prev, parsed]);
      } catch {
        setFileError(`Failed to parse ${file.name}. Please ensure it is a valid PDF, DOCX, or TXT file.`);
      } finally {
        setIsParsingFile(false);
      }
    }
  }, [uploadedFiles]);

  const removeFile = useCallback((fileName: string) => {
    setUploadedFiles((prev) => prev.filter((f) => f.name !== fileName));
    setFileError(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  return {
    uploadedFiles,
    isParsingFile,
    fileError,
    isDragOver,
    fileInputRef,
    handleFiles,
    removeFile,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  };
}

import { useCallback, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

interface SavedImage {
  id: string;
  dataUrl: string;
  timestamp: string;
  size: number;
}

interface UseImageCaptureArgs {
  drawingOverlayRef: RefObject<any>;
  setMessages: Dispatch<SetStateAction<any[]>>;
}

export function useImageCapture({ drawingOverlayRef, setMessages }: UseImageCaptureArgs) {
  const [savedImages, setSavedImages] = useState<SavedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);

  // Handle capture of annotated chart for LLM
  const handleCaptureImage = useCallback(async () => {
    if (drawingOverlayRef.current) {
      const blob = await drawingOverlayRef.current.exportAnnotatedImage();
      if (blob) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(blob);
        });

        const newImage: SavedImage = {
          id: `img-${Date.now()}`,
          dataUrl,
          timestamp: new Date().toISOString(),
          size: blob.size
        };

        setSavedImages((prev) => [...prev, newImage]);
        setSelectedImageId(newImage.id);

        // Show success message in chat
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '📸 Chart captured successfully! The image is ready to send to the LLM.'
          }
        ]);
      }
    }
  }, [drawingOverlayRef, setMessages]);

  // Delete an image from saved images
  const handleDeleteImage = useCallback(
    (imageId: string) => {
      setSavedImages((prev) => prev.filter((img) => img.id !== imageId));
      if (selectedImageId === imageId) {
        setSelectedImageId(null);
      }
    },
    [selectedImageId]
  );

  // Select/deselect an image
  const handleSelectImage = useCallback((imageId: string) => {
    setSelectedImageId((prev) => (prev === imageId ? null : imageId));
  }, []);

  return {
    savedImages,
    selectedImageId,
    handleCaptureImage,
    handleDeleteImage,
    handleSelectImage
  };
}

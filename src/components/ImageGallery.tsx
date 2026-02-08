import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CellComponentProps, Grid } from 'react-window';

interface SavedImage {
  id: string;
  dataUrl: string;
}

interface ImageGalleryProps {
  savedImages: SavedImage[];
  selectedImageId: string | null;
  onSelectImage: (id: string) => void;
  onDeleteImage: (id: string) => void;
}

interface CellData {
  images: SavedImage[];
  columnCount: number;
  selectedImageId: string | null;
  onSelectImage: (id: string) => void;
  onDeleteImage: (id: string) => void;
}

export const ImageGallery = React.memo(function ImageGallery({
  savedImages,
  selectedImageId,
  onSelectImage,
  onDeleteImage
}: ImageGalleryProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect?.width ?? 0;
      setContainerWidth(nextWidth);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const cellSize = 90;
    const width = Math.max(containerWidth, cellSize);
    const columnCount = Math.max(1, Math.floor(width / cellSize));
    const rowCount = Math.ceil(savedImages.length / columnCount);
    const height = Math.min(150, rowCount * cellSize);
    return { cellSize, columnCount, rowCount, height, width };
  }, [containerWidth, savedImages.length]);

  const cellProps = useMemo<CellData>(
    () => ({
      images: savedImages,
      columnCount: layout.columnCount,
      selectedImageId,
      onSelectImage,
      onDeleteImage
    }),
    [savedImages, layout.columnCount, selectedImageId, onSelectImage, onDeleteImage]
  );

  if (savedImages.length === 0) return null;

  return (
    <div className="image-gallery" ref={containerRef}>
      <div className="gallery-header">Captured Images ({savedImages.length})</div>
      <div className="gallery-thumbnails">
        {containerWidth === 0 ? (
          savedImages.map((image) => (
            <div
              key={image.id}
              className={`thumbnail-wrapper ${selectedImageId === image.id ? 'selected' : ''}`}
              onClick={() => onSelectImage(image.id)}
            >
              <img src={image.dataUrl} alt="Captured chart" className="thumbnail-image" />
              <button
                className="thumbnail-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteImage(image.id);
                }}
                title="Delete image"
              >
                ×
              </button>
              {selectedImageId === image.id && <div className="thumbnail-selected-badge">✓</div>}
            </div>
          ))
        ) : (
          <Grid
            cellComponent={({
              ariaAttributes,
              columnIndex,
              rowIndex,
              style,
              images,
              columnCount,
              selectedImageId,
              onSelectImage,
              onDeleteImage
            }: CellComponentProps<CellData>) => {
              const index = rowIndex * columnCount + columnIndex;
              if (index >= images.length) return null;
              const image = images[index];
              return (
                <div style={{ ...style, padding: 5 }} {...ariaAttributes}>
                  <div
                    className={`thumbnail-wrapper ${selectedImageId === image.id ? 'selected' : ''}`}
                    onClick={() => onSelectImage(image.id)}
                  >
                    <img src={image.dataUrl} alt="Captured chart" className="thumbnail-image" />
                    <button
                      className="thumbnail-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteImage(image.id);
                      }}
                      title="Delete image"
                    >
                      ×
                    </button>
                    {selectedImageId === image.id && (
                      <div className="thumbnail-selected-badge">✓</div>
                    )}
                  </div>
                </div>
              );
            }}
            cellProps={cellProps}
            columnCount={layout.columnCount}
            columnWidth={layout.cellSize}
            defaultHeight={layout.height}
            defaultWidth={layout.width}
            rowCount={layout.rowCount}
            rowHeight={layout.cellSize}
            style={{ height: layout.height, width: layout.width }}
          />
        )}
      </div>
    </div>
  );
});

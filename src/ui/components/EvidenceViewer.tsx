import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { api, loadProtectedImage, recordCropView } from '../api.ts';

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Canvas-based evidence image viewer with drag-to-zoom crop. No image library: cropping is a canvas
 * `drawImage` source-rect redraw, done entirely client-side (brief Section 3, "crop/zoom").
 */
export function EvidenceViewer({ evidenceId }: { evidenceId: string }): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setLoaded(false);
    setError(null);
    setZoomed(false);
    (async () => {
      try {
        objectUrl = await loadProtectedImage(api.evidenceImagePath(evidenceId));
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          imgRef.current = img;
          setLoaded(true);
          draw(null);
        };
        img.onerror = () => {
          if (!cancelled) setError('Could not decode stored image');
        };
        img.src = objectUrl;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evidenceId]);

  function draw(crop: Region | null): void {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (crop) {
      const sw = Math.max(1, crop.x1 - crop.x0);
      const sh = Math.max(1, crop.y1 - crop.y0);
      ctx.drawImage(img, crop.x0, crop.y0, sw, sh, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.drawImage(img, 0, 0);
    }
  }

  function toImageCoords(e: MouseEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function onMouseDown(e: MouseEvent<HTMLCanvasElement>): void {
    dragStartRef.current = toImageCoords(e);
  }

  function onMouseUp(e: MouseEvent<HTMLCanvasElement>): void {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const end = toImageCoords(e);
    const region: Region = { x0: Math.min(start.x, end.x), y0: Math.min(start.y, end.y), x1: Math.max(start.x, end.x), y1: Math.max(start.y, end.y) };
    if (region.x1 - region.x0 < 6 || region.y1 - region.y0 < 6) return;
    draw(region);
    setZoomed(true);
    void recordCropView(evidenceId, region);
  }

  function resetZoom(): void {
    draw(null);
    setZoomed(false);
  }

  return (
    <div data-testid="evidence-viewer">
      {error ? (
        <div className="banner banner-error" data-testid="evidence-viewer-error">
          {error}
        </div>
      ) : (
        <div className="evidence-canvas-wrap">
          <canvas ref={canvasRef} onMouseDown={onMouseDown} onMouseUp={onMouseUp} data-testid="evidence-canvas" />
        </div>
      )}
      {loaded ? (
        <div className="button-row">
          <span className="field-note">Drag on the image to zoom into a region.</span>
          {zoomed ? (
            <button onClick={resetZoom} data-testid="evidence-reset-zoom">
              Reset zoom
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import { renderAudio } from "./audio.js";
import type { CaptureSpec, RenderResult } from "./capture.js";
import { renderDocument } from "./document.js";
import { renderImage } from "./image.js";
import { renderSpectrum } from "./spectrum.js";
import { renderThermal } from "./thermal.js";
import { renderVideo } from "./video.js";

/** The media for one capture, from the spec alone: the same spec gives the same bytes (video: on the same ffmpeg). */
export async function render(c: CaptureSpec): Promise<RenderResult> {
  switch (c.outcome.media) {
    case "thermal":
      return renderThermal(c);
    case "image":
      return renderImage(c);
    case "audio":
      return renderAudio(c);
    case "video":
      return renderVideo(c);
    case "spectrum":
      return renderSpectrum(c);
    case "document":
      return renderDocument(c);
  }
}

export type { CaptureSpec, RenderResult } from "./capture.js";

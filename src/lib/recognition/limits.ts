import { RecognitionError, type RecognitionRequest } from "./types";

/** Most photos one scan may send for recognition. */
export const MAX_PHOTOS = 12;

/** Throws a safe message when a request has no photos or too many. */
export function checkPhotoCount(request: RecognitionRequest): void {
  if (request.photos.length === 0) {
    throw new RecognitionError("No photo was received. Take a photo and try again.");
  }
  if (request.photos.length > MAX_PHOTOS) {
    throw new RecognitionError(`Too many photos in one scan. Use ${MAX_PHOTOS} or fewer.`);
  }
}
